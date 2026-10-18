'use strict';
// Center Jarvis. Five states shown on the orb. Space holds the mic.
// Hands-free keeps it armed (Wake) until a phrase arrives.
(function () {
  const root = document.getElementById('talk');
  const orb = document.getElementById('talk-orb');
  const status = document.getElementById('talk-status');
  const transcript = document.getElementById('talk-transcript');
  const form = document.getElementById('talk-form');
  const input = document.getElementById('talk-input');
  const speakSelect = document.getElementById('talk-mode');
  const spaceTab = speakSelect?.querySelector('[data-mode="space"]');
  const handsfreeTab = speakSelect?.querySelector('[data-mode="handsfree"]');
  const voiceSettings = document.getElementById('talk-voice-settings');
  const modelSelect = document.getElementById('talk-model');
  const ttsEngineSelect = document.getElementById('talk-tts-engine');
  const voiceSelect = document.getElementById('talk-voice');
  const hold = document.getElementById('talk-hold');
  const modelTable = document.getElementById('talk-model-table');
  const modelTbody = document.getElementById('talk-model-tbody') || (modelTable && modelTable.querySelector('tbody'));
  const modelDevice = document.getElementById('talk-model-device');
  const tableSort = window.TableSort;
  const displayName = (name) => window.TalkModelsCore?.displayName?.(name) ?? String(name ?? '');
  const modelDisplayName = (name) => window.TalkModelsCore?.modelDisplayName?.(name) ?? displayName(name);
  let modelSort = null;
  const voiceGrid = document.getElementById('talk-voice-grid');
  const voiceTbody = document.getElementById('talk-voice-tbody') || voiceGrid;
  const voiceFilter = document.getElementById('talk-voice-filter');
  const voiceGroupBy = document.getElementById('talk-voice-group-by');
  const voiceDownloadAll = document.getElementById('talk-voice-download-all');
  const voiceDeleteAll = document.getElementById('talk-voice-delete-all');
  const voiceBatchStatus = document.getElementById('talk-voice-batch-status');
  if (!root || !orb || !status || !transcript || !form || !input || !speakSelect || !voiceSettings || !modelSelect || !ttsEngineSelect || !voiceSelect) return;
  form.hidden = true;

  const core = window.TalkVoiceCore;
  const MODE_KEY = 'talk.mode';
  const MODEL_KEY = 'talk.model';
  const STT_LOCAL_KEY = 'talk.stt.local';
  const TTS_ENGINE_KEY = 'talk.tts.engine';
  const BROWSER_VOICE_KEY = 'talk.tts.voice.browser';
  const ONNX_VOICE_KEY = 'talk.tts.voice.onnx';
  const ttsCatalog = window.TalkTtsCatalog;
  const LABELS = {
    ready: 'Ready',
    wake: 'Wake',
    listening: 'Listening',
    thinking: 'Thinking',
    speaking: 'Speaking',
  };
  const messages = [];
  const savedMode = core.parseMode(localStorage.getItem(MODE_KEY));
  let mode = savedMode === 'handsfree' ? 'handsfree' : 'space';
  const storedModel = localStorage.getItem(MODEL_KEY) || '';
  let model = storedModel === 'sangai' || storedModel.startsWith('cloud:') ? '' : storedModel;
  let ttsEngine = localStorage.getItem(TTS_ENGINE_KEY) === 'onnx' ? 'onnx' : 'browser';
  let browserVoice = localStorage.getItem(BROWSER_VOICE_KEY) || '';
  let onnxVoice = ttsCatalog.migrateStoredVoice('onnx', localStorage.getItem(ONNX_VOICE_KEY) || '');
  if (onnxVoice) localStorage.setItem(ONNX_VOICE_KEY, onnxVoice);
  const VOICE_PREFS_KEY = 'talk.tts.voice.byLang';
  let voicePrefs = { browser: {}, onnx: {} };
  try {
    const saved = JSON.parse(localStorage.getItem(VOICE_PREFS_KEY) || 'null');
    if (saved && typeof saved === 'object') voicePrefs = { browser: saved.browser || {}, onnx: saved.onnx || {} };
  } catch { voicePrefs = { browser: {}, onnx: {} }; }
  if (browserVoice === 'auto') browserVoice = '';
  let ui = 'ready';
  let rec = null;
  let holding = false;
  let heard = '';
  let inFlight = false;
  let speaking = false;
  let speechGeneration = 0;
  const ttsRuntime = window.TtsRuntime.create({ bundleFor: (engine) => ttsCatalog.bundleFor(engine) });
  let storedTts = { piper: new Set(), supertonic3: false, kokoro: {} };
  const voiceProgress = new Map();
  const onnxRowVoices = new Map();
  const voiceCards = [];
  let voiceBatchDownloading = false;
  let voiceBatchDeleting = false;
  let cancelVoiceBatch = false;
  const ttsCaps = { webgpu: false, wasm: typeof WebAssembly !== 'undefined' };
  let ttsLoaded = false;
  const ttsReady = (async () => {
    const [caps, response] = await Promise.all([
      ttsCatalog.detectCaps(navigator),
      fetch('/talk-tts.json', { signal: AbortSignal.timeout(15000) }),
    ]);
    ttsCaps.webgpu = caps.webgpu;
    if (!response.ok) throw new Error(`voice manifest request failed (${response.status})`);
    ttsCatalog.useManifest(await response.json());
    ttsLoaded = true;
  })();
  const onnxReadyVoices = new Set();
  let onnxPrefetch = null;
  let onnxAttempt = 0;
  let activeAudio = null;
  let activeAudioUrl = null;
  let activeSpeechCancel = null;
  let activeStageCancel = null;
  let controller = null;
  let flight = 0;
  let modelMenuAttempted = false;
  let sttInstallPending = false;
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;

  function paint(next) {
    ui = next;
    orb.dataset.state = next;
    const icon = next === 'thinking' ? 'brain' : next === 'speaking' ? 'speaker' : 'mic';
    orb.dataset.icon = icon;
    orb.classList.toggle('recording', next === 'listening' || next === 'wake');
    orb.setAttribute('aria-label', LABELS[next] || next);
  }

  function showError(text) {
    status.textContent = text || 'the model is unavailable';
    status.classList.add('is-error');
  }

  function clearStatus() {
    status.textContent = '';
    status.classList.remove('is-error');
  }

  function render() {
    transcript.replaceChildren();
    let lastSaid = null;
    for (const m of messages) {
      const line = document.createElement('p');
      line.className = 'talk-turn ' + (m.role === 'user' ? 'user' : 'assistant');
      const head = document.createElement('span');
      head.className = 'talk-head';
      const who = document.createElement('span');
      who.className = 'talk-role';
      who.textContent = m.role === 'user' ? 'You' : 'SangAI';
      if (m.role !== 'user') {
        const avatar = document.createElement('span');
        avatar.className = 'talk-avatar';
        avatar.setAttribute('data-fallback', 'S');
        const img = document.createElement('img');
        img.setAttribute('alt', '');
        img.setAttribute('src', '/sangai-logo.jpg');
        img.addEventListener('error', () => {
          img.hidden = true;
          avatar.setAttribute('data-failed', '1');
        });
        avatar.append(img);
        head.append(avatar);
      }
      head.append(who);
      const said = document.createElement('span');
      said.className = 'talk-said';
      said.textContent = m.role === 'user' ? m.content : window.TalkVoiceCore.displayText(m.content);
      line.append(head, said);
      transcript.append(line);
      lastSaid = said;
    }
    transcript.scrollTop = transcript.scrollHeight;
    return lastSaid;
  }

  function updateHoldHint() {
    if (!hold) return;
    const isTouch = Boolean(
      (window.matchMedia && (window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(max-width: 600px)').matches)) ||
      (navigator.maxTouchPoints && navigator.maxTouchPoints > 0)
    );
    hold.textContent = mode === 'space'
      ? (isTouch ? 'Hold the mic to talk with SangAI' : 'Hold Space to talk with SangAI')
      : core.modeHint(mode);
  }

  function paintModes() {
    spaceTab.setAttribute('aria-checked', String(mode === 'space'));
    handsfreeTab.setAttribute('aria-checked', String(mode === 'handsfree'));
    updateHoldHint();
    ttsEngineSelect.value = ttsEngine;
    paintVoiceChoices();
  }

  function triggerChange(element) {
    if (!element) return;
    if (typeof element.dispatchEvent === 'function') {
      const evt = typeof Event === 'function' ? new Event('change') : { type: 'change' };
      try { element.dispatchEvent(evt); } catch { /* ignore */ }
    } else if (element.handlers && typeof element.handlers.change === 'function') {
      element.handlers.change({ target: element, type: 'change', preventDefault() {} });
    }
  }

  const KNOWN_LANGUAGES = {
    'en-US': 'English (United States)',
    'en_US': 'English (United States)',
    'en-GB': 'English (United Kingdom)',
    'en_GB': 'English (United Kingdom)',
    'en': 'English',
    'vi-VN': 'Vietnamese (Vietnam)',
    'vi_VN': 'Vietnamese (Vietnam)',
    'vi': 'Vietnamese',
  };

  function languageForCode(rawCode) {
    const code = (rawCode || '').replace('_', '-');
    if (KNOWN_LANGUAGES[code]) return KNOWN_LANGUAGES[code];
    try {
      return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
    } catch {
      return code || 'Unknown';
    }
  }

  // A browser voice name is "[Vendor ]Name[ Variant][ Online (Natural)][ - Language]".
  // Edge exposes many variants of one person (e.g. Ava, Ava Multilingual); this splits
  // each voice into the parts a grouped picker needs.
  function parseBrowserVoice(voice) {
    let rawName = (voice.name || '').trim();
    let language = '';
    if (rawName.includes(' - ')) {
      const parts = rawName.split(/\s+-\s+/);
      rawName = parts[0].trim();
      language = parts.slice(1).join(' - ').trim();
    }
    let cleanName = rawName
      .replace(/^Microsoft\s+/i, '')
      .replace(/\s*Online\s*\(Natural\)/i, '')
      .replace(/\s*\(Natural\)/i, '')
      .trim();

    let variant = 'Standard';
    const variantMatch = cleanName.match(/\s+(Multilingual)$/i);
    if (variantMatch) {
      variant = variantMatch[1][0].toUpperCase() + variantMatch[1].slice(1).toLowerCase();
      cleanName = cleanName.slice(0, variantMatch.index).trim();
    }

    if (!language) language = languageForCode(voice.lang);

    return {
      id: voice.voiceURI || `${voice.name}|${voice.lang}`,
      name: cleanName || rawName,
      variant,
      language,
      rawLang: voice.lang || '',
    };
  }

  // Browsers never expose a voice's gender, so the picker infers one from known first names
  // (Microsoft's Edge voices, plus the Apple/Google/ONNX voices we ship) for a small gender
  // glyph next to each person. An explicit "Male"/"Female" in the name always wins; anything
  // else unrecognized returns null and the caller falls back to a neutral icon.
  const FEMALE_VOICE_NAMES = new Set([
    'ava', 'emma', 'jenny', 'aria', 'ana', 'michelle', 'leah', 'libby', 'maisie', 'sonia',
    'natasha', 'clara', 'neerja', 'molly', 'imani', 'hoài my', 'hoai my',
    'samantha', 'karen', 'moira', 'tessa', 'victoria', 'zira', 'catherine', 'susan', 'linda',
    'heera', 'lessac', 'vais1000',
  ]);
  const MALE_VOICE_NAMES = new Set([
    'andrew', 'brian', 'guy', 'christopher', 'eric', 'roger', 'steffan', 'luke', 'ryan',
    'thomas', 'william', 'liam', 'prabhat', 'mitchell', 'elimu', 'nam minh',
    'daniel', 'fred', 'alex', 'mark', 'james', 'oliver', 'george',
  ]);

  function voiceGender(name) {
    const raw = String(name || '').trim();
    if (!raw) return null;
    if (/\bfemale\b/i.test(raw)) return 'female';
    if (/\bmale\b/i.test(raw)) return 'male';
    const cleaned = raw
      .replace(/^(Microsoft|Google|Apple)\s+/i, '')
      .split(/\s+-\s+/)[0]
      .replace(/\s*Online\s*\(Natural\)/i, '')
      .replace(/\s*\(Natural\)/i, '')
      .replace(/\s+(Multilingual|Standard)$/i, '')
      .trim()
      .toLowerCase();
    if (FEMALE_VOICE_NAMES.has(cleaned)) return 'female';
    if (MALE_VOICE_NAMES.has(cleaned)) return 'male';
    const firstWord = cleaned.split(/\s+/)[0];
    if (FEMALE_VOICE_NAMES.has(firstWord)) return 'female';
    if (MALE_VOICE_NAMES.has(firstWord)) return 'male';
    return null;
  }

  function hashString(text) {
    let hash = 0;
    const s = String(text || '');
    for (let i = 0; i < s.length; i += 1) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
    return hash;
  }

  // A small, deterministic face built purely from the voice's name and inferred gender: same
  // name always draws the same avatar, so returning voices stay recognizable. Hair shape signals
  // gender (longer for female, a short cap for male, a thin neutral line otherwise); everything
  // else is one hue pulled from the name's hash.
  function voiceAvatarSvg(name, gender) {
    const hash = hashString(name);
    const hue = hash % 360;
    const skin = `hsl(${hue}, 55%, 76%)`;
    const hair = `hsl(${(hue + 200) % 360}, 35%, 26%)`;
    const hairPath = gender === 'female'
      ? `<path d="M1.5 11A9.5 9.5 0 0 1 20.5 11L20.5 16.5C19 18.5 18 13.5 16.3 16.5C14.6 18.5 13.6 13.5 11.9 16.5C10.2 18.5 9.2 13.5 7.5 16.5C5.8 18.5 4.8 13.5 3.1 16.5C1.9 18 1.5 16.8 1.5 16.5Z" fill="${hair}"/>`
      : gender === 'male'
        ? `<path d="M1.5 9.5A9.5 9.5 0 0 1 20.5 9.5L20.5 6.7C20.5 4.3 16.2 3.2 11 3.2C5.8 3.2 1.5 4.3 1.5 6.7Z" fill="${hair}"/>`
        : `<path d="M1.5 8.3A9.5 9 0 0 1 20.5 8.3L20.5 6.9C20.5 5.5 16.2 4.6 11 4.6C5.8 4.6 1.5 5.5 1.5 6.9Z" fill="${hair}" opacity=".5"/>`;
    return `<svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true"><circle cx="11" cy="11" r="10" fill="${skin}"/><circle cx="7.8" cy="11.3" r="1.15" fill="#33261f"/><circle cx="14.2" cy="11.3" r="1.15" fill="#33261f"/><path d="M7.6 14.2c1.2 1.5 5.6 1.5 6.8 0" stroke="#5a3a2c" stroke-width="1.1" fill="none" stroke-linecap="round"/>${hairPath}</svg>`;
  }

  function genderIconSvg(gender) {
    if (gender === 'female') {
      return '<svg width="12" height="12" viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="6" cy="4.6" r="3.3" fill="none" stroke="#ff8fc0" stroke-width="1.3"/><path d="M6 7.7V11.2M4.1 9.7h3.8" stroke="#ff8fc0" stroke-width="1.3" stroke-linecap="round"/></svg>';
    }
    if (gender === 'male') {
      return '<svg width="12" height="12" viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="5" cy="7" r="3.3" fill="none" stroke="#7fd6ff" stroke-width="1.3"/><path d="M7.3 4.7 11 1M11 1H7.7M11 1v3.3" stroke="#7fd6ff" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
    return '<svg width="12" height="12" viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="6" cy="6" r="4.2" fill="none" stroke="#7a8a99" stroke-width="1.3"/><circle cx="6" cy="6" r="1" fill="#7a8a99"/></svg>';
  }

  function genderLabel(gender) {
    return gender === 'female' ? 'Female voice' : gender === 'male' ? 'Male voice' : 'Voice';
  }

  // Prefixes a voice-table name cell with a deterministic face avatar (a small gender badge
  // pinned to its corner, so the pair costs one avatar's worth of width, not two), then the
  // name itself as plain text (kept as its own node so callers can still read it).
  function appendPersonIdentity(td, name, gender) {
    const avatar = document.createElement('span');
    avatar.className = 'talk-voice-avatar';
    avatar.classList.add('talk-voice-avatar');
    avatar.innerHTML = voiceAvatarSvg(name, gender);
    const genderIcon = document.createElement('span');
    genderIcon.className = 'talk-voice-gender';
    genderIcon.dataset.gender = gender || 'unknown';
    const label = genderLabel(gender);
    genderIcon.setAttribute('aria-label', label);
    genderIcon.title = label;
    genderIcon.innerHTML = genderIconSvg(gender);
    avatar.append(genderIcon);
    const nameLabel = document.createElement('span');
    nameLabel.textContent = displayName(name);
    td.append(avatar, nameLabel);
  }

  const TRASH_ICON_SVG = '<svg width="13" height="13" viewBox="0 0 13 13" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2 3.4h9M5 3.4V2h3v1.4M3.3 3.4l.6 7.6h5.2l.6-7.6M5.4 5.4v3.8M7.6 5.4v3.8" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const DOWNLOAD_ICON_SVG = '<svg width="13" height="13" viewBox="0 0 13 13" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M6.5 1v7.2M3.4 5.6 6.5 8.7l3.1-3.1M1.5 10.6h10" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const CANCEL_ICON_SVG = '<svg width="13" height="13" viewBox="0 0 13 13" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M3 3l7 7m0-7-7 7" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>';

  // A download action shown as an icon only (no label text), with the accessible name carried
  // by aria-label so screen readers still announce what it downloads.
  function makeIconButton(action, label, title, svg) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `talk-download-btn talk-${action}-btn`;
    btn.dataset.action = action;
    btn.setAttribute('aria-label', label);
    btn.title = title;
    const icon = document.createElement('span');
    icon.className = 'talk-btn-icon';
    icon.innerHTML = svg;
    btn.append(icon);
    return btn;
  }

  // Clicking a card selects and previews the voice, which downloads it on first use. Only deletion
  // remains as a per-voice action when its files are stored locally.
  function renderOnnxStatus(td, v, tr) {
    td.replaceChildren();
    td.textContent = '';
    if (voiceProgress.has(v.id)) {
      const progress = document.createElement('span');
      progress.className = 'talk-voice-progress';
      progress.textContent = `${voiceProgress.get(v.id)}%`;
      td.append(progress);
      return;
    }
    const stored = window.TtsStorage ? window.TtsStorage.isStored(storedTts, v) : false;
    tr.classList.toggle('has-delete', stored);
    if (!stored) return;
    const remove = makeIconButton('delete', `Delete ${v.name}`, 'Delete from this browser', TRASH_ICON_SVG);
    remove.addEventListener('click', (e) => {
      e?.stopPropagation?.();
      deleteVoice(v);
    });
    td.append(remove);
  }

  function paintOnnxStatuses(onlyKey = null) {
    for (const { voice, actions, card } of onnxRowVoices.values()) {
      if (!onlyKey || onlyKey === voice.id) renderOnnxStatus(actions, voice, card);
    }
  }

  async function refreshStored() {
    if (!window.TtsStorage) return;
    try {
      storedTts = await window.TtsStorage.storedVoices();
    } catch (error) {
      console.warn('Could not read the voices stored in this browser:', error.message);
      return;
    }
    renderVoiceGrid();
  }

  async function removeStoredVoice(v) {
    await window.TtsStorage.removeVoice(v);
    await ttsRuntime.dispose(v.engine);
    for (const key of [...onnxReadyVoices]) {
      if (v.engine === 'piper' ? key === v.id : key.startsWith(`${v.engine}:`)) onnxReadyVoices.delete(key);
    }
  }

  async function deleteVoice(v) {
    try {
      await removeStoredVoice(v);
    } catch (error) {
      status.textContent = `Could not remove ${v.name} (${error.message}).`;
      return;
    }
    status.textContent = v.engine === 'piper'
      ? `Removed ${v.name} from this browser.`
      : `Removed ${v.engineLabel} from this browser, with all its voices.`;
    await refreshStored();
  }

  function makeDownloadButton(itemName) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'talk-download-btn';
    btn.dataset.action = 'download';
    btn.setAttribute('aria-label', `Download ${itemName}`);
    btn.title = 'Download';
    const icon = document.createElement('span');
    icon.className = 'talk-btn-icon';
    icon.innerHTML = DOWNLOAD_ICON_SVG;
    btn.append(icon);
    return btn;
  }

  function langRankFor(viewerLang) {
    const norm = (l) => (l || '').toLowerCase().replace('_', '-');
    const uNorm = norm(viewerLang);
    const uPrefix = uNorm.split('-')[0];
    return (rawLang) => {
      const r = norm(rawLang);
      if (r === uNorm) return 0;
      if (r.startsWith(uPrefix)) return 1;
      return 2;
    };
  }

  // Keeps same-name browser variants adjacent while ordering voices by viewer language.
  function groupBrowserVoices(parsedList, viewerLang) {
    const rank = langRankFor(viewerLang || (typeof navigator !== 'undefined' && navigator.language) || 'en-US');
    const order = [];
    const byName = new Map();
    for (const v of parsedList) {
      if (!byName.has(v.name)) { byName.set(v.name, []); order.push(v.name); }
      byName.get(v.name).push(v);
    }
    const groups = order.map((name) => {
      const variants = [...byName.get(name)].sort((a, b) => a.variant.localeCompare(b.variant));
      const languages = [...new Set(variants.map((v) => v.language))];
      const bestRank = Math.min(...variants.map((v) => rank(v.rawLang)));
      return { name, variants, languages, rank: bestRank };
    });
    groups.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.name.localeCompare(b.name)));
    return groups;
  }

  function groupVoicesByProvider(parsedBrowser, onnxVoices, viewerLang) {
    const rank = langRankFor(viewerLang || (typeof navigator !== 'undefined' && navigator.language) || 'en-US');
    const providers = new Map();
    const add = (provider, code, kind, voice) => {
      if (!providers.has(provider)) providers.set(provider, new Map());
      const languages = providers.get(provider);
      if (!languages.has(code)) languages.set(code, { code, rank: rank(code), browser: [], onnx: [] });
      languages.get(code)[kind].push(voice);
    };
    for (const voice of parsedBrowser) add('Browser', (voice.rawLang || 'und').replace('_', '-'), 'browser', voice);
    for (const voice of onnxVoices) add(voice.engineLabel, (voice.languageCodes || [voice.rawLang || 'und']).join(' · '), 'onnx', voice);
    return [...providers.entries()]
      .sort(([a], [b]) => a === 'Browser' ? -1 : b === 'Browser' ? 1 : a.localeCompare(b))
      .map(([name, languages]) => ({
        name,
        languages: [...languages.values()]
          .sort((a, b) => a.rank !== b.rank ? a.rank - b.rank : a.code.localeCompare(b.code))
          .map((section) => ({
            ...section,
            people: groupBrowserVoices(section.browser, viewerLang),
          })),
      }));
  }

  window.TalkVoiceCore.groupVoicesByProvider = groupVoicesByProvider;
  window.TalkVoiceCore.parseBrowserVoice = parseBrowserVoice;
  window.TalkVoiceCore.groupBrowserVoices = groupBrowserVoices;
  window.TalkVoiceCore.voiceGender = voiceGender;
  window.TalkVoiceCore.voiceAvatarSvg = voiceAvatarSvg;

  function parseVoice(voice, isBrowser = true) {
    if (!isBrowser) {
      return {
        id: voice.key,
        engine: voice.engine,
        voice: voice.voice,
        backend: voice.backend,
        engineLabel: voice.engineLabel,
        name: voice.name,
        gender: voice.gender,
        quality: voice.quality,
        lang: voice.rawLangs.length > 1 ? 'Multilingual' : languageForCode(voice.rawLangs[0]),
        langLabel: voice.rawLangs.map(languageForCode).join(', '),
        rawLang: voice.rawLangs[0],
        languageCodes: [...new Set(voice.rawLangs.map((code) => code.replace('_', '-')))].sort(),
        type: [voice.engineLabel, voice.quality, voice.backend === 'webgpu' ? 'WebGPU' : null, voice.sizeMB ? `${voice.sizeMB} MB` : null]
          .filter(Boolean).join(' · '),
      };
    }

    let rawName = (voice.name || '').trim();
    let langLabel = '';
    if (rawName.includes(' - ')) {
      const parts = rawName.split(/\s+-\s+/);
      rawName = parts[0].trim();
      langLabel = parts.slice(1).join(' - ').trim();
    }
    const cleanName = rawName
      .replace(/^Microsoft\s+/i, '')
      .replace(/\s*Online\s*\(Natural\)/i, '')
      .replace(/\s*\(Natural\)/i, '')
      .trim();

    if (!langLabel) {
      const code = (voice.lang || '').replace('_', '-');
      if (KNOWN_LANGUAGES[code]) {
        langLabel = KNOWN_LANGUAGES[code];
      } else {
        try {
          langLabel = new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
        } catch {
          langLabel = code || 'Unknown';
        }
      }
    }

    return {
      id: voice.voiceURI || `${voice.name}|${voice.lang}`,
      name: cleanName || rawName,
      lang: langLabel,
      rawLang: voice.lang || '',
      type: 'Browser',
    };
  }

  function renderVoiceCard(v, provider, section, displayName = v.name) {
    const card = document.createElement('div');
    card.tabIndex = 0;
    card.classList.add('talk-voice-card');
    card.setAttribute('role', 'option');
    card.dataset.role = 'plain';
    card.dataset.id = v.id;
    card.dataset.name = displayName;
    card.setAttribute('title', `Language: ${section.code || 'Unknown'}`);
    card.dataset.lang = section.code;
    card.dataset.search = [v.langLabel || v.language || section.code, v.quality || v.variant || ''].join(' ');
    card.dataset.section = section.code;
    card.dataset.provider = provider;
    card.dataset.type = provider.toLowerCase();
    const isSelected = provider === 'Browser' ? browserVoice === v.id && ttsEngine === 'browser' : onnxVoice === v.id && ttsEngine === 'onnx';
    card.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    card.classList.toggle('is-selected', isSelected);

    const identity = document.createElement('span');
    identity.className = 'talk-voice-card-identity';
    appendPersonIdentity(identity, displayName, v.gender || voiceGender(v.name));
    card.append(identity);
    if (provider !== 'Browser') {
      const actions = document.createElement('span');
      actions.className = 'talk-voice-card-actions';
      onnxRowVoices.set(v.id, { voice: v, actions, card });
      renderOnnxStatus(actions, v, card);
      card.append(actions);
    }
    const handleSelect = (event) => {
      if (event) event.preventDefault?.();
      card.focus();
      selectVoice(provider === 'Browser' ? { id: v.id, type: 'Browser' } : v, card);
    };
    card.addEventListener('click', handleSelect);
    card.addEventListener('keydown', (event) => {
      if (event.code === 'Enter' || event.code === 'Space') handleSelect(event);
    });
    return card;
  }

  function onnxVoiceStatus(v) {
    if (voiceProgress.has(v.id)) return 'Downloading';
    if (window.TtsStorage && window.TtsStorage.isStored(storedTts, v)) return 'Downloaded';
    return onnxReadyVoices.has(v.id) ? 'Ready' : 'Not downloaded';
  }

  function matchingOnnxVoices() {
    const query = (voiceFilter?.value || '').trim().toLowerCase();
    return ttsCatalog.voiceRows(ttsCaps).map((row) => parseVoice(row, false)).filter((v) => {
      return !query || [v.name, v.quality, v.langLabel, v.engineLabel].filter(Boolean).join(' ').toLowerCase().includes(query);
    });
  }

  function voiceBatchCandidates() {
    return matchingOnnxVoices().filter((v) => onnxVoiceStatus(v) === 'Not downloaded');
  }

  function voiceDeleteCandidates() {
    if (!window.TtsStorage) return [];
    const seen = new Set();
    return matchingOnnxVoices().filter((v) => {
      if (!window.TtsStorage.isStored(storedTts, v) || voiceProgress.has(v.id)) return false;
      const key = v.engine === 'piper' ? v.id : v.engine;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function syncVoiceBatchButtons() {
    if (voiceDownloadAll) {
      const label = voiceBatchDownloading ? 'Cancel voice downloads' : 'Download all matching ONNX voices';
      voiceDownloadAll.innerHTML = voiceBatchDownloading ? CANCEL_ICON_SVG : DOWNLOAD_ICON_SVG;
      voiceDownloadAll.disabled = voiceBatchDeleting || (!voiceBatchDownloading && (!ttsLoaded || voiceBatchCandidates().length === 0));
      voiceDownloadAll.setAttribute('aria-label', label);
      voiceDownloadAll.title = label;
    }
    if (voiceDeleteAll) {
      voiceDeleteAll.disabled = voiceBatchDownloading || voiceBatchDeleting || !ttsLoaded || voiceDeleteCandidates().length === 0;
      voiceDeleteAll.setAttribute('aria-label', 'Delete all matching downloaded ONNX voice models');
      voiceDeleteAll.title = 'Delete all matching downloaded ONNX voice models';
    }
  }

  function setVoiceBatchStatus(message) {
    if (voiceBatchStatus) voiceBatchStatus.textContent = message;
  }

  async function runVoiceBatchDownload() {
    if (voiceBatchDownloading) {
      cancelVoiceBatch = true;
      setVoiceBatchStatus('Cancelling after the current voice…');
      return;
    }
    if (voiceBatchDeleting) return;
    voiceBatchDownloading = true;
    cancelVoiceBatch = false;
    syncVoiceBatchButtons();
    let ready = 0;
    try {
      await ttsReady;
      const voices = voiceBatchCandidates();
      if (!voices.length) {
        setVoiceBatchStatus('All matching ONNX voices are already downloaded.');
        return;
      }
      for (const [index, voice] of voices.entries()) {
        if (cancelVoiceBatch) break;
        const lang = (voice.rawLang || 'en').slice(0, 2).toLowerCase();
        const sample = core.previewSpeechText(lang);
        setVoiceBatchStatus(`Downloading voice ${index + 1} of ${voices.length}: ${voice.name}`);
        voiceProgress.set(voice.id, 0);
        paintOnnxStatuses(voice.id);
        try {
          await synthOnnx(voice.id, sample, lang, (progress) => {
            if (typeof progress !== 'number') return;
            voiceProgress.set(voice.id, Math.round(progress * 100));
            paintOnnxStatuses(voice.id);
            if (progress > 0 && progress < 1) {
              setVoiceBatchStatus(`Downloading voice ${index + 1} of ${voices.length}: ${voice.name} · ${Math.round(progress * 100)}%`);
            }
          });
          onnxReadyVoices.add(voice.id);
          ready += 1;
          await refreshStored();
        } finally {
          voiceProgress.delete(voice.id);
          paintOnnxStatuses(voice.id);
        }
        if (cancelVoiceBatch) break;
      }
      setVoiceBatchStatus(cancelVoiceBatch
        ? `Batch download cancelled. ${ready} voice${ready === 1 ? '' : 's'} ready.`
        : `Batch download complete: ${ready} voice${ready === 1 ? '' : 's'} ready.`);
    } catch (error) {
      setVoiceBatchStatus(`Batch download failed: ${error.message || 'the voice engine stopped'}`);
    } finally {
      voiceBatchDownloading = false;
      cancelVoiceBatch = false;
      syncVoiceBatchButtons();
    }
  }

  async function runVoiceBatchDelete() {
    if (voiceBatchDownloading || voiceBatchDeleting) return;
    voiceBatchDeleting = true;
    syncVoiceBatchButtons();
    let deleted = 0;
    try {
      await ttsReady;
      const voices = voiceDeleteCandidates();
      if (!voices.length) {
        setVoiceBatchStatus('No matching downloaded voice models to delete.');
        return;
      }
      for (const [index, voice] of voices.entries()) {
        setVoiceBatchStatus(`Deleting voice model ${index + 1} of ${voices.length}: ${voice.name}`);
        await removeStoredVoice(voice);
        deleted += 1;
        await refreshStored();
      }
      setVoiceBatchStatus(`Deleted ${deleted} voice model${deleted === 1 ? '' : 's'} from this browser.`);
    } catch (error) {
      setVoiceBatchStatus(`Delete all failed after ${deleted} voice model${deleted === 1 ? '' : 's'}: ${error.message || 'storage is unavailable'}`);
    } finally {
      voiceBatchDeleting = false;
      syncVoiceBatchButtons();
    }
  }

  function sectionItems(section, provider) {
    const languageGroups = [...new Set(String(section.code || '').split(/\s*·\s*/).map((code) => {
      const prefix = code.trim().slice(0, 2).toLowerCase();
      return prefix === 'en' ? 'EN' : prefix === 'vi' ? 'VN' : '';
    }).filter(Boolean))];
    const language = languageGroups.includes('EN') ? 'EN' : languageGroups.includes('VN') ? 'VN' : '';
    const country = [...new Set(String(section.code || '').split(/\s*·\s*/).map((code) => {
      const region = code.trim().match(/-([A-Z]{2})(?:-|$)/i)?.[1]?.toUpperCase();
      if (!region) return '';
      try {
        return new Intl.DisplayNames(['en'], { type: 'region' }).of(region) || region;
      } catch {
        return region;
      }
    }).filter(Boolean))].join(' · ') || 'Unknown';
    const makeItem = (voice, displayName) => ({
      name: displayName,
      groups: {
        language,
        gender: voice.gender || voiceGender(voice.name)
          ? genderLabel(voice.gender || voiceGender(voice.name)).replace(/ voice$/, '')
          : 'Unknown',
        country,
        provider,
      },
      render: () => renderVoiceCard(voice, provider, section, displayName),
    });
    const items = section.people.flatMap((group) => group.variants.map((voice) => {
      const displayName = group.variants.length > 1 ? `${group.name} · ${voice.variant}` : group.name;
      return makeItem(voice, displayName);
    }));
    const onnxGroups = new Map();
    for (const v of section.onnx) {
      const id = `${v.engine}:${v.name}`;
      if (!onnxGroups.has(id)) onnxGroups.set(id, { id, name: v.name, gender: v.gender, variants: [] });
      onnxGroups.get(id).variants.push(v);
    }
    for (const group of onnxGroups.values()) {
      items.push(...group.variants.map((voice) => {
        const displayName = group.variants.length > 1 ? `${group.name} · ${voice.quality}` : group.name;
        return makeItem(voice, displayName);
      }));
    }
    return items.sort((a, b) => a.name.localeCompare(b.name));
  }

  function renderVoiceGrid() {
    if (!voiceTbody) return;
    voiceTbody.replaceChildren();
    voiceCards.length = 0;
    onnxRowVoices.clear();

    const browserVoices = window.speechSynthesis
      ? core.filterBrowserVoices(speechSynthesis.getVoices()).filter((voice) => /^(en|vi)(-|$)/i.test(voice.lang || ''))
      : [];
    const parsedBrowser = browserVoices.map((voice) => parseBrowserVoice(voice));
    const onnxVoices = ttsCatalog.voiceRows(ttsCaps).map((row) => parseVoice(row, false));
    const items = [];
    for (const provider of groupVoicesByProvider(parsedBrowser, onnxVoices, navigator.language)) {
      const sections = provider.languages.filter((section) => section.browser.length || section.onnx.length);
      if (!sections.length) continue;
      for (const section of sections) items.push(...sectionItems(section, provider.name));
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    const groupMode = voiceGroupBy?.value || 'none';
    const appendCard = (item, parent) => {
      const card = item.render();
      voiceCards.push(card);
      parent.append(card);
    };
    if (groupMode === 'none') {
      for (const item of items) appendCard(item, voiceTbody);
    } else {
      const grouped = new Map();
      for (const item of items) {
        const label = item.groups[groupMode];
        if (!label || (groupMode === 'language' && !['EN', 'VN'].includes(label))) continue;
        if (!grouped.has(label)) grouped.set(label, []);
        grouped.get(label).push(item);
      }
      const languageOrder = ['EN', 'VN'];
      const genderOrder = ['Female', 'Male', 'Unknown'];
      const providerOrder = ['Browser', 'Piper', 'Supertonic 3', 'Kokoro'];
      const order = groupMode === 'language' ? languageOrder : groupMode === 'gender' ? genderOrder : groupMode === 'provider' ? providerOrder : [];
      const labels = [...grouped.keys()].sort((a, b) => {
        const ai = order.indexOf(a);
        const bi = order.indexOf(b);
        if (ai >= 0 || bi >= 0) return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi) || a.localeCompare(b);
        return a.localeCompare(b);
      });
      for (const label of labels) {
        const group = document.createElement('div');
        group.classList.add('talk-voice-group');
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', label);
        const heading = document.createElement('h3');
        heading.className = 'talk-voice-group-heading';
        heading.textContent = label;
        group.append(heading);
        for (const item of grouped.get(label)) appendCard(item, group);
        voiceTbody.append(group);
      }
    }
    applyVoiceFilter();
    syncVoiceBatchButtons();
  }

  function selectVoice(v, tr) {
    if (v.type === 'Browser') {
      if (ttsEngine !== 'browser') {
        ttsEngine = 'browser';
        ttsEngineSelect.value = 'browser';
        localStorage.setItem(TTS_ENGINE_KEY, ttsEngine);
        triggerChange(ttsEngineSelect);
      }
      browserVoice = v.id;
      voiceSelect.value = v.id;
      localStorage.setItem(BROWSER_VOICE_KEY, browserVoice);
      triggerChange(voiceSelect);
    } else {
      if (ttsEngine !== 'onnx') {
        ttsEngine = 'onnx';
        ttsEngineSelect.value = 'onnx';
        localStorage.setItem(TTS_ENGINE_KEY, ttsEngine);
        triggerChange(ttsEngineSelect);
      }
      const previous = ttsCatalog.parseVoiceKey(onnxVoice);
      // Piper stays loaded: it is the fallback for the other reply language.
      if (previous && previous.engine !== v.engine && previous.engine !== 'piper') {
        ttsRuntime.dispose(previous.engine);
      }
      onnxVoice = v.id;
      voiceSelect.value = v.id;
      localStorage.setItem(ONNX_VOICE_KEY, onnxVoice);
      triggerChange(voiceSelect);
    }

    for (const card of voiceCards) {
      const isThis = card === tr || card.dataset?.id === v.id;
      card.setAttribute('aria-selected', isThis ? 'true' : 'false');
      card.classList.toggle('is-selected', isThis);
    }
  }

  function applyVoiceFilter() {
    if (!voiceTbody) return;
    const query = (voiceFilter?.value || '').trim().toLowerCase();
    for (const card of voiceCards) {
      const searchable = [card.dataset.name, card.dataset.lang, card.dataset.search, card.dataset.provider].join(' ').toLowerCase();
      card.hidden = Boolean(query) && !searchable.includes(query);
    }
    for (const group of voiceTbody.children) {
      if (group.getAttribute('role') !== 'group') continue;
      group.hidden = !voiceCards.some((card) => card.parentElement === group && !card.hidden);
    }
  }

  function paintVoiceChoices() {
    const selected = ttsEngine === 'browser' ? browserVoice : onnxVoice;
    voiceSelect.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Choose a voice…';
    voiceSelect.append(placeholder);
    if (ttsEngine === 'browser') {
      const voices = window.speechSynthesis
        ? core.filterBrowserVoices(speechSynthesis.getVoices()).filter((voice) => /^(en|vi)(-|$)/i.test(voice.lang || ''))
        : [];
      const selectedVoice = window.TalkVoiceCore.chooseBrowserVoice(voices, browserVoice, navigator.language,
        (voice) => voice.voiceURI || `${voice.name}|${voice.lang}`);
      if (selectedVoice) {
        browserVoice = selectedVoice.voiceURI || `${selectedVoice.name}|${selectedVoice.lang}`;
        localStorage.setItem(BROWSER_VOICE_KEY, browserVoice);
      }
      if (!voices.length) {
        const unavailable = document.createElement('option');
        unavailable.textContent = 'No English or Vietnamese voices available';
        unavailable.disabled = true;
        voiceSelect.append(unavailable);
      }
      for (const voice of voices) {
        const option = document.createElement('option');
        option.value = voice.voiceURI || `${voice.name}|${voice.lang}`;
        option.textContent = voice.name;
        voiceSelect.append(option);
      }
      if (voices.length && selected && ![...voiceSelect.options].some((option) => option.value === selected)) browserVoice = '';
      voiceSelect.value = voices.length && browserVoice ? browserVoice : '';
    } else {
      for (const row of ttsCatalog.voiceRows(ttsCaps)) {
        const option = document.createElement('option');
        option.value = row.key;
        option.textContent = `${row.name} · ${row.engineLabel} · ${row.rawLangs.join(', ')}`;
        voiceSelect.append(option);
      }
      if (ttsLoaded && selected && ![...voiceSelect.options].some((option) => option.value === selected)) onnxVoice = '';
      voiceSelect.value = onnxVoice;
    }
    renderVoiceGrid();
  }

  function cancelSpeech() {
    speechGeneration += 1;
    onnxPrefetch = null;
    onnxAttempt += 1;
    speaking = false;
    if (activeStageCancel) activeStageCancel();
    if (activeSpeechCancel) activeSpeechCancel();
    activeStageCancel = null;
    activeSpeechCancel = null;
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch { /* idle */ }
    if (activeAudio) {
      activeAudio.pause();
      activeAudio.src = '';
      activeAudio = null;
    }
    if (activeAudioUrl) {
      URL.revokeObjectURL(activeAudioUrl);
      activeAudioUrl = null;
    }
  }

  function stopRec() {
    if (!rec) return;
    try { rec.stop(); } catch { /* not started */ }
  }

  // Nam Minh reads Vietnamese. Christopher reads English. The reply's own
  // letters pick which one — a Vietnamese mark means vi-VN, otherwise en-US.
  const VOICE_NAME = {
    'vi-VN': 'nam minh',
    'en-US': 'christopher',
  };
  function replyLang(text) {
    return window.TalkVoiceCore.detectLang(text);
  }

  function rememberChosenVoice(engine, id) {
    let langs = [];
    if (engine === 'onnx') langs = ttsCatalog.voiceRows(ttsCaps).find((row) => row.key === id)?.rawLangs || [];
    else {
      const voice = window.speechSynthesis?.getVoices().find((item) => (item.voiceURI || `${item.name}|${item.lang}`) === id);
      langs = voice ? [voice.lang] : [];
    }
    voicePrefs = { ...voicePrefs, [engine]: window.TalkVoiceCore.rememberVoice(voicePrefs[engine], id, langs) };
    localStorage.setItem(VOICE_PREFS_KEY, JSON.stringify(voicePrefs));
  }

  function voicesNow() {
    return new Promise((resolve) => {
      if (!window.speechSynthesis) { resolve([]); return; }
      const have = speechSynthesis.getVoices();
      if (have.length) { resolve(have); return; }
      const done = () => {
        speechSynthesis.removeEventListener('voiceschanged', done);
        resolve(speechSynthesis.getVoices());
      };
      speechSynthesis.addEventListener('voiceschanged', done);
      setTimeout(done, 800);
    });
  }

  function onnxVoiceFor(lang) {
    const key = ttsCatalog.voiceForReply(window.TalkVoiceCore.voiceIdFor(voicePrefs.onnx, lang, onnxVoice), lang, ttsCaps);
    if (!key) throw new Error('no ONNX voice runs on this device');
    return key;
  }

  async function synthOnnx(key, text, lang, progress) {
    const { engine, voice } = ttsCatalog.parseVoiceKey(key);
    const sizeMB = ttsCatalog.voiceRows(ttsCaps).find((row) => row.key === key)?.sizeMB || 0;
    return ttsRuntime.speak(engine, text, voice, { lang, progress, backend: ttsCatalog.backendFor(engine, ttsCaps), sizeBytes: sizeMB * 1e6 });
  }

  function prefetchOnnx(text, lang) {
    const blob = ttsReady.then(() => synthOnnx(onnxVoiceFor(lang), text, lang, () => {}));
    // Marks the rejection handled; the turn that takes this prefetch awaits it and gets the error.
    blob.catch(() => {});
    onnxPrefetch = { text, voice: onnxVoiceFor(lang), lang, blob };
  }

  async function speakOnnx(text, generation, attempt, onPrepared, lang = replyLang(text)) {
    await ttsReady;
    if (generation !== speechGeneration || attempt !== onnxAttempt) return;
    const key = onnxVoiceFor(lang);
    const voiceId = ttsCatalog.parseVoiceKey(key).voice;
    const prefetched = onnxPrefetch && onnxPrefetch.text === text && onnxPrefetch.voice === key && onnxPrefetch.lang === lang
      ? onnxPrefetch.blob : null;
    onnxPrefetch = null;
    if (!prefetched && !onnxReadyVoices.has(key)) status.textContent = 'Loading ONNX voice for first use…';
    let blob;
    try {
      blob = await (prefetched || synthOnnx(key, text, lang, (progress) => {
        const percent = Math.round(progress * 100);
        // The row keeps counting even after a slow first reply was handed to the browser voice.
        if (typeof progress === 'number' && progress > 0 && progress < 1) {
          voiceProgress.set(key, percent);
          paintOnnxStatuses(key);
        }
        if (generation !== speechGeneration || attempt !== onnxAttempt) return;
        if (typeof progress === 'number' && progress > 0 && progress < 1) {
          status.textContent = `Downloading ${voiceId} voice · ${percent}%`;
        } else if (progress === 0) {
          status.textContent = `Preparing ${voiceId} voice…`;
        }
      }));
    } finally {
      if (voiceProgress.delete(key)) paintOnnxStatuses(key);
    }
    onnxReadyVoices.add(key);
    paintOnnxStatuses();
    refreshStored();
    if (generation !== speechGeneration || attempt !== onnxAttempt) return;
    const audioUrl = URL.createObjectURL(blob);
    const audio = new Audio(audioUrl);
    activeAudio = audio;
    activeAudioUrl = audioUrl;
    status.textContent = '';
    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          activeStageCancel = null;
          if (error) reject(error); else resolve();
        };
        activeStageCancel = () => finish(new DOMException('Speech cancelled', 'AbortError'));
        let prepared = false;
        const markPrepared = () => {
          if (prepared) return;
          prepared = true;
          onPrepared();
        };
        audio.onplaying = markPrepared;
        audio.onended = () => finish();
        audio.onerror = () => finish(new Error('ONNX audio playback failed'));
        const play = audio.play();
        if (play && typeof play.then === 'function') play.then(markPrepared, finish);
        else markPrepared();
      });
    } finally {
      URL.revokeObjectURL(audioUrl);
      if (activeAudio === audio) activeAudio = null;
      if (activeAudioUrl === audioUrl) activeAudioUrl = null;
    }
  }

  async function speakOnnxThenBrowser(text, generation, allowBrowserDuringPreparation = true, lang = replyLang(text), onPlaying = null) {
    const attempt = ++onnxAttempt;
    let resolveReady;
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    const onnx = speakOnnx(text, generation, attempt, () => {
      resolveReady({ prepared: true });
      if (onPlaying) onPlaying();
    }, lang)
      .then(() => ({ ok: true }), (error) => ({ ok: false, error }));
    onnx.then((result) => resolveReady({ result }));
    let timer;
    const result = await Promise.race([
      ready,
      new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), 5000); }),
    ]);
    clearTimeout(timer);
    if (generation !== speechGeneration) return;
    if (result.timedOut) {
      if (!window.TalkVoiceCore.canUseBrowserDuringOnnxPreparation(window.speechSynthesis?.getVoices(), allowBrowserDuringPreparation, lang)) {
        const outcome = result.result || await onnx;
        if (!outcome.ok) throw outcome.error;
        return 'onnx';
      }
      onnxAttempt += 1;
      if (activeStageCancel) activeStageCancel();
      if (activeAudio) {
        activeAudio.pause();
        activeAudio.removeAttribute('src');
        activeAudio = null;
      }
      if (activeAudioUrl) {
        URL.revokeObjectURL(activeAudioUrl);
        activeAudioUrl = null;
      }
      status.textContent = 'ONNX voice is still preparing; using browser voice…';
      await speakBrowser(text, generation, lang);
      return 'browser';
    }
    const outcome = result.result || await onnx;
    if (!outcome.ok) {
      status.textContent = 'ONNX voice failed; using browser voice…';
      await speakBrowser(text, generation, lang);
      return 'browser';
    }
    return 'onnx';
  }

  async function speakBrowser(text, generation, lang = replyLang(text)) {
    if (!window.speechSynthesis || typeof SpeechSynthesisUtterance !== 'function') {
      throw new Error('Browser speech synthesis is unavailable');
    }
    const voices = core.filterBrowserVoices(await voicesNow());
    if (generation !== speechGeneration) return;
    const chosenId = window.TalkVoiceCore.voiceIdFor(voicePrefs.browser, lang, browserVoice);
    const selectedVoice = chosenId
      ? voices.find((item) => (item.voiceURI || `${item.name}|${item.lang}`) === chosenId)
      : null;
    const preferred = selectedVoice && (selectedVoice.lang || '').toLowerCase().startsWith(lang.slice(0, 2))
      ? selectedVoice
      : voices.find((item) => (item.name || '').toLowerCase().includes(VOICE_NAME[lang]))
        || voices.find((item) => (item.lang || '').toLowerCase().startsWith(lang.slice(0, 2)));
    if (!preferred) throw new Error(`No browser voice available for ${lang}`);
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(startTimer);
        activeStageCancel = null;
        if (error) reject(error); else resolve();
      };
      const utter = new SpeechSynthesisUtterance(text);
      let started = false;
      let settled = false;
      const settle = (error) => {
        if (settled) return;
        settled = true;
        finish(error);
      };
      const startTimer = setTimeout(() => {
        if (!started) {
          window.speechSynthesis.cancel();
          settle(new Error('Browser speech did not start'));
        }
      }, 1800);
      utter.lang = preferred ? preferred.lang : lang;
      if (preferred) utter.voice = preferred;
      utter.onstart = () => { started = true; };
      utter.onend = () => settle();
      utter.onerror = (event) => settle(new Error(event.error || 'Browser speech failed'));
      activeStageCancel = () => settle(new DOMException('Speech cancelled', 'AbortError'));
      try { window.speechSynthesis.speak(utter); }
      catch (error) { settle(error); }
    });
  }

  async function speak(text) {
    if (!text) return;
    const generation = ++speechGeneration;
    speaking = true;
    paint('speaking');
    const cancelled = new Promise((_, reject) => {
      activeSpeechCancel = () => reject(new DOMException('Speech cancelled', 'AbortError'));
    });
    try {
      await Promise.race([(async () => {
        let engine = ttsEngine;
        const chunks = window.TalkVoiceCore.speechChunks(window.TalkVoiceCore.speechText(text));
        const langs = window.TalkVoiceCore.speechLangs(chunks);
        for (const [index, chunk] of chunks.entries()) {
          if (generation !== speechGeneration) return;
          const lang = langs[index];
          const next = chunks[index + 1];
          const prefetchNext = next ? () => prefetchOnnx(next, langs[index + 1]) : null;
          if (engine === 'onnx') {
            engine = await speakOnnxThenBrowser(chunk, generation, true, lang, prefetchNext);
            continue;
          }
          try { await speakBrowser(chunk, generation, lang); }
          catch (error) {
            if (generation !== speechGeneration || error.name === 'AbortError') return;
            status.textContent = 'Browser voice failed; using ONNX voice…';
            engine = await speakOnnxThenBrowser(chunk, generation, false, lang, prefetchNext);
          }
        }
      })(), cancelled]);
      return true;
    } catch (error) {
      if (generation !== speechGeneration) return;
      showError(`No audio played (${error && error.message ? error.message : 'voice engine unavailable'}). Check audio permissions and retry.`);
      return false;
    } finally {
      if (generation === speechGeneration) {
        speaking = false;
        activeSpeechCancel = null;
      }
    }
  }

  async function previewVoice() {
    if ((ttsEngine === 'browser' && !browserVoice) || (ttsEngine === 'onnx' && !onnxVoice)) return;
    cancelSpeech();
    const generation = ++speechGeneration;
    const selectedBrowserVoice = ttsEngine === 'browser' && window.speechSynthesis
      ? core.filterBrowserVoices(speechSynthesis.getVoices()).find((voice) => (voice.voiceURI || `${voice.name}|${voice.lang}`) === browserVoice)
      : null;
    const onnxLang = ttsCatalog.voiceRows(ttsCaps).find((row) => row.key === onnxVoice)?.rawLangs[0] || '';
    const demo = core.previewSpeechText(ttsEngine === 'onnx' ? onnxLang : selectedBrowserVoice?.lang);
    speaking = true;
    paint('speaking');
    status.textContent = 'Jarvis is previewing this voice…';
    try {
      if (ttsEngine === 'onnx') await speakOnnxThenBrowser(demo, generation);
      else {
        try { await speakBrowser(demo, generation); }
        catch (error) {
          if (generation !== speechGeneration || error.name === 'AbortError') return;
          status.textContent = 'Browser voice failed; using ONNX voice…';
          await speakOnnxThenBrowser(demo, generation, false);
        }
      }
    } catch (error) {
      if (generation === speechGeneration) showError(`Voice preview failed (${error.message || 'voice engine unavailable'}). Choose another voice and retry.`);
    } finally {
      if (generation === speechGeneration) {
        speaking = false;
        activeSpeechCancel = null;
        paint('ready');
      }
    }
  }

  function armHandsFree() {
    if (mode !== 'handsfree' || inFlight || speaking || !rec) return;
    heard = '';
    rec.continuous = true;
    rec.interimResults = true;
    try { rec.start(); } catch { /* already running */ }
    paint('wake');
  }

  async function clearModelSelection(message) {
    model = '';
    localStorage.removeItem(MODEL_KEY);
    modelSelect.value = '';
    await window.TalkModels.unload();
    status.textContent = message;
  }

  let lastModelOptions = [];
  let lastDownloads = { models: [], usage: null, quota: null };
  let downloadingModelId = null;
  let downloadingModelProgress = 0;

  const MODEL_SORT_KEYS = ['name', 'size', 'speed'];
  let modelMenuState = 'loading';

  function savedModelGone() {
    if (!model) return false;
    return ![...modelSelect.options].some((option) => option.value === model);
  }

  const SETTINGS_TAB_KEY = 'talk.settingsTab';
  const SETTINGS_TABS = ['models', 'voice'];
  const settingsTabs = document.getElementById('talk-settings-tabs');
  let settingsTab = null;

  function showSettingsTab(name, remember) {
    settingsTab = name;
    for (const tabName of SETTINGS_TABS) {
      const on = tabName === name;
      const button = settingsTabs?.querySelector(`[data-tab="${tabName}"]`);
      button?.setAttribute('aria-selected', on ? 'true' : 'false');
      if (button) button.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(`talk-panel-${tabName}`);
      if (panel) panel.hidden = !on;
    }
    if (remember) {
      try {
        localStorage.setItem(SETTINGS_TAB_KEY, name);
      } catch (error) {
        console.warn('Settings tab not remembered', error);
      }
    }
  }

  let savedTab = null;
  try {
    savedTab = localStorage.getItem(SETTINGS_TAB_KEY);
  } catch (error) {
    savedTab = null;
  }
  showSettingsTab(savedTab === 'voice' ? 'voice' : 'models', false);
  for (const tabName of SETTINGS_TABS) {
    settingsTabs?.querySelector(`[data-tab="${tabName}"]`)?.addEventListener('click', () => showSettingsTab(tabName, true));
  }
  settingsTabs?.addEventListener('keydown', (e) => {
    const at = SETTINGS_TABS.indexOf(settingsTab);
    const nextIndex = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: SETTINGS_TABS.length - 1 }[e.key];
    if (nextIndex === undefined) return;
    e.preventDefault();
    const next = SETTINGS_TABS[(nextIndex + SETTINGS_TABS.length) % SETTINGS_TABS.length];
    showSettingsTab(next, true);
    settingsTabs.querySelector(`[data-tab="${next}"]`)?.focus();
  });

  function appendModelName(td, base, name) {
    const core = window.TalkModelsCore;
    const iconSrc = core?.iconForModel?.(base) || core?.GENERIC_MODEL_ICON;
    if (!iconSrc) {
      td.textContent = name;
      return;
    }
    const icon = document.createElement('img');
    icon.className = 'talk-model-icon';
    icon.src = iconSrc;
    icon.alt = '';
    icon.width = 14;
    icon.height = 14;
    icon.loading = 'lazy';
    const label = document.createElement('span');
    label.textContent = name;
    td.append(icon, label);
  }

  function renderModelTable() {
    if (!modelTbody) return;
    modelTbody.replaceChildren();

    const items = [];

    const downloadedMap = new Map();
    for (const m of (lastDownloads.models || [])) {
      downloadedMap.set(m.id, m);
      if (m.base) downloadedMap.set(m.base, m);
    }

    for (const opt of lastModelOptions) {
      const downloaded = downloadedMap.get(opt.id) || (opt.base && downloadedMap.get(opt.base));
      let sizeStr = '—';
      if (downloaded && downloaded.bytes) {
        sizeStr = window.TalkModelsCore?.formatBytes ? window.TalkModelsCore.formatBytes(downloaded.bytes) : `${downloaded.bytes} B`;
      } else if (opt.label && opt.label.includes(' · ')) {
        const parts = opt.label.split(' · ');
        sizeStr = parts[1] || '—';
      } else if (opt.vramMB) {
        sizeStr = window.TalkModelsCore?.formatBytes ? window.TalkModelsCore.formatBytes(opt.vramMB * 1024 * 1024) : `${opt.vramMB} MB`;
      }

      let itemStatus = 'Not downloaded';
      if (downloaded && downloaded.complete) {
        itemStatus = 'Downloaded';
      } else if (downloadingModelId === opt.id) {
        itemStatus = `Downloading ${downloadingModelProgress}%`;
      }

      items.push({
        id: opt.id,
        base: opt.base || opt.id,
        name: modelDisplayName(opt.base || opt.id),
        size: sizeStr,
        sizeBytes: downloaded?.bytes || (opt.vramMB ? opt.vramMB * 2 ** 20 : null),
        speed: opt.tokS > 0 ? `~${Math.round(opt.tokS)} tok/s` : '—',
        tokS: opt.tokS > 0 ? opt.tokS : null,
        status: itemStatus,
        complete: downloaded ? downloaded.complete : false,
      });
    }

    const shown = tableSort.sortBy(
      items,
      modelSort,
      (item, key) => ({ name: item.name, size: item.sizeBytes, speed: item.tokS })[key],
    );
    for (const key of MODEL_SORT_KEYS) tableSort.markHeader(document.getElementById(`talk-model-sort-${key}`), key, modelSort);
    for (const item of shown) {
      const tr = document.createElement('tr');
      tr.tabIndex = 0;
      tr.setAttribute('role', 'option');
      tr.dataset.id = item.id;
      tr.dataset.name = item.name;

      const isSelected = model === item.id || modelSelect.value === item.id;
      tr.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      tr.classList.toggle('is-selected', isSelected);

      const tdName = document.createElement('td');
      appendModelName(tdName, item.base || item.name, item.name);

      const tdSize = document.createElement('td');
      tdSize.textContent = item.size;
      const tdSpeed = document.createElement('td');
      tdSpeed.textContent = item.speed;

      const tdStatus = document.createElement('td');
      if (item.status === 'Downloaded') {
        const removeBtn = makeIconButton('delete', `Delete ${item.name} from this browser`, 'Delete downloaded model', TRASH_ICON_SVG);
        removeBtn.dataset.action = 'remove';
        removeBtn.addEventListener('click', async (e) => {
          e?.stopPropagation?.();
          await removeModel(item.id);
        });
        tdStatus.append(removeBtn);
      } else if (item.status === 'Not downloaded') {
        const downloadBtn = makeDownloadButton(item.name);
        downloadBtn.addEventListener('click', (e) => {
          e?.stopPropagation?.();
          selectModel(item.id, tr);
        });
        tdStatus.append(downloadBtn);
      } else {
        tdStatus.textContent = item.status;
      }

      tr.append(tdName, tdSize, tdSpeed, tdStatus);

      const handleSelect = (e) => {
        if (e) e.preventDefault?.();
        selectModel(item.id, tr);
      };

      tr.addEventListener('click', handleSelect);
      tr.addEventListener('keydown', (e) => {
        if (e.code === 'Enter' || e.code === 'Space') {
          handleSelect(e);
        }
      });

      modelTbody.append(tr);
    }
    const emptyText = modelMenuState === 'failed' ? 'Browser models are unavailable right now'
      : modelMenuState === 'ready' && !lastModelOptions.length ? 'No browser models run well on this device' : '';
    if (emptyText) {
      const tr = document.createElement('tr');
      tr.dataset.role = 'empty';
      const td = document.createElement('td');
      td.colSpan = 4;
      td.textContent = emptyText;
      tr.append(td);
      modelTbody.append(tr);
    }
  }

  function selectModel(id, tr) {
    if (modelSelect.value !== id) {
      stopTurn();
      messages.length = 0;
      render();
    }
    modelSelect.value = id;
    triggerChange(modelSelect);

    if (modelTbody) {
      for (const child of modelTbody.children) {
        const isThis = child === tr || child.dataset?.id === id;
        child.setAttribute('aria-selected', isThis ? 'true' : 'false');
        child.classList.toggle('is-selected', isThis);
      }
    }
  }

  async function removeModel(id) {
    const item = lastDownloads.models?.find((m) => m.id === id || m.base === id) || { id, base: id, bytes: 0 };
    if (window.confirm && typeof window.confirm === 'function') {
      const size = window.TalkModelsCore?.formatBytes;
      const sizeStr = size && item.bytes ? ` (${size(item.bytes)})` : '';
      if (!window.confirm(`Delete ${item.base || id}${sizeStr} from this browser? It will download again if you pick it later.`)) return;
    }
    const current = modelSelect.selectedOptions[0];
    if (current && (current.value === id || current.dataset?.base === id || current.dataset?.base === item.base)) {
      stopTurn();
      messages.length = 0;
      render();
      await clearModelSelection('');
    }
    await window.TalkModels.removeDownload(id);
    await refreshDownloads();
  }

  async function prepareModelMenu() {
    const { options, device } = await window.TalkModels.prepareMenu();
    if (modelDevice) {
      modelDevice.textContent = device || '';
      modelDevice.hidden = !device;
    }
    lastModelOptions = options || [];
    modelMenuState = 'ready';
    modelSelect.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = options.length ? 'Choose a browser model…' : 'No browser models run well on this device';
    placeholder.disabled = !options.length;
    modelSelect.append(placeholder);
    for (const option of options) {
      const element = document.createElement('option');
      element.value = option.id;
      element.textContent = option.label;
      element.dataset.base = option.base;
      element.dataset.label = option.label;
      modelSelect.append(element);
    }
    await refreshDownloads();
    if (!model) {
      const downloaded = lastModelOptions.find((opt) =>
        lastDownloads.models?.some((m) => (m.id === opt.id || m.base === opt.base) && m.complete));
      if (downloaded) {
        model = downloaded.id;
        localStorage.setItem(MODEL_KEY, model);
      }
    }
    if (savedModelGone()) {
      await clearModelSelection('Saved model is unavailable. Choose a browser model.');
    } else if (model) {
      modelSelect.value = model;
      await switchModel(model);
    }
    renderModelTable();
  }

  async function refreshDownloads() {
    let state;
    try {
      state = await window.TalkModels.downloads();
      lastDownloads = state;
    } catch (error) {
      status.textContent = `Couldn't read downloaded models (${error && error.message ? error.message : error})`;
      renderModelTable();
      return;
    }
    const stored = new Set(state.models.filter((item) => item.complete).map((item) => item.base));
    for (const option of modelSelect.options) {
      if (option.dataset && option.dataset.label) option.textContent = option.dataset.label + (stored.has(option.dataset.base) ? ' · ✓ downloaded' : '');
    }
    renderModelTable();
  }

  async function switchModel(id) {
    if (!id) {
      await clearModelSelection('');
      renderModelTable();
      return false;
    }
    model = id;
    localStorage.setItem(MODEL_KEY, model);
    try {
      downloadingModelId = id;
      await window.TalkModels.select(id, (progress) => {
        downloadingModelProgress = Math.round(progress * 100);
        const base = modelSelect.selectedOptions[0]?.dataset.base || id;
        status.textContent = `Downloading ${base} · ${downloadingModelProgress}%`;
        renderModelTable();
      });
      clearStatus();
      downloadingModelId = null;
      await refreshDownloads();
      return true;
    } catch (error) {
      downloadingModelId = null;
      renderModelTable();
      const base = modelSelect.selectedOptions[0]?.dataset.base || id;
      const reason = error && error.message ? error.message : String(error);
      await clearModelSelection(`Couldn't load ${base} (${reason}). Choose another browser model.`);
      return false;
    }
  }

  async function ensureBrowserModel() {
    try {
      await prepareModelMenu();
    } catch {
      await clearModelSelection('Browser models are unavailable right now.');
      return false;
    }
    if (!model && lastModelOptions.length) {
      const downloaded = lastModelOptions.find((opt) =>
        lastDownloads.models?.some((m) => (m.id === opt.id || m.base === opt.base) && m.complete));
      model = (downloaded || lastModelOptions[0]).id;
      modelSelect.value = model;
    }
    if (!model) {
      showError(lastModelOptions.length ? 'Choose a browser model first.' : 'No browser models run well on this device');
      return false;
    }
    return switchModel(model);
  }

  async function send(text) {
    const said = String(text || '').trim();
    if (!said || inFlight) return;
    stopRec();
    const mine = ++flight;
    const userMessage = { role: 'user', content: said };
    messages.push(userMessage);
    // Only the current message goes to the model: `messages` feeds the
    // transcript, never the request, so no earlier turn is sent as context.
    const turn = [userMessage];
    render();
    clearStatus();
    inFlight = true;
    paint('thinking');
    try {
      const ready = await ensureBrowserModel();
      if (mine !== flight || !ready) {
        if (!ready && messages.at(-1) === userMessage) {
          messages.pop();
          render();
          if (!form.hidden && !input.value) input.value = said;
        }
        paint('ready');
        return;
      }
      controller = new AbortController();
      const reply = await window.TalkModels.reply(turn, controller.signal);
      if (mine !== flight) return;
      const played = await speak(reply);
      if (mine !== flight) return;
      if (reply) {
        messages.push({ role: 'assistant', content: reply });
        render();
      }
      if (!played) {
        paint('ready');
        return;
      }
      paint(mode === 'handsfree' ? 'wake' : 'ready');
    } catch (e) {
      if (mine !== flight) return;
      paint('ready');
      if (!e || e.name !== 'AbortError') showError(e && e.message ? e.message : 'Browser model failed.');
    } finally {
      if (mine === flight) {
        controller = null;
        inFlight = false;
        if (mode === 'handsfree' && lastModelOptions.length) armHandsFree();
      }
    }
  }

  function stopTurn() {
    flight += 1;
    holding = false;
    heard = '';
    if (controller) controller.abort();
    controller = null;
    inFlight = false;
    cancelSpeech();
    stopRec();
    clearStatus();
    paint('ready');
    if (mode === 'handsfree') armHandsFree();
  }

  function setMode(next) {
    if (!core.MODES.includes(next)) return;
    mode = next;
    localStorage.setItem(MODE_KEY, mode);
    paintModes();
    holding = false;
    heard = '';
    stopRec();
    clearStatus();
    if (!inFlight && !speaking) {
      if (mode === 'handsfree') armHandsFree();
      else paint('ready');
    }
  }

  async function useLocalSpeech() {
    form.hidden = false;
    if (rec.processLocally || !('processLocally' in rec) || typeof Ctor.available !== 'function') {
      showError("Voice input isn't available in this browser right now. Type instead.");
      return;
    }
    let availability;
    try {
      availability = await Ctor.available({ langs: [rec.lang], processLocally: true });
    } catch (error) {
      showError(`Voice input isn't available in this browser right now (${error.message}). Type instead.`);
      return;
    }
    if (availability === 'available') {
      rec.processLocally = true;
      localStorage.setItem(STT_LOCAL_KEY, '1');
      status.textContent = 'Using on-device speech recognition. Hold Space or the mic to talk again.';
      return;
    }
    if (availability === 'unavailable') {
      showError("Voice input isn't available in this browser. Type instead.");
      return;
    }
    sttInstallPending = true;
    status.textContent = 'Voice input can run on this device. Press the mic or Space once to download it.';
  }

  async function installLocalSpeech() {
    sttInstallPending = false;
    status.textContent = 'Downloading on-device speech recognition…';
    try {
      // Called straight from the key or pointer handler: install() needs that user gesture.
      if (!await Ctor.install({ langs: [rec.lang], processLocally: true })) throw new Error('the browser declined');
    } catch (error) {
      showError(`Couldn't set up on-device speech recognition (${error.message}). Type instead.`);
      return false;
    }
    rec.processLocally = true;
    localStorage.setItem(STT_LOCAL_KEY, '1');
    clearStatus();
    status.textContent = 'On-device speech recognition is ready. Hold Space or the mic to talk.';
    return true;
  }

  function startSpace() {
    if (sttInstallPending && rec) {
      installLocalSpeech();
      return;
    }
    if (mode !== 'space' || inFlight || speaking || !rec || holding) return;
    holding = true;
    heard = '';
    rec.continuous = false;
    rec.interimResults = true;
    try { rec.start(); } catch { /* already running */ }
    paint('listening');
  }

  function endSpace() {
    if (!holding) return;
    holding = false;
    stopRec();
  }

  paint('ready');
  paintModes();
  if (window.TalkOrb) {
    const reactor = window.TalkOrb.createTalkOrb(root.querySelector('.talk-orb-canvas'), root.querySelector('.talk-orb-gl'));
    const drawOrb = (ts) => {
      reactor.frame(ui, window.TalkOrb.readVoice(null), ts / 1000);
      requestAnimationFrame(drawOrb);
    };
    requestAnimationFrame(drawOrb);
  }
  if (window.matchMedia) {
    try {
      const mCoarse = window.matchMedia('(pointer: coarse)');
      const mNarrow = window.matchMedia('(max-width: 600px)');
      if (typeof mCoarse.addEventListener === 'function') {
        mCoarse.addEventListener('change', updateHoldHint);
        mNarrow.addEventListener('change', updateHoldHint);
      }
    } catch { /* matchMedia listener not supported */ }
  }

  spaceTab.addEventListener('click', () => setMode('space'));
  handsfreeTab.addEventListener('click', () => setMode('handsfree'));
  voiceSettings.addEventListener('toggle', () => {
    if (!voiceSettings.open) return;
    renderVoiceGrid();
    if (modelMenuAttempted) return;
    modelMenuAttempted = true;
    prepareModelMenu().catch(async () => {
      modelSelect.replaceChildren();
      const unavailable = document.createElement('option');
      unavailable.value = '';
      unavailable.textContent = 'Browser models are unavailable right now';
      unavailable.disabled = true;
      modelSelect.append(unavailable);
      lastModelOptions = [];
      modelMenuState = 'failed';
      renderModelTable();
      status.textContent = 'Browser models are unavailable right now';
    }).catch((error) => showError(error.message));
  });
  modelSelect.addEventListener('change', () => {
    if (modelSelect.value !== model) {
      stopTurn();
      messages.length = 0;
      render();
    }
    switchModel(modelSelect.value).catch((error) => showError(error.message));
  });
  ttsEngineSelect.addEventListener('change', () => {
    ttsEngine = ttsEngineSelect.value === 'onnx' ? 'onnx' : 'browser';
    localStorage.setItem(TTS_ENGINE_KEY, ttsEngine);
    paintModes();
  });
  voiceSelect.addEventListener('change', () => {
    if (ttsEngine === 'browser') {
      browserVoice = voiceSelect.value;
      localStorage.setItem(BROWSER_VOICE_KEY, browserVoice);
      if (browserVoice) rememberChosenVoice('browser', browserVoice);
    } else {
      if (!ttsCatalog.parseVoiceKey(voiceSelect.value)) return;
      onnxVoice = voiceSelect.value;
      localStorage.setItem(ONNX_VOICE_KEY, onnxVoice);
      rememberChosenVoice('onnx', onnxVoice);
    }
    if ((ttsEngine === 'browser' && browserVoice) || (ttsEngine === 'onnx' && onnxVoice)) previewVoice();
  });
  if (voiceFilter) {
    voiceFilter.addEventListener('input', () => {
      applyVoiceFilter();
      syncVoiceBatchButtons();
    });
  }
  voiceGroupBy?.addEventListener('change', renderVoiceGrid);
  voiceDownloadAll?.addEventListener('click', (event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    void runVoiceBatchDownload();
  });
  voiceDeleteAll?.addEventListener('click', (event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    void runVoiceBatchDelete();
  });
  for (const key of MODEL_SORT_KEYS) {
    tableSort.bindHeader(document.getElementById(`talk-model-sort-${key}`), key, () => modelSort, (next) => {
      modelSort = next;
      renderModelTable();
    });
  }
  if (window.speechSynthesis) {
    speechSynthesis.addEventListener('voiceschanged', paintVoiceChoices);
    voicesNow().then(paintVoiceChoices);
  }
  ttsReady.then(() => {
    paintVoiceChoices();
    refreshStored();
  }, (error) => console.warn('ONNX voices unavailable:', error.message));

  orb.addEventListener('pointerdown', (e) => {
    if (mode !== 'space' || !rec) return;
    e.preventDefault();
    startSpace();
  });
  orb.addEventListener('pointerup', endSpace);
  orb.addEventListener('pointerleave', endSpace);
  orb.addEventListener('click', () => {
    if (sttInstallPending && rec && mode === 'handsfree') {
      installLocalSpeech().then((ready) => { if (ready) armHandsFree(); });
      return;
    }
    if (inFlight || speaking) stopTurn();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value;
    input.value = '';
    send(text);
  });

  // Space belongs to the orb wherever focus is: it closes the Voice popup, moves focus to the
  // orb and talks. Caught in the capture phase and stopped on both key down and key up, so no
  // focused button, select or table row acts on it as well.
  // Typing is the one exception: a space in a text box stays a space. Chords (Ctrl, Alt,
  // Shift, Cmd + Space) stay with the browser and the system.
  const typing = (t) => Boolean(t && ((t.closest && t.closest('input, textarea')) || t.isContentEditable));
  const chord = (e) => e.ctrlKey || e.altKey || e.metaKey || e.shiftKey;
  let spaceClaimed = false;
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') {
      stopTurn();
      return;
    }
    if (e.code !== 'Space' || chord(e) || typing(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    spaceClaimed = true;
    voiceSettings.open = false;
    orb.focus();
    if (mode === 'space') startSpace();
  }, true);
  // The key-up of a press this handler claimed ends it wherever focus went in between.
  window.addEventListener('keyup', (e) => {
    if (e.code !== 'Space' || !spaceClaimed) return;
    spaceClaimed = false;
    e.preventDefault();
    e.stopPropagation();
    if (mode === 'space') endSpace();
  }, true);
  // A key-up that never arrives (Alt-Tab mid-hold, the tab hidden) must not leave the mic open.
  const dropHold = () => {
    spaceClaimed = false;
    endSpace();
  };
  window.addEventListener('blur', dropHold);
  window.addEventListener('visibilitychange', () => { if (document.hidden !== false) dropHold(); });

  if (typeof Ctor !== 'function') {
    form.hidden = false;
    status.textContent = 'This browser has no speech recognition. Type instead.';
    return;
  }
  try { rec = new Ctor(); } catch { rec = null; }
  if (!rec) {
    form.hidden = false;
    return;
  }
  rec.lang = navigator.language || 'en-US';
  if ('processLocally' in rec && localStorage.getItem(STT_LOCAL_KEY) === '1') rec.processLocally = true;
  rec.onresult = (ev) => {
    let finalText = '';
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
      const piece = ev.results[i][0] ? ev.results[i][0].transcript : '';
      if (ev.results[i].isFinal) finalText += piece;
      else interim += piece;
    }
    heard = (finalText || interim).trim();
    if (heard && ui !== 'thinking' && ui !== 'speaking') paint('listening');
    if (mode === 'handsfree' && finalText.trim() && !inFlight) send(finalText);
  };
  rec.onerror = (ev) => {
    if (ev && ev.error === 'network') {
      useLocalSpeech();
      return;
    }
    if (ev && ev.error === 'not-allowed') showError('the microphone is blocked');
    else if (ev && ev.error && ev.error !== 'no-speech' && ev.error !== 'aborted') {
      showError('speech recognition: ' + ev.error);
    }
  };
  rec.onend = () => {
    const text = heard.trim();
    heard = '';
    if (mode === 'space' && text && !inFlight) {
      send(text);
      return;
    }
    if (mode === 'handsfree' && !inFlight && !speaking) armHandsFree();
    else if (!inFlight && !speaking && ui !== 'thinking') paint('ready');
  };

  if (mode === 'handsfree') armHandsFree();
})();
