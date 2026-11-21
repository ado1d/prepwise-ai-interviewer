import { getCurrentUser } from "@/lib/actions/auth.action";
import { interviewDesigner, interviewer } from "@/constants";
import { resolveProvider } from "@/lib/voice/config";
import type { GeminiFunctionDeclaration, GeminiToolList, VoiceSetupPayload } from "@/lib/voice/types";

// Defaults; override via .env.local if OpenAI renames models.
// GA Realtime API (post-June-2026): ephemeral tokens come from
// POST /v1/realtime/client_secrets, and the session config is nested
// under a top-level "session" object with type: "realtime".
const REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1-mini";
const TRANSCRIBE_MODEL =
  process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-transcribe";

type SessionType = "generate" | "interview";

interface AssistantConfig {
  voice: string;
  geminiVoice: string;
  firstMessage: string;
  systemPrompt: string;
}

function buildInstructions(
  config: AssistantConfig,
  type: SessionType,
  questions: string[]
): string {
  let instructions = config.systemPrompt;

  if (type !== "generate") {
    const questionsBlock = questions.length
      ? questions
          .map((question, index) => `${index + 1}. ${question}`)
          .join("\n")
      : "Ask relevant questions about the candidate's background, skills, and motivation for the role.";

    instructions = `${config.systemPrompt}

QUESTIONS FOR THIS INTERVIEW (ask them one at a time, in this order):
${questionsBlock}`;
  }

  instructions += `

Begin the conversation by saying exactly this first message: "${config.firstMessage}"`;

  return instructions;
}

/**
 * Shared JSON schema for the createInterview function (used by both
 * providers; OpenAI wraps it as a `function` tool, Gemini as a
 * `function_declaration`).
 */
const CREATE_INTERVIEW_PARAMS = {
  type: "object",
  properties: {
    role: {
      type: "string",
      description: "The job role, e.g. Frontend Developer",
    },
    level: {
      type: "string",
      enum: ["Junior", "Mid", "Senior", "Lead"],
    },
    type: {
      type: "string",
      enum: ["Behavioral", "Technical", "Mixed", "Leadership"],
    },
    techstack: {
      type: "array",
      items: { type: "string" },
      description: "Main technologies for the role",
    },
    amount: {
      type: "number",
      description: "Number of questions to prepare (3-10)",
    },
  },
  required: ["role", "level", "type", "amount"],
} as const;

const CREATE_INTERVIEW_DECL: GeminiFunctionDeclaration = {
  name: "createInterview",
  description:
    "Create the mock interview once all details have been collected from the user.",
  parameters: CREATE_INTERVIEW_PARAMS as unknown as Record<string, unknown>,
};

/**
 * Creates a short-lived (ephemeral) OpenAI Realtime session token, OR
 * prepares a Gemini Live setup payload, depending on the requested provider.
 *
 * For OpenAI: the real OPENAI_API_KEY never leaves the server — the browser
 * only receives the ephemeral client secret scoped to the Realtime API.
 *
 * For Gemini: the server prepares the instructions/voice/tools; the browser
 * opens the Live WebSocket itself using NEXT_PUBLIC_GEMINI_API_KEY (Google
 * AI Studio keys support client-side use).
 *
 * For Groq: the server prepares the instructions/tools; the browser runs a
 * turn-based pipeline (VAD -> /api/groq-voice/transcribe -> /api/groq-voice/chat
 * -> SpeechSynthesis). The real GROQ_API_KEY stays server-side.
 */
export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const type: SessionType = body.type === "generate" ? "generate" : "interview";
    const questions: string[] = Array.isArray(body.questions) ? body.questions : [];
    const provider = resolveProvider(body.provider);
    const isGenerate = type === "generate";
    const config: AssistantConfig = isGenerate ? interviewDesigner : interviewer;

    const instructions = buildInstructions(config, type, questions);

    if (provider === "gemini") {
      // The browser auto-detects a Live-capable model (models.list does not
      // include Live models, so each candidate is verified with a direct
      // models.get). Only forward an explicit override here.
      const payload: VoiceSetupPayload = {
        provider: "gemini",
        model: process.env.NEXT_PUBLIC_GEMINI_LIVE_MODEL || undefined,
        instructions,
        voice: config.geminiVoice,
        tools: isGenerate
          ? ({ function_declarations: [CREATE_INTERVIEW_DECL] } satisfies GeminiToolList)
          : undefined,
      };
      return Response.json(payload);
    }

    if (provider === "groq") {
      const payload: VoiceSetupPayload = {
        provider: "groq",
        instructions,
        // Tools use the same function_declarations shape as Gemini; the
        // /api/groq-voice/chat route converts them to the OpenAI tool format
        // Groq expects.
        tools: isGenerate
          ? ({ function_declarations: [CREATE_INTERVIEW_DECL] } satisfies GeminiToolList)
          : undefined,
      };
      return Response.json(payload);
    }

    // --- OpenAI Realtime -------------------------------------------------
    const session: Record<string, unknown> = {
      type: "realtime",
      model: REALTIME_MODEL,
      instructions,
      audio: {
        input: {
          // Transcripts of the candidate's speech are needed for the feedback step.
          transcription: { model: TRANSCRIBE_MODEL },
          // The server decides when the user starts/stops speaking.
          turn_detection: { type: "server_vad" },
        },
        output: {
          voice: config.voice,
        },
      },
    };

    if (isGenerate) {
      session.tools = [
        {
          type: "function",
          name: "createInterview",
          description: CREATE_INTERVIEW_DECL.description,
          parameters: CREATE_INTERVIEW_PARAMS,
        },
      ];
    }

    const response = await fetch(
      "https://api.openai.com/v1/realtime/client_secrets",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ session }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Failed to create realtime session:", errorText);

      let hint = "Check your OPENAI_API_KEY and billing in the server logs.";
      if (errorText.includes("model")) {
        hint = `A model name was rejected (realtime: "${REALTIME_MODEL}", transcription: "${TRANSCRIBE_MODEL}"). Set OPENAI_REALTIME_MODEL / OPENAI_TRANSCRIBE_MODEL in .env.local to valid names from https://developers.openai.com/api/docs/models and restart.`;
      }

      return Response.json({ error: hint }, { status: 500 });
    }

    const data = await response.json();

    // GA returns the ephemeral token at `value`; the retired beta returned
    // `client_secret.value`. Support both so this keeps working either way.
    const clientSecret = data.value ?? data.client_secret?.value;
    if (!clientSecret) {
      console.error(
        "Unexpected client_secrets response shape:",
        JSON.stringify(data).slice(0, 500)
      );
      return Response.json(
        { error: "OpenAI did not return an ephemeral token" },
        { status: 500 }
      );
    }

    const payload: VoiceSetupPayload = {
      provider: "openai",
      clientSecret,
      model: data.session?.model || REALTIME_MODEL,
    };

    return Response.json(payload);
  } catch (error) {
    console.error("Error creating realtime session:", error);
    return Response.json({ error: "Something went wrong" }, { status: 500 });
  }
}
