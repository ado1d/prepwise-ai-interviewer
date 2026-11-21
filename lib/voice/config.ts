import type { VoiceProvider } from "./types";

/**
 * Default voice provider, resolved at build time from
 * `NEXT_PUBLIC_VOICE_PROVIDER`. The user can still switch providers
 * on the call screen at runtime; this only picks the initial selection.
 *
 * Values: "openai" (default) | "gemini" | "groq"
 */
const ENV_PROVIDER = (process.env.NEXT_PUBLIC_VOICE_PROVIDER || "openai")
  .trim()
  .toLowerCase();

export const DEFAULT_VOICE_PROVIDER: VoiceProvider =
  ENV_PROVIDER === "gemini"
    ? "gemini"
    : ENV_PROVIDER === "groq"
      ? "groq"
      : "openai";

export function isValidProvider(
  value: string | undefined | null
): value is VoiceProvider {
  return value === "openai" || value === "gemini" || value === "groq";
}

/**
 * Coerce an arbitrary string (e.g. from a request body or localStorage)
 * into a valid provider, falling back to the env default.
 */
export function resolveProvider(
  value: string | undefined | null
): VoiceProvider {
  return isValidProvider(value) ? value : DEFAULT_VOICE_PROVIDER;
}
