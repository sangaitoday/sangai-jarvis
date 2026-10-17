'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createSite } = require('../server.js');
const { cacheControlFor, MIME, PAGES } = require('../site-rules.js');

const root = path.resolve(__dirname, '../public');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('public app keeps the www.sangai.today UI and local model/voice controls without cloud or live mode', () => {
  const html = read('index.html');
  const talk = read('talk.js');
  for (const id of [
    'talk-voice-settings',
    'talk-model-table',
    'talk-voice-grid',
    'talk-voice-download-all',
    'talk-voice-delete-all',
    'talk-orb',
    'talk-transcript',
    'talk-mode',
    'legal-panel',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /data-mode="space"/);
  assert.match(html, /data-mode="handsfree"/);
  assert.match(html, /onnxruntime-web\/wasm/);
  assert.match(html, /\/table-sort\.js/);
  assert.match(html, /\/talk\.js/);
  assert.doesNotMatch(html, /data-mode="live"|Cloud models|id="talk-cloud-table"|id="talk-call-btn"|id="status-page-panel"|talk-call-ripples/i);
  assert.doesNotMatch(html + talk, /api\/talk|api\/live|gtag|turnstile|data-mode="live"|loadCloudModels|sendChatStream/i);
  assert.doesNotMatch(read('talk.css'), /talk-call-ripples|talk-call-btn|#talk-cloud-table|\.is-live-off/);
  assert.doesNotMatch(read('talk-voice-core.js'), /\borbState\b/);
  assert.doesNotMatch(read('talk-models-core.js'), /\/\^sangai\$\/i|\/\^built-\?in\$\/i/);
  assert.match(talk, /TalkModels\.reply/);
  assert.match(talk, /speakOnnxThenBrowser/);
  assert.doesNotMatch(read('talk-models.js'), /cloud:|selectedId === 'sangai'|LanguageModel\.create/);
  assert.match(read('legal-panel.js'), /link\.target === '_blank'|link\.id === 'legal-panel-external'/);
  assert.match(read('home-graph-bg.js'), /preload = 'none'/);
});

test('browser model and voice catalogs match the SangAI site choices', () => {
  const catalog = JSON.parse(read('talk-models.json'));
  const voices = JSON.parse(read('talk-tts.json'));
  assert.equal(catalog.models.length, 159);
  assert.equal(new Set(catalog.models.map((model) => model.base)).size, 65);
  assert.equal(voices.voices.piper.length, 124);
  assert.equal(voices.voices.kokoro.length, 28);
  for (const engine of ['piper', 'supertonic3', 'kokoro']) assert.match(voices.bundles[engine], /^\/onnx\//);
});

test('tts-storage removeVoice handles missing Cache Storage without throwing', async () => {
  const ttsStorage = require('../public/tts-storage.js');
  await assert.doesNotReject(ttsStorage.removeVoice({ engine: 'supertonic3' }, { cachesImpl: null, storageImpl: null }));
  await assert.doesNotReject(ttsStorage.removeVoice({ engine: 'kokoro' }, { cachesImpl: null, storageImpl: null }));
  await assert.doesNotReject(ttsStorage.removeVoice({ engine: 'piper', voice: 'en_US-lessac-medium' }, { cachesImpl: null, storageImpl: null }));
});

test('static server serves index, legal pages, trailing slashes, HEAD, Range 206, healthz, and immutable bundle headers without env', async () => {
  assert.deepEqual(PAGES, { '/': 'index.html', '/privacy': 'privacy.html', '/terms': 'terms.html' });
  assert.equal(MIME['.wasm'], 'application/wasm');
  assert.equal(cacheControlFor('/webllm/0.2.85/893d9998/engine.js'), 'public, max-age=31536000, immutable');
  assert.equal(cacheControlFor('/onnx/piper/1d4462e52b38/entry.js'), 'public, max-age=31536000, immutable');

  const site = createSite();
  const server = http.createServer(site.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    for (const route of ['/', '/privacy', '/privacy/', '/terms', '/terms/', '/healthz', '/talk.js']) {
      const res = await fetch(`http://127.0.0.1:${port}${route}`);
      assert.equal(res.status, 200, route);
    }
    const headRes = await fetch(`http://127.0.0.1:${port}/privacy`, { method: 'HEAD' });
    assert.equal(headRes.status, 200);
    assert.equal(await headRes.text(), '');

    const rangeRes = await fetch(`http://127.0.0.1:${port}/talk.js`, {
      headers: { Range: 'bytes=0-15' },
    });
    assert.equal(rangeRes.status, 206);
    assert.equal(rangeRes.headers.get('accept-ranges'), 'bytes');
    assert.match(rangeRes.headers.get('content-range') || '', /^bytes 0-15\/\d+$/);
    const partial = await rangeRes.arrayBuffer();
    assert.equal(partial.byteLength, 16);

    const badUriRes = await fetch(`http://127.0.0.1:${port}/%E0%A4%A`);
    assert.equal(badUriRes.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
