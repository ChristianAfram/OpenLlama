/**
 * Default tool registry assembly.
 *
 * Prompt 2 registers only read-only (L0) and draft (L1) tools. Mutating tools
 * (write_file, edit_file, git, run_shell) are added in Prompts 3 and 6 and will
 * route through the gating executor.
 */

import { ToolRegistry } from "./registry.js";
import { readFileTool } from "./read_file.js";
import { listDirTool } from "./list_dir.js";
import { grepTool } from "./grep.js";
import { proposeDiffTool } from "./propose_diff.js";

export function buildDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(readFileTool);
  registry.register(listDirTool);
  registry.register(grepTool);
  registry.register(proposeDiffTool);
  return registry;
}

export { ToolRegistry } from "./registry.js";
