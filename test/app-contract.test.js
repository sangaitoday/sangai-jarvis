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
  assert.doesNotMatch(html, /data-mode="live"|Cloud models|id="talk-cloud-table"|id="talk-call-btn"|id="status-page-panel"/i);
  assert.doesNotMatch(html + talk, /api\/talk|api\/live|gtag|turnstile|data-mode="live"|loadCloudModels|sendChatStream/i);
  assert.match(talk, /TalkModels\.reply/);
  assert.match(talk, /speakOnnxThenBrowser/);
  assert.doesNotMatch(read('talk-models.js'), /cloud:|selectedId === 'sangai'|LanguageModel\.create/);
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

test('static server serves index, legal pages, healthz, and immutable bundle headers without env', async () => {
  assert.deepEqual(PAGES, { '/': 'index.html', '/privacy': 'privacy.html', '/terms': 'terms.html' });
  assert.equal(MIME['.wasm'], 'application/wasm');
  assert.equal(cacheControlFor('/webllm/0.2.85/893d9998/engine.js'), 'public, max-age=31536000, immutable');
  assert.equal(cacheControlFor('/onnx/piper/1d4462e52b38/entry.js'), 'public, max-age=31536000, immutable');

  const site = createSite();
  const server = http.createServer(site.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    for (const route of ['/', '/privacy', '/terms', '/healthz', '/talk.js']) {
      const res = await fetch(`http://127.0.0.1:${port}${route}`);
      assert.equal(res.status, 200, route);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
