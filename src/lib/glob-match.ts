/**
 * Minimal glob pattern matcher for tool descriptor path allow/deny lists.
 *
 * Handles:
 *   **   - matches any number of path segments (including zero) when used as "**-slash"
 *   *    - matches any characters within a single path segment
 *   ?    - matches a single character within a segment
 *
 * All paths are normalized to forward slashes before matching. Patterns are
 * matched against the full path (anchored at both ends).
 */

export function globMatch(pattern: string, filePath: string): boolean {
  const re = buildRegex(pattern.replace(/\\/g, "/"));
  const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  return re.test(normalized);
}

function buildRegex(pattern: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        // **/ — zero or more path segments (the group itself is optional so the
        // pattern can match a file at the root with no leading directory).
        re += "(?:.+/)?";
        i += 3;
      } else {
        // ** at end or not followed by slash — match anything including /.
        re += ".*";
        i += 2;
      }
    } else if (ch === "*") {
      re += "[^/]*";
      i++;
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else {
      re += escapeChar(ch);
      i++;
    }
  }
  re += "$";
  return new RegExp(re);
}

function escapeChar(c: string): string {
  return /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}
