'use strict';
(function () {
  const HIDDEN_BROWSER_VOICES = new Set([
    'albert', 'bad news', 'bahh', 'bells', 'boing', 'bubbles', 'cellos', 'deranged',
    'eddy', 'flo', 'fred', 'good news', 'grandma', 'grandpa', 'hysterical', 'jester',
    'junior', 'kathy', 'organ', 'ralph', 'reed', 'rocko', 'samantha', 'sandy',
    'shelley', 'superstar', 'trinoids', 'whisper', 'wobble', 'zarvox',
  ]);

  function browserVoiceName(voice) {
    const name = typeof voice === 'string' ? voice : (voice?.name || '');
    return name.trim().replace(/^bot:\s*/i, '').replace(/\s+\(.*\)$/, '').trim().toLowerCase();
  }

  function filterBrowserVoices(voices) {
    return (voices || []).filter((voice) => !HIDDEN_BROWSER_VOICES.has(browserVoiceName(voice)));
  }

  function previewSpeechText(lang) {
    return String(lang || '').slice(0, 2).toLowerCase() === 'vi'
      ? 'Xin chào, tôi là Sang A I.'
      : 'This is Sang A I voice. Have a nice day.';
  }

  function chooseBrowserVoice(voices, selectedKey, browserLanguage, getKey) {
    const supported = filterBrowserVoices(voices).filter((voice) => /^(en|vi)(-|$)/i.test(voice.lang || ''));
    if (!supported.length) return null;
    const selected = supported.find((voice) => getKey(voice) === selectedKey);
    if (selected) return selected;
    const language = (browserLanguage || 'en').split('-')[0].toLowerCase();
    return supported.find((voice) => (voice.lang || '').toLowerCase().startsWith(language + '-'))
      || supported.find((voice) => (voice.lang || '').toLowerCase() === language)
      || supported.find((voice) => (voice.lang || '').toLowerCase().startsWith('en-'))
      || supported.find((voice) => (voice.lang || '').toLowerCase() === 'en')
      || supported[0];
  }

  function hasSupportedBrowserVoice(voices) {
    return filterBrowserVoices(voices).some((voice) => /^(en|vi)(-|$)/i.test(voice.lang || ''));
  }

  function canUseBrowserDuringOnnxPreparation(voices, allowed, lang) {
    const prefix = String(lang || 'en').slice(0, 2).toLowerCase();
    return allowed && hasSupportedBrowserVoice(voices)
      && filterBrowserVoices(voices).some((voice) => (voice.lang || '').toLowerCase().startsWith(prefix));
  }

  const MIN_CHUNK_CHARS = 12;
  const MAX_CHUNK_CHARS = 200;

  const HTML_TAGS = 'a|abbr|article|aside|audio|b|big|blockquote|body|br|button|caption|center|cite|code|col|colgroup|dd|del|details|dfn|div|dl|dt|em|figcaption|figure|font|footer|form|h[1-6]|head|header|hr|html|i|iframe|img|input|ins|kbd|label|li|link|main|mark|meta|nav|ol|option|p|path|pre|q|s|samp|section|select|small|source|span|strike|strong|sub|summary|sup|svg|table|tbody|td|textarea|tfoot|th|thead|time|title|tr|tt|u|ul|var|video';
  const BLOCK_TAGS = 'br|p|div|li|tr|h[1-6]|title|section|article|table|ul|ol|blockquote|pre|header|footer|center|details|summary|figure|figcaption';
  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–' };
  const CELL = '\u0001';

  function htmlToText(text) {
    return text
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<\/t[hd]\s*>/gi, CELL)
      .replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^<>]*>`, 'gi'), '\n')
      .replace(new RegExp(`<\\/?(?:${HTML_TAGS})\\b[^<>]*>`, 'gi'), '')
      // A tag with no attributes, including ones models invent (<letter>, <review>); "x<y and y>z" has a space.
      .replace(/<\/?[a-zA-Z][\w-]*\s*\/?>/g, '')
      // Placeholders like "<rest of the statement>": read the words. "x<y" is left alone.
      .replace(/(^|[^A-Za-z0-9<])<+\/?([A-Za-z][A-Za-z0-9 '’,.-]{0,60})>+/gm, '$1$2')
      .replace(new RegExp(`${CELL}\\s*(?=\\n|$)`, 'g'), '')
      .replace(new RegExp(CELL, 'g'), ', ')
      .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (entity, name) => {
        if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? entity;
        return String.fromCodePoint(name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10));
      });
  }

  function displayText(text) {
    return htmlToText(String(text || '')).replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{2,}/g, '\n').trim();
  }

  const REACTION_ICON_PATTERN = /(?:[\u{1F1E6}-\u{1F1FF}]{2}|\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F}|[0-9#*]\uFE0F?\u20E3|(?<![a-zA-Z0-9]):[a-zA-Z0-9_+-]+:(?![a-zA-Z0-9])|(?![\u00A9\u00AE\u2122](?!\uFE0F))\p{Extended_Pictographic}(?:[\uFE0E\uFE0F])?(?:\p{Emoji_Modifier})?(?:\u200D(?![\u00A9\u00AE\u2122](?!\uFE0F))\p{Extended_Pictographic}(?:[\uFE0E\uFE0F])?(?:\p{Emoji_Modifier})?)*)/gu;

  function speechText(text) {
    const lines = htmlToText(String(text || '')).split(/\n+/)
      .map((line) => line
        .replace(/^\s*#{1,6}\s+/, '')
        .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, '')
        .replace(/[*`]+/g, '')
        .replace(REACTION_ICON_PATTERN, '')
        .replace(/\s+([,.:;!?…])/g, '$1')
        .replace(/\s+/g, ' ')
        .trim())
      .filter(Boolean);
    return lines.map((line, i) => (i < lines.length - 1 && !/[.!?…:;,]$/.test(line) ? line + '.' : line)).join(' ');
  }

  function speechChunks(text) {
    const pieces = [];
    for (const sentence of String(text || '').trim().split(/(?<=[.!?…])\s+/)) {
      let rest = sentence.trim();
      while (rest.length > MAX_CHUNK_CHARS) {
        const window = rest.slice(0, MAX_CHUNK_CHARS);
        const cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf(' '));
        const at = cut > 0 ? cut + 1 : MAX_CHUNK_CHARS;
        pieces.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
      }
      if (rest) pieces.push(rest);
    }
    const chunks = [];
    for (const piece of pieces) {
      const last = chunks[chunks.length - 1];
      if (last !== undefined && last.length < MIN_CHUNK_CHARS && last.length + piece.length < MAX_CHUNK_CHARS) chunks[chunks.length - 1] = last + ' ' + piece;
      else chunks.push(piece);
    }
    return chunks;
  }

  const MODES = ['space', 'handsfree'];
  const MODE_HINTS = {
    space: 'Hold Space or the mic to talk',
    handsfree: 'Click to stop the current turn',
  };
  const LISTENING_RMS = 0.03;
  const SPEAKING_RMS = 0.02;
  const ORB_HOLD_MS = 600;
  const THINK_MAX_MS = 8000;

  const parseMode = (raw) => (MODES.includes(raw) ? raw : 'space');

  const modeHint = (mode) => MODE_HINTS[parseMode(mode)];

  function orbState({ inCall, connecting, now, micLoudAt, remoteLoudAt }) {
    if (!inCall) return connecting ? 'thinking' : 'ready';
    if (now - remoteLoudAt < ORB_HOLD_MS) return 'speaking';
    if (now - micLoudAt < ORB_HOLD_MS) return 'listening';
    if (micLoudAt > remoteLoudAt && now - micLoudAt < THINK_MAX_MS) return 'thinking';
    return 'listening';
  }

  const VIETNAMESE_ONLY = /[đĐ]|[\u0306\u031B\u0309\u0323]|[aeiouyAEIOUY]\u0303|[aeoAEO]\u0302[\u0300\u0301\u0303\u0309\u0323]/g;
  const ACCENT_MARKS = /[\u0300\u0301\u0302\u0303]/g;

  // Vietnamese is told apart by its own letters (đ, ă, ơ, ư, hooks, dots, circumflex with a tone), so an
  // English reply with café or hôtel stays English; a text with no letters to judge keeps the fallback.
  function detectLang(text, fallback = 'en-US') {
    const decomposed = String(text || '').normalize('NFD');
    const words = decomposed.split(/\s+/).filter((word) => /\p{L}/u.test(word)).length;
    if (!words) return fallback;
    const only = (decomposed.match(VIETNAMESE_ONLY) || []).length;
    const score = only * 2 + (decomposed.match(ACCENT_MARKS) || []).length;
    if (!score) return words >= 3 ? 'en-US' : fallback;
    return score / words >= 0.35 || (words <= 3 && score >= 1) ? 'vi-VN' : 'en-US';
  }

  function speechLangs(chunks) {
    let previous = detectLang(chunks.join(' '));
    return chunks.map((chunk) => { previous = detectLang(chunk, previous); return previous; });
  }

  const REPLY_LANGS = ['en', 'vi'];
  const baseLang = (lang) => String(lang || '').slice(0, 2).toLowerCase();

  function rememberVoice(prefs, id, langs) {
    const next = { ...prefs };
    for (const lang of (langs || []).map(baseLang)) if (REPLY_LANGS.includes(lang)) next[lang] = id;
    return next;
  }

  const voiceIdFor = (prefs, lang, fallback) => (prefs && prefs[baseLang(lang)]) || fallback;

  const api = { detectLang, speechLangs, rememberVoice, voiceIdFor, filterBrowserVoices, previewSpeechText, chooseBrowserVoice, hasSupportedBrowserVoice, canUseBrowserDuringOnnxPreparation, speechText, speechChunks, displayText, MODES, parseMode, modeHint, orbState, LISTENING_RMS, SPEAKING_RMS };
  if (typeof window !== 'undefined') window.TalkVoiceCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
