/**
 * MCP (Model Context Protocol) wire types — JSON-RPC 2.0 + MCP 2024-11-05.
 *
 * These are the only external-protocol types in OpenCLI. They describe
 * what arrives over the stdio pipe; everything OpenCLI uses internally is
 * expressed in terms of ToolDescriptor / MutatingTool / PlannedMutation.
 */

// ─── JSON-RPC 2.0 ────────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number;
  result: T;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: number;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse<T = unknown> =
  | JsonRpcSuccessResponse<T>
  | JsonRpcErrorResponse;

// ─── MCP initialize ───────────────────────────────────────────────────────────

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpCapabilities {
  tools?: { listChanged?: boolean };
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: McpCapabilities;
  serverInfo: McpServerInfo;
}

// ─── MCP tools/list ──────────────────────────────────────────────────────────

export interface McpToolAnnotations {
  /** True if the tool only reads — never writes or has side effects. */
  readOnlyHint?: boolean;
  /** True if the tool may cause destructive or irreversible changes. */
  destructiveHint?: boolean;
  /** True if calling the tool multiple times with the same args is idempotent. */
  idempotentHint?: boolean;
}

export interface McpToolInputSchema {
  type: "object";
  properties?: Record<string, { type?: string; description?: string; [key: string]: unknown }>;
  required?: string[];
  [key: string]: unknown;
}

export interface McpToolDescription {
  name: string;
  description?: string;
  inputSchema?: McpToolInputSchema;
  annotations?: McpToolAnnotations;
}

export interface McpToolsListResult {
  tools: McpToolDescription[];
}

// ─── MCP tools/call ──────────────────────────────────────────────────────────

export interface McpContent {
  type: "text" | "image" | "resource";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface McpToolCallResult {
  content: McpContent[];
  /** True when the tool itself reported an error in its content. */
  isError?: boolean;
}
