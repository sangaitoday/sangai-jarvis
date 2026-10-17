'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../public');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('public app has two microphone modes and no chat API route', () => {
  const html = read('index.html');
  const app = read('app.js');
  assert.match(html, /id="push-mode"/);
  assert.match(html, /id="handsfree-mode"/);
  assert.doesNotMatch(html + app, /api\/talk|api\/live|gtag|turnstile|data-mode="live"/i);
  assert.match(app, /TalkModels\.reply/);
  assert.match(app, /tts\.speak\('piper'/);
  assert.doesNotMatch(read('talk-models.js'), /cloud:|selectedId === 'sangai'|LanguageModel\.create/);
});

test('model catalog includes only the permitted on-device models', () => {
  const catalog = JSON.parse(read('talk-models.json'));
  assert.ok(catalog.models.length > 0);
  for (const model of catalog.models) assert.match(model.id, /^Qwen3-(0\.6B|1\.7B)-q4f(16|32)_1-MLC$/);
});
