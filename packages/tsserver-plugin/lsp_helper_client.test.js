'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');

const { createLspHelperClient } = require('./lsp_helper_client.js');

function encodeMessage(message) {
  const json = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
}

function decodeMessages(bufferText) {
  const messages = [];
  let offset = 0;

  while (offset < bufferText.length) {
    const headerEnd = bufferText.indexOf('\r\n\r\n', offset);
    if (headerEnd === -1) {
      break;
    }

    const header = bufferText.slice(offset, headerEnd);
    const match = /^Content-Length:\s*(\d+)$/im.exec(header);
    if (!match) {
      break;
    }

    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const body = bufferText.slice(bodyStart, bodyStart + length);
    messages.push(JSON.parse(body));
    offset = bodyStart + length;
  }

  return messages;
}

function createFakeChild() {
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stdinText = '';
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      stdinText += chunk.toString('utf8');
      callback();
    },
  });

  return {
    get stdinText() {
      return stdinText;
    },
    kill() {
      events.emit('exit');
    },
    on(eventName, listener) {
      events.on(eventName, listener);
      return this;
    },
    stderr,
    stdin,
    stdout,
  };
}

test('lsp helper client initializes once, syncs document changes, and caches published diagnostics', () => {
  const diagnosticsFiles = [];
  const fakeChild = createFakeChild();
  let spawnCall;
  const helper = createLspHelperClient({
    argsPrefix: ['run', '-A', '/repo/src/main.ts'],
    command: 'deno',
    cwd: '/workspace',
    onDiagnostics(fileName) {
      diagnosticsFiles.push(fileName);
    },
    spawn(command, args, options) {
      spawnCall = { command, args, options };
      return fakeChild;
    },
  });

  helper.updateDocument('/workspace/src/main.sts', {
    languageId: 'soundscript',
    text: 'const value = 1;\n',
    version: '1',
  });

  assert.deepEqual(spawnCall, {
    command: 'deno',
    args: ['run', '--v8-flags=--max-old-space-size=8192', '-A', '/repo/src/main.ts', 'lsp'],
    options: {
      cwd: '/workspace',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  });
  assert.equal(decodeMessages(fakeChild.stdinText).length, 1);
  assert.equal(decodeMessages(fakeChild.stdinText)[0].method, 'initialize');

  fakeChild.stdout.write(encodeMessage({
    id: 1,
    jsonrpc: '2.0',
    result: {
      capabilities: {},
    },
  }));

  const initializedMessages = decodeMessages(fakeChild.stdinText);
  assert.equal(initializedMessages.length, 3);
  assert.equal(initializedMessages[1].method, 'initialized');
  assert.equal(initializedMessages[2].method, 'textDocument/didOpen');

  helper.updateDocument('/workspace/src/main.sts', {
    languageId: 'soundscript',
    text: 'const value = 1;\n',
    version: '1',
  });
  assert.equal(decodeMessages(fakeChild.stdinText).length, 3);

  helper.updateDocument('/workspace/src/main.sts', {
    languageId: 'soundscript',
    text: 'const value = 2;\n',
    version: '2',
  });
  const changedMessages = decodeMessages(fakeChild.stdinText);
  assert.equal(changedMessages.length, 4);
  assert.equal(changedMessages[3].method, 'textDocument/didChange');

  fakeChild.stdout.write(encodeMessage({
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: {
      uri: 'file:///workspace/src/main.sts',
      diagnostics: [{
        code: 'SOUND1024',
        message: 'Null-prototype values are not assignable to object in soundscript.',
        range: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 8 },
        },
        severity: 1,
        source: 'sound',
      }],
    },
  }));

  assert.deepEqual(diagnosticsFiles, ['/workspace/src/main.sts']);
  assert.deepEqual(helper.getDiagnostics('/workspace/src/main.sts'), [{
    code: 'SOUND1024',
    message: 'Null-prototype values are not assignable to object in soundscript.',
    range: {
      start: { line: 0, character: 6 },
      end: { line: 0, character: 8 },
    },
    severity: 1,
    source: 'sound',
  }]);
});
