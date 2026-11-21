import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

import { db } from "@/firebase/admin";
import { getCurrentUser } from "@/lib/actions/auth.action";
import { getRandomInterviewCover } from "@/lib/utils";

// Text model used for question generation. Override with any chat model your
// OpenAI account supports via OPENAI_TEXT_MODEL (e.g. gpt-4o, gpt-5-mini,
// gpt-5.6-mini). Default: gpt-4o-mini.
const TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-4o-mini";

// Used if question generation fails, so the user is never blocked.
const fallbackQuestions = [
  "Could you tell me a bit about yourself and your background?",
  "What drew you to this role?",
  "Can you describe a challenging project you worked on and your contribution to it?",
  "How do you approach solving a problem when you get stuck?",
  "Where do you see yourself professionally in a few years?",
];

/**
 * Creates a new interview (replaces the old /api/vapi/generate webhook).
 * Questions are generated with gpt-4o-mini and stored in Firestore.
 */
export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const { role, level, type, techstack, amount } = await request.json();

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

    let questions: string[] = [];

    try {
      const { text } = await generateText({
        model: openai(TEXT_MODEL),
        prompt: `Prepare questions for a job interview.
          The job role is ${role}.
          The job experience level is ${level}.
          The tech stack used in the job is: ${techstackString}.
          The focus between behavioural and technical questions should lean towards: ${type}.
          The amount of questions required is: ${questionCount}.
          Please return only the questions, without any additional text.
          The questions are going to be read by a voice assistant so do not use "/" or "*" or any other special characters which might break the voice assistant.
          Return the questions formatted like this:
          ["Question 1", "Question 2", "Question 3"]

          Thank you! <3
        `,
      });

      // Strip markdown code fences if the model added them
      const cleaned = text
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```\s*$/, "");

      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed) && parsed.every((q) => typeof q === "string")) {
        questions = parsed;
      } else {
        throw new Error("Unexpected question format");
      }
    } catch (error) {
      console.error("Question generation failed, using fallback questions:", error);
      questions = fallbackQuestions;
    }

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
