/**
 * Default tool registry assembly.
 *
 * Read-only (L0) and draft (L1) tools dispatch directly; mutating tools (L3+)
 * route through the gating executor. write_file (L3) lands in Prompt 3; the
 * higher-risk mutating tools (edit_file, git, run_shell) arrive in Prompt 6.
 */

import { ToolRegistry } from "./registry.js";
import { readFileTool } from "./read_file.js";
import { listDirTool } from "./list_dir.js";
import { grepTool } from "./grep.js";
import { proposeDiffTool } from "./propose_diff.js";
import { writeFileTool } from "./write_file.js";
import { editFileTool } from "./edit_file.js";
import { runShellTool } from "./run_shell.js";
import { gitTool } from "./git.js";

export function buildDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(readFileTool);
  registry.register(listDirTool);
  registry.register(grepTool);
  registry.register(proposeDiffTool);
  registry.register(writeFileTool);
  registry.register(editFileTool);
  registry.register(runShellTool);
  registry.register(gitTool);
  return registry;
}

export { ToolRegistry } from "./registry.js";
