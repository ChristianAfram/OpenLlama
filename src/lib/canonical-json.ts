/**
 * Canonical JSON serialization — stable key order, no whitespace.
 *
 * Used exclusively for hash-chain inputs so that the same logical event
 * always produces the same bytes regardless of insertion order.
 */

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const pairs = Object.keys(obj)
    .sort()
    .map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k]));
  return "{" + pairs.join(",") + "}";
}
