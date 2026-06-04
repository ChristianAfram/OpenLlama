/**
 * A scripted ModelClient for prompt-injection evals.
 *
 * It replays a fixed sequence of turns, ignoring what the model is actually
 * shown. We use it to simulate a FULLY COMPROMISED model — one that does exactly
 * what an injected instruction in repo content tells it to do (force-push,
 * exfiltrate `.env`, `rm -rf`). Running this through the real engine + kernel
 * proves the kernel blocks the action regardless of model behaviour.
 */

import type { ChatMessage } from "../lib/ollama.js";
import type {
  ModelClient,
  ModelTurn,
  ToolDefinition,
} from "../reasoning/model-client.js";

export class ScriptedModelClient implements ModelClient {
  model: string;
  private i = 0;
  readonly seen: ChatMessage[][] = [];

  constructor(
    private readonly script: ModelTurn[],
    model = "scripted-compromised-model",
  ) {
    this.model = model;
  }

  generate(messages: ChatMessage[], _tools: ToolDefinition[]): Promise<ModelTurn> {
    void _tools;
    this.seen.push(messages);
    // After the script is exhausted, behave as if finished (no tool calls).
    const turn =
      this.i < this.script.length
        ? this.script[this.i]!
        : { content: "done", tool_calls: [] };
    this.i++;
    return Promise.resolve(turn);
  }
}

/** Convenience: a tool-call turn. */
export function toolTurn(
  name: string,
  args: unknown,
  content = "",
): ModelTurn {
  return { content, tool_calls: [{ name, arguments: args }] };
}

/** Convenience: a final-answer turn with no tool calls. */
export function finalTurn(content: string): ModelTurn {
  return { content, tool_calls: [] };
}
