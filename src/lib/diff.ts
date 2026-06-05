/**
 * Minimal line-based unified diff.
 *
 * Implemented locally (LCS over lines) rather than adding a dependency, since
 * OpenCLI keeps its surface small and the diff is only used for *proposals*
 * (it never drives a write). Output follows the standard unified-diff format
 * so it renders in any diff viewer.
 */

export function unifiedDiff(
  oldText: string,
  newText: string,
  oldName = "a",
  newName = "b",
  context = 3,
): string {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const ops = diffLines(oldLines, newLines);

  const hunks = groupIntoHunks(ops, context);
  if (hunks.length === 0) return ""; // identical

  const out: string[] = [`--- ${oldName}`, `+++ ${newName}`];
  for (const hunk of hunks) {
    out.push(
      `@@ -${String(hunk.oldStart)},${String(hunk.oldCount)} +${String(hunk.newStart)},${String(hunk.newCount)} @@`,
    );
    for (const line of hunk.lines) out.push(line);
  }
  return out.join("\n") + "\n";
}

type Op = { type: "eq" | "del" | "add"; line: string };

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  // A trailing newline yields a final empty element; drop it so line counts
  // reflect actual lines.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Classic LCS-based line diff. */
function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = length of LCS of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "eq", line: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ type: "del", line: a[i]! });
      i++;
    } else {
      ops.push({ type: "add", line: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", line: a[i++]! });
  while (j < m) ops.push({ type: "add", line: b[j++]! });
  return ops;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

/** Collapse runs of equal lines, keeping `context` lines around each change. */
function groupIntoHunks(ops: Op[], context: number): Hunk[] {
  // Mark which op indices are "interesting" (changes) or within context of one.
  const keep = new Array<boolean>(ops.length).fill(false);
  let any = false;
  for (let k = 0; k < ops.length; k++) {
    if (ops[k]!.type !== "eq") {
      any = true;
      for (let c = Math.max(0, k - context); c <= Math.min(ops.length - 1, k + context); c++) {
        keep[c] = true;
      }
    }
  }
  if (!any) return [];

  const hunks: Hunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  let cur: Hunk | null = null;

  for (let k = 0; k < ops.length; k++) {
    const op = ops[k]!;
    if (keep[k]) {
      if (!cur) {
        cur = { oldStart: oldLine, oldCount: 0, newStart: newLine, newCount: 0, lines: [] };
      }
      if (op.type === "eq") {
        cur.lines.push(` ${op.line}`);
        cur.oldCount++;
        cur.newCount++;
      } else if (op.type === "del") {
        cur.lines.push(`-${op.line}`);
        cur.oldCount++;
      } else {
        cur.lines.push(`+${op.line}`);
        cur.newCount++;
      }
    } else if (cur) {
      hunks.push(cur);
      cur = null;
    }

    if (op.type === "eq") {
      oldLine++;
      newLine++;
    } else if (op.type === "del") {
      oldLine++;
    } else {
      newLine++;
    }
  }
  if (cur) hunks.push(cur);
  return hunks;
}
