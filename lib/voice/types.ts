/**
 * Provider-agnostic types for the realtime voice layer.
 *
 * The Agent component talks to a {@link VoiceSession} no matter which
 * backend (OpenAI Realtime or Gemini Live) is actually connected. Each
 * provider implements the same callback contract so the UI logic
 * (transcripts, speaking indicator, interruptions, function calls,
 * feedback generation) stays identical.
 */

export type VoiceProvider = "openai" | "gemini" | "groq";

export interface VoiceSessionConfig {
  type: "generate" | "interview";
  questions?: string[];
}

/**
 * Payload returned by /api/realtime-session.
 *
 * - OpenAI: only `clientSecret` is needed (the browser uses it to do the
 *   WebRTC handshake with OpenAI; the real API key never leaves the server).
 * - Gemini: the server prepares the instructions / voice / tools and sends
 *   them down. The browser opens the Gemini Live WebSocket itself using the
 *   `NEXT_PUBLIC_GEMINI_API_KEY` (Google AI Studio keys are designed for
 *   client-side use; OpenAI keys are not, hence the different models).
 */
export interface VoiceSetupPayload {
  provider: VoiceProvider;
  model?: string;
  instructions?: string;
  voice?: string;
  tools?: GeminiToolList;
  /** OpenAI only */
  clientSecret?: string;
}

/** Gemini tools format: a list of `tools`, each with `function_declarations`. */
export interface GeminiToolList {
  function_declarations: GeminiFunctionDeclaration[];
}

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export interface VoiceSessionCallbacks {
  /** Session is fully established and the assistant has been asked to greet. */
  onReady?: () => void;
  /** Final transcript of the candidate's speech for this turn. */
  onUserMessage: (text: string) => void;
  /** Final transcript of the assistant's speech for this turn. */
  onAssistantMessage: (text: string) => void;
  /** Assistant started producing audio. */
  onSpeakingStart: () => void;
  /** Assistant finished producing audio for this turn. */
  onSpeakingEnd: () => void;
  /** Candidate interrupted the assistant. */
  onInterrupted: () => void;
  /** The model invoked a function (e.g. createInterview). */
  onFunctionCall: (name: string, args: string, callId?: string) => void;
  /** Non-fatal error surfaced to the UI. */
  onError: (message: string) => void;
}

export interface VoiceSession {
  /** Establish the connection. Resolves once the session is ready to talk. */
  connect(): Promise<void>;
  /** Respond to a function call so the model can continue. */
  sendToolResult(callId: string, result: unknown): void;
  /** Tear everything down (WebRTC / WebSocket / mic / audio graphs). */
  disconnect(): void;
}
