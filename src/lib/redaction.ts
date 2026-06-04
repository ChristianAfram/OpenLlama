/**
 * Secret redaction for audit events.
 *
 * Any value passed through `redactValue` or `redactEventFields` that matches
 * a secret pattern is replaced with a placeholder. A redaction record (the
 * pattern matched + a SHA-256 of the original value, never the value itself)
 * is appended to the event's `redactions` array.
 *
 * Rules (framework §11, §17, §31):
 *   - Secrets are NEVER written in the clear to the ledger.
 *   - The ledger records *that* a secret was touched, plus a hash of the value.
 *   - Redaction is mandatory, not optional.
 */

import { createHash } from "node:crypto";

export interface RedactionRecord {
  field: string;
  original_sha256: string;
  pattern: string;
}

/** Opaque marker written in place of a redacted value. */
export const REDACTED = "[REDACTED]";

/**
 * Patterns that identify secret-looking strings. Order matters: first match wins.
 * Each entry has a name (written to the redaction record) and a regex.
 */
const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  // PEM-encoded private material
  { name: "pem_private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/i },
  // Common bearer / API token prefixes
  { name: "bearer_token", re: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/i },
  // Anthropic / OpenAI style keys: sk- prefix, 20+ chars (alphanum or hyphen)
  { name: "sk_api_key", re: /\bsk-[A-Za-z0-9-]{20,}\b/ },
  // GitHub personal access tokens (classic and fine-grained)
  { name: "github_pat", re: /\bghp_[A-Za-z0-9]{36,}\b/ },
  { name: "github_pat_fine", re: /\bgithub_pat_[A-Za-z0-9_]{82,}\b/ },
  // AWS access key id
  { name: "aws_access_key", re: /\b(AKIA|ASIA|AROA)[A-Z0-9]{16}\b/ },
  // Generic: assignment-style secret/password/token/key in a string
  {
    name: "env_assignment",
    re: /\b(?:secret|password|passwd|token|api[_-]?key|private[_-]?key)\s*=\s*['"]?[^\s'"]{8,}/i,
  },
  // Long base64-like blobs (>= 40 chars of base64 alphabet)
  { name: "base64_blob", re: /[A-Za-z0-9+/]{40,}={0,2}/ },
];

/**
 * Paths (partial, case-insensitive) whose entire value is unconditionally
 * redacted regardless of content — e.g. `.env`, `id_rsa`, `credentials`.
 */
const SECRET_PATH_FRAGMENTS = [
  ".env",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  "credentials",
  "secrets",
  ".npmrc",
  ".netrc",
  "auth.json",
  "service-account",
];

export function isSecretPath(path: string): boolean {
  const lower = path.toLowerCase();
  return SECRET_PATH_FRAGMENTS.some((frag) => lower.includes(frag));
}

/**
 * Inspect a string value; if it matches any secret pattern, return the
 * redacted placeholder and a RedactionRecord. Otherwise return unchanged.
 */
export function redactValue(
  fieldName: string,
  value: string,
): { value: string; record: RedactionRecord | null } {
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(value)) {
      return {
        value: REDACTED,
        record: {
          field: fieldName,
          original_sha256: sha256(value),
          pattern: name,
        },
      };
    }
  }
  return { value, record: null };
}

/**
 * Walk a plain object or array, redacting any string values that look like
 * secrets. Returns the sanitised copy and a list of redaction records.
 */
export function redactDeep(
  fieldName: string,
  data: unknown,
): { value: unknown; records: RedactionRecord[] } {
  if (typeof data === "string") {
    const { value, record } = redactValue(fieldName, data);
    return { value, records: record ? [record] : [] };
  }
  if (Array.isArray(data)) {
    const records: RedactionRecord[] = [];
    const value = data.map((item, i) => {
      const r = redactDeep(`${fieldName}[${i}]`, item);
      records.push(...r.records);
      return r.value;
    });
    return { value, records };
  }
  if (data !== null && typeof data === "object") {
    const records: RedactionRecord[] = [];
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      const r = redactDeep(`${fieldName}.${k}`, v);
      records.push(...r.records);
      out[k] = r.value;
    }
    return { value: out, records };
  }
  return { value: data, records: [] };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
