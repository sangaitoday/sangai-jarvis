import { TtsSession } from '@mintplex-labs/piper-tts-web';
import { downloadFraction, latestOnly } from '../tts-engine-core.js';

const root = '/onnx/piper/';
let listener = () => {};
let expectedBytes = 0;
const sessionFor = latestOnly((voiceId) => {
  // The library keeps one session; clearing it is how a new voice gets loaded.
  TtsSession._instance = null;
  return TtsSession.create({
    voiceId,
    progress: (event) => listener(downloadFraction(event.loaded, event.total, expectedBytes)),
    wasmPaths: {
      onnxWasm: root + 'ort/',
      piperData: root + 'piper/piper_phonemize.data',
      piperWasm: root + 'piper/piper_phonemize.wasm',
    },
  });
});

export async function speak(text, voiceId, { progress, sizeBytes = 0 } = {}) {
  listener = progress || (() => {});
  expectedBytes = sizeBytes;
  const session = await sessionFor(voiceId);
  listener(1);
  return session.predict(text);
}

export function dispose() {
  sessionFor.reset();
  TtsSession._instance = null;
}
