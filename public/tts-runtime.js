'use strict';
(function () {
  // One loader for the browser's ONNX voice engines.
  // Each engine is an ESM bundle exporting speak(text, voice, opts) → WAV Blob and dispose().
  // A bundle is imported once per page; a failed import is forgotten so the next call retries.
  function create({ bundleFor, importer = (url) => import(url) }) {
    const modules = new Map();

    function load(engine) {
      if (!modules.has(engine)) {
        const url = bundleFor(engine);
        const promise = url ? importer(url, engine) : Promise.reject(new Error(`No bundle for ${engine}`));
        promise.catch(() => modules.delete(engine));
        modules.set(engine, promise);
      }
      return modules.get(engine);
    }

    const speak = (engine, text, voice, opts) => load(engine).then((mod) => mod.speak(text, voice, opts));

    const dispose = (engine) => modules.get(engine)?.then((mod) => mod.dispose?.(), () => {});

    return { load, speak, dispose };
  }

  const api = { create };
  if (typeof window !== 'undefined') window.TtsRuntime = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
