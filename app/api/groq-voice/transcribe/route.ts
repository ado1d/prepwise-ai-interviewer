import { getCurrentUser } from "@/lib/actions/auth.action";

// Groq STT model. Override via GROQ_STT_MODEL if needed.
const STT_MODEL = process.env.GROQ_STT_MODEL || "whisper-large-v3";

/**
 * Proxies mic audio to Groq's Whisper transcription endpoint.
 *
 * The browser sends a WAV blob (multipart "file"); we forward it to Groq
 * with the server-side GROQ_API_KEY and return `{ text }`. The key never
 * reaches the browser.
 *
 * Groq Whisper is batch (not streaming), so this is one request per
 * utterance — fine for a turn-based interview flow.
 */
export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!process.env.GROQ_API_KEY) {
      return Response.json(
        { error: "Server missing GROQ_API_KEY. Add it to .env.local and restart." },
        { status: 500 }
      );
    }

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof Blob)) {
      return Response.json({ error: "No audio file received" }, { status: 400 });
    }

    const groqForm = new FormData();
    groqForm.append("file", file, "audio.wav");
    groqForm.append("model", STT_MODEL);
    groqForm.append("response_format", "json");
    // Prompt nudges Whisper toward clean interview-style transcripts.
    if (process.env.GROQ_STT_PROMPT) {
      groqForm.append("prompt", process.env.GROQ_STT_PROMPT);
    }

    const res = await fetch(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
        body: groqForm,
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error("Groq STT error:", errText);
      return Response.json(
        { error: `Groq transcription failed: ${res.status} ${errText.slice(0, 200)}` },
        { status: 502 }
      );
    }

    const data = (await res.json()) as { text?: string };
    return Response.json({ text: data.text || "" });
  } catch (error) {
    console.error("Groq transcribe route error:", error);
    return Response.json({ error: "Something went wrong" }, { status: 500 });
  }
}
