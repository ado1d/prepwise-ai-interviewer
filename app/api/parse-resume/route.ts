import { extractText } from "unpdf";

import { getCurrentUser } from "@/lib/actions/auth.action";

// PDF text extraction uses unpdf (a serverless-friendly pdf.js build). It is
// imported statically from a Node runtime route so it never ends up in an
// edge/ client bundle.
export const runtime = "nodejs";

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_TEXT_CHARS = 8000; // keep prompts + payloads sane

interface ParseResponse {
  success: boolean;
  error?: string;
  name?: string;
  chars?: number;
  truncated?: boolean;
  text?: string;
}

const fail = (error: string, status = 400): Response =>
  Response.json({ success: false, error } satisfies ParseResponse, {
    status,
  });

/**
 * Accepts a resume/CV upload (PDF, TXT or Markdown) as multipart/form-data
 * and returns the extracted plain text. The browser then stores this text as
 * the `resumeText` advanced preference, which flows into the interview
 * designer instructions and the generated questions.
 *
 * Strictly additive: nothing else in the app depends on this route. If the
 * upload fails the user can always paste their resume text directly.
 */
export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return fail("Unauthorized", 401);
    }

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return fail("No file was uploaded (expected a 'file' form field).");
    }
    if (file.size === 0) {
      return fail("The uploaded file is empty.");
    }
    if (file.size > MAX_FILE_BYTES) {
      return fail("The file is too large. Please upload a file under 5 MB.");
    }

    const name = file.name || "resume";
    const lower = name.toLowerCase();
    const isPdf =
      lower.endsWith(".pdf") || file.type === "application/pdf";
    const isText =
      lower.endsWith(".txt") ||
      lower.endsWith(".md") ||
      lower.endsWith(".markdown") ||
      file.type.startsWith("text/");

    if (!isPdf && !isText) {
      return fail(
        "Unsupported file type. Upload a PDF, TXT or Markdown file, or paste your resume text in the box instead."
      );
    }

    let text = "";

    if (isPdf) {
      const buffer = await file.arrayBuffer();
      const result = await extractText(buffer, { mergePages: true });
      text = result.text;
    } else {
      text = await file.text();
    }

    // Normalize whitespace so the model gets clean text, not raw PDF layout.
    text = text
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (!text) {
      return fail(
        "No readable text was found in that file. If it is a scanned PDF, paste the text manually instead."
      );
    }

    const truncated = text.length > MAX_TEXT_CHARS;
    if (truncated) {
      text = text.slice(0, MAX_TEXT_CHARS);
    }

    return Response.json(
      {
        success: true,
        name,
        chars: text.length,
        truncated,
        text,
      } satisfies ParseResponse,
      { status: 200 }
    );
  } catch (error) {
    console.error("Resume parsing failed:", error);
    return fail(
      "Could not read that file. Try a different file or paste the text manually.",
      500
    );
  }
}
