import * as ort from 'onnxruntime-web/webgpu';
import { TextToSpeech, loadCfgs, loadTextProcessor, loadVoiceStyle, writeWavFile } from 'supertonic-helper';
import { fetchCached } from '../tts-engine-core.js';

/* global SUPERTONIC_REVISION */
const BASE = `https://huggingface.co/Supertone/supertonic-3/resolve/${SUPERTONIC_REVISION}`;
const CACHE = 'onnx/supertonic3';
// Byte sizes at the pinned revision, so one progress bar covers all four downloads.
const MODELS = [
  ['duration_predictor', 3700147],
  ['text_encoder', 36416150],
  ['vector_estimator', 256534781],
  ['vocoder', 101424195],
];
const TOTAL_BYTES = MODELS.reduce((sum, [, bytes]) => sum + bytes, 0);
const STEPS = 5;
const SPEED = 1.05;

// Building the GPU sessions takes ~20 s even from cache, so it gets its own share of the bar.
const DOWNLOAD_SHARE = 0.9;
// ORT reports ordinary CPU fallbacks for a few nodes as warnings, which browsers print as errors.
const SESSION_OPTIONS = { executionProviders: ['webgpu'], logSeverityLevel: 3 };

ort.env.wasm.wasmPaths = new URL('./', import.meta.url).href;
let listener = () => {};
let engine = null;
const styles = new Map();

async function buildEngine() {
  const sessions = [];
  let done = 0;
  for (const [name, bytes] of MODELS) {
    const data = await fetchCached(`${BASE}/onnx/${name}.onnx`, {
      cacheName: CACHE,
      expectedBytes: bytes,
      progress: (fraction) => listener((DOWNLOAD_SHARE * (done + fraction * bytes)) / TOTAL_BYTES + ((1 - DOWNLOAD_SHARE) * sessions.length) / MODELS.length),
    });
    done += bytes;
    sessions.push(await ort.InferenceSession.create(data, SESSION_OPTIONS));
    listener((DOWNLOAD_SHARE * done) / TOTAL_BYTES + ((1 - DOWNLOAD_SHARE) * sessions.length) / MODELS.length);
  }
  const [cfgs, textProcessor] = await Promise.all([loadCfgs(`${BASE}/onnx`), loadTextProcessor(`${BASE}/onnx`)]);
  return new TextToSpeech(cfgs, textProcessor, ...sessions);
}

function loadEngine() {
  if (!engine) {
    engine = buildEngine();
    engine.catch(() => { engine = null; });
  }
  return engine;
}

function styleFor(voice) {
  if (!styles.has(voice)) {
    const style = loadVoiceStyle([`${BASE}/voice_styles/${voice}.json`]);
    style.catch(() => styles.delete(voice));
    styles.set(voice, style);
  }
  return styles.get(voice);
}

export async function speak(text, voice, { lang = 'en', progress, speed = SPEED, steps = STEPS } = {}) {
  listener = progress || (() => {});
  const [tts, style] = await Promise.all([loadEngine(), styleFor(voice)]);
  listener(1);
  try {
    const { wav } = await tts.call(text, String(lang).slice(0, 2).toLowerCase(), style, steps, speed);
    return new Blob([writeWavFile(wav, tts.sampleRate)], { type: 'audio/wav' });
  } catch (error) {
    // A lost GPU device leaves every session unusable; the next reply rebuilds them from cache.
    dispose();
    throw error;
  }
}

export function dispose() {
  const held = engine;
  engine = null;
  held?.then((tts) => Promise.all([tts.dpOrt, tts.textEncOrt, tts.vectorEstOrt, tts.vocoderOrt].map((s) => s.release())), () => {});
}
