#!/usr/bin/env bash
# Build Linux packages without touching another product's artifacts or shortcuts.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
if [ "$(uname -s)" != "Linux" ]; then
    echo "Linux packaging requires a Linux host." >&2
    exit 2
fi
npm run tauri:build -- -- --locked
mkdir -p "$ROOT/release"
for format in deb appimage; do
    for artifact in "$ROOT/src-tauri/target/release/bundle/$format/"*; do
        [ -f "$artifact" ] || continue
        cp -f "$artifact" "$ROOT/release/"
    done
done
