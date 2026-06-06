/**
 * `opencli agent` — run the reasoning engine against a local model.
 *
 * The agent can read files, list directories, search, and propose diffs to
 * answer a question about the repository. It modifies nothing: every action is
 * read-only or a draft, and every action is logged to the audit ledger
 * (inspect with `opencli audit show`).
 */

import { join, resolve } from "node:path";
import { Command } from "commander";
import { loadLayeredConfig, effectiveProfile } from "../lib/config-scopes.js";
import { OllamaError } from "../lib/ollama.js";
import { error, info, warn } from "../lib/ui.js";
import { buildDefaultRegistry } from "../tools/index.js";
import { OllamaModelClient } from "../reasoning/model-client.js";
import { ReasoningEngine } from "../reasoning/engine.js";
import { loadModelCatalog, checkModelGovernance } from "../lib/model-governance.js";
import { RuleBasedVerifier } from "../kernel/verifier.js";
import { getDefaultSnapshotStore } from "../kernel/snapshot.js";
import { getDefaultLedger } from "../kernel/audit.js";
import { PROMPT_VERSION } from "../reasoning/context.js";
import { getDefaultSessionStore, type SessionStore } from "../sessions/store.js";

interface AgentOptions {
  model?: string;
  host?: string;
  cwd?: string;
  maxIterations?: string;
  enterprise?: boolean;
  resume?: string;
  continue?: boolean;
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
    .option("--resume <id>", "resume a previous session by id")
    .option("--continue", "resume the most recent session for this directory")
    .action(async (questionParts: string[], options: AgentOptions) => {
      const question = questionParts.join(" ").trim();
      const repoRoot = resolve(options.cwd ?? process.cwd());

      // Layered, governed config: builtin < user < project < env < flag.
      // The `--enterprise` flag may only TIGHTEN; a project file can never
      // loosen a security control a lower scope established (Config Scopes, v0.8).
      const merged = loadLayeredConfig({
        cwd: repoRoot,
        flags: { enterprise: options.enterprise },
      });
      const profile = effectiveProfile(merged.effective);
      const model = options.model ?? profile.model;
      const host = options.host ?? profile.host;
      const enterprise = merged.effective.security.enterprise;

      // Surface any loosening attempts that the merge dropped.
      for (const r of merged.rejections) {
        warn(`config: ignored ${r.scope} scope override of ${r.field} — ${r.reason}`);
      }

      // Record the effective security posture on the audit timeline (L0, informational).
      // Non-fatal: config logging does not gate world mutations, so a ledger
      // failure here warns rather than aborts.
      try {
        getDefaultLedger().appendEvent({
          actor: "user",
          service: "opencli-agent",
          action: "effective_config",
          input_source: "developer",
          target: repoRoot,
          model,
          prompt_version: PROMPT_VERSION,
          result: "executed",
          data_read: [
            {
              enterprise,
              enterprise_origin: merged.origins["security.enterprise"] ?? "builtin",
              denied_paths: merged.effective.security.denied_paths,
              context_budget: merged.effective.context.budget,
              compaction: merged.effective.context.compaction,
              rejected_overrides: merged.rejections.map((r) => `${r.scope}:${r.field}`),
            },
          ],
        });
      } catch (e) {
        warn(`config: could not record effective_config audit event: ${String(e)}`);
      }

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

      // Session store: persist this run so it can be resumed. Degrade gracefully
      // if the store can't be opened — persistence is convenience, not a gate.
      let sessionStore: SessionStore | undefined;
      try {
        sessionStore = getDefaultSessionStore();
      } catch (e) {
        warn(`sessions: could not open session store, running without persistence: ${String(e)}`);
      }

      // Resolve which session to resume: --resume <id> wins; --continue picks
      // the most recent session for this directory.
      let resumeSessionId: string | undefined = options.resume;
      if (!resumeSessionId && options.continue && sessionStore) {
        const latest = sessionStore.latestForCwd(repoRoot);
        if (latest) {
          resumeSessionId = latest.session_id;
          info(`continuing session ${latest.session_id}`);
        } else {
          warn("sessions: no previous session for this directory; starting fresh");
        }
      }
      if (resumeSessionId && sessionStore && !sessionStore.get(resumeSessionId)) {
        error(`no session with id ${resumeSessionId}`);
        process.exitCode = 1;
        return;
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
        contextBudget: merged.effective.context.budget,
        compaction: merged.effective.context.compaction,
        ...(sessionStore ? { sessionStore } : {}),
        ...(resumeSessionId ? { resumeSessionId } : {}),
      });

      try {
        info(`opencli agent: ${model} @ ${host} (read-only + draft tools)`);
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
