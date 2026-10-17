#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SITE="$ROOT"
OUT="$SITE/public/onnx/piper"
PIPER_VOICES_REVISION=840e38a7e26d813bd6221b78cfbaefa3585b3f71
HF_PINNED="https://huggingface.co/diffusionstudio/piper-voices/resolve/$PIPER_VOICES_REVISION"
# Served from this origin so the default voices work without Hugging Face; every other voice loads from it.
LOCAL_VOICES=(en_US-lessac-medium vi_VN-vais1000-medium)
: "${TMPDIR:=$ROOT/tmp}"
mkdir -p "$TMPDIR"
BUILD_TMP="$(mktemp -d -p "$TMPDIR" build-talk-onnx.XXXXXX)"
trap 'rm -rf "$BUILD_TMP"' EXIT

npm install --prefix "$BUILD_TMP" --no-save --package-lock=false \
  @mintplex-labs/piper-tts-web@1.0.5 \
  onnxruntime-web@1.18.0 \
  @diffusionstudio/piper-wasm@1.0.0 \
  esbuild@0.25.5
LIB="$BUILD_TMP/node_modules/@mintplex-labs/piper-tts-web/dist/piper-tts-web.js"
node - "$LIB" "$HF_PINNED" "${LOCAL_VOICES[@]}" <<'NODE'
const fs = require('node:fs');
const [file, pinned, ...local] = process.argv.slice(2);
let source = fs.readFileSync(file, 'utf8');
const pathMap = Object.fromEntries([...source.matchAll(/^\s+"([a-z]{2}_[A-Z]{2}-[^"]+)": "([^"]+\.onnx)",?$/gm)].map((m) => [m[1], m[2]]));
const localPaths = local.map((id) => {
  if (!pathMap[id]) throw new Error(`bundled voice ${id} is not in piper-tts-web's PATH_MAP`);
  return pathMap[id];
});
const swap = (from, to, count) => {
  const found = source.split(from).length - 1;
  if (found !== count) throw new Error(`expected ${count} of ${JSON.stringify(from)} in piper-tts-web, found ${found}`);
  source = source.split(from).join(to);
};
swap('const HF_BASE = "https://huggingface.co/diffusionstudio/piper-voices/resolve/main";',
  `const HF_BASE = ${JSON.stringify(pinned)};\nconst LOCAL_PATHS = new Set(${JSON.stringify(localPaths)});\nconst baseFor = (path) => (LOCAL_PATHS.has(path) ? "/onnx/piper/models" : HF_BASE);`, 1);
swap('const ONNX_BASE = "https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.18.0/";', 'const ONNX_BASE = "/onnx/piper/ort/";', 1);
swap('const WASM_BASE = "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize";',
  'const WASM_BASE = "/onnx/piper/piper/piper_phonemize";', 1);
swap('${HF_BASE}/${path}', '${baseFor(path)}/${path}', 6);
fs.writeFileSync(file, source);
NODE

NODE_PATH="$BUILD_TMP/node_modules" "$BUILD_TMP/node_modules/.bin/esbuild" "$SITE/tts/piper-entry.js" \
  --bundle --format=esm --platform=browser --target=es2022 --minify \
  --external:fs --external:path --outfile="$BUILD_TMP/entry.js"
node "$SITE/tts-build.js" check "$BUILD_TMP/entry.js" "$(basename "$BUILD_TMP")"
# The published path carries a content hash: it is served immutable, so new bytes need a new URL.
HASH="$(sha256sum "$BUILD_TMP/entry.js" | cut -c1-12)"
mkdir -p "$OUT/ort" "$OUT/piper" "$OUT/models"
find "$OUT" -mindepth 1 -maxdepth 1 -type d ! -name ort ! -name piper ! -name models -exec rm -rf {} +
rm -f "$OUT/entry.js"
mkdir -p "$OUT/$HASH"
mv "$BUILD_TMP/entry.js" "$OUT/$HASH/entry.js"
cp "$BUILD_TMP/node_modules/onnxruntime-web/dist/ort-wasm"*.wasm "$OUT/ort/"
cp "$BUILD_TMP/node_modules/@diffusionstudio/piper-wasm/build/"* "$OUT/piper/"

curl --fail --location --silent --show-error "$HF_PINNED/voices.json" --output "$BUILD_TMP/voices.json"
node - "$LIB" "$BUILD_TMP/voices.json" "$OUT/models" "$BUILD_TMP/catalog-voices.json" "${LOCAL_VOICES[@]}" <<'NODE'
const fs = require('node:fs');
const [lib, voicesFile, modelsDir, outFile, ...local] = process.argv.slice(2);
const pathMap = Object.fromEntries([...fs.readFileSync(lib, 'utf8').matchAll(/^\s+"([a-z]{2}_[A-Z]{2}-[^"]+)": "([^"]+\.onnx)",?$/gm)].map((m) => [m[1], m[2]]));
const voices = JSON.parse(fs.readFileSync(voicesFile, 'utf8'));
const title = (name) => name.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const entry = (id, name, code, quality, bytes) => ({
  id, name: title(name), langs: [code.replace('_', '-')], quality: quality.replace('_', '-'), sizeMB: Math.round(bytes / 1e6),
});
(async () => {
  const catalog = Object.values(voices).filter((v) => pathMap[v.key])
    .map((v) => entry(v.key, v.name, v.language.code, v.quality, v.files[pathMap[v.key]].size_bytes));
  catalog.sort((a, b) => (a.id < b.id ? -1 : 1));
  const ids = catalog.map((v) => v.id);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate Piper voice id');
  const missing = [...Object.keys(voices), ...Object.keys(pathMap)].filter((id) => !ids.includes(id));
  if (missing.length) throw new Error(`Piper voices missing from the catalog: ${[...new Set(missing)].join(', ')}`);
  for (const id of local) {
    if (!ids.includes(id)) throw new Error(`bundled voice ${id} is missing from the catalog`);
    fs.writeFileSync(`${modelsDir}/.want-${id}`, pathMap[id]);
  }
  fs.writeFileSync(outFile, JSON.stringify(catalog));
  process.stdout.write(`${catalog.length} Piper voices in ${new Set(catalog.map((v) => v.langs[0])).size} locales\n`);
})().catch((error) => { console.error(error); process.exit(1); });
NODE
for marker in "$OUT/models"/.want-*; do
  voice_path="$(cat "$marker")"
  rm -f "$marker"
  mkdir -p "$OUT/models/$(dirname "$voice_path")"
  for suffix in "" .json; do
    [ -s "$OUT/models/$voice_path$suffix" ] && continue
    curl --fail --location --silent --show-error "$HF_PINNED/$voice_path$suffix" --output "$OUT/models/$voice_path$suffix"
  done
done
node "$SITE/tts-build.js" manifest "$SITE/public/talk-tts.json" piper "/onnx/piper/$HASH/entry.js" \
  "$PIPER_VOICES_REVISION" "$BUILD_TMP/catalog-voices.json"
printf 'Built local Piper browser assets at %s\n' "$OUT"
du -sh "$OUT"
