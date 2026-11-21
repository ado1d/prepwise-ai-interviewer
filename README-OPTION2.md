# Prepwise — Multi Voice Provider (OpenAI Realtime + Gemini Live + Groq)

This fork of [adrianhajdin/ai_mock_interviews](https://github.com/adrianhajdin/ai_mock_interviews) (Prepwise) runs the voice interview on **your own** account and lets you switch between three voice providers at runtime:

| What | Option |
| --- | --- |
| Voice conversation (A) | **OpenAI Realtime API** (`gpt-realtime-2.1-mini`) over WebRTC |
| Voice conversation (B) | **Google Gemini Live API** over WebSocket — free tier, auto-detected model (`gemini-3.8-live` and friends) |
| Voice conversation (C) | **Groq Voice** — free, region-agnostic turn-based pipeline: Groq Whisper (STT) + Groq Llama (LLM) + browser SpeechSynthesis (TTS) |
| Question generation | Any OpenAI chat model via `OPENAI_TEXT_MODEL` (default `gpt-4o-mini`; e.g. `gpt-4o`, `gpt-5-mini`, `gpt-5.6-mini`) |
| Interview feedback | Same `OPENAI_TEXT_MODEL` as above |
| Webhook / public URL needed | No — everything runs in-app, works 100% on localhost |
| Auth & database | Firebase (unchanged) |

You pick the provider on the call screen with a small **OpenAI Realtime / Gemini Live / Groq Voice** toggle, or set a default via `NEXT_PUBLIC_VOICE_PROVIDER`. All three share the same UI, transcript, and feedback flow — only the audio transport differs.

> **Is Gemini really free?** Yes. The Gemini API has a free tier via [Google AI Studio](https://aistudio.google.com/apikey). The Multimodal Live API is available on that free tier (rate-limited). For personal/portfolio interview practice, the free quota is more than enough.
>
> **How is the Live model picked?** `models.list` does **not** include Live models (and truncates at 50 entries by default), so the app probes known Live model names (`gemini-3.8-live`, `gemini-3.1-flash-live-preview`, `gemini-2.5-flash-native-audio-preview-12-2025`, …) with direct `models.get` requests and uses the first one that lists `bidiGenerateContent`. The working model is cached, and if the model rejects the requested voice or the transcription config at setup, the session retries with a degraded config automatically.
>
> **Gemini Live not available in your region?** Google enforces regional restrictions **per IP address** ("User location is not supported for the API use"). If your network is blocked, use the **Groq Voice** provider instead — it's free and region-agnostic.

## What changed vs. the single-provider fork

- `lib/voice/` **(new)** — a provider-agnostic voice layer:
  - `types.ts` — `VoiceSession` interface + callback contract.
  - `config.ts` — resolves the default provider from `NEXT_PUBLIC_VOICE_PROVIDER`.
  - `openaiRealtime.ts` — the existing WebRTC flow, extracted behind the interface.
  - `geminiLive.ts` — a new WebSocket + Web Audio implementation of the Gemini Live API.
  - `index.ts` — `createVoiceSession(provider, payload, callbacks)` factory.
- `app/api/realtime-session/route.ts` — now branches by provider. For OpenAI it still mints an ephemeral Realtime token (key stays server-side). For Gemini it prepares the instructions / voice / tools and returns them; the browser opens the Live WebSocket itself.
- `components/Agent.tsx` — rewritten to talk to a `VoiceSession` instead of OpenAI directly, and adds the in-call provider toggle (persisted to `localStorage`).
- `constants/index.ts` — interviewer/designer configs gained a `geminiVoice` field.
- Question generation (`app/api/interviews/route.ts`) and feedback (`lib/actions/general.action.ts`) are **unchanged** — they still use `gpt-4o-mini`.

## How the three providers differ

| | OpenAI Realtime | Gemini Live | Groq Voice |
| --- | --- | --- | --- |
| Transport | WebRTC (`RTCPeerConnection`) | WebSocket (base64 PCM audio) | HTTP: mic WAV -> `/api/groq-voice/*` -> SpeechSynthesis |
| Key handling | Server-side; browser gets ephemeral token | Client-side `NEXT_PUBLIC_GEMINI_API_KEY` | Server-side `GROQ_API_KEY` (proxied via Next.js routes) |
| Cost | ~$0.02–0.05/min on the mini model | Free tier (rate-limited) | Free tier (rate-limited) |
| Quality | State-of-the-art natural conversation | Very good; slightly behind OpenAI on nuanced technical follow-ups | Good; Llama-3.3-70B reasoning, browser-TTS voice quality varies by OS |
| Latency | ~300–500ms | ~500–700ms | ~1–2s per turn (turn-based, no streaming audio) |
| Region | Global | Per-IP region check on the Live API | Global |
| Interruption | Yes (server VAD) | Yes (server VAD) | No (turn-based — wait for the assistant to finish) |
| Voice name | `sage` | `Aoede` / `Puck` | Browser system voice (auto-picked English voice) |

All three support transcripts for the feedback page and the `createInterview` function call in the voice-setup flow. **If Gemini Live isn't available in your region, Groq Voice is the recommended free alternative.**

## Setup

### 0. Before anything: revoke exposed keys

If you ever pasted an API key or GitHub token into a chat (including with an AI), treat it as leaked and revoke it:
- OpenAI: https://platform.openai.com/api-keys → delete the old key
- Google: https://aistudio.google.com/apikey → delete the old key
- GitHub: https://github.com/settings/tokens → delete the old token

Then create **fresh** keys below. Never reuse or share keys.

### 1. Get the code

This zip is the **complete project** with both providers wired up. Extract it:

- **Windows**: right-click the zip → *Extract All…* → open the extracted folder
- **macOS / Linux**: `unzip prepwise-dual-voice.zip && cd prepwise-ai-interviewer`

### 2. Configure Firebase (skip if you already have it)

1. https://console.firebase.google.com → **Add project** (free Spark plan is fine).
2. **Build → Authentication → Get started → Email/Password → Enable.**
3. **Build → Firestore Database → Create database** → start in **test mode** (or set rules to allow read/write for the `users`, `interviews`, `feedback` collections).
4. **Project settings (⚙) → General → Your apps → Web (</>)** → copy the config values → these are the `NEXT_PUBLIC_FIREBASE_*` vars.
5. **Project settings → Service accounts → Generate new private key** → open the JSON → these are the `FIREBASE_*` vars (`project_id`, `client_email`, `private_key`).

### 3. Get your voice provider key(s)

You need **at least one** of the following. Get whichever you plan to use.

**OpenAI** (paid, ~$0.20–0.60 per 10-minute interview):
1. https://platform.openai.com/api-keys → **Create new secret key**.
2. Recommended: set a monthly spend limit in the OpenAI dashboard.

**Gemini** (free tier; Live availability is checked per IP region):
1. https://aistudio.google.com/apikey → **Create API key**.
2. In Google Cloud Console, **restrict the key** to the **Generative Language API**.
3. Keep the project on the free tier (no billing enabled) so a leak can't cost anything.
4. Optional sanity check that your key + network can reach a Live model. **Important:** don't test with `models.list` — it omits Live models entirely. Probe a known Live model directly and check for `bidiGenerateContent`:
   ```bash
   curl -s "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-live?key=YOUR_KEY"
   ```
   If the response shows `"supportedGenerationMethods": ["bidiGenerateContent"]`, Live works from your network. If you get `"User location is not supported"`, use **Groq Voice** instead.

**Groq** (free tier, region-agnostic — recommended if Gemini Live isn't available):
1. https://console.groq.com/keys → **Create API key** (starts with `gsk_`).
2. That's it — put it in `GROQ_API_KEY` (server-side; do NOT prefix with `NEXT_PUBLIC_`).

### 4. Set up `.env.local`

```bash
cp .env.local.example .env.local
```

Fill it in (you only need the keys for the provider(s) you plan to use):

```env
# Default provider shown first on the call screen. Values: openai | gemini
NEXT_PUBLIC_VOICE_PROVIDER=openai

# --- OpenAI (required if you use OpenAI Realtime) ---
OPENAI_API_KEY=sk-proj-...
# Voice model (realtime interviewer):
# OPENAI_REALTIME_MODEL=gpt-realtime-2.1-mini
# Transcription model (your speech -> text for the feedback page):
# OPENAI_TRANSCRIBE_MODEL=gpt-transcribe
# Text model for question generation + feedback. Set to ANY chat model your
# account supports to upgrade from the default:
#   gpt-4o-mini (default), gpt-4o, gpt-5-mini, gpt-5.6-mini, ...
OPENAI_TEXT_MODEL=gpt-4o-mini

# --- Gemini (required if you use Gemini Live) ---
NEXT_PUBLIC_GEMINI_API_KEY=AIza...
# NEXT_PUBLIC_GEMINI_LIVE_MODEL=models/gemini-3.8-live   # optional; auto-detected by default

# --- Groq (required if you use Groq Voice) — free, region-agnostic ---
# Get a key: https://console.groq.com/keys  (stays server-side)
GROQ_API_KEY=gsk_...
# GROQ_LLM_MODEL=llama-3.3-70b-versatile
# GROQ_STT_MODEL=whisper-large-v3

# --- Firebase ---
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=...
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...
FIREBASE_PROJECT_ID=...
FIREBASE_CLIENT_EMAIL=...
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n"
```

Notes:
- `FIREBASE_PRIVATE_KEY` must stay on **one line**, with `\n` where the real key has line breaks.
- `NEXT_PUBLIC_VOICE_PROVIDER` only sets the **initial** selection — you can still switch on the call screen at any time, and your choice is remembered in `localStorage`.
- If you only configured one provider, just leave the toggle on it.

### 5. Install & run

```bash
npm install
npm run dev
```

Open http://localhost:3000 (use Chrome). Sign up with email/password, then:

1. **Start an Interview** → pick a provider on the call screen → **Call** → talk to Nexa: tell it the role, level, type, tech stack, number of questions → it creates the interview and takes you to it.
2. On the interview page → pick a provider → **Call** → answer out loud (allow the mic) → **End** when done.
3. You land on the feedback page with scores, strengths and areas to improve.

## Switching providers

- **At runtime:** the segmented control above the Call button. Disabled while a call is in progress (the active call keeps its provider until you hang up).
- **Default:** set `NEXT_PUBLIC_VOICE_PROVIDER=openai` (or `gemini`) in `.env.local` and restart.
- Your last choice is saved in the browser, so it sticks across sessions.

## Choosing the text model (questions + feedback)

Question generation and feedback analysis use a single OpenAI chat model, configurable via `OPENAI_TEXT_MODEL` (default `gpt-4o-mini`). Set it to **any** chat model your OpenAI account supports when you want to upgrade quality:

```env
# Defaults to gpt-4o-mini. Examples of valid upgrades:
OPENAI_TEXT_MODEL=gpt-4o          # smarter, ~15x the cost of mini
OPENAI_TEXT_MODEL=gpt-5-mini      # newer mini class (when available on your account)
OPENAI_TEXT_MODEL=gpt-5.6-mini    # any model name your key can access
```

This is independent of the voice provider: you can run voice on Gemini Live (free) while still using an OpenAI text model for questions/feedback. If you get `model_not_found` or a 404, the name isn't available on your account — check https://developers.openai.com/api/docs/models for valid IDs and restart `npm run dev`.

## Cost cheat-sheet (approx.)

- **OpenAI Realtime** voice: ~$0.02–0.05/min on `gpt-realtime-2.1-mini` (+ ~$0.017/min for speech transcription). A 10-minute mock interview ≈ $0.20–0.60.
- **Gemini Live** voice: $0 on the free tier (rate-limited).
- Questions + feedback (`OPENAI_TEXT_MODEL`, default `gpt-4o-mini`, both voice providers): less than $0.01 per interview on the mini; scales with whatever model you pick.
- Billing stops the moment you press **End**.

> If your only goal is to avoid OpenAI voice costs, set `NEXT_PUBLIC_VOICE_PROVIDER=gemini`, add `NEXT_PUBLIC_GEMINI_API_KEY`, and leave `OPENAI_API_KEY` set too — question/feedback generation still uses OpenAI (`OPENAI_TEXT_MODEL`, default `gpt-4o-mini`, <$0.01/interview). The text path is OpenAI-only in this build; a Gemini text swap is not included.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `Missing NEXT_PUBLIC_GEMINI_API_KEY` | Add it to `.env.local` and restart, or switch the call-screen toggle back to OpenAI. |
| Gemini: no sound from the interviewer | Click the Call button (a user gesture is required to start audio). Make sure the tab isn't muted. |
| Gemini: `connection error` / closes immediately | Check the key is valid and not restricted away from the Generative Language API. Check the free-tier rate limit in AI Studio. |
| Gemini: chipmunk / wrong-speed audio | Rare; means the browser ignored the 24 kHz output rate. Web Audio resamples on playback, so this shouldn't happen — if it does, update Chrome. |
| OpenAI: `Invalid URL (POST /v1/realtime/sessions)` | You are running old beta code — this fork uses the GA endpoints (`/v1/realtime/client_secrets` + `/v1/realtime/calls`). Re-copy the current files. |
| OpenAI: "The model ... was rejected" | Set `OPENAI_REALTIME_MODEL` in `.env.local` to a currently available Realtime model and restart. |
| OpenAI: 401 / "Failed to start the session" | Check `OPENAI_API_KEY` and that billing is active. |
| Microphone error | Click the lock icon next to the address bar → allow microphone → reload. |
| Firestore `permission-denied` | Firestore → Rules → allow reads/writes (test mode) for `users`, `interviews`, `feedback`. |

## Security notes

- `.env.local` is git-ignored; never commit it, never paste its contents anywhere.
- **OpenAI:** the browser never sees your real key — only short-lived ephemeral Realtime tokens minted by `/api/realtime-session`, which requires a logged-in Firebase session.
- **Gemini:** Google AI Studio keys are designed for client-side use, so `NEXT_PUBLIC_GEMINI_API_KEY` ships to the browser. Restrict the key to the Generative Language API and keep the project on the free tier so a leak can't cost money. If a key leaks, revoke it at https://aistudio.google.com/apikey immediately.
- **Groq:** the `GROQ_API_KEY` stays server-side (never `NEXT_PUBLIC_*`); the browser only ever calls your own `/api/groq-voice/*` routes. If a key leaks, revoke it at https://console.groq.com/keys.
