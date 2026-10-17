#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SITE="$ROOT"
SUPERTONIC_REVISION=3cadd1ee6394adea1bd021217a0e650ede09a323
HELPER_COMMIT=1e9799e964ea4c0dad7cde993b65c3c813a7b373
HELPER_SHA256=a8200d50e2eabeb18c777b218ecb5214fd33fb623477e8b8378b4696179d125a
ORT_VERSION=1.30.0
KOKORO_REVISION=1939ad2a8e416c0acfeecc08a694d14ef25f2231
KOKORO_JS_VERSION=1.2.1
for tool in npm node curl sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || { printf 'Required tool missing: %s\n' "$tool" >&2; exit 1; }
done
: "${SANGAI_TMP:=$ROOT/tmp}"
mkdir -p "$SANGAI_TMP"
BUILD_TMP="$(mktemp -d -p "$SANGAI_TMP" build-talk-tts.XXXXXX)"
trap 'rm -rf "$BUILD_TMP"' EXIT

npm install --prefix "$BUILD_TMP" --no-save --package-lock=false "onnxruntime-web@$ORT_VERSION" esbuild@0.25.5

# Supertone's own browser client (MIT), pinned by commit and checksum, bundled like a dependency.
HELPER_PKG="$BUILD_TMP/node_modules/supertonic-helper"
mkdir -p "$HELPER_PKG"
curl --fail --location --silent --show-error \
  "https://raw.githubusercontent.com/supertone-inc/supertonic/$HELPER_COMMIT/web/helper.js" --output "$HELPER_PKG/index.js"
printf '%s  %s\n' "$HELPER_SHA256" "$HELPER_PKG/index.js" | sha256sum --check --quiet
printf '{"name":"supertonic-helper","type":"module","main":"index.js"}\n' > "$HELPER_PKG/package.json"
node - "$HELPER_PKG/index.js" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const from = "import * as ort from 'onnxruntime-web';";
const source = fs.readFileSync(file, 'utf8');
if (source.split(from).length !== 2) throw new Error('supertonic helper no longer imports onnxruntime-web the expected way');
fs.writeFileSync(file, source.replace(from, "import * as ort from 'onnxruntime-web/webgpu';"));
NODE

OUT="$BUILD_TMP/out"
mkdir -p "$OUT"
NODE_PATH="$BUILD_TMP/node_modules" "$BUILD_TMP/node_modules/.bin/esbuild" "$SITE/tts/supertonic3-entry.js" \
  --bundle --format=esm --platform=browser --target=es2022 --minify \
  --define:SUPERTONIC_REVISION="\"$SUPERTONIC_REVISION\"" --outfile="$OUT/entry.js"
node "$SITE/tts-build.js" check "$OUT/entry.js" "$(basename "$BUILD_TMP")"
cp "$BUILD_TMP/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify."{mjs,wasm} "$OUT/"
# The published path carries a content hash: it is served immutable, so new bytes need a new URL.
HASH="$(sha256sum "$OUT/entry.js" | cut -c1-12)"
DEST="$SITE/public/onnx/supertonic3"
rm -rf "$DEST"
mkdir -p "$DEST"
mv "$OUT" "$DEST/$HASH"
node "$SITE/tts-build.js" manifest "$SITE/public/talk-tts.json" supertonic3 "/onnx/supertonic3/$HASH/entry.js" "$SUPERTONIC_REVISION"
printf 'Built Supertonic 3 browser assets at %s\n' "$DEST/$HASH"
du -sh "$DEST"

# Kokoro gets its own prefix: transformers.js pins its own onnxruntime-web, unlike Supertonic's.
KOKORO_TMP="$BUILD_TMP/kokoro"
npm install --prefix "$KOKORO_TMP" --no-save --package-lock=false "kokoro-js@$KOKORO_JS_VERSION" esbuild@0.25.5
# kokoro-js imports fs/promises and path for Node only; the browser path never touches them.
mkdir -p "$KOKORO_TMP/node_modules/node-builtin-stub"
printf 'export default {};\n' > "$KOKORO_TMP/node_modules/node-builtin-stub/index.js"
printf '{"name":"node-builtin-stub","type":"module","main":"index.js"}\n' > "$KOKORO_TMP/node_modules/node-builtin-stub/package.json"
node - "$KOKORO_TMP/node_modules" "$KOKORO_REVISION" "$KOKORO_TMP/voices.json" <<'NODE'
const fs = require('node:fs');
const [modules, revision, voicesOut] = process.argv.slice(2);
const swap = (file, from, to) => {
  const source = fs.readFileSync(file, 'utf8');
  if (source.split(from).length !== 2) throw new Error(`expected one ${JSON.stringify(from.slice(0, 60))} in ${file}`);
  fs.writeFileSync(file, source.replace(from, to));
};
const kokoro = `${modules}/kokoro-js/dist/kokoro.js`;
swap(kokoro, 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/',
  `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/${revision}/voices/`);
// The runtime files ship beside the bundle, never from a CDN.
swap(`${modules}/@huggingface/transformers/dist/transformers.web.js`,
  'ONNX_ENV.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${_env_js__WEBPACK_IMPORTED_MODULE_0__.env.version}/dist/`;',
  "ONNX_ENV.wasm.wasmPaths = new URL('./', import.meta.url).href;");
// ORT prints ordinary CPU fallbacks as warnings, which browsers show as errors; kokoro-js offers no session options.
swap(`${modules}/@huggingface/transformers/dist/transformers.web.js`,
  'InferenceSession.create(buffer_or_path, session_options)',
  'InferenceSession.create(buffer_or_path, { logSeverityLevel: 3, ...session_options })');
const source = fs.readFileSync(kokoro, 'utf8');
const start = source.indexOf('Object.freeze({af_heart:') + 'Object.freeze('.length;
let depth = 0;
let end = start;
for (; end < source.length; end += 1) {
  if (source[end] === '{') depth += 1;
  else if (source[end] === '}' && --depth === 0) break;
}
const table = Function(`return ${source.slice(start, end + 1)}`)();
const voices = Object.entries(table).map(([id, v]) => ({
  id,
  name: v.name,
  gender: v.gender.toLowerCase(),
  langs: [v.language.replace(/^(\w+)-(\w+)$/, (m, l, r) => `${l}-${r.toUpperCase()}`)],
  quality: `grade ${v.overallGrade}`,
}));
if (!voices.length || voices.some((v) => !/^[a-z]{2}-[A-Z]{2}$/.test(v.langs[0]))) throw new Error('unexpected kokoro-js voice table');
fs.writeFileSync(voicesOut, JSON.stringify(voices));
process.stdout.write(`${voices.length} Kokoro voices\n`);
NODE
KOKORO_OUT="$KOKORO_TMP/out"
mkdir -p "$KOKORO_OUT"
NODE_PATH="$KOKORO_TMP/node_modules" "$KOKORO_TMP/node_modules/.bin/esbuild" "$SITE/tts/kokoro-entry.js" \
  --bundle --format=esm --platform=browser --target=es2022 --minify \
  --alias:fs/promises=node-builtin-stub --alias:path=node-builtin-stub \
  --define:KOKORO_REVISION="\"$KOKORO_REVISION\"" --outfile="$KOKORO_OUT/entry.js"
node "$SITE/tts-build.js" check "$KOKORO_OUT/entry.js" "$(basename "$BUILD_TMP")"
cp "$KOKORO_TMP/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded."{mjs,wasm,jsep.mjs,jsep.wasm} "$KOKORO_OUT/"
KOKORO_HASH="$(sha256sum "$KOKORO_OUT/entry.js" | cut -c1-12)"
KOKORO_DEST="$SITE/public/onnx/kokoro"
rm -rf "$KOKORO_DEST"
mkdir -p "$KOKORO_DEST"
mv "$KOKORO_OUT" "$KOKORO_DEST/$KOKORO_HASH"
node "$SITE/tts-build.js" manifest "$SITE/public/talk-tts.json" kokoro "/onnx/kokoro/$KOKORO_HASH/entry.js" \
  "$KOKORO_REVISION" "$KOKORO_TMP/voices.json"
printf 'Built Kokoro browser assets at %s\n' "$KOKORO_DEST/$KOKORO_HASH"
du -sh "$KOKORO_DEST"
