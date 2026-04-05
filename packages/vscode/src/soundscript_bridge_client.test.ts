import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import {
  createSoundscriptBridgeClient,
  type LspDefinitionLocation,
  type LspDiagnostic,
} from './soundscript_bridge_client';

function encodeMessage(message: unknown): string {
  const json = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
}

function decodeMessages(bufferText: string): unknown[] {
  const messages: unknown[] = [];
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
    on(eventName: string, listener: (...args: unknown[]) => void) {
      events.on(eventName, listener);
      return this;
    },
    stderr,
    stdin,
    stdout,
  };
}

async function waitForMicrotaskTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('soundscript bridge client initializes, syncs the document, and resolves hover requests', async () => {
  const fakeChild = createFakeChild();
  let spawnCall:
    | {
      args: readonly string[];
      command: string;
      options: { cwd: string; stdio: [string, string, string] };
    }
    | undefined;
  const clientUnderTest = createSoundscriptBridgeClient({
    argsPrefix: ['run', '-A', '/repo/src/main.ts'],
    command: 'deno',
    cwd: '/workspace',
    rootUri: 'file:///workspace',
    onLog() {},
    spawn(command, args, options) {
      spawnCall = { command, args, options };
      return fakeChild;
    },
  });

  try {
    const hoverPromise = clientUnderTest.hover(
      {
        languageId: 'soundscript',
        text: 'const value = Object.create(null);\n',
        uri: 'file:///workspace/src/demo.sts',
        version: 1,
      },
      { line: 0, character: 6 },
    );

    assert.deepEqual(spawnCall, {
      command: 'deno',
      args: ['run', '--v8-flags=--max-old-space-size=8192', '-A', '/repo/src/main.ts', 'lsp'],
      options: {
        cwd: '/workspace',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    });
    const initializeMessages = decodeMessages(fakeChild.stdinText) as Array<{ method?: string }>;
    assert.equal(initializeMessages.length, 1);
    assert.equal(initializeMessages[0]?.method, 'initialize');

    fakeChild.stdout.write(encodeMessage({
      id: 1,
      jsonrpc: '2.0',
      result: {
        capabilities: {},
      },
    }));
    await waitForMicrotaskTurn();

    const requestMessages = decodeMessages(fakeChild.stdinText) as Array<{ method?: string }>;
    assert.equal(requestMessages[1]?.method, 'initialized');
    assert.equal(requestMessages[2]?.method, 'textDocument/didOpen');
    assert.equal(requestMessages[3], undefined);

    fakeChild.stdout.write(encodeMessage({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: 'file:///workspace/src/demo.sts',
        diagnostics: [],
      },
    }));
    await waitForMicrotaskTurn();

    const hoverRequestMessages = decodeMessages(fakeChild.stdinText) as Array<{ method?: string }>;
    assert.equal(hoverRequestMessages[3]?.method, 'textDocument/hover');

    fakeChild.stdout.write(encodeMessage({
      id: 2,
      jsonrpc: '2.0',
      result: {
        contents: {
          kind: 'markdown',
          value: '```ts\nconst value: BareObject\n```',
        },
        range: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 11 },
        },
      },
    }));

    assert.deepEqual(await hoverPromise, {
      contents: {
        kind: 'markdown',
        value: '```ts\nconst value: BareObject\n```',
      },
      range: {
        start: { line: 0, character: 6 },
        end: { line: 0, character: 11 },
      },
    });
  } finally {
    clientUnderTest.dispose();
  }
});

test('soundscript bridge client resolves definition responses', async () => {
  const fakeChild = createFakeChild();
  const client = createSoundscriptBridgeClient({
    argsPrefix: ['run', '-A', '/repo/src/main.ts'],
    command: 'deno',
    cwd: '/workspace',
    rootUri: 'file:///workspace',
    onLog() {},
    spawn() {
      return fakeChild;
    },
  });

  try {
    const definitionPromise = client.definition(
      {
        languageId: 'soundscript',
        text: 'const value = helper;\n',
        uri: 'file:///workspace/src/demo.sts',
        version: 1,
      },
      { line: 0, character: 14 },
    );

    fakeChild.stdout.write(encodeMessage({
      id: 1,
      jsonrpc: '2.0',
      result: {
        capabilities: {},
      },
    }));
    await waitForMicrotaskTurn();

    fakeChild.stdout.write(encodeMessage({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: 'file:///workspace/src/demo.sts',
        diagnostics: [],
      },
    }));
    await waitForMicrotaskTurn();

    fakeChild.stdout.write(encodeMessage({
      id: 2,
      jsonrpc: '2.0',
      result: [{
        uri: 'file:///workspace/src/helper.ts',
        range: {
          start: { line: 0, character: 13 },
          end: { line: 0, character: 19 },
        },
      } satisfies LspDefinitionLocation],
    }));

    assert.deepEqual(await definitionPromise, [{
      uri: 'file:///workspace/src/helper.ts',
      range: {
        start: { line: 0, character: 13 },
        end: { line: 0, character: 19 },
      },
    }]);
  } finally {
    client.dispose();
  }
});

test('soundscript bridge client waits for diagnostics before the first hover request', async () => {
  const fakeChild = createFakeChild();
  const client = createSoundscriptBridgeClient({
    argsPrefix: ['run', '-A', '/repo/src/main.ts'],
    command: 'deno',
    cwd: '/workspace',
    rootUri: 'file:///workspace',
    onLog() {},
    spawn() {
      return fakeChild;
    },
  });

  try {
    const hoverPromise = client.hover(
      {
        languageId: 'soundscript',
        text: 'const env: Environment = source;\nvoid env;\n',
        uri: 'file:///workspace/src/demo.sts',
        version: 1,
      },
      { line: 1, character: 5 },
    );

    fakeChild.stdout.write(encodeMessage({
      id: 1,
      jsonrpc: '2.0',
      result: {
        capabilities: {},
      },
    }));
    await waitForMicrotaskTurn();

    let messages = decodeMessages(fakeChild.stdinText) as Array<{ method?: string }>;
    assert.equal(messages[3], undefined);

    fakeChild.stdout.write(encodeMessage({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: 'file:///workspace/src/demo.sts',
        diagnostics: [],
      },
    }));
    await waitForMicrotaskTurn();

    messages = decodeMessages(fakeChild.stdinText) as Array<{ method?: string }>;
    assert.equal(messages[3]?.method, 'textDocument/hover');

    fakeChild.stdout.write(encodeMessage({
      id: 2,
      jsonrpc: '2.0',
      result: {
        contents: {
          kind: 'markdown',
          value: '```ts\nenv: unknown\n```',
        },
      },
    }));

    assert.deepEqual(await hoverPromise, {
      contents: {
        kind: 'markdown',
        value: '```ts\nenv: unknown\n```',
      },
    });
  } finally {
    client.dispose();
  }
});

test('soundscript bridge client publishes diagnostics to listeners', async () => {
  const fakeChild = createFakeChild();
  const published: Array<{ diagnostics: readonly LspDiagnostic[]; uri: string }> = [];
  const client = createSoundscriptBridgeClient({
    argsPrefix: ['run', '-A', '/repo/src/main.ts'],
    command: 'deno',
    cwd: '/workspace',
    rootUri: 'file:///workspace',
    onLog() {},
    onPublishDiagnostics(params) {
      published.push(params);
    },
    spawn() {
      return fakeChild;
    },
  });

  try {
    const syncPromise = client.syncDocument({
      languageId: 'soundscript',
      text: 'const value = source;\n',
      uri: 'file:///workspace/src/demo.sts',
      version: 1,
    });

    fakeChild.stdout.write(encodeMessage({
      id: 1,
      jsonrpc: '2.0',
      result: {
        capabilities: {},
      },
    }));
    await syncPromise;

    fakeChild.stdout.write(encodeMessage({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: 'file:///workspace/src/demo.sts',
        diagnostics: [{
          code: 'SOUND1001',
          message: 'Example diagnostic.',
          range: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 11 },
          },
          severity: 1,
          source: 'soundscript',
        }],
      },
    }));
    await waitForMicrotaskTurn();

    assert.deepEqual(published, [{
      uri: 'file:///workspace/src/demo.sts',
      diagnostics: [{
        code: 'SOUND1001',
        message: 'Example diagnostic.',
        range: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 11 },
        },
        severity: 1,
        source: 'soundscript',
      }],
    }]);
  } finally {
    client.dispose();
  }
});

test('soundscript bridge client returns null when diagnostics never settle', async () => {
  const fakeChild = createFakeChild();
  const client = createSoundscriptBridgeClient({
    argsPrefix: ['run', '-A', '/repo/src/main.ts'],
    command: 'deno',
    cwd: '/workspace',
    diagnosticsWaitTimeoutMs: 1,
    rootUri: 'file:///workspace',
    onLog() {},
    spawn() {
      return fakeChild;
    },
  });

  try {
    const hoverPromise = client.hover(
      {
        languageId: 'soundscript',
        text: 'const env: Environment = source;\nvoid env;\n',
        uri: 'file:///workspace/src/demo.sts',
        version: 1,
      },
      { line: 1, character: 5 },
    );

    fakeChild.stdout.write(encodeMessage({
      id: 1,
      jsonrpc: '2.0',
      result: {
        capabilities: {},
      },
    }));
    await waitForMicrotaskTurn();

    assert.equal(await hoverPromise, null);

    const messages = decodeMessages(fakeChild.stdinText) as Array<{ method?: string }>;
    assert.equal(messages[3], undefined);
  } finally {
    client.dispose();
  }
});

test('soundscript bridge client times out stalled hover requests', async () => {
  const fakeChild = createFakeChild();
  const client = createSoundscriptBridgeClient({
    argsPrefix: ['run', '-A', '/repo/src/main.ts'],
    command: 'deno',
    cwd: '/workspace',
    requestTimeoutMs: 1,
    rootUri: 'file:///workspace',
    onLog() {},
    spawn() {
      return fakeChild;
    },
  });

  try {
    const hoverPromise = client.hover(
      {
        languageId: 'soundscript',
        text: 'const value = source;\n',
        uri: 'file:///workspace/src/demo.sts',
        version: 1,
      },
      { line: 0, character: 6 },
    );
    const rejection = assert.rejects(
      hoverPromise,
      /soundscript helper request timed out: textDocument\/hover/,
    );

    fakeChild.stdout.write(encodeMessage({
      id: 1,
      jsonrpc: '2.0',
      result: {
        capabilities: {},
      },
    }));
    await waitForMicrotaskTurn();

    fakeChild.stdout.write(encodeMessage({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: 'file:///workspace/src/demo.sts',
        diagnostics: [],
      },
    }));
    await waitForMicrotaskTurn();

    await rejection;
  } finally {
    client.dispose();
  }
});
