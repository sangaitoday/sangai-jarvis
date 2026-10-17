'use strict';
(function () {
  const TALK_BRIEF = 'You are Javis, a concise browser-only voice assistant. You have no access to accounts, files, or live information unless the user provides it.';
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
    deviceSummary,
  };
  if (typeof window !== 'undefined') window.TalkModelsCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
