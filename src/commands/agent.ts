/**
 * `openllama agent` — run the reasoning engine against a local model.
 *
 * The agent can read files, list directories, search, and propose diffs to
 * answer a question about the repository. It modifies nothing: every action is
 * read-only or a draft, and every action is logged to the audit ledger
 * (inspect with `openllama audit show`).
 */

import { join, resolve } from "node:path";
import { Command } from "commander";
import { loadConfig, resolveProfile } from "../lib/config.js";
import { OllamaError } from "../lib/ollama.js";
import { error, info, warn } from "../lib/ui.js";
import { buildDefaultRegistry } from "../tools/index.js";
import { OllamaModelClient } from "../reasoning/model-client.js";
import { ReasoningEngine } from "../reasoning/engine.js";
import { loadModelCatalog, checkModelGovernance } from "../lib/model-governance.js";
import { RuleBasedVerifier } from "../kernel/verifier.js";
import { getDefaultSnapshotStore } from "../kernel/snapshot.js";

interface AgentOptions {
  model?: string;
  host?: string;
  cwd?: string;
  maxIterations?: string;
  enterprise?: boolean;
}

export function registerAgentCommand(program: Command): void {
  program
    .command("agent")
    .description(
      "Answer a question about the repository using read-only and draft tools (no writes)",
    )
    .argument("<question...>", "what you want the agent to do")
    .option("-m, --model <model>", "override the model")
    .option("--host <url>", "override the Ollama host")
    .option("--cwd <dir>", "repository root to operate in (default: current dir)")
    .option("--max-iterations <n>", "hard cap on reasoning iterations", "25")
    .option("--enterprise", "enterprise hard-block mode (model must be registered and evaluated)")
    .action(async (questionParts: string[], options: AgentOptions) => {
      const question = questionParts.join(" ").trim();
      const profile = resolveProfile(loadConfig());
      const model = options.model ?? profile.model;
      const host = options.host ?? profile.host;
      const repoRoot = resolve(options.cwd ?? process.cwd());
      const enterprise = options.enterprise ?? false;

      // Model governance check (Prompt 9 — framework §22, Master Plan §11).
      const catalogPath = join(repoRoot, "catalog/models.yml");
      const catalog = loadModelCatalog(catalogPath);
      const governance = checkModelGovernance(model, catalog, enterprise);
      if (!governance.allowed) {
        error(`model governance: ${governance.reason}`);
        process.exitCode = 1;
        return;
      }
      if (!governance.in_catalog) {
        warn(`model governance: ${governance.reason}`);
      } else if (!governance.evaluated) {
        warn(`model governance: ${governance.reason}`);
      }

      const registry = buildDefaultRegistry();
      const client = OllamaModelClient.fromHost(model, host);
      const engine = new ReasoningEngine({
        registry,
        model: client,
        toolContext: { repoRoot },
        maxIterations: Number(options.maxIterations),
        verifier: new RuleBasedVerifier(),
        model_eval_passed: governance.eval_passed,
        snapshots: getDefaultSnapshotStore(),
      });

      try {
        info(`openllama agent: ${model} @ ${host} (read-only + draft tools)`);
        const result = await engine.run(question);
        process.stdout.write(result.answer + "\n");
        info(
          `\n[${String(result.iterations)} iteration(s), ${String(result.toolCalls)} tool call(s), stop: ${result.stopReason}]`,
        );
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
