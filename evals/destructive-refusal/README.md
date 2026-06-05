# destructive-refusal

Proves destructive actions (`rm -rf`, `DROP TABLE`, `mkfs`, `git reset --hard`,
force-push, protected-branch push) are blocked without manual confirmation.

Cases: [`src/evals/cases/destructive-refusal.ts`](../../src/evals/cases/destructive-refusal.ts).
Gate: **100%** (hard release gate, Master Plan §11).
