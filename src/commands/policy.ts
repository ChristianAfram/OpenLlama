/**
 * `opencli policy …` — inspect and enforce policy-as-code (Master Plan §8).
 *
 *   policy test --json '<action>'   evaluate a proposed action against the bundle
 *   policy exceptions [--file p]    validate the exception catalog (CI gate)
 *
 * `policy exceptions` exits non-zero if any active exception is past its expiry
 * or is missing an owner / expiry / compensating control — the framework §25
 * lifecycle gate, run in CI by .github/workflows/policy.yml.
 */

import { resolve } from "node:path";
import { Command } from "commander";
import { error, info } from "../lib/ui.js";
import { getDefaultPolicyEngine } from "../policy/engine.js";
import type { PolicyInput } from "../policy/types.js";
import { loadExceptions, validateExceptions } from "../policy/exceptions.js";

interface TestOptions {
  json?: string;
}
interface ExceptionsOptions {
  file?: string;
}

export function registerPolicyCommand(program: Command): void {
  const policy = program
    .command("policy")
    .description("Inspect and enforce policy-as-code");

  policy
    .command("test")
    .description("Evaluate a proposed action against the policy bundle")
    .option("--json <action>", "the action as a JSON PolicyInput object", "{}")
    .action((options: TestOptions) => {
      let input: PolicyInput;
      try {
        input = JSON.parse(options.json ?? "{}") as PolicyInput;
      } catch (err) {
        error(`--json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
        return;
      }
      if (typeof input.tool !== "string" || typeof input.permission_level !== "number") {
        error('PolicyInput requires at least { "tool": string, "permission_level": 0-5 }');
        process.exitCode = 1;
        return;
      }

      const engine = getDefaultPolicyEngine();
      const result = engine.evaluate(input);
      process.stdout.write(
        JSON.stringify({ bundle: engine.version, ...result }, null, 2) + "\n",
      );
      // A DENY is a non-zero exit so the command is usable as a gate in scripts.
      if (result.decision === "DENY") process.exitCode = 2;
    });

  policy
    .command("exceptions")
    .description("Validate the exception catalog (fails on expired / malformed entries)")
    .option("--file <path>", "path to the exceptions catalog", "catalog/exceptions.yml")
    .action((options: ExceptionsOptions) => {
      const path = resolve(options.file ?? "catalog/exceptions.yml");
      let records;
      try {
        records = loadExceptions(path);
      } catch (err) {
        error(`could not read exceptions catalog at ${path}: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
        return;
      }

      const v = validateExceptions(records);
      info(`exceptions: ${String(v.total)} total, ${String(v.active)} active`);
      for (const e of v.expired) error(`EXPIRED  ${e.exception_id}: ${e.problem}`);
      for (const m of v.malformed) error(`MALFORMED ${m.exception_id}: ${m.problem}`);

      if (!v.ok) {
        error(
          `policy exception gate FAILED: ${String(v.expired.length)} expired, ${String(v.malformed.length)} malformed`,
        );
        process.exitCode = 1;
        return;
      }
      info("✓ all exceptions are valid and unexpired");
    });
}
