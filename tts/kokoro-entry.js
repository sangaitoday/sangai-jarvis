import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';
import { latestOnly } from '../tts-engine-core.js';

/* global KOKORO_REVISION */
const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DTYPE = { webgpu: 'fp32', wasm: 'q8' };
// Weight file sizes at the pinned revision, so progress covers the one file that matters.
const MODEL_BYTES = { fp32: 325532232, q8: 92361116 };

env.allowLocalModels = false;
env.remotePathTemplate = `{model}/resolve/${KOKORO_REVISION}/`;
let listener = () => {};
let held = null;

const engineFor = latestOnly((backend) => {
  const loaded = new Map();
  const dtype = DTYPE[backend];
  held = KokoroTTS.from_pretrained(MODEL, {
    dtype,
    device: backend,
    progress_callback: (event) => {
      if (event.status !== 'progress') return;
      loaded.set(event.file, event.loaded);
      const bytes = [...loaded.values()].reduce((sum, n) => sum + n, 0);
      listener(Math.min(0.99, bytes / MODEL_BYTES[dtype]));
    },
  });
  return held;
});

export async function speak(text, voice, { progress, backend = 'webgpu', speed = 1 } = {}) {
  listener = progress || (() => {});
  const tts = await engineFor(backend);
  listener(1);
  try {
    return (await tts.generate(text, { voice, speed })).toBlob();
  } catch (error) {
    // A lost GPU device leaves the session unusable; the next reply rebuilds it from cache.
    dispose();
    throw error;
  }
}

export function dispose() {
  const current = held;
  held = null;
  engineFor.reset();
  current?.then((tts) => tts.model.dispose(), () => {});
}
