'use strict';
(function () {
  const TALK_BRIEF = 'You are SangAI. Be warm, brief, and playful. Use only the facts in this note.';
  const MIN_TOKS = 5;
  const SPEED_CAP = 30;
  const MEMORY_SHARE = 0.6;
  const UNKNOWN_MEMORY_MB = 4096;

  function talkModelOptions(catalog, scores, hw) {
    if (!(scores.efficiency > 0)) throw new Error('scores.efficiency must be a positive number');
    if (!hw.gpu) return [];
    const budget = hw.memoryMB == null ? UNKNOWN_MEMORY_MB : hw.memoryMB * MEMORY_SHARE;
    const eligible = catalog.models.filter((model) =>
      !(model.f16 && !hw.f16)
      && model.vramMB <= budget
      && (!model.bufferBytes || model.bufferBytes / 2 ** 20 <= hw.maxBufferMB));
    const preferred = eligible.sort((a, b) =>
      Number(!a.quant.startsWith('q4')) - Number(!b.quant.startsWith('q4'))
      || Number(b.f16) - Number(a.f16)
      || Number(a.short) - Number(b.short)
      || a.vramMB - b.vramMB);
    const selected = new Map();
    for (const model of preferred) {
      if (!selected.has(model.base)) selected.set(model.base, model);
    }
    return Array.from(selected.values()).flatMap((model) => {
      const tokS = hw.bandwidthGBs * scores.efficiency / (model.vramMB / 1024);
      if (tokS < MIN_TOKS) return [];
      const quality = scores.models[model.base] ? scores.models[model.base].quality : null;
      const rank = quality == null ? null : Math.round(0.7 * quality + 0.3 * Math.min(tokS, SPEED_CAP) / SPEED_CAP * 100);
      return [{
        id: model.id,
        base: model.base,
        label: `${model.base} · ${(model.vramMB / 1024).toFixed(1)} GB · ~${Math.round(tokS)} tok/s · ${rank == null ? 'not rated' : rank}`,
        vramMB: model.vramMB,
        tokS,
        quality,
        score: rank,
      }];
    }).sort((a, b) => (a.score == null) - (b.score == null)
      || (a.score == null ? b.tokS - a.tokS : b.score - a.score)
      || (a.base < b.base ? -1 : a.base > b.base ? 1 : 0));
  }

  function trimHistory(messages, contextWindow, reserveTokens = 512) {
    const trimmed = messages.slice();
    let estimated = trimmed.reduce((sum, message) => sum + Math.ceil(message.content.length / 3), 0);
    const budget = contextWindow - reserveTokens;
    while (trimmed.length > 1 && estimated > budget) {
      estimated -= Math.ceil(trimmed.shift().content.length / 3);
    }
    return trimmed;
  }

  // Sampled replies sometimes contain the model's own control tokens (<|user|>, <|im_start|>,
  // <|reserved_special_token_1|>); what follows one is junk or an invented next turn.
  const CONTROL_TOKEN = /<\|[^|<>\s]+\|>/;

  function cleanReply(text) {
    const reply = text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').replace(new RegExp(`^(?:\\s*${CONTROL_TOKEN.source})+`), '');
    const cut = reply.search(CONTROL_TOKEN);
    return (cut < 0 ? reply : reply.slice(0, cut)).trim();
  }

  function formatBytes(bytes) {
    if (bytes >= 1000 * 2 ** 20) return `${(bytes / 2 ** 30).toFixed(1)} GB`;
    if (bytes >= 2 ** 20) return `${Math.round(bytes / 2 ** 20)} MB`;
    return `${bytes} B`;
  }

  // Vendor logo for a model name, or null when none is known (the table then shows the generic
  // glyph). Order matters: fine-tunes carry their base model in the name (Hermes-3-Llama,
  // Llama-3.1-Nemotron, DeepSeek-R1-Distill-Qwen), so the publisher is matched before the base family. TinyLlama is a community model, not Meta's.
  const MODEL_ICONS = [
    [/^auto$/i, '/vendor/model-icons/auto.svg'],
    [/^sangai$/i, '/sangai-logo.jpg'],
    [/^built-?in$/i, '/vendor/model-icons/gemini.svg'],
    [/nemotron|nvidia/i, '/vendor/model-icons/nvidia.svg'],
    [/hermes/i, '/vendor/model-icons/nousresearch.svg'],
    [/deepseek/i, '/vendor/model-icons/deepseek.svg'],
    [/tinyllama/i, null],
    [/wizard/i, '/vendor/model-icons/microsoft.svg'],
    [/qwen/i, '/vendor/model-icons/qwen.svg'],
    [/llama/i, '/vendor/model-icons/meta.svg'],
    [/^phi/i, '/vendor/model-icons/microsoft.svg'],
    [/gemma/i, '/vendor/model-icons/gemma.svg'],
    [/smollm/i, '/vendor/model-icons/huggingface.svg'],
    [/m(in)?istral/i, '/vendor/model-icons/mistral.svg'],
    [/olmo/i, '/vendor/model-icons/ai2.svg'],
    [/stablelm/i, '/vendor/model-icons/stability.svg'],
    [/redpajama/i, '/vendor/model-icons/together.svg'],
  ];

  // Readable Title Case for a model or voice id: hyphens and underscores become spaces, a
  // lowercase word gets a capital, a mixed-case word (TinyLlama, SmolLM2) and an acronym stay
  // as written, and a size token (31b, a12b, 1.5b) is upper-cased.
  const SIZE_TOKEN = /^(?:\d+(?:\.\d+)?|[a-z]\d+)[bkmt]$/i;

  function displayName(name) {
    return String(name ?? '').split(/[\s_-]+/).filter(Boolean).map((word) => {
      if (SIZE_TOKEN.test(word)) return word.toUpperCase();
      if (/[a-z]/.test(word) && /[A-Z]/.test(word)) return word;
      if (!/[a-z]/.test(word)) return word;
      return word.replace(/[a-z]/, (letter) => letter.toUpperCase());
    }).join(' ');
  }

  const GENERIC_MODEL_ICON = '/vendor/model-icons/generic.svg';

  function iconForModel(name) {
    const text = String(name || '');
    if (!text) return null;
    for (const [pattern, icon] of MODEL_ICONS) if (pattern.test(text)) return icon;
    return null;
  }

  function modelDisplayName(name) {
    return displayName(name);
  }

  function deviceSummary(adapterInfo, bandwidthGBs, uaData, userAgent) {
    if (!adapterInfo) return null;
    const gpu = adapterInfo.description || [adapterInfo.vendor, adapterInfo.architecture].filter(Boolean).join(' ') || 'this GPU';
    const brand = (uaData?.brands || []).find((b) => !/not.?a.?brand|^chromium$/i.test(b.brand));
    const match = /(Edg|Firefox|Chrome)\/(\d+)/.exec(userAgent || '')
      || (/Safari\//.test(userAgent || '') && /Version\/(\d+)/.exec(userAgent || ''));
    const names = { Edg: 'Edge' };
    const browser = brand ? `${brand.brand} ${brand.version}`
      : match ? (match.length === 3 ? `${names[match[1]] || match[1]} ${match[2]}` : `Safari ${match[1]}`)
      : 'this browser';
    return `Estimated for ${gpu} · ${Math.round(bandwidthGBs)} GB/s · ${browser}`;
  }

  const api = {
    TALK_BRIEF,
    formatBytes,
    cleanReply,
    MIN_TOKS,
    SPEED_CAP,
    MEMORY_SHARE,
    UNKNOWN_MEMORY_MB,
    talkModelOptions,
    trimHistory,
    iconForModel,
    modelDisplayName,
    GENERIC_MODEL_ICON,
    displayName,
    deviceSummary,
  };
  if (typeof window !== 'undefined') window.TalkModelsCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
