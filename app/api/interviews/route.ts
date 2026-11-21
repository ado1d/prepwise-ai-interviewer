import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

import { db } from "@/firebase/admin";
import { getCurrentUser } from "@/lib/actions/auth.action";
import { getRandomInterviewCover } from "@/lib/utils";

// Primary text model (OpenAI, via the AI SDK). Override with any chat model
// your OpenAI account supports via OPENAI_TEXT_MODEL (e.g. gpt-4o, gpt-5-mini).
const TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-4o-mini";

// Gemini text fallback candidates (plain REST call — no extra dependency).
// Used when the OpenAI call fails or no OPENAI_API_KEY is configured. The
// same key the Gemini voice sessions use works here (NEXT_PUBLIC_GEMINI_API_KEY
// is readable server-side too, or set GEMINI_API_KEY).
const GEMINI_TEXT_MODEL_CANDIDATES = [
  ...(process.env.GEMINI_TEXT_MODEL ? [process.env.GEMINI_TEXT_MODEL] : []),
  "gemini-2.5-flash",
  "gemini-flash-latest",
];

// Last-resort questions per interview focus. Used only when BOTH providers
// fail so the user is never blocked. Varied by focus instead of one fixed
// list, so even the fallback respects the kind of interview being practised.
const FALLBACK_SETS: { keywords: string[]; questions: string[] }[] = [
  {
    keywords: ["leader"],
    questions: [
      "Tell me about a time you led a team through a difficult delivery.",
      "How do you give feedback to an underperforming teammate?",
      "Describe a decision you made that was unpopular, and how you handled the response.",
      "Tell me about a conflict between team members that you resolved.",
      "How do you balance business goals with your team's wellbeing?",
      "How do you mentor people on your team who want to grow?",
      "What is your approach to delegating work, and how do you follow up?",
    ],
  },
  {
    keywords: ["tech"],
    questions: [
      "Walk me through how you would debug a production issue that only appears under load.",
      "Tell me about the most complex project you have built and your specific contribution to it.",
      "Explain a technical concept you know well as if I were new to it.",
      "Describe a technical decision you made that turned out to be wrong. What did you learn?",
      "How do you decide when a piece of work is ready to ship?",
      "Tell me about a performance problem you solved and how you measured the improvement.",
      "How do you keep your technical skills current?",
    ],
  },
];

const GENERAL_FALLBACK_QUESTIONS = [
  "Could you tell me a bit about yourself and your background?",
  "What are your greatest strengths, and how have they helped you?",
  "Tell me about a time you worked under pressure and how you handled it.",
  "Can you describe a challenging project you worked on and your contribution to it?",
  "Tell me about a time you failed and what you learned from it.",
  "How do you handle conflict with a coworker?",
  "Where do you see yourself professionally in a few years?",
];

function pickFallbackQuestions(type: string): string[] {
  const lowered = String(type || "").toLowerCase();
  const match = FALLBACK_SETS.find((set) =>
    set.keywords.some((keyword) => lowered.includes(keyword))
  );
  return match ? match.questions : GENERAL_FALLBACK_QUESTIONS;
}

/** Parse the model output into a clean list of question strings. */
function parseQuestions(raw: string): string[] {
  // Strip markdown code fences if the model added them.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");

  const parsed = JSON.parse(cleaned);
  if (
    Array.isArray(parsed) &&
    parsed.length > 0 &&
    parsed.every((q) => typeof q === "string")
  ) {
    return parsed;
  }
  throw new Error("Unexpected question format");
}

/**
 * Generate text with the Gemini REST API. Tries each model candidate in
 * order; a 404 (model not available for this key) moves on to the next one.
 */
async function generateWithGemini(prompt: string): Promise<string> {
  const apiKey =
    process.env.GEMINI_API_KEY || process.env.NEXT_PUBLIC_GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "No Gemini API key configured (set GEMINI_API_KEY or NEXT_PUBLIC_GEMINI_API_KEY)"
    );
  }

  let lastError = "";

  for (const model of GEMINI_TEXT_MODEL_CANDIDATES) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );

    if (response.status === 404) {
      lastError = `${model}: not available for this key`;
      continue;
    }
    if (!response.ok) {
      throw new Error(
        `Gemini ${model} -> ${response.status}: ${(await response.text()).slice(0, 300)}`
      );
    }

    const data = await response.json();
    const text = (data?.candidates?.[0]?.content?.parts ?? [])
      .map((part: { text?: string }) => part?.text ?? "")
      .join("")
      .trim();

    if (text) return text;
    lastError = `${model}: empty response`;
  }

  throw new Error(lastError || "Gemini text generation failed");
}

/**
 * Creates a new interview (replaces the old /api/vapi/generate webhook).
 * Questions are generated with the OpenAI text model, falling back to the
 * Gemini text model, and finally to focus-aware built-in questions. The
 * source actually used is logged so provider issues are visible in the
 * server console.
 */
export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const { role, level, type, techstack, amount, preferences } =
      await request.json();

    if (!role || !level || !type) {
      return Response.json(
        { success: false, error: "Missing required fields: role, level, type" },
        { status: 400 }
      );
    }

    const questionCount = Math.min(Math.max(Number(amount) || 5, 3), 10);
    const techstackString = Array.isArray(techstack)
      ? techstack.join(", ")
      : String(techstack || "");

    // Advanced preferences (optional, generate flow only). Strictly additive.
    const interviewTypePref =
      typeof preferences?.interviewType === "string"
        ? preferences.interviewType.trim()
        : "";
    const questionPref =
      typeof preferences?.questionPreference === "string"
        ? preferences.questionPreference.trim()
        : "";
    const resumeText =
      typeof preferences?.resumeText === "string"
        ? preferences.resumeText.trim().slice(0, 4000)
        : "";

    // Build the preference block. The wording is intentionally strong: the
    // user explicitly asked for these, so every question must reflect them.
    const preferenceLines: string[] = [];
    if (interviewTypePref) {
      preferenceLines.push(
        `- Interview category explicitly requested by the user: "${interviewTypePref}". Every question must match this category.`
      );
    }
    if (questionPref) {
      preferenceLines.push(
        `- Question focus explicitly requested by the user: "${questionPref}". Every question must align with this focus — do not substitute generic questions instead.`
      );
    }
    if (resumeText) {
      preferenceLines.push(
        `- The user uploaded their CV/resume (text between <resume> tags below). Personalize the questions using the projects, skills and experience in it. Do not quote the resume back.`
      );
      preferenceLines.push(`<resume>${resumeText}</resume>`);
    }

    const preferenceBlock = preferenceLines.length
      ? `The user EXPLICITLY requested the following when setting up this interview — these are hard requirements, not suggestions:\n          ${preferenceLines.join("\n          ")}\n`
      : "";

    const prompt = `Prepare questions for a job interview.
          The job role is ${role}.
          The job experience level is ${level}.
          The tech stack used in the job is: ${techstackString}.
          The focus between behavioural and technical questions should lean towards: ${type}.
          The amount of questions required is: ${questionCount}.
          ${preferenceBlock}
          Please return only the questions, without any additional text.
          The questions are going to be read by a voice assistant so do not use "/" or "*" or any other special characters which might break the voice assistant.
          Return the questions formatted like this:
          ["Question 1", "Question 2", "Question 3"]

          Thank you! <3
        `;

    let questions: string[] = [];
    let source = "none";

    // 1. OpenAI (primary) — only when a key is configured.
    if (process.env.OPENAI_API_KEY) {
      try {
        const { text } = await generateText({
          model: openai(TEXT_MODEL),
          prompt,
        });
        questions = parseQuestions(text);
        source = `openai:${TEXT_MODEL}`;
      } catch (error) {
        console.error("[interviews] OpenAI question generation failed:", error);
      }
    }

    // 2. Gemini REST fallback — covers a missing/expired OpenAI key.
    if (!questions.length) {
      try {
        const text = await generateWithGemini(prompt);
        questions = parseQuestions(text);
        source = "gemini-fallback";
      } catch (error) {
        console.error("[interviews] Gemini question generation failed:", error);
      }
    }

    // 3. Built-in focus-aware questions — the user is never blocked.
    if (!questions.length) {
      questions = pickFallbackQuestions(type).slice(0, questionCount);
      source = "built-in-fallback";
    }

    console.log(
      `[interviews] generated ${questions.length} questions via ${source}`
    );

    const interview = {
      role: role,
      type: type,
      level: level,
      techstack: techstackString
        .split(",")
        .map((tech: string) => tech.trim())
        .filter(Boolean),
      questions: questions,
      userId: user.id,
      finalized: true,
      coverImage: getRandomInterviewCover(),
      createdAt: new Date().toISOString(),
    };

    const docRef = await db.collection("interviews").add(interview);

    return Response.json({ success: true, interviewId: docRef.id }, { status: 200 });
  } catch (error) {
    console.error("Error creating interview:", error);
    return Response.json({ success: false, error: String(error) }, { status: 500 });
  }
}
