'use strict';
(function () {
  // Where each engine keeps its downloads: Piper (piper-tts-web) in the OPFS folder "piper",
  // Supertonic in its own Cache Storage bucket, Kokoro in transformers.js's shared cache.
  const CACHES = { supertonic3: 'onnx/supertonic3', transformers: 'transformers-cache', kokoroVoices: 'kokoro-voices' };
  const SUPERTONIC_FILES = ['duration_predictor.onnx', 'text_encoder.onnx', 'vector_estimator.onnx', 'vocoder.onnx'];
  const KOKORO_REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX';
  const KOKORO_FILES = { webgpu: '/onnx/model.onnx', wasm: '/onnx/model_quantized.onnx' };

  const defaults = () => ({
    cachesImpl: typeof caches !== 'undefined' ? caches : null,
    storageImpl: typeof navigator !== 'undefined' && navigator.storage ? navigator.storage : null,
  });

  async function cachedUrls(cachesImpl, name) {
    if (!cachesImpl || !(await cachesImpl.has(name))) return [];
    return (await (await cachesImpl.open(name)).keys()).map((request) => request.url);
  }

  async function piperFolder(storageImpl) {
    if (!storageImpl?.getDirectory) return null;
    try {
      return await (await storageImpl.getDirectory()).getDirectoryHandle('piper');
    } catch (error) {
      if (error.name === 'NotFoundError') return null;
      throw error;
    }
  }

  async function storedVoices(options = {}) {
    const { cachesImpl, storageImpl } = { ...defaults(), ...options };
    const piper = new Set();
    const folder = await piperFolder(storageImpl);
    if (folder) {
      for await (const [name] of folder.entries()) {
        if (name.endsWith('.onnx')) piper.add(name.slice(0, -'.onnx'.length));
      }
    }
    const supertonic = await cachedUrls(cachesImpl, CACHES.supertonic3);
    const transformers = (await cachedUrls(cachesImpl, CACHES.transformers)).filter((url) => url.includes(`/${KOKORO_REPO}/`));
    return {
      piper,
      supertonic3: SUPERTONIC_FILES.every((file) => supertonic.some((url) => url.endsWith(`/${file}`))),
      kokoro: {
        webgpu: transformers.some((url) => url.endsWith(KOKORO_FILES.webgpu)),
        wasm: transformers.some((url) => url.endsWith(KOKORO_FILES.wasm)),
      },
    };
  }

  function isStored(found, row) {
    if (row.engine === 'piper') return found.piper.has(row.voice);
    if (row.engine === 'supertonic3') return found.supertonic3;
    if (row.engine === 'kokoro') return Boolean(found.kokoro[row.backend]);
    return false;
  }

  async function removeVoice(row, options = {}) {
    const { cachesImpl, storageImpl } = { ...defaults(), ...options };
    if (row.engine === 'piper') {
      const folder = await piperFolder(storageImpl);
      for (const name of [`${row.voice}.onnx`, `${row.voice}.onnx.json`]) {
        try {
          await folder?.removeEntry(name);
        } catch (error) {
          if (error.name !== 'NotFoundError') throw error;
        }
      }
    } else if (row.engine === 'supertonic3') {
      await cachesImpl?.delete(CACHES.supertonic3);
    } else if (row.engine === 'kokoro') {
      if (!cachesImpl) return;
      const urls = (await cachedUrls(cachesImpl, CACHES.transformers)).filter((url) => url.includes(`/${KOKORO_REPO}/`));
      const cache = urls.length ? await cachesImpl.open(CACHES.transformers) : null;
      for (const url of urls) await cache.delete(url);
      await cachesImpl.delete(CACHES.kokoroVoices);
    }
  }

  const api = { CACHES, KOKORO_REPO, storedVoices, isStored, removeVoice };
  if (typeof window !== 'undefined') window.TtsStorage = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
