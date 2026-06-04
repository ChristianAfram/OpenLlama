/**
 * `openllama chat` — read-only conversation with a local model.
 *
 * Scope (Prompt 0): a single-turn, read-only exchange. It sends the user's
 * prompt to Ollama and streams the response. There are NO tools, NO filesystem
 * writes, and NO side effects of any kind here. The governance kernel (audit
 * ledger, executor, classifier, approvals) and any mutating tools arrive in
 * later prompts; until then this command is purely the Level 0 surface.
 */

import { Command } from "commander";
import { loadConfig, resolveProfile } from "../lib/config.js";
import { OllamaClient, OllamaError, type ChatMessage } from "../lib/ollama.js";
import { error, info, writeToken } from "../lib/ui.js";

interface ChatOptions {
  model?: string;
  host?: string;
}

const SYSTEM_PROMPT =
  "You are OpenLlama, a local, read-only assistant. In this mode you cannot " +
  "modify files, run commands, or take any action — you can only answer.";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

export function registerChatCommand(program: Command): void {
  program
    .command("chat")
    .description("Read-only conversation with a local Ollama model (no tools, no writes)")
    .argument("[prompt...]", "the prompt to send (or pipe via stdin)")
    .option("-m, --model <model>", "override the model for this turn")
    .option("--host <url>", "override the Ollama host for this turn")
    .action(async (promptParts: string[], options: ChatOptions) => {
      const argPrompt = promptParts.join(" ").trim();
      const prompt = argPrompt.length > 0 ? argPrompt : await readStdin();

      if (prompt.length === 0) {
        error("no prompt provided (pass text or pipe via stdin)");
        process.exitCode = 1;
        return;
      }

      const profile = resolveProfile(loadConfig());
      const model = options.model ?? profile.model;
      const host = options.host ?? profile.host;

      const client = new OllamaClient({ host });
      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ];

      try {
        info(`openllama: ${model} @ ${host} (read-only)`);
        for await (const fragment of client.chatStream({ model, messages })) {
          writeToken(fragment);
        }
        writeToken("\n");
      } catch (err) {
        const message =
          err instanceof OllamaError
            ? err.message
            : err instanceof Error
              ? `${err.name}: ${err.message}`
              : String(err);
        error(message);
        error("is a local Ollama server running? see .env.example / `ollama serve`");
        process.exitCode = 1;
      }
    });
}
