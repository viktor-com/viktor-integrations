#!/usr/bin/env bash
# Run vitest tests matching a name pattern and fail unless at least one test ran and all passed.
# Usage: scripts/vt.sh <package-dir> <test-file> <name-pattern>
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root/$1"
out="$(npx vitest run "$2" -t "$3" --reporter=json 2>/dev/null || true)"
node -e '
const r = JSON.parse(process.argv[1].slice(process.argv[1].indexOf("{")));
if (r.numFailedTests > 0 || r.numPassedTests < 1) { console.error(`passed=${r.numPassedTests} failed=${r.numFailedTests}`); process.exit(1); }
' "$out"
