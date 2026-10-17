'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../public/talk-models-core.js');
const catalog = require('../public/talk-models.json');
const scores = require('../public/talk-models-scores.json');

test('WebGPU and memory gates hide models the device cannot run', () => {
  assert.deepEqual(core.talkModelOptions(catalog, scores, { gpu: false, f16: false, maxBufferMB: 4096, memoryMB: 8192, bandwidthGBs: 100 }), []);
  const rows = core.talkModelOptions(catalog, scores, { gpu: true, f16: false, maxBufferMB: 4096, memoryMB: 4096, bandwidthGBs: 100 });
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => row.id.includes('q4f32')));
});

test('model reply cleanup removes thinking and control tokens', () => {
  assert.equal(core.cleanReply('<think>internal</think> Hello <|user|>ignore me'), 'Hello');
});
