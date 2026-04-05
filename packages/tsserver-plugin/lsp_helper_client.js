'use strict';

const { spawn: nodeSpawn } = require('node:child_process');
const { fileURLToPath, pathToFileURL } = require('node:url');

function encodeMessage(message) {
  const json = JSON.stringify(message);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`, 'utf8');
}

function createInitializeRequest(id) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      capabilities: {},
      initializationOptions: {
        capabilityMode: 'editor-bridge',
      },
      processId: null,
      rootUri: null,
    },
  };
}

function createInitializedNotification() {
  return {
    jsonrpc: '2.0',
    method: 'initialized',
    params: {},
  };
}

function createDidOpenNotification(fileName, document) {
  return {
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: {
      textDocument: {
        languageId: document.languageId,
        text: document.text,
        uri: pathToFileURL(fileName).href,
        version: document.version,
      },
    },
  };
}

function createDidChangeNotification(fileName, document) {
  return {
    jsonrpc: '2.0',
    method: 'textDocument/didChange',
    params: {
      contentChanges: [{
        text: document.text,
      }],
      textDocument: {
        uri: pathToFileURL(fileName).href,
        version: document.version,
      },
    },
  };
}

function readMessagesFromBuffer(state, chunk, onMessage) {
  state.buffer = Buffer.concat([state.buffer, chunk]);

  while (true) {
    const headerEnd = state.buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      return;
    }

    const headerText = state.buffer.subarray(0, headerEnd).toString('utf8');
    const contentLengthMatch = /^Content-Length:\s*(\d+)$/im.exec(headerText);
    if (!contentLengthMatch) {
      state.buffer = Buffer.alloc(0);
      return;
    }

    const contentLength = Number(contentLengthMatch[1]);
    const messageStart = headerEnd + 4;
    const messageEnd = messageStart + contentLength;
    if (state.buffer.length < messageEnd) {
      return;
    }

    const payload = state.buffer.subarray(messageStart, messageEnd).toString('utf8');
    state.buffer = state.buffer.subarray(messageEnd);
    onMessage(JSON.parse(payload));
  }
}

function isPublishDiagnosticsMessage(message) {
  return message?.method === 'textDocument/publishDiagnostics' &&
    typeof message?.params?.uri === 'string' &&
    Array.isArray(message?.params?.diagnostics);
}

function isInitializeResponse(message, initializeRequestId) {
  return message?.jsonrpc === '2.0' && message?.id === initializeRequestId;
}

function createSpawnOptions(cwd) {
  return {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
}

function log(options, message) {
  options.onLog?.(`[helper] ${message}`);
}

function helperArgsForCommand(command, argsPrefix) {
  const lowerCommand = String(command).toLowerCase();
  if (lowerCommand.endsWith('/deno') || lowerCommand.endsWith('\\deno') || lowerCommand === 'deno') {
    if (argsPrefix[0] === 'run') {
      return ['run', '--v8-flags=--max-old-space-size=8192', ...argsPrefix.slice(1), 'lsp'];
    }
    return ['--v8-flags=--max-old-space-size=8192', ...argsPrefix, 'lsp'];
  }

  return [...argsPrefix, 'lsp'];
}

function createLspHelperClient(options) {
  const spawn = options.spawn ?? nodeSpawn;
  const args = helperArgsForCommand(options.command, options.argsPrefix);
  const diagnosticsByFile = new Map();
  const openDocuments = new Map();
  const parserState = {
    buffer: Buffer.alloc(0),
  };
  let child;
  let initializeRequestId = 1;
  let initialized = false;
  let syncedDocuments = new Map();

  function writeMessage(message) {
    if (!child?.stdin?.writable) {
      return;
    }

    child.stdin.write(encodeMessage(message));
  }

  function writeAfterInitialize(message) {
    ensureStarted();
    if (!initialized) {
      return;
    }

    writeMessage(message);
  }

  function syncDocument(fileName, document) {
    const synced = syncedDocuments.get(fileName);
    if (!synced) {
      writeMessage(createDidOpenNotification(fileName, document));
      syncedDocuments.set(fileName, {
        text: document.text,
        version: document.version,
      });
      return;
    }

    if (synced.version === document.version && synced.text === document.text) {
      return;
    }

    writeMessage(createDidChangeNotification(fileName, document));
    syncedDocuments.set(fileName, {
      text: document.text,
      version: document.version,
    });
  }

  function syncOpenDocuments() {
    for (const [fileName, document] of openDocuments) {
      syncDocument(fileName, document);
    }
  }

  function handleMessage(message) {
    if (isInitializeResponse(message, initializeRequestId)) {
      log(options, 'received initialize response');
      initialized = true;
      writeMessage(createInitializedNotification());
      syncOpenDocuments();
      return;
    }

    if (!isPublishDiagnosticsMessage(message)) {
      return;
    }

    let fileName;
    try {
      fileName = fileURLToPath(message.params.uri);
    } catch {
      return;
    }

    diagnosticsByFile.set(fileName, message.params.diagnostics);
    log(options, `received ${message.params.diagnostics.length} diagnostics for ${fileName}`);
    options.onDiagnostics(fileName);
  }

  function attachChild(nextChild) {
    child = nextChild;
    parserState.buffer = Buffer.alloc(0);
    initialized = false;
    syncedDocuments = new Map();

    nextChild.stdout?.on('data', (chunk) => {
      const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      readMessagesFromBuffer(parserState, bufferChunk, handleMessage);
    });
    nextChild.stderr?.on('data', (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          log(options, `stderr: ${trimmed}`);
        }
      }
    });

    nextChild.on('error', (error) => {
      log(options, `process error: ${error instanceof Error ? error.message : String(error)}`);
      child = undefined;
      initialized = false;
    });
    nextChild.on('exit', (code, signal) => {
      log(options, `process exit: code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      child = undefined;
      initialized = false;
    });

    log(options, `starting ${options.command} ${args.join(' ')} (cwd=${options.cwd})`);
    writeMessage(createInitializeRequest(initializeRequestId));
  }

  function ensureStarted() {
    if (child) {
      return;
    }

    attachChild(
      spawn(options.command, args, createSpawnOptions(options.cwd)),
    );
  }

  return {
    dispose() {
      if (child && typeof child.kill === 'function') {
        child.kill();
      }
      child = undefined;
      initialized = false;
      syncedDocuments = new Map();
    },

    getDiagnostics(fileName) {
      return diagnosticsByFile.get(fileName) ?? [];
    },

    updateDocument(fileName, document) {
      openDocuments.set(fileName, document);
      ensureStarted();
      if (!initialized) {
        log(options, `queued ${fileName} until initialize completes`);
        return;
      }
      log(options, `syncing ${fileName} version=${document.version}`);
      syncDocument(fileName, document);
    },
  };
}

module.exports = {
  createLspHelperClient,
};
