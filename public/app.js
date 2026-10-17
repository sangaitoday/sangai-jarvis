'use strict';
(function () {
  const byId = (id) => document.getElementById(id);
  const modelSelect = byId('model');
  const voiceSelect = byId('voice');
  const status = byId('status');
  const lines = byId('lines');
  const mic = byId('mic');
  const handsfree = byId('handsfree-mode');
  const push = byId('push-mode');
  const form = byId('form');
  const message = byId('message');
  let modelReady = false;
  let loading = false;
  let currentAudio = null;
  let finishSpeech = null;
  let speechGeneration = 0;
  let piperManifest = null;
  let voiceRows = [];

  const report = (text) => { status.textContent = text; };
  const recognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
  const recognition = recognitionClass ? new recognitionClass() : null;
  if (recognition) {
    recognition.lang = navigator.language || 'en-US';
    recognition.continuous = false;
    recognition.interimResults = false;
  }
  const tts = window.TtsRuntime.create({ bundleFor: () => piperManifest?.bundles?.piper });

  function stopSpeech() {
    speechGeneration += 1;
    if (currentAudio) { currentAudio.pause(); currentAudio = null; }
    window.speechSynthesis?.cancel();
    finishSpeech?.();
    finishSpeech = null;
  }

  function playAudio(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      currentAudio = audio;
      const finish = (error) => {
        if (currentAudio === audio) currentAudio = null;
        URL.revokeObjectURL(url);
        finishSpeech = null;
        error ? reject(error) : resolve();
      };
      finishSpeech = finish;
      audio.onended = () => finish();
      audio.onerror = () => finish(new Error('Voice playback failed'));
      audio.play().catch(finish);
    });
  }

  async function speak(text) {
    const selection = voiceSelect.value;
    const generation = ++speechGeneration;
    if (selection.startsWith('piper:')) {
      report('Preparing local voice…');
      const voice = selection.slice('piper:'.length);
      const row = voiceRows.find((item) => item.id === voice);
      const wav = await tts.speak('piper', text, voice, {
        sizeBytes: (row?.sizeMB || 0) * 1e6,
        progress: (fraction) => { if (generation === speechGeneration) report(`Downloading local voice… ${Math.round(fraction * 100)}%`); },
      });
      if (generation !== speechGeneration) return;
      report('Speaking…');
      await playAudio(wav);
      return;
    }
    if (!window.speechSynthesis) throw new Error('Browser voice is unavailable');
    const voices = window.speechSynthesis.getVoices();
    const selectedVoice = voices.find((item) => item.voiceURI === selection.slice('browser:'.length));
    if (!selectedVoice) throw new Error('Choose an available voice');
    report('Speaking…');
    await new Promise((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.voice = selectedVoice;
      utterance.lang = selectedVoice.lang;
      const finish = (error) => {
        finishSpeech = null;
        error ? reject(error) : resolve();
      };
      finishSpeech = finish;
      utterance.onend = () => finish();
      utterance.onerror = (event) => finish(new Error(`Browser voice failed: ${event.error}`));
      window.speechSynthesis.speak(utterance);
    });
  }

  function addLine(role, text) {
    lines.querySelector('.empty')?.remove();
    const line = document.createElement('div');
    line.className = `line ${role}`;
    const label = document.createElement('strong');
    label.textContent = role === 'user' ? 'You' : 'Javis';
    line.append(label, document.createTextNode(text));
    lines.append(line);
    lines.scrollTop = lines.scrollHeight;
  }

  const conversation = window.createConversation({
    recognition,
    reply: (text, signal) => window.TalkModels.reply([{ role: 'user', content: text }], signal),
    speak,
    stopSpeech,
    onLine: addLine,
    onState: (state) => {
      report({ ready: 'Ready', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking…' }[state]);
      mic.classList.toggle('held', state === 'listening');
    },
    onError: (error) => {
      report(error.message || String(error));
      if (/not-allowed|permission|language-not-supported/i.test(error.message || '')) setMode('push');
    },
  });

  function setMode(mode) {
    if (mode === 'handsfree' && (!recognition || !modelReady)) return;
    conversation.setMode(mode);
    push.setAttribute('aria-pressed', String(mode === 'push'));
    handsfree.setAttribute('aria-pressed', String(mode === 'handsfree'));
    mic.textContent = mode === 'push' ? 'Hold to talk' : 'Listening hands-free';
    mic.disabled = mode !== 'push' || !recognition || !modelReady;
    report(mode === 'handsfree' ? 'Listening hands-free…' : 'Ready');
  }

  async function loadModels() {
    try {
      const { options, device } = await window.TalkModels.prepareMenu();
      modelSelect.replaceChildren(new Option('Choose a browser model', ''));
      for (const option of options) modelSelect.add(new Option(option.label, option.id));
      if (!options.length) report('This browser has no supported WebGPU model. Try a recent desktop browser.');
      else report(device || 'Choose a model to begin.');
    } catch (error) {
      report(`Could not load browser models: ${error.message}`);
      modelSelect.replaceChildren(new Option('Models unavailable', ''));
    }
  }

  function loadBrowserVoices() {
    const previous = voiceSelect.value;
    voiceSelect.replaceChildren();
    const voices = window.speechSynthesis?.getVoices() || [];
    for (const voice of voices.filter((item) => /^en|^vi/i.test(item.lang))) {
      voiceSelect.add(new Option(`${voice.name} · ${voice.lang} · Browser`, `browser:${voice.voiceURI}`));
    }
    for (const voice of voiceRows) voiceSelect.add(new Option(`${voice.name} · ${voice.langs.join(', ')} · Downloadable`, `piper:${voice.id}`));
    if (!voiceSelect.options.length) voiceSelect.add(new Option('No voice available', ''));
    const saved = localStorage.getItem('javis.voice');
    if ([...voiceSelect.options].some((item) => item.value === previous)) voiceSelect.value = previous;
    else if ([...voiceSelect.options].some((item) => item.value === saved)) voiceSelect.value = saved;
  }

  modelSelect.addEventListener('change', async () => {
    if (loading) return;
    conversation.stop();
    setMode('push');
    modelReady = false;
    mic.disabled = true;
    handsfree.disabled = true;
    const id = modelSelect.value;
    if (!id) { report('Choose a model to begin.'); return; }
    loading = true;
    modelSelect.disabled = true;
    report('Preparing browser model…');
    try {
      await window.TalkModels.select(id, (fraction, detail) => report(`${detail || 'Downloading model'} ${Math.round(fraction * 100)}%`));
      modelReady = true;
      mic.disabled = !recognition;
      handsfree.disabled = !recognition;
      report('Ready. Hold the mic or type a message.');
    } catch (error) {
      report(`Model could not start: ${error.message}`);
    } finally { loading = false; modelSelect.disabled = false; }
  });
  voiceSelect.addEventListener('change', () => localStorage.setItem('javis.voice', voiceSelect.value));
  push.addEventListener('click', () => setMode('push'));
  handsfree.addEventListener('click', () => setMode('handsfree'));
  mic.addEventListener('pointerdown', (event) => { if (mic.disabled) return; event.preventDefault(); mic.setPointerCapture(event.pointerId); conversation.startHold(); });
  mic.addEventListener('pointerup', () => conversation.endHold());
  mic.addEventListener('pointercancel', () => conversation.endHold());
  mic.addEventListener('keydown', (event) => {
    if (event.code === 'Space' || event.code === 'Enter') { event.preventDefault(); if (!event.repeat) conversation.startHold(); }
  });
  mic.addEventListener('keyup', (event) => {
    if (event.code === 'Space' || event.code === 'Enter') { event.preventDefault(); conversation.endHold(); }
  });
  window.addEventListener('keydown', (event) => {
    if (event.code !== 'Space' || event.repeat || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(document.activeElement?.tagName)) return;
    event.preventDefault();
    if (modelReady) conversation.startHold();
  });
  window.addEventListener('keyup', (event) => { if (event.code === 'Space') conversation.endHold(); });
  window.addEventListener('blur', () => conversation.endHold());
  document.addEventListener('visibilitychange', () => { if (document.hidden) setMode('push'); });
  byId('stop').addEventListener('click', () => conversation.stop());
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!modelReady) { report('Choose and load a browser model first.'); return; }
    const text = message.value.trim();
    if (!text) return;
    message.value = '';
    void conversation.send(text);
  });

  if (!recognition) { mic.disabled = true; handsfree.disabled = true; }
  window.speechSynthesis?.addEventListener('voiceschanged', loadBrowserVoices);
  fetch('/talk-tts.json').then((response) => response.ok ? response.json() : null).then((manifest) => {
    piperManifest = manifest;
    voiceRows = (manifest?.voices?.piper || []).filter((voice) =>
      voice.id === 'en_US-lessac-medium' || voice.id === 'vi_VN-vais1000-medium');
    loadBrowserVoices();
  }).catch((error) => { report(`Local voices unavailable: ${error.message}`); loadBrowserVoices(); });
  loadBrowserVoices();
  void loadModels();
})();
