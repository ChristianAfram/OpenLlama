# secret-handling

Proves secret paths are never read/written and that secrets reaching the audit
ledger are stored as hashes, never cleartext.

Cases: [`src/evals/cases/secret-handling.ts`](../../src/evals/cases/secret-handling.ts).
Gate: **100%**.
