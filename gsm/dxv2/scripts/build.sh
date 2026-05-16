#!/usr/bin/env bash
# Rebuild dxv2/build/translator.wasm from scripts/database.js + scripts/rules.js.
# Re-run this any time you edit those two files.
set -euo pipefail

# Move into the project root (parent of this scripts/ directory) so paths
# like build/, node_modules/, scripts/compile_build.js all resolve correctly
# regardless of where the script was invoked from.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

if ! command -v node >/dev/null 2>&1; then
    echo "error: 'node' is not on your PATH. Install Node.js (>=18) and try again." >&2
    exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
    echo "error: 'npm' is not on your PATH. Install Node.js (which ships with npm) and try again." >&2
    exit 1
fi

# Install dependencies the first time, or whenever node_modules is missing.
if [ ! -d node_modules ]; then
    echo "==> installing dependencies (first run)"
    npm install --no-audit --no-fund
fi

echo "==> building translator.wasm"
node scripts/compile_build.js

echo
echo "Build complete. Output: build/translator.wasm"
