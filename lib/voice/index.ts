import { GeminiLiveSession } from "./geminiLive";
import { GroqVoiceSession } from "./groqVoice";
import { OpenAIRealtimeSession } from "./openaiRealtime";
import type {
  VoiceProvider,
  VoiceSession,
  VoiceSessionCallbacks,
  VoiceSetupPayload,
} from "./types";

export { DEFAULT_VOICE_PROVIDER, isValidProvider, resolveProvider } from "./config";
export type {
  VoiceProvider,
  VoiceSession,
  VoiceSessionCallbacks,
  VoiceSetupPayload,
} from "./types";

/**
 * Build the right concrete session for a provider. All implementations
 * share the {@link VoiceSession} interface, so callers (the Agent) are
 * fully provider-agnostic after this point.
 */
export function createVoiceSession(
  provider: VoiceProvider,
  payload: VoiceSetupPayload,
  callbacks: VoiceSessionCallbacks
): VoiceSession {
  if (provider === "gemini") {
    return new GeminiLiveSession(payload, callbacks);
  }
  if (provider === "groq") {
    return new GroqVoiceSession(payload, callbacks);
  }
  return new OpenAIRealtimeSession(payload, callbacks);
}
