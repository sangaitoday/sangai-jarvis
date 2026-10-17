'use strict';
(function () {
  const TALK_LANGS = ['en', 'vi'];
  const PIPER_DEFAULTS = { en: 'en_US-lessac-medium', vi: 'vi_VN-vais1000-medium' };
  const SUPERTONIC_LANGS = ['en-US', 'vi-VN'];
  const supertonicVoice = (id) => ({
    id,
    name: `${id[0] === 'M' ? 'Male' : 'Female'} ${id.slice(1)}`,
    gender: id[0] === 'M' ? 'male' : 'female',
    langs: SUPERTONIC_LANGS,
  });
  const ENGINES = [
    { id: 'piper', label: 'Piper', backends: ['wasm'], voices: [] },
    {
      id: 'supertonic3',
      label: 'Supertonic 3',
      backends: ['webgpu'],
      sizeMB: 401,
      voices: ['M1', 'M2', 'M3', 'M4', 'M5', 'F1', 'F2', 'F3', 'F4', 'F5'].map(supertonicVoice),
    },
    // Full precision on WebGPU; the 8-bit build keeps WASM-only devices at a quarter of the download.
    { id: 'kokoro', label: 'Kokoro', backends: ['webgpu', 'wasm'], sizeMB: { webgpu: 326, wasm: 93 }, voices: [] },
  ];
  let manifest = { bundles: {}, voices: {} };

  const baseLang = (lang) => String(lang || '').slice(0, 2).toLowerCase();
  const voiceKey = (engine, voice) => `${engine}:${voice}`;
  const engineById = (id) => ENGINES.find((e) => e.id === id) || null;
  const voicesOf = (engine) => (manifest.voices[engine.id] || []).concat(engine.voices);

  function useManifest(next) {
    manifest = { bundles: next.bundles || {}, voices: next.voices || {} };
  }

  function parseVoiceKey(key) {
    const at = String(key || '').indexOf(':');
    if (at < 1) return null;
    const engine = key.slice(0, at);
    return engineById(engine) ? { engine, voice: key.slice(at + 1) } : null;
  }

  function findVoice(key) {
    const parsed = parseVoiceKey(key);
    if (!parsed) return null;
    return voicesOf(engineById(parsed.engine)).find((v) => v.id === parsed.voice) || null;
  }

  // Runs before the manifest loads, so it recognises a Piper id by shape; voiceForReply vets it later.
  function migrateStoredVoice(storedEngine, storedVoice) {
    if (parseVoiceKey(storedVoice)) return storedVoice;
    if (storedEngine !== 'onnx' || !/^[a-z]{2,3}_[A-Z]{2}-[\w-]+$/.test(storedVoice || '')) return '';
    return voiceKey('piper', storedVoice);
  }

  function backendFor(engineId, caps) {
    const engine = engineById(engineId);
    if (!engine || !manifest.bundles[engineId]) return null;
    return engine.backends.find((b) => caps[b]) || null;
  }

  function voiceForReply(key, lang, caps) {
    const want = baseLang(lang);
    const fallback = backendFor('piper', caps) ? voiceKey('piper', PIPER_DEFAULTS[want] || PIPER_DEFAULTS.en) : '';
    const voice = findVoice(key);
    if (!voice || !backendFor(parseVoiceKey(key).engine, caps)) return fallback;
    const langs = voice.langs.map(baseLang);
    if (langs.includes(want)) return key;
    return langs.some((l) => TALK_LANGS.includes(l)) ? fallback : key;
  }

  function rowsOf(engine, backend) {
    const engineSize = typeof engine.sizeMB === 'object' ? engine.sizeMB[backend || engine.backends[0]] : engine.sizeMB;
    return voicesOf(engine).map((v) => ({
      key: voiceKey(engine.id, v.id),
      engine: engine.id,
      voice: v.id,
      engineLabel: engine.label,
      name: v.name,
      gender: v.gender || null,
      quality: v.quality || null,
      rawLangs: v.langs,
      backend,
      sizeMB: v.sizeMB || engineSize,
    }));
  }

  function voiceRows(caps) {
    return ENGINES.flatMap((engine) => {
      const backend = backendFor(engine.id, caps);
      return backend ? rowsOf(engine, backend) : [];
    });
  }

  function allVoiceRows(caps) {
    return ENGINES.filter((engine) => manifest.bundles[engine.id]).flatMap((engine) => {
      const backend = backendFor(engine.id, caps);
      if (backend) return rowsOf(engine, backend);
      const unavailable = engine.backends.includes('wasm') ? 'needs WebAssembly' : 'needs WebGPU';
      return rowsOf(engine, null).map((row) => ({ ...row, unavailable }));
    });
  }

  const voiceCounts = () => ENGINES.filter((engine) => manifest.bundles[engine.id])
    .map((engine) => ({ engine: engine.id, label: engine.label, count: voicesOf(engine).length }));

  const bundleFor = (engineId) => manifest.bundles[engineId] || null;

  // Chrome can answer requestAdapter() with null while its GPU process is still starting, then
  // with the adapter a moment later, so a null is asked again a few times before it counts.
  async function detectCaps(nav, { tries = 4, waitMs = 750 } = {}) {
    const wasm = typeof WebAssembly !== 'undefined';
    if (!nav || !nav.gpu) return { webgpu: false, wasm, adapter: null };
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      let adapter = null;
      try {
        adapter = await nav.gpu.requestAdapter();
      } catch {
        adapter = null;
      }
      if (adapter) return { webgpu: true, wasm, adapter };
      if (attempt < tries) await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    return { webgpu: false, wasm, adapter: null };
  }

  const api = { ENGINES, useManifest, voiceKey, parseVoiceKey, migrateStoredVoice, backendFor, voiceForReply, voiceRows, allVoiceRows, voiceCounts, bundleFor, detectCaps };
  if (typeof window !== 'undefined') window.TalkTtsCatalog = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
