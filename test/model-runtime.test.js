'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../public/talk-models-core.js');
const catalog = require('../public/talk-models.json');
const scores = require('../public/talk-models-scores.json');

test('browser model picker offers only compatible local models and rejects cloud ids', async () => {
  const adapter = { info: { vendor: 'test' }, features: new Set(['shader-f16']), limits: { maxBufferSize: 4 * 2 ** 30 } };
  const context = {
    window: { TalkModelsCore: core },
    navigator: { gpu: { requestAdapter: async () => adapter }, deviceMemory: 8, userAgent: 'Chrome/120' },
    localStorage: { getItem: () => '100' },
    fetch: async (url) => ({ ok: true, json: async () => url.includes('scores') ? scores : catalog }),
    AbortSignal,
    URL,
    console,
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../public/talk-models.js'), 'utf8'), context);
  const menu = await context.window.TalkModels.prepareMenu();
  assert.ok(menu.options.length > 20);
  assert.ok(menu.options.some((option) => option.base === 'Qwen3-0.6B'));
  assert.ok(menu.options.some((option) => option.base === 'Llama-3.2-1B-Instruct'));
  assert.ok(menu.options.every((option) => catalog.models.some((model) => model.id === option.id)));
  await assert.rejects(context.window.TalkModels.select('cloud:any'), /Unknown browser model/);
});
