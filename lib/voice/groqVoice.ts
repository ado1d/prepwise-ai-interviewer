import type {
  VoiceSession,
  VoiceSessionCallbacks,
  VoiceSetupPayload,
} from "./types";

/**
 * Groq-powered voice session.
 *
 * Groq has no single realtime voice model (unlike OpenAI Realtime or Gemini
 * Live), so this orchestrates a turn-based pipeline:
 *
 *   mic -> (client-side VAD) -> Groq Whisper STT -> Groq Llama LLM (streaming)
 *       -> browser SpeechSynthesis TTS
 *
 * All Groq calls go through two small Next.js routes
 * (`/api/groq-voice/transcribe` and `/api/groq-voice/chat`) so the real
 * GROQ_API_KEY stays on the server. The browser only does VAD, WAV encoding,
 * stream reading, and TTS playback.
 *
 * This is turn-based (simplex): the user speaks, then the assistant speaks.
 * Interruption isn't supported in this version — wait for the assistant to
 * finish before answering. Tool calls (the createInterview flow) work: when
 * the model emits a tool call, the Agent runs it and `sendToolResult` resumes
 * the conversation.
 */

// VAD tuning.
const VAD_THRESHOLD = 0.015; // RMS above this = speech
const VAD_SILENCE_MS = 1100; // trailing silence that ends a utterance
const MIN_SPEECH_SAMPLES = 3200; // ignore utterances shorter than ~200ms @16k

// Chat history entry (OpenAI-compatible, what Groq expects).
interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ToolCallEvent {
  id: string;
  name: string;
  args: string;
}

export class GroqVoiceSession implements VoiceSession {
  private payload: VoiceSetupPayload;
  private cb: VoiceSessionCallbacks;
  private systemPrompt: string;
  private tools?: import("./types").GeminiToolList;

  private micStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;

  // VAD state.
  private listening = true; // capturing user speech
  private userSpeaking = false;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private speechChunks: Float32Array[] = [];

  // TTS state.
  private voices: SpeechSynthesisVoice[] = [];
  private speakQueue: string[] = [];
  private speakingSentence = false;
  private speakingStarted = false;

  // Chat history.
  private messages: ChatMessage[] = [];

  private disconnected = false;

  constructor(payload: VoiceSetupPayload, cb: VoiceSessionCallbacks) {
    this.payload = payload;
    this.cb = cb;
    this.systemPrompt = payload.instructions || "";
    this.tools = payload.tools;
    this.messages = [{ role: "system", content: this.systemPrompt }];
  }

  async connect(): Promise<void> {
    // Load TTS voices (Chrome loads them async).
    if (typeof window !== "undefined" && window.speechSynthesis) {
      this.voices = window.speechSynthesis.getVoices();
      if (this.voices.length === 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1500);
          window.speechSynthesis.onvoiceschanged = () => {
            this.voices = window.speechSynthesis.getVoices();
            clearTimeout(timer);
            resolve();
          };
        });
      }
    }

    // Mic + input graph.
    this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const Ctx: typeof AudioContext =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    this.audioContext = new Ctx();
    await this.audioContext.resume?.();

    this.sourceNode = this.audioContext.createMediaStreamSource(this.micStream);
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (event) => this.processAudio(event);
    this.sourceNode.connect(this.processor);
    this.processor.connect(this.audioContext.destination);

    this.cb.onReady?.();

    // Trigger the assistant's opening message (the system prompt instructs it
    // to begin with the configured first message).
    this.messages.push({
      role: "user",
      content:
        "(Begin the conversation now with your opening message exactly as instructed, then wait for the candidate.)",
    });
    void this.runAssistantTurn();
  }

  private processAudio(event: AudioProcessingEvent) {
    // Zero the output so the mic isn't echoed back through the speakers.
    event.outputBuffer.getChannelData(0).fill(0);

    if (!this.listening || this.disconnected) return;

    const input = event.inputBuffer.getChannelData(0);
    const rms = computeRMS(input);

    if (rms > VAD_THRESHOLD) {
      // Speech detected.
      if (!this.userSpeaking) this.userSpeaking = true;
      this.speechChunks.push(new Float32Array(input));
      if (this.silenceTimer) {
        clearTimeout(this.silenceTimer);
        this.silenceTimer = null;
      }
    } else if (this.userSpeaking) {
      // Trailing silence within an utterance — keep buffering, schedule end.
      this.speechChunks.push(new Float32Array(input));
      if (!this.silenceTimer) {
        this.silenceTimer = setTimeout(() => {
          this.silenceTimer = null;
          void this.endOfSpeech();
        }, VAD_SILENCE_MS);
      }
    }
  }

  private async endOfSpeech() {
    this.userSpeaking = false;
    if (this.disconnected) return;

    const chunks = this.speechChunks;
    this.speechChunks = [];
    if (chunks.length === 0) return;

    const combined = concatFloat32(chunks);
    if (combined.length < MIN_SPEECH_SAMPLES) return; // ignore blips

    // Stop capturing while we transcribe + the assistant responds.
    this.listening = false;

    const sampleRate = this.audioContext?.sampleRate ?? 48000;
    const wav = encodeWav(combined, sampleRate);

    const form = new FormData();
    form.append("file", wav, "audio.wav");

    try {
      const res = await fetch("/api/groq-voice/transcribe", {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Transcribe failed (HTTP ${res.status})`);
      }
      const data = (await res.json()) as { text?: string };
      const transcript = (data.text || "").trim();
      if (!transcript) {
        // Nothing recognizable — resume listening.
        this.listening = true;
        return;
      }
      this.cb.onUserMessage(transcript);
      this.messages.push({ role: "user", content: transcript });
      await this.runAssistantTurn();
    } catch (error) {
      this.cb.onError(
        error instanceof Error ? error.message : "Transcription failed"
      );
      this.listening = true;
    }
  }

  /**
   * Call the Groq LLM (streaming) and speak the response. If the model emits
   * a tool call, hand it to the Agent via onFunctionCall and keep the mic
   * paused until sendToolResult() resumes the turn.
   */
  private async runAssistantTurn() {
    if (this.disconnected) return;
    this.listening = false;
    this.cb.onSpeakingStart();
    this.speakingStarted = true;

    let assistantText = "";
    let toolCall: ToolCallEvent | null = null;

    try {
      const res = await fetch("/api/groq-voice/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: this.messages, tools: this.tools }),
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Chat failed (HTTP ${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith("data: ")) continue;
          const json = line.slice(6).trim();
          if (!json || json === "[DONE]") continue;
          let evt: { type: string; delta?: string; name?: string; args?: string; id?: string };
          try {
            evt = JSON.parse(json);
          } catch {
            continue;
          }
          if (evt.type === "text" && evt.delta) {
            assistantText += evt.delta;
            this.queueSentences(assistantText, false);
          } else if (evt.type === "tool_call") {
            toolCall = {
              id: evt.id || "",
              name: evt.name || "",
              args: evt.args || "{}",
            };
          }
        }
      }

      // Flush any trailing text that didn't end with sentence punctuation.
      this.queueSentences(assistantText, true);
    } catch (error) {
      this.cb.onError(
        error instanceof Error ? error.message : "Chat failed"
      );
    }

    // Wait for queued TTS to finish playing.
    await this.drainQueue();
    this.speakingStarted = false;
    this.cb.onSpeakingEnd();

    if (toolCall) {
      // Record the assistant's tool-call message so the next turn has context.
      this.messages.push({
        role: "assistant",
        content: assistantText || null,
        tool_calls: [
          {
            id: toolCall.id,
            type: "function",
            function: { name: toolCall.name, arguments: toolCall.args },
          },
        ],
      });
      // Keep listening=false; the Agent will call sendToolResult() to resume.
      this.cb.onFunctionCall(toolCall.name, toolCall.args, toolCall.id);
    } else {
      this.messages.push({ role: "assistant", content: assistantText });
      if (assistantText.trim()) this.cb.onAssistantMessage(assistantText.trim());
      // Turn complete — resume listening for the user's next answer.
      this.listening = true;
    }
  }

  /**
   * Split accumulated text into complete sentences and queue them for speech.
   * If `flush` is true, any remaining text is queued even without a boundary.
   */
  private pendingText = "";
  private queueSentences(text: string, flush: boolean) {
    this.pendingText = text;
    const re = /[^.!?]*[.!?]+["')\]]?\s*/g;
    let consumed = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(this.pendingText)) !== null) {
      const sentence = match[0].trim();
      if (sentence) this.queueSpeak(sentence);
      consumed = re.lastIndex;
    }
    if (consumed > 0) this.pendingText = this.pendingText.slice(consumed);
    if (flush && this.pendingText.trim()) {
      this.queueSpeak(this.pendingText.trim());
      this.pendingText = "";
    }
  }

  private queueSpeak(text: string) {
    this.speakQueue.push(text);
    void this.pumpQueue();
  }

  private async pumpQueue() {
    if (this.speakingSentence) return;
    this.speakingSentence = true;
    while (this.speakQueue.length > 0 && !this.disconnected) {
      const text = this.speakQueue.shift() as string;
      await this.speakOne(text);
    }
    this.speakingSentence = false;
  }

  private speakOne(text: string): Promise<void> {
    return new Promise((resolve) => {
      if (this.disconnected || !window.speechSynthesis) {
        resolve();
        return;
      }
      const utter = new SpeechSynthesisUtterance(text);
      const voice =
        this.voices.find((v) => v.lang === "en-US") ||
        this.voices.find((v) => v.lang.startsWith("en")) ||
        this.voices[0];
      if (voice) utter.voice = voice;
      utter.rate = 1;
      utter.onend = () => resolve();
      utter.onerror = () => resolve();
      window.speechSynthesis.speak(utter);
    });
  }

  private drainQueue(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (!this.speakingSentence && this.speakQueue.length === 0) {
          resolve();
        } else {
          setTimeout(check, 60);
        }
      };
      check();
    });
  }

  sendToolResult(callId: string, result: unknown): void {
    this.messages.push({
      role: "tool",
      tool_call_id: callId,
      content: typeof result === "string" ? result : JSON.stringify(result),
    });
    void this.runAssistantTurn();
  }

  disconnect(): void {
    this.disconnected = true;
    this.listening = false;

    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    this.speakQueue = [];

    try {
      this.processor?.disconnect();
    } catch {
      /* ignore */
    }
    this.processor = null;
    try {
      this.sourceNode?.disconnect();
    } catch {
      /* ignore */
    }
    this.sourceNode = null;

    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;

    try {
      this.audioContext?.close();
    } catch {
      /* ignore */
    }
    this.audioContext = null;

    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }
}

/* ----------------------------- audio helpers ----------------------------- */

function computeRMS(input: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
  return Math.sqrt(sum / input.length);
}

function concatFloat32(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++)
      view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // subchunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}
