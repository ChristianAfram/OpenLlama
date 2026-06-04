/**
 * Minimal Ollama HTTP client.
 *
 * Talks to a local Ollama server's `/api/chat` endpoint and yields assistant
 * tokens as they stream in (NDJSON: one JSON object per line). The `fetch`
 * implementation is injectable so the streaming/parse logic can be unit-tested
 * without a live server.
 *
 * Scope (Prompt 0): read-only conversation only. No tool calls, no side effects.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OllamaClientOptions {
  /** Base URL of the Ollama server, e.g. http://127.0.0.1:11434 */
  host: string;
  /** Injectable fetch (defaults to global fetch). */
  fetchImpl?: typeof fetch;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /** Sampling temperature, forwarded to Ollama options. */
  temperature?: number;
  /** Abort signal to cancel an in-flight stream. */
  signal?: AbortSignal;
}

/** Shape of a single NDJSON line returned by /api/chat (subset we use). */
interface OllamaChatChunk {
  message?: { role?: string; content?: string };
  done?: boolean;
  error?: string;
}

export const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";

export class OllamaError extends Error {
  override name = "OllamaError";
}

export class OllamaClient {
  private readonly host: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaClientOptions) {
    this.host = options.host.replace(/\/+$/, "");
    const f = options.fetchImpl ?? globalThis.fetch;
    if (typeof f !== "function") {
      throw new OllamaError("No fetch implementation available");
    }
    this.fetchImpl = f;
  }

  /**
   * Stream a chat completion, yielding assistant content fragments in order.
   */
  async *chatStream(request: ChatRequest): AsyncGenerator<string, void, void> {
    const res = await this.fetchImpl(`${this.host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        stream: true,
        options:
          request.temperature === undefined
            ? undefined
            : { temperature: request.temperature },
      }),
      signal: request.signal,
    });

    if (!res.ok) {
      throw new OllamaError(
        `Ollama request failed: ${String(res.status)} ${res.statusText}`,
      );
    }
    if (!res.body) {
      throw new OllamaError("Ollama response had no body to stream");
    }

    for await (const chunk of parseNdjsonStream(res.body)) {
      if (chunk.error) {
        throw new OllamaError(chunk.error);
      }
      const content = chunk.message?.content;
      if (content) {
        yield content;
      }
      if (chunk.done) {
        return;
      }
    }
  }

  /** Convenience: collect a full (non-streamed-to-caller) response. */
  async chat(request: ChatRequest): Promise<string> {
    let out = "";
    for await (const fragment of this.chatStream(request)) {
      out += fragment;
    }
    return out;
  }

  /**
   * Non-streaming /api/chat returning the raw parsed JSON response. Used by the
   * reasoning engine for native tool-calling (the `tools` field carries tool
   * definitions; the response's `message.tool_calls` carries requested calls).
   */
  async chatRaw(body: Record<string, unknown>): Promise<unknown> {
    const res = await this.fetchImpl(`${this.host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, stream: false }),
    });
    if (!res.ok) {
      throw new OllamaError(
        `Ollama request failed: ${String(res.status)} ${res.statusText}`,
      );
    }
    return res.json();
  }
}

/**
 * Parse a ReadableStream of bytes as NDJSON, tolerating chunk boundaries that
 * split a line. Yields one parsed object per complete line.
 *
 * Exported for unit testing.
 */
export async function* parseNdjsonStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<OllamaChatChunk, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line.length > 0) {
            yield parseLine(line);
          }
        }
      }
      if (done) {
        break;
      }
    }
    // Flush any trailing line without a terminating newline.
    const tail = buffer.trim();
    if (tail.length > 0) {
      yield parseLine(tail);
    }
  } finally {
    reader.releaseLock();
  }
}

function parseLine(line: string): OllamaChatChunk {
  try {
    return JSON.parse(line) as OllamaChatChunk;
  } catch {
    throw new OllamaError(`Malformed NDJSON line from Ollama: ${line}`);
  }
}
