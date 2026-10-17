'use strict';

function baseId(modelId) {
  const match = /-(q\d+f\d+(?:_\d+)?)-MLC(?:-(1k|b\d+))?$/.exec(modelId);
  if (!match) throw new Error(`model_id does not match WebLLM build format: ${modelId}`);
  return modelId.slice(0, match.index);
}

// Same rule as WebLLM's cleanModelUrl(), so cached keys match what the engine stored.
function modelUrl(model) {
  let url = model.endsWith('/') ? model : model + '/';
  if (!/.+\/resolve\/.+\//.test(url)) url += 'resolve/main/';
  return new URL(url).href;
}

function buildCatalog(modelList, version) {
  if (!Array.isArray(modelList)) throw new Error('modelList must be an array');
  return {
    webllm: version,
    models: modelList.map((record) => {
      if (typeof record.model_id !== 'string') throw new Error('model_id is required');
      const base = baseId(record.model_id);
      if (!Number.isFinite(record.vram_required_MB)) throw new Error(`vram_required_MB is required for ${record.model_id}`);
      if (record.model_type === 1) return null;
      if (typeof record.model !== 'string' || !record.model) throw new Error(`model URL is required for ${record.model_id}`);
      if (typeof record.model_lib !== 'string' || !record.model_lib) throw new Error(`model_lib is required for ${record.model_id}`);
      const quant = /-(q\d+f\d+(?:_\d+)?)-MLC(?:-(?:1k|b\d+))?$/.exec(record.model_id)[1];
      return {
        id: record.model_id,
        base,
        quant,
        short: record.model_id.endsWith('-1k'),
        vramMB: record.vram_required_MB,
        // WebLLM declares shader-f16 on only some f16 builds; every f16 build's shaders need it.
        f16: quant.includes('f16') || (record.required_features || []).includes('shader-f16'),
        contextWindow: record.overrides?.context_window_size ?? null,
        bufferBytes: record.buffer_size_required_bytes ?? null,
        vision: record.model_type === 2,
        url: modelUrl(record.model),
        lib: record.model_lib,
      };
    }).filter(Boolean),
  };
}

module.exports = { buildCatalog, baseId };
