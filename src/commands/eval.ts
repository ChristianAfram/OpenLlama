/**
 * `openllama eval` — run the deterministic AI eval suite and enforce the gates.
 *
 * Exit code 1 if any category falls below its pass-rate gate (Master Plan §11:
 * prompt-injection and destructive-refusal must be 100%). `--json` prints the
 * framework §23 records for machine consumption / CI artifacts.
 */

import { Command } from "commander";
import { allEvalCases, runSuite, checkGates } from "../evals/index.js";
import type { EvalCategory } from "../evals/types.js";
import { info, error } from "../lib/ui.js";

interface EvalOptions {
  json?: boolean;
  category?: string;
}

export function registerEvalCommand(program: Command): void {
  program
    .command("eval")
    .description("Run the AI eval suite and enforce the release gates")
    .option("--json", "emit the §23 eval records as JSON")
    .option("--category <name>", "run only one category (e.g. prompt-injection)")
    .action(async (options: EvalOptions) => {
      const cases = options.category
        ? allEvalCases.filter((c) => c.category === options.category)
        : allEvalCases;

      if (cases.length === 0) {
        error(`no eval cases for category: ${String(options.category)}`);
        process.exitCode = 1;
        return;
      }

      const suite = await runSuite(cases);
      const gate = checkGates(suite);

      if (options.json) {
        process.stdout.write(JSON.stringify(suite.results, null, 2) + "\n");
      } else {
        printReport(suite.byCategory, suite.total, suite.passed);
        for (const r of suite.results.filter((x) => !x.passed)) {
          error(`FAIL ${r.eval_id} [${r.category}] ${r.input}`);
          error(`     expected: ${r.expected}`);
          error(`     actual:   ${r.actual}`);
        }
      }

      if (!gate.ok) {
        for (const f of gate.failures) {
          const tag = f.hard ? "HARD GATE" : "gate";
          error(
            `${tag} FAILED: ${f.category} ${(f.rate * 100).toFixed(1)}% < ${(f.required * 100).toFixed(0)}% required`,
          );
        }
        process.exitCode = 1;
        return;
      }

      info(`✓ all eval gates passed (${String(suite.passed)}/${String(suite.total)})`);
    });
}

function printReport(
  byCategory: Record<string, { total: number; passed: number; rate: number }>,
  total: number,
  passed: number,
): void {
  info("AI eval suite results");
  info("─".repeat(48));
  const categories = Object.keys(byCategory).sort() as EvalCategory[];
  for (const cat of categories) {
    const b = byCategory[cat]!;
    const mark = b.passed === b.total ? "✓" : "✗";
    info(`${mark} ${cat.padEnd(22)} ${String(b.passed)}/${String(b.total)}  (${(b.rate * 100).toFixed(0)}%)`);
  }
  info("─".repeat(48));
  info(`total: ${String(passed)}/${String(total)}`);
}
