# MCP Policy Wrapper — Future Architecture (not yet implemented)

> **Status: design stub.** This document describes how Model Context Protocol
> (MCP) support *will* be added to OpenCLI. **No MCP runtime exists today.** MCP
> is intentionally absent from the README "What works today" list. This file
> exists so the integration is designed against the governance kernel *before*
> any code lands — not bolted on afterwards.

## Goal

Let OpenCLI consume tools exposed by external MCP servers **without creating any
new path to a side effect that bypasses the kernel**. The headline invariant is
unchanged and non-negotiable:

> No tool that mutates the world runs unless an audit write succeeds first.

An MCP server is **untrusted external code**. Its tool list, tool descriptions,
and tool results are all untrusted data. MCP support must therefore add zero
trust and zero privilege — every MCP call is just another `MutatingTool` flowing
through the existing `Executor`.

## Principles

1. **Every MCP tool becomes a `ToolDescriptor`.** An importer converts each
   advertised MCP tool into the same tool abstraction native tools use, with a
   Zod-validated argument schema. The reasoning engine sees no difference between
   a native tool and an MCP tool; both are dispatched identically.

2. **MCP tools are registered in the existing `ToolRegistry`.** There is no
   parallel registry, no separate dispatch path. If a tool is not in the
   registry, it cannot be called.

3. **MCP tools inherit permission levels — conservatively.** Imported tools
   default to a high floor (`permission_level: 4`, `requires_approval: true`,
   `risk_level: "high"`). A write-capable MCP tool (by server declaration or
   name/annotation heuristic) is raised to **Level 5** (manual confirmation every
   time). An MCP tool can never default to ALLOW for a mutation.

4. **Discovery is policy-filtered.** A `.opencli/servers.toml` registry declares
   servers with an `allowlisted` flag and a `default_level`. In `--enterprise`
   mode, a non-allowlisted server is **DENY**: its tools are never imported. A
   dedicated `mcp` policy rule enforces the server allowlist and the
   write-capable → confirmation floor.

5. **Mutating MCP tools route through the `Executor`.** An MCP tool's `apply()`
   (which calls the server) runs only after the executor has classified,
   policy-checked, approval-gated, and **audited** the action. There is no
   private apply path. Because the agent loop holds **no `ApprovalProvider`**,
   agent-driven MCP mutations stay blocked exactly like `git push` and
   `run_shell` today.

6. **All MCP calls are audited.** Events carry `source_kind: "mcp"`,
   `mcp_server`, and `mcp_tool` so the timeline distinguishes external tool calls
   from native ones. If the audit write fails, the MCP call does not run.

7. **All MCP results are fenced.** Tool results return through the normal
   tool-result path and are wrapped by `fenceUntrusted` before entering the
   context. Instruction-like text in an MCP response is inert data — covered by
   the prompt-injection eval category (a new `mcp-trust` category will assert a
   compromised server cannot cause an executed mutation or secret leak).

8. **Network egress passes the policy engine.** Connecting to an MCP server is
   itself a governed action: the egress policy rule evaluates the server
   transport/endpoint. A server the egress policy denies is never contacted.

9. **No grant propagation.** MCP tools never receive an `ApprovalProvider` the
   parent lacks. `ApprovalScope` binding means a grant for one server/tool cannot
   be reused for another.

## Out of scope for the stub

No client, importer, policy rule, registry parser, or command is implemented
yet. This document is the contract those pieces must satisfy. Implementation is
tracked as the next platform milestone (MCP client + policy wrapper) and will
ship behind the existing kernel with its own threat model
(`docs/threat-models/mcp.md`) and eval coverage.

## Kernel touch-points (when implemented)

| Component | Change |
|---|---|
| `src/kernel/audit.ts` | optional `source_kind`, `mcp_server`, `mcp_tool` fields (additive, nullable) |
| `src/policy/types.ts` + `rules/mcp.ts` | server allowlist; write-capable → confirmation; deny non-allowlisted in enterprise |
| `src/kernel/classifier.ts` | write-capable MCP tool floored at L5 |
| `src/mcp/` (new) | client (stdio JSON-RPC), importer (`MutatingTool[]`) |
| `src/tools/registry.ts` | imported MCP tools registered alongside native tools |

Every one of these is additive and routes through the same executor and ledger
that govern native tools. MCP adds reach, never a bypass.
