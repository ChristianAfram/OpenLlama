#!/usr/bin/env bash
# The 90-second OpenLlama thesis demo (see docs/demo.md).
# Build first:  npm run build
# Then run:     ./scripts/demo.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OL="node ${ROOT}/dist/index.js"

WORK="$(mktemp -d)"
export OPENLLAMA_AUDIT_DB="${WORK}/.audit.sqlite"
cd "${WORK}"
trap 'rm -rf "${WORK}"' EXIT

bar() { printf '\n═══ %s ═══\n' "$1"; }

bar "1. Create a file via the executor (classify → audit → write)"
$OL exec write_file --json '{"path":"feature.txt","content":"new feature code\n"}'

bar "2. The file exists"
cat feature.txt

bar "3. audit show — the action is on the ledger"
$OL audit show

bar "4. audit verify — chain intact"
$OL audit verify

bar "5. TAMPER: rewrite the event directly in SQLite, bypassing the trigger"
node -e '
const Database = require("'"${ROOT}"'/node_modules/better-sqlite3");
const db = new Database(process.env.OPENLLAMA_AUDIT_DB);
db.exec("DROP TRIGGER IF EXISTS no_update_events");
db.prepare("UPDATE events SET target = ? WHERE tool_name = ?").run("EVIL.txt", "write_file");
db.close();
console.log("  rewrote the write_file event target to EVIL.txt");
'

bar "6. audit verify — tampering detected, chain BREAKS"
if $OL audit verify; then
  echo "UNEXPECTED: verify passed after tamper" >&2
  exit 1
else
  echo "(verify exited non-zero, as it should)"
fi
