import { getCurrentUser } from "@/lib/actions/auth.action";
import type { GeminiFunctionDeclaration, GeminiToolList } from "@/lib/voice/types";

// Groq rotates/renames chat models, and not every account has every model.
// Rather than hard-coding one ID that may 404, we auto-detect an available
// chat model from the key's /openai/v1/models list. Set GROQ_LLM_MODEL to
// force a specific model (e.g. "llama-3.1-8b-instant") if you want to override.
const CHAT_MODEL_CANDIDATES = [
  "llama-3.3-70b-versatile",
  "llama-3.3-70b-specdec",
  "llama-3.1-8b-instant",
  "llama3-70b-8192",
  "llama3-8b-8192",
  "qwen-2.5-32b",
  "qwen/qwen3-32b",
  "gemma2-9b-it",
];

let cachedChatModel: string | null = null;

async function resolveChatModel(): Promise<string> {
  if (cachedChatModel) return cachedChatModel;

  // Explicit override always wins (we don't second-guess it).
  const envModel = process.env.GROQ_LLM_MODEL?.trim();
  if (envModel) {
    cachedChatModel = envModel;
    return envModel;
  }

  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    });
    if (res.ok) {
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      const available = new Set((data.data ?? []).map((m) => m.id));

      // Prefer known-good chat models in quality order.
      for (const candidate of CHAT_MODEL_CANDIDATES) {
        if (available.has(candidate)) {
          cachedChatModel = candidate;
          console.info(`[groq-voice] using chat model "${candidate}"`);
          return candidate;
        }
      }

      // None of the known IDs match — pick the first model that isn't
      // clearly a whisper/tts/guard model.
      const fallback = (data.data ?? []).find(
        (m) => !/whisper|tts|guard|distil-whisper|preview-tts|moonshot/i.test(m.id)
      );
      if (fallback) {
        cachedChatModel = fallback.id;
        console.info(`[groq-voice] using chat model "${fallback.id}"`);
        return fallback.id;
      }
    }
  } catch {
    /* fall through to default */
  }

  // Last resort: the documented default. Will surface a clear error if it
  // still isn't available, telling the user to set GROQ_LLM_MODEL.
  cachedChatModel = "llama-3.3-70b-versatile";
  return cachedChatModel;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
}

/**
 * Streams a Groq chat completion back to the browser as Server-Sent-Events,
 * translated into a tiny event protocol the Groq voice session understands:
 *
 *   data: {"type":"text","delta":"..."}      // incremental assistant text
 *   data: {"type":"tool_call","id":"...","name":"...","args":"..."}
 *   data: {"type":"done"}
 *
 * Tool definitions arrive in the Gemini `function_declarations` shape (shared
 * with the Gemini provider) and are converted to the OpenAI tool format Groq
 * (which is OpenAI-compatible) expects.
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

    const body = (await request.json()) as {
      messages: ChatMessage[];
      tools?: GeminiToolList;
    };

    const payload: Record<string, unknown> = {
      model: await resolveChatModel(),
      messages: body.messages,
      stream: true,
      temperature: 0.7,
    };

    if (body.tools?.function_declarations?.length) {
      payload.tools = body.tools.function_declarations.map(toOpenAITool);
      payload.tool_choice = "auto";
    }

    const upstream = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text();
      console.error("Groq chat error:", errText);
      // Reset the cached model so a bad pick is retried on the next request.
      if (errText.includes("model_not_found") || errText.includes("does not exist")) {
        cachedChatModel = null;
      }
      const hint =
        errText.includes("model_not_found") || errText.includes("does not exist")
          ? " The Groq chat model wasn't found on your account. Set GROQ_LLM_MODEL in .env.local to a model listed at https://console.groq.com/docs/models and restart."
          : "";
      return Response.json(
        { error: `Groq chat failed: ${upstream.status} ${errText.slice(0, 200)}${hint}` },
        { status: 502 }
      );
    }

    // SSE stream that translates Groq's chunks into our event protocol.
    const upstreamBody = upstream.body;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        const send = (obj: unknown) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

        const reader = upstreamBody.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        // Tool calls arrive as incremental deltas; accumulate per index.
        const toolAccum = new Map<
          number,
          { id: string; name: string; args: string }
        >();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const rawLine of lines) {
              const line = rawLine.trim();
              if (!line.startsWith("data: ")) continue;
              const json = line.slice(6).trim();
              if (!json || json === "[DONE]") continue;
              let chunk: {
                choices?: Array<{
                  delta?: {
                    content?: string | null;
                    tool_calls?: Array<{
                      index?: number;
                      id?: string;
                      function?: { name?: string; arguments?: string };
                    }>;
                  };
                }>;
              };
              try {
                chunk = JSON.parse(json);
              } catch {
                continue;
              }
              const delta = chunk.choices?.[0]?.delta;
              if (!delta) continue;

              if (delta.content) {
                send({ type: "text", delta: delta.content });
              }
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  const entry = toolAccum.get(idx) ?? {
                    id: "",
                    name: "",
                    args: "",
                  };
                  if (tc.id) entry.id = tc.id;
                  if (tc.function?.name) entry.name = tc.function.name;
                  if (tc.function?.arguments) entry.args += tc.function.arguments;
                  toolAccum.set(idx, entry);
                }
              }
            }
          }

          // Emit accumulated tool calls (if any) before signalling done.
          for (const entry of toolAccum.values()) {
            if (entry.name) {
              send({
                type: "tool_call",
                id: entry.id,
                name: entry.name,
                args: entry.args || "{}",
              });
            }
          }
          send({ type: "done" });
        } catch (error) {
          console.error("Groq chat stream error:", error);
          send({ type: "error", message: String(error) });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("Groq chat route error:", error);
    return Response.json({ error: "Something went wrong" }, { status: 500 });
  }
}

function toOpenAITool(decl: GeminiFunctionDeclaration) {
  return {
    type: "function",
    function: {
      name: decl.name,
      description: decl.description,
      parameters: decl.parameters ?? { type: "object", properties: {} },
    },
  };
}
