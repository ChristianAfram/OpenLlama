import { describe, it, expect } from "vitest";
import { OllamaClient, OllamaError, parseNdjsonStream } from "./ollama.js";

/** Build a ReadableStream from a list of byte chunks (to simulate the wire). */
function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i] as string));
        i += 1;
      } else {
        controller.close();
      }
    },
  });
}

/** A fetch stub that returns the given chunks as an NDJSON body. */
function fetchReturning(chunks: string[], ok = true, status = 200): typeof fetch {
  return (async () =>
    new Response(streamFromChunks(chunks), {
      status,
      statusText: ok ? "OK" : "Error",
    })) as unknown as typeof fetch;
}

const lines = [
  JSON.stringify({ message: { role: "assistant", content: "Hello" }, done: false }),
  JSON.stringify({ message: { role: "assistant", content: ", " }, done: false }),
  JSON.stringify({ message: { role: "assistant", content: "world" }, done: false }),
  JSON.stringify({ message: { role: "assistant", content: "!" }, done: true }),
];

describe("parseNdjsonStream", () => {
  it("parses whole lines", async () => {
    const stream = streamFromChunks([lines.join("\n") + "\n"]);
    const out: unknown[] = [];
    for await (const chunk of parseNdjsonStream(stream)) {
      out.push(chunk);
    }
    expect(out).toHaveLength(4);
  });

  it("tolerates chunk boundaries that split a line", async () => {
    const whole = lines.join("\n") + "\n";
    // Split mid-way through a JSON object.
    const mid = Math.floor(whole.length / 2);
    const stream = streamFromChunks([whole.slice(0, mid), whole.slice(mid)]);
    const out: { message?: { content?: string } }[] = [];
    for await (const chunk of parseNdjsonStream(stream)) {
      out.push(chunk);
    }
    const text = out.map((c) => c.message?.content ?? "").join("");
    expect(text).toBe("Hello, world!");
  });

  it("flushes a trailing line without a terminating newline", async () => {
    const stream = streamFromChunks([lines.join("\n")]); // no final \n
    const out: unknown[] = [];
    for await (const chunk of parseNdjsonStream(stream)) {
      out.push(chunk);
    }
    expect(out).toHaveLength(4);
  });
});

describe("OllamaClient.chatStream", () => {
  it("yields concatenated assistant tokens in order", async () => {
    const client = new OllamaClient({
      host: "http://test",
      fetchImpl: fetchReturning([lines.join("\n") + "\n"]),
    });
    let text = "";
    for await (const fragment of client.chatStream({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
    })) {
      text += fragment;
    }
    expect(text).toBe("Hello, world!");
  });

  it("stops at the done chunk", async () => {
    const withExtra = [
      ...lines,
      JSON.stringify({ message: { content: "SHOULD-NOT-APPEAR" }, done: false }),
    ];
    const client = new OllamaClient({
      host: "http://test",
      fetchImpl: fetchReturning([withExtra.join("\n") + "\n"]),
    });
    const text = await client.chat({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(text).toBe("Hello, world!");
    expect(text).not.toContain("SHOULD-NOT-APPEAR");
  });

  it("throws OllamaError on a non-ok response", async () => {
    const client = new OllamaClient({
      host: "http://test",
      fetchImpl: fetchReturning(["{}"], false, 500),
    });
    await expect(
      client.chat({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBeInstanceOf(OllamaError);
  });

  it("surfaces an error field from the stream", async () => {
    const client = new OllamaClient({
      host: "http://test",
      fetchImpl: fetchReturning([JSON.stringify({ error: "model not found" }) + "\n"]),
    });
    await expect(
      client.chat({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/model not found/);
  });
});
