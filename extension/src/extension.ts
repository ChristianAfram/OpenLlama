/**
 * OpenCLI VS Code extension — a THIN CLIENT over the audited CLI.
 *
 * This extension contains no kernel logic. It spawns the `opencli` binary and
 * renders its output. Every governance gate (executor, policy, approval, audit,
 * kill switch) lives in the CLI, so the editor cannot introduce a new path to a
 * side effect: it can only ask the CLI to do something, and the CLI gates it.
 *
 * The agent is driven via `opencli agent --json`, whose NDJSON event contract is
 * documented in docs/ide-bridge.md.
 */

import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** Mirror of the AgentEvent contract (docs/ide-bridge.md, v1). */
type AgentEvent =
  | { type: "run_start"; v: 1; session_id: string; correlation_id: string; model: string; instruction: string }
  | { type: "iteration"; v: 1; n: number }
  | { type: "assistant"; v: 1; content: string }
  | { type: "tool_call"; v: 1; name: string; status: string; audit_event_id: string | null; feedback: string }
  | { type: "run_end"; v: 1; stop_reason: string; iterations: number; tool_calls: number; answer: string };

function binaryPath(): string {
  return vscode.workspace.getConfiguration("opencli").get<string>("binaryPath", "opencli");
}

function workspaceDir(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel("OpenCLI");
  context.subscriptions.push(channel);

  context.subscriptions.push(
    vscode.commands.registerCommand("opencli.runAgent", () => runAgent(channel)),
    vscode.commands.registerCommand("opencli.showAudit", () => showAudit(channel)),
    vscode.commands.registerCommand("opencli.killSwitch", () => killSwitch(channel)),
  );
}

export function deactivate(): void {
  /* nothing to clean up — child processes are short-lived */
}

async function runAgent(channel: vscode.OutputChannel): Promise<void> {
  const cwd = workspaceDir();
  if (!cwd) {
    void vscode.window.showErrorMessage("OpenCLI: open a folder first.");
    return;
  }
  const instruction = await vscode.window.showInputBox({
    prompt: "What should the OpenCLI agent do?",
    placeHolder: "e.g. summarise src/kernel",
  });
  if (!instruction) return;

  channel.show(true);
  channel.appendLine(`\n$ opencli agent --json ${JSON.stringify(instruction)}`);

  const child = spawn(binaryPath(), ["agent", "--json", instruction], { cwd, shell: false });
  const rl = createInterface({ input: child.stdout });

  rl.on("line", (line) => {
    let event: AgentEvent;
    try {
      event = JSON.parse(line) as AgentEvent;
    } catch {
      return; // ignore non-JSON noise
    }
    channel.appendLine(formatEvent(event));
  });

  child.stderr.on("data", (d: Buffer) => channel.append(d.toString()));
  child.on("error", (err) => channel.appendLine(`error: ${err.message}`));
  child.on("close", (code) => channel.appendLine(`[opencli exited with code ${String(code)}]`));
}

function formatEvent(event: AgentEvent): string {
  switch (event.type) {
    case "run_start":
      return `▶ run ${event.session_id} (model ${event.model})`;
    case "iteration":
      return `· iteration ${String(event.n)}`;
    case "assistant":
      return `  ${event.content}`;
    case "tool_call": {
      const link = event.audit_event_id ? ` [audit ${event.audit_event_id}]` : "";
      return `  → ${event.name}: ${event.status}${link}`;
    }
    case "run_end":
      return `■ ${event.stop_reason} (${String(event.iterations)} iter, ${String(event.tool_calls)} tool calls)\n${event.answer}`;
    default:
      return JSON.stringify(event);
  }
}

function showAudit(channel: vscode.OutputChannel): void {
  const cwd = workspaceDir();
  channel.show(true);
  channel.appendLine("\n$ opencli audit show");
  const child = spawn(binaryPath(), ["audit", "show"], { cwd, shell: false });
  child.stdout.on("data", (d: Buffer) => channel.append(d.toString()));
  child.stderr.on("data", (d: Buffer) => channel.append(d.toString()));
  child.on("error", (err) => channel.appendLine(`error: ${err.message}`));
}

async function killSwitch(channel: vscode.OutputChannel): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    "Activate the OpenCLI kill switch? This halts all agent mutations until deactivated.",
    { modal: true },
    "Activate",
  );
  if (confirm !== "Activate") return;

  const cwd = workspaceDir();
  channel.show(true);
  channel.appendLine("\n$ opencli kill-switch activate --reason \"activated from VS Code\"");
  const child = spawn(
    binaryPath(),
    ["kill-switch", "activate", "--reason", "activated from VS Code"],
    { cwd, shell: false },
  );
  child.stdout.on("data", (d: Buffer) => channel.append(d.toString()));
  child.stderr.on("data", (d: Buffer) => channel.append(d.toString()));
  child.on("error", (err) => channel.appendLine(`error: ${err.message}`));
}
