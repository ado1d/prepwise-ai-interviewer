import type {
  VoiceSession,
  VoiceSessionCallbacks,
  VoiceSetupPayload,
} from "./types";

/**
 * Gemini Live API (Multimodal Live / BidiGenerateContent) voice session.
 *
 * Unlike OpenAI Realtime (WebRTC), Gemini Live streams bidirectional audio
 * over a plain WebSocket:
 *   - Mic audio is captured at 16 kHz, encoded as little-endian PCM 16-bit,
 *     base64'd, and sent as `realtime_input.audio` (the current input
 *     format; the legacy `media_chunks` field is deprecated and newer
 *     models reject it with INVALID_ARGUMENT).
 *   - Assistant audio arrives as base64 PCM (rate parsed from the chunk's
 *     mime type, 24 kHz by default) and is scheduled on a Web Audio graph
 *     for gapless playback.
 *   - Transcripts arrive as incremental deltas on each turn and are flushed
 *     to the UI when `turnComplete` is signalled.
 *   - Function calls (the createInterview tool) arrive as `toolCall` and are
 *     answered with `toolResponse`.
 *
 * Model selection: `models.list` does NOT reliably include Live models (it
 * truncates at 50 entries by default and omits the bidi models entirely on
 * some accounts), so each candidate is verified with a direct `models.get`
 * request and must list "bidiGenerateContent" in supportedGenerationMethods.
 * The first capable model wins; the resolved name is cached in localStorage
 * so subsequent sessions need a single verification request.
 *
 * Setup fallbacks (the exact schema accepted by newer Live models can't
 * always be predicted, so the client degrades gracefully):
 *   1. If the requested prebuilt voice is rejected, retry with the model's
 *      default voice.
 *   2. If the transcription config is rejected, retry without it.
 *   3. If a model is rejected at setup, advance to the next capable one.
 *
 * The API key is read from `NEXT_PUBLIC_GEMINI_API_KEY`. Google AI Studio
 * keys are designed for client-side use; restrict yours to the Generative
 * Language API and keep it on the free tier.
 */

const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;
const REST_BASE = "https://generativelanguage.googleapis.com/v1beta";
const WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const MODEL_CACHE_KEY = "prepwise:gemini-live-model:v2";

/**
 * Live-capable model candidates, newest first. Each is verified with a
 * direct models.get call before use, so stale entries are simply skipped.
 */
const LIVE_MODEL_CANDIDATES = [
  "models/gemini-3.8-live",
  "models/gemini-3.1-flash-live-preview",
  "models/gemini-2.5-flash-native-audio-preview-12-2025",
  "models/gemini-omni-1.2-flash",
  "models/gemini-omni-1.1-flash",
  "models/gemini-omni-flash-preview",
  "models/gemini-live-2.5-flash-preview",
  "models/gemini-2.5-flash-preview-native-audio-dialog",
  "models/gemini-2.0-flash-live-001",
];

interface GeminiModelInfo {
  name?: string;
  supportedGenerationMethods?: string[];
}

// Minimal shapes of the server messages we care about (kept loose because
// the protocol uses camelCase JSON that occasionally also accepts snake_case).
interface GeminiPart {
  text?: string;
  inlineData?: { data?: string; mimeType?: string; mime_type?: string };
  inline_data?: { data?: string; mimeType?: string; mime_type?: string };
}

interface GeminiServerContent {
  modelTurn?: { parts?: GeminiPart[] };
  inputTranscription?: { text?: string };
  outputTranscription?: { text?: string };
  interrupted?: boolean;
  turnComplete?: boolean;
}

interface GeminiToolCall {
  functionCalls?: { id?: string; name: string; args?: unknown }[];
}

interface GeminiToolCallCancellation {
  ids?: string[];
}

interface GeminiServerMessage {
  setupComplete?: unknown;
  serverContent?: GeminiServerContent;
  toolCall?: GeminiToolCall;
  toolCallCancellation?: GeminiToolCallCancellation;
  error?: { message?: string };
}

export class GeminiLiveSession implements VoiceSession {
  private payload: VoiceSetupPayload;
  private cb: VoiceSessionCallbacks;
  private apiKey: string;
  private model = "";

  private ws: WebSocket | null = null;
  private inCtx: AudioContext | null = null;
  private outCtx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;

  // Accumulated transcript deltas for the current turn.
  private turnInput = "";
  private turnOutput = "";
  private turnSpeaking = false;

  // True once the server confirms setup; mic audio is only sent after this.
  private ready = false;

  // Last error frame the server sent (if any), surfaced in the close message.
  private lastServerError = "";

  // Function-call ids cancelled by the server (e.g. the user interrupted);
  // responding to them is an error, so they are skipped.
  private cancelledCalls = new Set<string>();

  // Model resolution state (probe results + setup-time fallbacks).
  private probeCache = new Map<string, boolean>();
  private lastProbeError = "";
  private untriedCandidates: string[] = [];
  private triedModels = new Set<string>();

  // Resolves the current connect attempt once the server confirms setup.
  private attemptResolve: (() => void) | null = null;
  private attemptReject: ((error: Error) => void) | null = null;

  // Playback scheduling.
  private nextPlayTime = 0;
  private activeSources: AudioBufferSourceNode[] = [];

  constructor(payload: VoiceSetupPayload, cb: VoiceSessionCallbacks) {
    this.payload = payload;
    this.cb = cb;
    this.apiKey = (process.env.NEXT_PUBLIC_GEMINI_API_KEY || "").trim();

    if (!this.apiKey) {
      throw new Error(
        "Missing NEXT_PUBLIC_GEMINI_API_KEY. Create a free key at https://aistudio.google.com/apikey and add it to .env.local."
      );
    }
  }

  async connect(): Promise<void> {
    // 0. Validate the API key AND auto-select a Live-capable model. Done
    //    before requesting the mic so a failure never triggers a
    //    microphone permission prompt.
    const resolution = await this.resolveLiveModel();
    this.model = resolution.model;
    this.triedModels = new Set([resolution.model]);
    this.untriedCandidates = resolution.remaining;

    // 1. Microphone
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });

    // 2. Input graph at 16 kHz (browser resamples the mic to the context rate;
    //    if it ignores the requested rate we downsample manually below).
    const Ctx: typeof AudioContext =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;

    this.inCtx = new Ctx({ sampleRate: INPUT_RATE });
    await this.inCtx.resume?.();

    this.sourceNode = this.inCtx.createMediaStreamSource(this.micStream);
    // ScriptProcessor is deprecated but universally supported and simplest
    // for capturing mic frames; AudioWorklet would require a separate
    // publicly-served worklet module.
    this.processor = this.inCtx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (event) => {
      // Zero the output so the mic is NOT echoed back through the speakers
      // (the ScriptProcessor must be connected to a destination to fire, but
      // we don't want to hear the input).
      event.outputBuffer.getChannelData(0).fill(0);
      if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      const raw = event.inputBuffer.getChannelData(0);
      const rate = this.inCtx?.sampleRate ?? INPUT_RATE;
      const pcm = rate === INPUT_RATE ? raw : downsample(raw, rate, INPUT_RATE);
      // Current Live API input format: realtime_input.audio (the legacy
      // realtime_input.media_chunks field is deprecated and rejected by
      // newer models like gemini-3.8-live with INVALID_ARGUMENT).
      this.ws.send(
        JSON.stringify({
          realtime_input: {
            audio: {
              data: float32ToInt16Base64(pcm),
              mimeType: `audio/pcm;rate=${INPUT_RATE}`,
            },
          },
        })
      );
    };
    // ScriptProcessor only fires when connected to a destination node.
    this.sourceNode.connect(this.processor);
    this.processor.connect(this.inCtx.destination);

    // 3. Output graph (default rate; AudioBuffers are created at the rate
    //    announced by the server and the browser resamples them on playback).
    this.outCtx = new Ctx();
    await this.outCtx.resume?.();
    this.nextPlayTime = this.outCtx.currentTime;

    // 4. Connect, degrading the setup config if the model rejects part of
    //    it. Each attempt is a fresh WebSocket; the mic graph is reused.
    let useVoice = true;
    let useTranscription = true;
    let lastError: Error | null = null;

    try {
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          await this.openSocket(this.model, useVoice, useTranscription);
          this.cacheModel(this.model);
          if (!useTranscription) {
            console.warn(
              "[gemini-live] running without transcripts — the model rejected the transcription config, so the feedback page may be incomplete."
            );
          }
          return;
        } catch (error) {
          lastError =
            error instanceof Error ? error : new Error(String(error));
          const message = lastError.message.toLowerCase();

          // Regional blocks and quota errors cannot be fixed by degrading
          // the config — surface them immediately with clear guidance.
          if (message.includes("location")) {
            throw new Error(
              "Gemini Live is not available from your current network location — Google enforces regional restrictions per IP address. " +
                "Switch to the Groq Voice provider on the call screen (free, region-agnostic), or retry from a supported network. " +
                `Google said: "${lastError.message}"`
            );
          }
          if (/quota|resource|rate limit|too many requests/.test(message)) {
            throw new Error(
              "Gemini Live free-tier quota or rate limit reached. Wait about a minute and try again, or switch to another voice provider on the call screen. " +
                `Google said: "${lastError.message}"`
            );
          }
          if (message.includes("voice")) {
            useVoice = false;
            continue;
          }
          if (message.includes("transcri")) {
            useTranscription = false;
            continue;
          }
          if (/model|not found|not supported|unsupported|deprecated/.test(message)) {
            const next = await this.nextCapableModel();
            if (next) {
              this.model = next;
              useVoice = true;
              useTranscription = true;
              continue;
            }
          }
          throw lastError;
        }
      }
      throw lastError ?? new Error("Gemini Live setup failed");
    } catch (error) {
      this.disconnect();
      throw error;
    }
  }

  /* ------------------------- model resolution ------------------------- */

  /**
   * Validate the key via models.list (following pagination — Live models
   * are usually absent from the list, but it proves the key works and may
   * surface capable models we don't know about).
   */
  private async fetchModelList(): Promise<GeminiModelInfo[]> {
    const models: GeminiModelInfo[] = [];
    let pageToken = "";
    for (let page = 0; page < 5; page++) {
      const url = new URL(`${REST_BASE}/models`);
      url.searchParams.set("key", this.apiKey);
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const response = await fetch(url, { method: "GET" });
      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const body = (await response.json()) as {
            error?: { message?: string };
          };
          if (body?.error?.message) detail = body.error.message;
        } catch {
          /* keep the HTTP status */
        }
        if (/location/i.test(detail)) {
          throw new Error(
            `Gemini API is blocked from your current network location — Google enforces regional restrictions per IP address. ` +
              `Google said: "${detail}". ` +
              `Use the Groq Voice provider instead (free, region-agnostic) or retry from a supported network.`
          );
        }
        throw new Error(
          `Gemini API key check failed: ${detail}. Make sure NEXT_PUBLIC_GEMINI_API_KEY is a valid AI Studio key from https://aistudio.google.com/apikey and that the Generative Language API is enabled on the project.`
        );
      }

      const body = (await response.json()) as {
        models?: GeminiModelInfo[];
        nextPageToken?: string;
      };
      models.push(...(body.models ?? []));
      if (!body.nextPageToken) break;
      pageToken = body.nextPageToken;
    }
    return models;
  }

  /**
   * Check whether a model exists on this key AND supports
   * bidiGenerateContent, via a direct models.get request (models.list
   * cannot be trusted to include Live models).
   */
  private async isLiveCapable(name: string): Promise<boolean> {
    const normalized = normalizeModelName(name);
    if (!normalized) return false;
    if (this.probeCache.has(normalized)) {
      return this.probeCache.get(normalized) === true;
    }

    let capable = false;
    try {
      const response = await fetch(
        `${REST_BASE}/models/${encodeURIComponent(
          normalized.slice("models/".length)
        )}?key=${encodeURIComponent(this.apiKey)}`,
        { method: "GET" }
      );
      if (response.ok) {
        const info = (await response.json()) as GeminiModelInfo;
        capable =
          info.supportedGenerationMethods?.includes("bidiGenerateContent") ??
          false;
      } else {
        try {
          const body = (await response.json()) as {
            error?: { message?: string };
          };
          if (body?.error?.message) this.lastProbeError = body.error.message;
        } catch {
          /* ignore */
        }
      }
    } catch {
      capable = false;
    }
    this.probeCache.set(normalized, capable);
    return capable;
  }

  /**
   * Pick the first Live-capable model, in priority order:
   *   explicit NEXT_PUBLIC_GEMINI_LIVE_MODEL (or the server payload model)
   *   > last model that worked (localStorage)
   * > known candidates > anything bidi-capable found in models.list.
   */
  private async resolveLiveModel(): Promise<{
    model: string;
    remaining: string[];
  }> {
    const listed = await this.fetchModelList();
    const bidiFromList = listed
      .filter((m) => m.supportedGenerationMethods?.includes("bidiGenerateContent"))
      .map((m) => normalizeModelName(m.name ?? ""))
      .filter((name) => name.length > 0);

    const configured = (
      process.env.NEXT_PUBLIC_GEMINI_LIVE_MODEL ||
      this.payload.model ||
      ""
    ).trim();
    let cached = "";
    try {
      cached = localStorage.getItem(MODEL_CACHE_KEY) ?? "";
    } catch {
      /* private browsing */
    }

    const queue: string[] = [];
    for (const candidate of [
      configured,
      cached,
      ...LIVE_MODEL_CANDIDATES,
      ...bidiFromList,
    ]) {
      const normalized = normalizeModelName(candidate);
      if (normalized && !queue.includes(normalized)) queue.push(normalized);
    }

    let resolved = "";
    for (const candidate of queue) {
      // Sequential by design: stop at the first capable model.
      if (await this.isLiveCapable(candidate)) {
        resolved = candidate;
        break;
      }
    }

    if (!resolved) {
      const extra = this.lastProbeError
        ? ` Last Google response: "${this.lastProbeError}".`
        : "";
      throw new Error(
        `No Live-capable Gemini model is accessible with this API key. Checked directly: ${queue
          .slice(0, 12)
          .join(", ")}.${extra} ` +
          "If Google blocks the Live API from your region you will see a \"User location\" error instead. " +
          "You can force a specific model with NEXT_PUBLIC_GEMINI_LIVE_MODEL (it must list bidiGenerateContent)."
      );
    }

    if (configured && normalizeModelName(configured) !== resolved) {
      console.warn(
        `[gemini-live] NEXT_PUBLIC_GEMINI_LIVE_MODEL="${configured}" is not Live-capable on this key; using auto-detected "${resolved}".`
      );
    }

    const index = queue.indexOf(resolved);
    return { model: resolved, remaining: queue.slice(index + 1) };
  }

  /** Next setup-time fallback: the first untried candidate that is capable. */
  private async nextCapableModel(): Promise<string> {
    while (this.untriedCandidates.length > 0) {
      const candidate = this.untriedCandidates.shift();
      if (!candidate) break;
      const normalized = normalizeModelName(candidate);
      if (!normalized || this.triedModels.has(normalized)) continue;
      if (await this.isLiveCapable(normalized)) return normalized;
    }
    return "";
  }

  private cacheModel(model: string) {
    try {
      localStorage.setItem(MODEL_CACHE_KEY, model);
    } catch {
      /* private browsing */
    }
  }

  /* ---------------------------- connection ---------------------------- */

  /**
   * Open a WebSocket and resolve once the server confirms the setup.
   * Rejects (with Google's message when available) if the socket closes or
   * errors before setup completes, so connect() can retry with a degraded
   * configuration.
   */
  private openSocket(
    model: string,
    useVoice: boolean,
    useTranscription: boolean
  ): Promise<void> {
    this.triedModels.add(model);
    return new Promise<void>((resolve, reject) => {
      this.attemptResolve = resolve;
      this.attemptReject = reject;
      this.lastServerError = "";

      const ws = new WebSocket(
        `${WS_BASE}?key=${encodeURIComponent(this.apiKey)}`
      );
      this.ws = ws;
      ws.onopen = () => this.sendSetup(model, useVoice, useTranscription);
      ws.onmessage = (event) => {
        void this.handleMessage(event);
      };
      ws.onerror = () => {
        /* the close event carries the diagnosis */
      };
      ws.onclose = (event) => {
        if (this.ws === ws) this.ws = null;
        if (this.ready) {
          const reason = event.reason ? ` — ${event.reason}` : "";
          this.cb.onError(
            `Gemini Live connection dropped (code ${event.code})${reason}`
          );
          return;
        }
        const rejectAttempt = this.attemptReject;
        this.attemptReject = null;
        this.attemptResolve = null;
        if (!rejectAttempt) return;

        const reason = event.reason ? ` — ${event.reason}` : "";
        const serverError = this.lastServerError
          ? ` Server reported: "${this.lastServerError}".`
          : "";
        rejectAttempt(
          new Error(
            `Gemini Live connection closed before setup completed (code ${event.code})${reason}.${serverError} ` +
              "A close without a server message usually means the WebSocket handshake was rejected (regional block, invalid key, or exhausted quota); the browser cannot read the HTTP error body of a failed WS upgrade."
          )
        );
      };
    });
  }

  private sendSetup(
    model: string,
    useVoice: boolean,
    useTranscription: boolean
  ) {
    const generationConfig: Record<string, unknown> = {
      response_modalities: ["AUDIO"],
    };
    if (useVoice) {
      generationConfig.speech_config = {
        voice_config: {
          prebuilt_voice_config: {
            voice_name: this.payload.voice || "Aoede",
          },
        },
      };
    }

    const setup: Record<string, unknown> = {
      model,
      generation_config: generationConfig,
      system_instruction: {
        parts: [{ text: this.payload.instructions || "" }],
      },
    };
    if (useTranscription) {
      setup.input_audio_transcription = {};
      setup.output_audio_transcription = {};
    }
    if (this.payload.tools) {
      setup.tools = [this.payload.tools];
    }

    this.ws?.send(JSON.stringify({ setup }));
  }

  /**
   * Gemini Live does not auto-greet on setup (unlike OpenAI Realtime's
   * `response.create`). We send a minimal text turn to trigger the assistant's
   * opening message, which the system instruction tells it to deliver.
   */
  private sendStartSignal() {
    this.ws?.send(
      JSON.stringify({
        client_content: {
          turns: [
            {
              // Explicit roles are required by newer Live models
              // (gemini-3.8-live rejects role-less turns).
              role: "user",
              parts: [
                {
                  text: "(Session started. Deliver your opening message now, exactly as instructed, then wait for the candidate.)",
                },
              ],
            },
          ],
          turn_complete: true,
        },
      })
    );
  }

  private async handleMessage(event: MessageEvent) {
    let raw: string;
    if (typeof event.data === "string") {
      raw = event.data;
    } else if (event.data instanceof Blob) {
      raw = await event.data.text();
    } else {
      return;
    }

    let data: GeminiServerMessage;
    try {
      data = JSON.parse(raw) as GeminiServerMessage;
    } catch {
      return;
    }

    if (data.setupComplete) {
      this.ready = true;
      const resolveAttempt = this.attemptResolve;
      this.attemptResolve = null;
      this.attemptReject = null;
      this.cb.onReady?.();
      this.sendStartSignal();
      resolveAttempt?.();
      return;
    }

    if (data.error) {
      this.lastServerError = data.error.message ?? "Gemini Live error";
      const rejectAttempt = this.attemptReject;
      if (!this.ready && rejectAttempt) {
        this.attemptReject = null;
        this.attemptResolve = null;
        try {
          this.ws?.close();
        } catch {
          /* ignore */
        }
        rejectAttempt(new Error(this.lastServerError));
      } else {
        this.cb.onError(this.lastServerError);
      }
      return;
    }

    const sc = data.serverContent;
    if (sc) {
      if (sc.interrupted) {
        this.cb.onInterrupted();
        this.stopPlayback();
      }

      const parts = sc.modelTurn?.parts ?? [];
      for (const part of parts) {
        const inline = part.inlineData ?? part.inline_data;
        if (inline?.data) {
          this.playAudio(
            inline.data,
            inline.mimeType ?? inline.mime_type
          );
          if (!this.turnSpeaking) {
            this.turnSpeaking = true;
            this.cb.onSpeakingStart();
          }
        }
        if (part.text) {
          this.turnOutput += part.text;
        }
      }

      if (sc.inputTranscription?.text) {
        this.turnInput += sc.inputTranscription.text;
      }
      if (sc.outputTranscription?.text) {
        this.turnOutput += sc.outputTranscription.text;
      }

      if (sc.turnComplete) {
        if (this.turnInput.trim()) this.cb.onUserMessage(this.turnInput.trim());
        if (this.turnOutput.trim())
          this.cb.onAssistantMessage(this.turnOutput.trim());
        this.turnInput = "";
        this.turnOutput = "";
        if (this.turnSpeaking) {
          this.turnSpeaking = false;
        }
        this.cb.onSpeakingEnd();
      }
    }

    if (data.toolCall?.functionCalls) {
      for (const call of data.toolCall.functionCalls) {
        const args =
          typeof call.args === "string"
            ? call.args
            : JSON.stringify(call.args ?? {});
        this.cb.onFunctionCall(call.name, args, call.id);
      }
    }

    if (data.toolCallCancellation?.ids) {
      for (const id of data.toolCallCancellation.ids) {
        this.cancelledCalls.add(id);
      }
    }
  }

  private playAudio(base64: string, mimeType?: string) {
    if (!this.outCtx) return;
    const bytes = base64ToBytes(base64);
    const float32 = int16BytesToFloat32(bytes);
    // The server announces the sample rate in the chunk's mime type
    // (e.g. "audio/pcm;rate=24000"); trust it instead of assuming 24 kHz.
    const rateMatch = /rate=(\d+)/.exec(mimeType ?? "");
    const rate = rateMatch ? parseInt(rateMatch[1], 10) : OUTPUT_RATE;
    if (!Number.isFinite(rate) || rate <= 0) return;
    const buffer = this.outCtx.createBuffer(1, float32.length, rate);
    buffer.copyToChannel(float32, 0);
    const src = this.outCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.outCtx.destination);
    const startAt = Math.max(this.outCtx.currentTime, this.nextPlayTime);
    src.start(startAt);
    this.nextPlayTime = startAt + buffer.duration;
    this.activeSources.push(src);
    src.onended = () => {
      this.activeSources = this.activeSources.filter((s) => s !== src);
    };
  }

  private stopPlayback() {
    for (const s of this.activeSources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.activeSources = [];
    if (this.outCtx) this.nextPlayTime = this.outCtx.currentTime;
  }

  sendToolResult(callId: string, result: unknown): void {
    // The server may cancel a call (e.g. on interruption); answering a
    // cancelled call is rejected with an invalid-argument error.
    if (callId && this.cancelledCalls.has(callId)) {
      this.cancelledCalls.delete(callId);
      return;
    }
    const parsed =
      typeof result === "string" ? safeParse(result) : { result };
    this.ws?.send(
      JSON.stringify({
        toolResponse: {
          functionResponses: [
            {
              id: callId,
              name: "createInterview",
              response: parsed,
            },
          ],
        },
      })
    );
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.ready = false;
    this.attemptResolve = null;
    this.attemptReject = null;

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

    this.stopPlayback();

    try {
      this.inCtx?.close();
    } catch {
      /* ignore */
    }
    this.inCtx = null;

    try {
      this.outCtx?.close();
    } catch {
      /* ignore */
    }
    this.outCtx = null;
  }
}

/* ----------------------------- audio helpers ----------------------------- */

function normalizeModelName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("models/") ? trimmed : `models/${trimmed}`;
}

function downsample(
  input: Float32Array,
  fromRate: number,
  toRate: number
): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      sum += input[j];
      count++;
    }
    out[i] = count ? sum / count : 0;
  }
  return out;
}

function float32ToInt16Base64(input: Float32Array): string {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(out.buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function int16BytesToFloat32(bytes: Uint8Array): Float32Array {
  const count = Math.floor(bytes.length / 2);
  const out = new Float32Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i++) {
    out[i] = view.getInt16(i * 2, true) / 0x8000;
  }
  return out;
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return { result: value };
  }
}
