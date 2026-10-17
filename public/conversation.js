'use strict';
(function () {
  function createConversation({ recognition, reply, speak, stopSpeech, onState, onLine, onError }) {
    let mode = 'push';
    let state = 'ready';
    let listening = false;
    let pending = '';
    let turn = Promise.resolve();
    let controller = null;
    let generation = 0;
    let suppressEnd = false;

    function paint(next) { state = next; onState(next); }
    function listen() {
      if (!recognition || listening || state === 'thinking' || state === 'speaking') return;
      pending = '';
      try {
        recognition.start();
        listening = true;
        paint('listening');
      } catch (error) { onError(error); }
    }
    function stopListening(processResult = false) {
      if (!listening) return;
      listening = false;
      suppressEnd = !processResult;
      recognition.stop();
    }
    async function send(text) {
      const message = String(text || '').trim();
      if (!message || state === 'thinking' || state === 'speaking') return;
      pending = '';
      stopListening();
      const thisGeneration = ++generation;
      controller = new AbortController();
      onLine('user', message);
      paint('thinking');
      turn = (async () => {
        let failure = null;
        try {
          const answer = await reply(message, controller.signal);
          if (thisGeneration !== generation) return;
          onLine('assistant', answer);
          paint('speaking');
          await speak(answer);
        } catch (error) {
          if (thisGeneration === generation && error?.name !== 'AbortError') failure = error;
        } finally {
          if (thisGeneration === generation) {
            controller = null;
            paint('ready');
            if (failure) onError(failure);
            if (mode === 'handsfree') listen();
          }
        }
      })();
      await turn;
    }

    if (recognition) {
      recognition.onresult = (event) => {
        for (let index = event.resultIndex || 0; index < event.results.length; index += 1) {
          if (event.results[index].isFinal ?? event.results[index][1]) {
            pending += ` ${event.results[index][0]?.transcript || ''}`;
          }
        }
      };
      recognition.onend = () => {
        listening = false;
        if (suppressEnd) { suppressEnd = false; return; }
        const text = pending.trim();
        pending = '';
        if (text) void send(text);
        else if (mode === 'handsfree' && state !== 'thinking' && state !== 'speaking') listen();
        else if (state === 'listening') paint('ready');
      };
      recognition.onerror = (event) => {
        listening = false;
        if (event.error !== 'no-speech' && event.error !== 'aborted') onError(new Error(`Speech recognition: ${event.error}`));
      };
    }

    return {
      mode: () => mode,
      state: () => state,
      idle: () => turn,
      setMode(next) {
        if (next !== 'push' && next !== 'handsfree') throw new Error(`Unknown mode: ${next}`);
        if (next === mode) return;
        pending = '';
        mode = next;
        if (next === 'handsfree') listen();
        else { stopListening(); if (state === 'listening') paint('ready'); }
      },
      startHold() { if (mode === 'push') listen(); },
      endHold() { if (mode === 'push') stopListening(true); },
      send,
      stop() {
        generation += 1;
        pending = '';
        controller?.abort();
        controller = null;
        stopSpeech();
        stopListening();
        paint('ready');
        if (mode === 'handsfree') listen();
      },
    };
  }
  if (typeof window !== 'undefined') window.createConversation = createConversation;
  if (typeof module !== 'undefined' && module.exports) module.exports = { createConversation };
})();
