#!/usr/bin/env bash
# Run pytest tests matching -k in a Python workspace package. pytest exits 5 when nothing matches, so this is never vacuous.
# Usage: scripts/pt.sh <package-name> <tests-dir> <k-expression>
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)/python"
uv run -q --package "$1" pytest "$2" -q -k "$3" >/dev/null
