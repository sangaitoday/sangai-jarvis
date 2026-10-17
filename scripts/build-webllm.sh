#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
for tool in npm node; do
  command -v "$tool" >/dev/null 2>&1 || { printf 'Required tool missing: %s\n' "$tool" >&2; exit 1; }
: "${TMPDIR:=$ROOT/tmp}"
mkdir -p "$TMPDIR"
BUILD_TMP="$(mktemp -d -p "$TMPDIR" talk-models-build.XXXXXX)"
trap 'rm -rf "$BUILD_TMP"' EXIT

WEBLLM_VERSION=0.2.85
OUT="$BUILD_TMP/out"
npm install --prefix "$BUILD_TMP" --no-save --package-lock=false \
  "@mlc-ai/web-llm@$WEBLLM_VERSION" esbuild@0.25.5
mkdir -p "$OUT"
cat > "$BUILD_TMP/engine-entry.js" <<'EOF'
export { CreateWebWorkerMLCEngine } from '@mlc-ai/web-llm';
EOF
cat > "$BUILD_TMP/worker-entry.js" <<'EOF'
import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm';
const h = new WebWorkerMLCEngineHandler();
self.onmessage = (m) => h.onmessage(m);
EOF
"$BUILD_TMP/node_modules/.bin/esbuild" "$BUILD_TMP/engine-entry.js" \
  --bundle --format=esm --platform=browser --target=es2022 --minify \
  --outfile="$OUT/engine.js"
"$BUILD_TMP/node_modules/.bin/esbuild" "$BUILD_TMP/worker-entry.js" \
  --bundle --format=esm --platform=browser --target=es2022 --minify \
  --outfile="$OUT/worker.js"
if grep -q "$(basename "$BUILD_TMP")" "$OUT/engine.js" "$OUT/worker.js"; then
  printf 'Build path leaked into the WebLLM bundles in %s\n' "$OUT" >&2
  exit 1
fi
# The published path carries a content hash: it is served immutable, so new bytes need a new URL.
BUNDLE="$WEBLLM_VERSION/$(cat "$OUT/engine.js" "$OUT/worker.js" | sha256sum | cut -c1-12)"
rm -rf "$ROOT/public/webllm"
mkdir -p "$ROOT/public/webllm/$BUNDLE"
mv "$OUT/engine.js" "$OUT/worker.js" "$ROOT/public/webllm/$BUNDLE/"
node - "$BUILD_TMP" "$ROOT" "$BUNDLE" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { prebuiltAppConfig } = require(path.join(process.argv[2], 'node_modules/@mlc-ai/web-llm/lib/index.js'));
const { buildCatalog } = require(path.join(process.argv[3], 'talk-models-catalog.js'));
const version = require(path.join(process.argv[2], 'node_modules/@mlc-ai/web-llm/package.json')).version;
const destination = path.join(process.argv[3], 'public/talk-models.json');
const temporary = `${destination}.tmp`;
const data = Buffer.from(`${JSON.stringify({ ...buildCatalog(prebuiltAppConfig.model_list, version), bundle: process.argv[4] }, null, 2)}\n`);
const fd = fs.openSync(temporary, 'w');
try {
  fs.writeSync(fd, data);
  fs.fsyncSync(fd);
} finally {
  fs.closeSync(fd);
}
fs.renameSync(temporary, destination);
NODE
