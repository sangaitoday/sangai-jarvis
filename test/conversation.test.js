'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createConversation } = require('../public/conversation.js');

function setup() {
  const calls = [];
  const recognition = {
    start() { calls.push('listen'); },
    stop() { calls.push('stop-listening'); this.onend(); },
  };
  const conversation = createConversation({
    recognition,
    reply: async (text) => { calls.push(`reply:${text}`); return `answer to ${text}`; },
    speak: async (text) => { calls.push(`speak:${text}`); },
    stopSpeech: () => calls.push('stop-speech'),
    onState: (state) => calls.push(`state:${state}`),
    onLine: (role, text) => calls.push(`${role}:${text}`),
    onError: (error) => { throw error; },
  });
  return { calls, recognition, conversation };
}

test('push-to-talk sends the final transcript after release and leaves the mic off', async () => {
  const { calls, recognition, conversation } = setup();
  conversation.startHold();
  recognition.onresult({ results: [[{ transcript: 'hello' }, true]] });
  conversation.endHold();
  await conversation.idle();
  assert.deepEqual(calls.filter((call) => call === 'listen' || call.startsWith('reply:')), ['listen', 'reply:hello']);
  assert.equal(conversation.mode(), 'push');
  assert.equal(conversation.state(), 'ready');
});

test('hands-free listens again only after the answer has been spoken', async () => {
  const { calls, recognition, conversation } = setup();
  conversation.setMode('handsfree');
  recognition.onresult({ results: [[{ transcript: 'question' }, true]] });
  recognition.onend();
  await conversation.idle();
  assert.deepEqual(calls.filter((call) => call === 'listen' || call.startsWith('reply:') || call.startsWith('speak:')),
    ['listen', 'reply:question', 'speak:answer to question', 'listen']);
  conversation.setMode('push');
  assert.equal(conversation.mode(), 'push');
  assert.equal(conversation.state(), 'ready');
});

test('empty speech does not send a turn and hands-free can be stopped', async () => {
  const { calls, recognition, conversation } = setup();
  conversation.setMode('handsfree');
  recognition.onend();
  conversation.setMode('push');
  await conversation.idle();
  assert.equal(calls.filter((call) => call.startsWith('reply:')).length, 0);
  assert.equal(conversation.state(), 'ready');
});

test('typed send pauses hands-free recognition while the model and voice run', async () => {
  const { calls, conversation } = setup();
  conversation.setMode('handsfree');
  await conversation.send('typed');
  assert.deepEqual(calls.filter((call) => call === 'listen' || call.startsWith('reply:')),
    ['listen', 'reply:typed', 'listen']);
});
