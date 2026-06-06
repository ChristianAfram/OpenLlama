/**
 * Stdio MCP client — JSON-RPC 2.0 over child-process stdin/stdout.
 *
 * Governance: the client only moves bits. All trust decisions (permission level,
 * audit write, approval gate) happen in the Executor after this call returns.
 * Every MCP tool call is therefore: resolve args → audit write → apply (= this
 * client call) — never skipping the kernel pipeline.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  JsonRpcResponse,
  McpInitializeResult,
  McpToolsListResult,
  McpToolCallResult,
} from "./types.js";

export interface McpClientOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Milliseconds before an unanswered request is rejected. Default: 10 000. */
  timeoutMs?: number;
}

export class McpClientError extends Error {
  override name = "McpClientError";
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class McpClient {
  private readonly proc: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private readonly timeoutMs: number;

  constructor(opts: McpClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 10_000;

    this.proc = spawn(opts.command, opts.args ?? [], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ...opts.env },
      shell: false,
    });

    const rl = createInterface({ input: this.proc.stdout! });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(trimmed) as JsonRpcResponse;
      } catch {
        return; // Server sent non-JSON diagnostic — ignore
      }
      const p = this.pending.get(msg.id as number);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id as number);
      if ("error" in msg) {
        p.reject(new McpClientError(`MCP JSON-RPC error ${msg.error.code}: ${msg.error.message}`));
      } else {
        p.resolve(msg.result);
      }
    });

    this.proc.on("close", () => {
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new McpClientError("MCP server process closed unexpectedly"));
      }
      this.pending.clear();
    });

    this.proc.on("error", (err) => {
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new McpClientError(`MCP server process error: ${err.message}`));
      }
      this.pending.clear();
    });
  }

  private request<T>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      return Promise.reject(new McpClientError("MCP client is closed"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpClientError(`MCP request timed out after ${this.timeoutMs}ms: ${method}`));
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });

      const msg = JSON.stringify(
        params !== undefined
          ? { jsonrpc: "2.0", id, method, params }
          : { jsonrpc: "2.0", id, method },
      );
      this.proc.stdin!.write(msg + "\n");
    });
  }

  /** Perform the MCP handshake. Must be called before listTools / callTool. */
  async initialize(): Promise<McpInitializeResult> {
    const result = await this.request<McpInitializeResult>("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "opencli", version: "0.7" },
    });
    // Send the required initialized notification (no response expected).
    this.proc.stdin!.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );
    return result;
  }

  /** List all tools advertised by the server. */
  listTools(): Promise<McpToolsListResult> {
    return this.request<McpToolsListResult>("tools/list");
  }

  /** Call a named tool with validated arguments. */
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    return this.request<McpToolCallResult>("tools/call", { name, arguments: args });
  }

  /** Terminate the server process and reject all pending requests. */
  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.proc.kill();
    }
  }
}
