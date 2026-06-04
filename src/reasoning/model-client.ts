/**
 * ModelClient — the reasoning engine's view of the model.
 *
 * The engine depends on this narrow interface, not on Ollama directly, so it
 * can be driven by a scripted client in tests (no live server needed) and by a
 * real Ollama client in production.
 */

import type { ChatMessage } from "../lib/ollama.js";
import { OllamaClient } from "../lib/ollama.js";
import type { ToolDescriptor } from "../tools/registry.js";
import type { ZodType } from "zod";
import { z } from "zod";

/** A tool call requested by the model. */
export interface ModelToolCall {
  name: string;
  arguments: unknown;
}

/** One assistant turn: free-text content plus any tool calls. */
export interface ModelTurn {
  content: string;
  tool_calls: ModelToolCall[];
}

/** A tool definition handed to the model (name + JSON-schema parameters). */
export interface ToolDefinition {
  descriptor: ToolDescriptor;
  schema: ZodType;
}

export interface ModelClient {
  model: string;
  generate(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ModelTurn>;
}

// ─── Ollama-backed implementation ─────────────────────────────────────────────

interface OllamaToolCallRaw {
  function?: { name?: string; arguments?: unknown };
}

interface OllamaChatResponse {
  message?: {
    content?: string;
    tool_calls?: OllamaToolCallRaw[];
  };
}

/**
 * Wraps OllamaClient to expose native /api/chat tool-calling (non-streamed).
 */
export class OllamaModelClient implements ModelClient {
  constructor(
    public readonly model: string,
    private readonly client: OllamaClient,
  ) {}

  static fromHost(model: string, host: string): OllamaModelClient {
    return new OllamaModelClient(model, new OllamaClient({ host }));
  }

  async generate(
    messages: ChatMessage[],
    tools: ToolDefinition[],
  ): Promise<ModelTurn> {
    const toolDefs = tools.map((t) => ({
      type: "function",
      function: {
        name: t.descriptor.name,
        description: t.descriptor.description,
        parameters: z.toJSONSchema(t.schema),
      },
    }));

    const raw = (await this.client.chatRaw({
      model: this.model,
      messages,
      tools: toolDefs,
    })) as OllamaChatResponse;

    const content = raw.message?.content ?? "";
    const tool_calls: ModelToolCall[] = (raw.message?.tool_calls ?? [])
      .filter((tc): tc is Required<OllamaToolCallRaw> => tc.function?.name != null)
      .map((tc) => ({
        name: tc.function.name as string,
        arguments: parseArguments(tc.function.arguments),
      }));

    return { content, tool_calls };
  }
}

/** Ollama may return tool-call arguments as an object or a JSON string. */
function parseArguments(args: unknown): unknown {
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch {
      return args;
    }
  }
  return args ?? {};
}
