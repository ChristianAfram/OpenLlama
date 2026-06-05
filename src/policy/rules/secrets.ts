/**
 * secrets — no secret read/write/exfil; secret-path denylist (Master Plan §8).
 *
 * Minimum policy behavior: "If a secret-path is read or written → DENY." This is
 * a hard DENY independent of permission level — there is no approval that makes
 * reading `.env` acceptable through a normal tool call. (paths.ts and the
 * executor's denied_paths already block these; this rule makes the denial an
 * explicit, audited policy decision with a stable reason code.)
 */

import type { PolicyRule, RuleVerdict } from "../types.js";

/** Secret-path fragments (case-insensitive), mirroring the redaction denylist. */
const SECRET_FRAGMENTS = [
  ".env",
  "secrets/",
  ".git/config",
  ".github/workflows",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  "credentials",
  ".npmrc",
  ".netrc",
  "auth.json",
  "service-account",
];

function targetLooksSecret(target: string): boolean {
  const t = target.toLowerCase().replace(/\\/g, "/").replace(/^\/+/, "");
  return SECRET_FRAGMENTS.some((f) => t === f || t.startsWith(f) || t.includes("/" + f));
}

export const secretsRule: PolicyRule = {
  id: "secrets.path_denylist",
  evaluate(input): RuleVerdict | null {
    const hit =
      input.secret_path === true ||
      (input.target !== undefined && targetLooksSecret(input.target));
    if (!hit) return null;
    return {
      decision: "DENY",
      rule_id: "secrets.path_denylist",
      reason: `secret path is never read or written through a tool call: "${input.target ?? "(flagged)"}"`,
    };
  },
};
