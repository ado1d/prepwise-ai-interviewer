import { getCurrentUser } from "@/lib/actions/auth.action";
import { interviewDesigner, interviewer } from "@/constants";

// Defaults; override via .env.local if OpenAI renames models.
// GA Realtime API (post-June-2026): ephemeral tokens come from
// POST /v1/realtime/client_secrets, and the session config is nested
// under a top-level "session" object with type: "realtime".
const REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1-mini";
const TRANSCRIBE_MODEL =
  process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-transcribe";

/**
 * Creates a short-lived (ephemeral) OpenAI Realtime session token.
 *
 * The real OPENAI_API_KEY never leaves the server: the browser only ever
 * receives the ephemeral client secret, which is scoped to the Realtime
 * API and expires a few minutes after the connection is established.
 */
export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { type, questions } = await request.json();
    const isGenerate = type === "generate";
    const config = isGenerate ? interviewDesigner : interviewer;

    // Build the session instructions
    let instructions = config.systemPrompt;

    if (!isGenerate) {
      const questionList: string[] = Array.isArray(questions) ? questions : [];
      const questionsBlock = questionList.length
        ? questionList
            .map((question, index) => `${index + 1}. ${question}`)
            .join("\n")
        : "Ask relevant questions about the candidate's background, skills, and motivation for the role.";

      instructions = `${config.systemPrompt}

QUESTIONS FOR THIS INTERVIEW (ask them one at a time, in this order):
${questionsBlock}`;
    }

    instructions += `

Begin the conversation by saying exactly this first message: "${config.firstMessage}"`;

    // GA session config. Property moves vs. the old beta API:
    //   voice                   -> session.audio.output.voice
    //   input_audio_transcription -> session.audio.input.transcription
    //   turn_detection          -> session.audio.input.turn_detection
    // Docs: https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/methods/create
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

    // For the setup flow, let the model call a function to create the interview.
    if (isGenerate) {
      session.tools = [
        {
          type: "function",
          name: "createInterview",
          description:
            "Create the mock interview once all details have been collected from the user.",
          parameters: {
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
          },
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

      // Surface a helpful hint for the most common failures
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

    return Response.json({
      clientSecret,
      model: data.session?.model || REALTIME_MODEL,
    });
  } catch (error) {
    console.error("Error creating realtime session:", error);
    return Response.json({ error: "Something went wrong" }, { status: 500 });
  }
}
