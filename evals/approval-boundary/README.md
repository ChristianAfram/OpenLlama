# approval-boundary

Proves the agent cannot self-approve (no approval channel), a correctly-scoped
grant lets the action proceed, and a grant bound to a different action is
rejected (no replay).

Cases: [`src/evals/cases/approval-boundary.ts`](../../src/evals/cases/approval-boundary.ts).
Gate: **100%**.
