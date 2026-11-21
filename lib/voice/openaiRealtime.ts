import type {
  VoiceSession,
  VoiceSessionCallbacks,
  VoiceSetupPayload,
} from "./types";

/**
 * Events received over the OpenAI Realtime data channel (subset we use).
 * Field names cover both the GA API and the retired beta event names.
 */
interface RealtimeEvent {
  type: string;
  transcript?: string;
  name?: string;
  arguments?: string;
  call_id?: string;
  item?: {
    type?: string;
    name?: string;
    arguments?: string;
    call_id?: string;
  };
  error?: { message?: string } | string;
}

/**
 * OpenAI Realtime API voice session over WebRTC.
 *
 * This is a direct port of the original inline implementation in
 * `components/Agent.tsx`, extracted behind the {@link VoiceSession}
 * interface so the Agent does not care which provider is connected.
 */
export class OpenAIRealtimeSession implements VoiceSession {
  private payload: VoiceSetupPayload;
  private cb: VoiceSessionCallbacks;

  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private audioEl: HTMLAudioElement | null = null;

  constructor(payload: VoiceSetupPayload, cb: VoiceSessionCallbacks) {
    this.payload = payload;
    this.cb = cb;
  }

  async connect(): Promise<void> {
    const clientSecret = this.payload.clientSecret;
    if (!clientSecret) {
      throw new Error("Missing OpenAI realtime client secret");
    }

    // 1. Microphone
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.stream = stream;

    // 2. Peer connection: send mic audio, receive the assistant's audio
    const pc = new RTCPeerConnection();
    this.pc = pc;

    const audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    audioEl.style.display = "none";
    document.body.appendChild(audioEl);
    this.audioEl = audioEl;

    pc.ontrack = (event) => {
      audioEl.srcObject = event.streams[0];
      audioEl.play().catch(() => {
        /* autoplay can throw if the user hasn't interacted yet */
      });
    };

    stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));

    // 3. Data channel for realtime events (transcripts, function calls)
    const dc = pc.createDataChannel("oai-events");
    this.dc = dc;
    dc.addEventListener("message", (event) => {
      try {
        this.handleEvent(JSON.parse(event.data as string));
      } catch (error) {
        console.error("Failed to parse realtime event:", error);
      }
    });

    pc.onconnectionstatechange = () => {
      if (
        pc.connectionState === "failed" ||
        pc.connectionState === "closed"
      ) {
        this.cb.onError("Voice connection lost");
      }
    };

    // 4. WebRTC handshake with the OpenAI Realtime API (GA endpoint;
    //    the model is already bound to the ephemeral token).
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      body: offer.sdp!,
      headers: {
        Authorization: `Bearer ${clientSecret}`,
        "Content-Type": "application/sdp",
      },
    });

    if (!sdpResponse.ok) {
      throw new Error(`Realtime connection failed: ${await sdpResponse.text()}`);
    }

    const answerSdp = await sdpResponse.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
  }

  private handleEvent(event: RealtimeEvent) {
    switch (event.type) {
      // Connection established -> make the assistant say its greeting
      case "session.created":
        this.send({ type: "response.create" });
        this.cb.onReady?.();
        break;

      // The candidate's speech, transcribed (needed for feedback later)
      case "conversation.item.input_audio_transcription.completed":
      case "conversation.item.input_audio_transcription.done":
        if (event.transcript) this.cb.onUserMessage(event.transcript);
        break;

      // The assistant's speech, transcribed (GA event name + legacy beta name)
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        if (event.transcript) this.cb.onAssistantMessage(event.transcript);
        break;

      // Speaking indicator
      case "response.created":
        this.cb.onSpeakingStart();
        break;
      case "response.done":
        this.cb.onSpeakingEnd();
        break;

      // The candidate starts talking (interrupting the assistant)
      case "input_audio_buffer.speech_started":
        this.cb.onInterrupted();
        break;

      // Function calls from the voice-setup assistant
      case "response.output_item.done":
        if (event.item?.type === "function_call" && event.item.name) {
          this.cb.onFunctionCall(
            event.item.name,
            event.item.arguments || "{}",
            event.item.call_id
          );
        }
        break;
      case "response.function_call_arguments.done":
        if (event.name) {
          this.cb.onFunctionCall(
            event.name,
            event.arguments || "{}",
            event.call_id
          );
        }
        break;

      case "error": {
        const message =
          typeof event.error === "string"
            ? event.error
            : event.error?.message ?? "Realtime error";
        this.cb.onError(message);
        break;
      }
    }
  }

  private send(payload: unknown) {
    if (this.dc && this.dc.readyState === "open") {
      this.dc.send(JSON.stringify(payload));
    }
  }

  sendToolResult(callId: string, result: unknown): void {
    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    });
    this.send({ type: "response.create" });
  }

  disconnect(): void {
    this.dc?.close();
    this.dc = null;

    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;

    if (this.pc) {
      this.pc.ontrack = null;
      this.pc.onconnectionstatechange = null;
      this.pc.close();
      this.pc = null;
    }

    if (this.audioEl) {
      this.audioEl.srcObject = null;
      this.audioEl.remove();
      this.audioEl = null;
    }
  }
}
