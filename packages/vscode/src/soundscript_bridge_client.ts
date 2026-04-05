import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';

interface BridgeChildProcess {
  kill(): void;
  on(eventName: 'error' | 'exit', listener: (...args: unknown[]) => void): unknown;
  stderr: {
    on(eventName: 'data', listener: (chunk: Buffer | string) => void): unknown;
  };
  stdin: Writable & { writable: boolean };
  stdout: {
    on(eventName: 'data', listener: (chunk: Buffer | string) => void): unknown;
  };
}

type SpawnBridgeProcess = (
  command: string,
  args: readonly string[],
  options: { cwd: string; stdio: ['pipe', 'pipe', 'pipe'] },
) => BridgeChildProcess;

interface JsonRpcRequestMessage {
  id: number;
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcNotificationMessage {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcResponseMessage {
  error?: unknown;
  id?: number;
  jsonrpc?: '2.0';
  result?: unknown;
}

interface LspDiagnosticNotification {
  jsonrpc?: '2.0';
  method?: string;
  params?: {
    diagnostics?: unknown[];
    uri?: string;
  };
}

interface BridgeDocument {
  languageId: string;
  text: string;
  uri: string;
  version: number;
}

interface LspPosition {
  character: number;
  line: number;
}

export interface LspRange {
  end: LspPosition;
  start: LspPosition;
}

export interface LspHover {
  contents?: {
    kind?: string;
    value?: string;
  };
  range?: LspRange;
}

export interface LspDefinitionLocation {
  range: LspRange;
  uri: string;
}

interface PendingRequest {
  reject(error: Error): void;
  resolve(value: unknown): void;
}

interface PendingDiagnosticsWaiter {
  generation: number;
  reject(error: Error): void;
  resolve(): void;
}

interface SoundscriptBridgeClientOptions {
  argsPrefix: readonly string[];
  command: string;
  cwd: string;
  diagnosticsWaitTimeoutMs?: number;
  requestTimeoutMs?: number;
  onLog?(message: string): void;
  onPublishDiagnostics?(params: { diagnostics: readonly LspDiagnostic[]; uri: string }): void;
  rootUri: string | null;
  spawn?: SpawnBridgeProcess;
}

export interface LspDiagnostic {
  code?: number | string;
  message?: string;
  range?: LspRange;
  severity?: number;
  source?: string;
}

function encodeMessage(message: unknown): Buffer {
  const json = JSON.stringify(message);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`, 'utf8');
}

function helperArgsForCommand(
  command: string,
  argsPrefix: readonly string[],
): readonly string[] {
  const lowerCommand = command.toLowerCase();
  if (lowerCommand.endsWith('/deno') || lowerCommand.endsWith('\\deno') || lowerCommand === 'deno') {
    if (argsPrefix[0] === 'run') {
      return ['run', '--v8-flags=--max-old-space-size=8192', ...argsPrefix.slice(1), 'lsp'];
    }
    return ['--v8-flags=--max-old-space-size=8192', ...argsPrefix, 'lsp'];
  }

  return [...argsPrefix, 'lsp'];
}

function isInitializeResponse(
  message: JsonRpcResponseMessage,
  initializeRequestId: number,
): boolean {
  return message.jsonrpc === '2.0' && message.id === initializeRequestId;
}

function isPublishDiagnosticsNotification(message: unknown): message is LspDiagnosticNotification {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const candidate = message as LspDiagnosticNotification;
  return candidate.method === 'textDocument/publishDiagnostics';
}

function createInitializeRequest(
  id: number,
  rootUri: string | null,
): JsonRpcRequestMessage {
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
      rootUri,
    },
  };
}

function createInitializedNotification(): JsonRpcNotificationMessage {
  return {
    jsonrpc: '2.0',
    method: 'initialized',
    params: {},
  };
}

function createDidOpenNotification(document: BridgeDocument): JsonRpcNotificationMessage {
  return {
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: {
      textDocument: document,
    },
  };
}

function createDidChangeNotification(document: BridgeDocument): JsonRpcNotificationMessage {
  return {
    jsonrpc: '2.0',
    method: 'textDocument/didChange',
    params: {
      contentChanges: [{
        text: document.text,
      }],
      textDocument: {
        uri: document.uri,
        version: document.version,
      },
    },
  };
}

function readMessagesFromBuffer(
  state: { buffer: Buffer },
  chunk: Buffer,
  onMessage: (message: unknown) => void,
): void {
  state.buffer = Buffer.concat([state.buffer, chunk]);

  while (true) {
    const headerEnd = state.buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      return;
    }

    const headerText = state.buffer.subarray(0, headerEnd).toString('utf8');
    const match = /^Content-Length:\s*(\d+)$/im.exec(headerText);
    if (!match) {
      state.buffer = Buffer.alloc(0);
      return;
    }

    const bodyLength = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + bodyLength;
    if (state.buffer.length < bodyEnd) {
      return;
    }

    const body = state.buffer.subarray(bodyStart, bodyEnd).toString('utf8');
    state.buffer = state.buffer.subarray(bodyEnd);
    onMessage(JSON.parse(body));
  }
}

function toError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

export interface SoundscriptBridgeClient {
  definition(document: BridgeDocument, position: LspPosition): Promise<LspDefinitionLocation[] | null>;
  dispose(): void;
  hasSettledDiagnostics(document: BridgeDocument): boolean;
  hover(document: BridgeDocument, position: LspPosition): Promise<LspHover | null>;
  syncDocument(document: BridgeDocument): Promise<void>;
}

export function createSoundscriptBridgeClient(
  options: SoundscriptBridgeClientOptions,
): SoundscriptBridgeClient {
  const diagnosticsWaitTimeoutMs = options.diagnosticsWaitTimeoutMs ?? 1500;
  const requestTimeoutMs = options.requestTimeoutMs ?? 1500;
  const spawnProcess = options.spawn ?? spawn;
  const args = helperArgsForCommand(options.command, options.argsPrefix);
  const parserState = { buffer: Buffer.alloc(0) };
  const pendingRequests = new Map<number, PendingRequest>();
  const pendingDiagnosticsWaiters = new Map<string, PendingDiagnosticsWaiter[]>();
  const publishedDiagnosticsGeneration = new Map<string, number>();
  const syncedDiagnosticsGeneration = new Map<string, number>();
  const openDocuments = new Map<string, BridgeDocument>();
  const syncedDocuments = new Map<string, { text: string; version: number }>();
  const initializeRequestId = 1;
  let child: BridgeChildProcess | undefined;
  let initialized = false;
  let initializePromise: Promise<void> | undefined;
  let resolveInitialized: (() => void) | undefined;
  let rejectInitialized: ((error: Error) => void) | undefined;
  let nextRequestId = initializeRequestId + 1;

  function log(message: string): void {
    options.onLog?.(`[bridge-helper] ${message}`);
  }

  function writeMessage(message: unknown): void {
    if (!child?.stdin.writable) {
      throw new Error('soundscript helper stdin is not writable.');
    }

    child.stdin.write(encodeMessage(message));
  }

  function rejectAllPending(message: string): void {
    const error = new Error(message);
    for (const pending of pendingRequests.values()) {
      pending.reject(error);
    }
    pendingRequests.clear();

    for (const waiters of pendingDiagnosticsWaiters.values()) {
      for (const waiter of waiters) {
        waiter.reject(error);
      }
    }
    pendingDiagnosticsWaiters.clear();
  }

  function syncOpenDocuments(): void {
    for (const document of openDocuments.values()) {
      syncDocumentNow(document);
    }
  }

  function handleMessage(message: unknown): void {
    if (isInitializeResponse(message as JsonRpcResponseMessage, initializeRequestId)) {
      initialized = true;
      resolveInitialized?.();
      resolveInitialized = undefined;
      rejectInitialized = undefined;
      writeMessage(createInitializedNotification());
      syncOpenDocuments();
      log('received initialize response');
      return;
    }

    if (isPublishDiagnosticsNotification(message)) {
      const uri = message.params?.uri;
      if (typeof uri === 'string') {
        const diagnostics = Array.isArray(message.params?.diagnostics)
          ? message.params.diagnostics as LspDiagnostic[]
          : [];
        log(`received publishDiagnostics for ${uri}`);
        options.onPublishDiagnostics?.({
          uri,
          diagnostics,
        });
        const generation = syncedDiagnosticsGeneration.get(uri) ?? 0;
        publishedDiagnosticsGeneration.set(uri, generation);
        const waiters = pendingDiagnosticsWaiters.get(uri);
        if (waiters) {
          const remaining: PendingDiagnosticsWaiter[] = [];
          for (const waiter of waiters) {
            if (waiter.generation <= generation) {
              waiter.resolve();
            } else {
              remaining.push(waiter);
            }
          }
          if (remaining.length > 0) {
            pendingDiagnosticsWaiters.set(uri, remaining);
          } else {
            pendingDiagnosticsWaiters.delete(uri);
          }
        }
      }
      return;
    }

    const response = message as JsonRpcResponseMessage;
    if (typeof response.id !== 'number') {
      return;
    }

    const pending = pendingRequests.get(response.id);
    if (!pending) {
      return;
    }
    pendingRequests.delete(response.id);
    if (response.error) {
      pending.reject(toError(response.error, `soundscript helper request ${response.id} failed.`));
      return;
    }
    pending.resolve(response.result ?? null);
  }

  function attachChild(nextChild: BridgeChildProcess): void {
    child = nextChild;
    initialized = false;
    parserState.buffer = Buffer.alloc(0);
    syncedDocuments.clear();
    initializePromise = new Promise<void>((resolve, reject) => {
      resolveInitialized = resolve;
      rejectInitialized = reject;
    });

    nextChild.stdout.on('data', (chunk: Buffer | string) => {
      const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      readMessagesFromBuffer(parserState, bufferChunk, handleMessage);
    });
    nextChild.stderr.on('data', (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          log(`stderr: ${trimmed}`);
        }
      }
    });
    nextChild.on('error', (error) => {
      const normalized = toError(error, 'soundscript helper process failed.');
      rejectInitialized?.(normalized);
      rejectInitialized = undefined;
      resolveInitialized = undefined;
      initializePromise = undefined;
      rejectAllPending(normalized.message);
      child = undefined;
      initialized = false;
      log(`process error: ${normalized.message}`);
    });
    nextChild.on('exit', (code, signal) => {
      const message = `soundscript helper exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`;
      rejectInitialized?.(new Error(message));
      rejectInitialized = undefined;
      resolveInitialized = undefined;
      initializePromise = undefined;
      rejectAllPending(message);
      child = undefined;
      initialized = false;
      log(`process exit: code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    });

    log(`starting ${options.command} ${args.join(' ')} (cwd=${options.cwd})`);
    writeMessage(createInitializeRequest(initializeRequestId, options.rootUri));
  }

  function ensureStarted(): Promise<void> {
    if (!child) {
      attachChild(spawnProcess(options.command, args, {
        cwd: options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      }));
    }

    if (!initializePromise) {
      initializePromise = Promise.resolve();
    }
    return initializePromise;
  }

  function syncDocumentNow(document: BridgeDocument): void {
    const synced = syncedDocuments.get(document.uri);
    if (!synced) {
      writeMessage(createDidOpenNotification(document));
      syncedDiagnosticsGeneration.set(document.uri, (syncedDiagnosticsGeneration.get(document.uri) ?? 0) + 1);
      syncedDocuments.set(document.uri, {
        text: document.text,
        version: document.version,
      });
      return;
    }

    if (synced.text === document.text && synced.version === document.version) {
      return;
    }

    writeMessage(createDidChangeNotification(document));
    syncedDiagnosticsGeneration.set(document.uri, (syncedDiagnosticsGeneration.get(document.uri) ?? 0) + 1);
    syncedDocuments.set(document.uri, {
      text: document.text,
      version: document.version,
    });
  }

  async function syncDocument(document: BridgeDocument): Promise<void> {
    openDocuments.set(document.uri, document);
    await ensureStarted();
    if (!initialized) {
      return;
    }
    syncDocumentNow(document);
  }

  async function waitForPublishedDiagnostics(uri: string, generation: number): Promise<boolean> {
    if ((publishedDiagnosticsGeneration.get(uri) ?? 0) >= generation) {
      return true;
    }

    return await new Promise<boolean>((resolve, reject) => {
      const waiters = pendingDiagnosticsWaiters.get(uri) ?? [];
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        const current = pendingDiagnosticsWaiters.get(uri) ?? [];
        const remaining = current.filter((waiter) => waiter !== pendingWaiter);
        if (remaining.length > 0) {
          pendingDiagnosticsWaiters.set(uri, remaining);
        } else {
          pendingDiagnosticsWaiters.delete(uri);
        }
        resolve(false);
      }, diagnosticsWaitTimeoutMs);
      const pendingWaiter: PendingDiagnosticsWaiter = {
        generation,
        reject(error) {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          reject(error);
        },
        resolve() {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          resolve(true);
        },
      };
      waiters.push(pendingWaiter);
      pendingDiagnosticsWaiters.set(uri, waiters);
    });
  }

  async function issueRequest<TResult>(
    method: string,
    params: unknown,
  ): Promise<TResult | null> {
    const requestId = nextRequestId;
    nextRequestId += 1;

    const resultPromise = new Promise<TResult | null>((resolve, reject) => {
      pendingRequests.set(requestId, {
        resolve(value) {
          resolve(value as TResult | null);
        },
        reject,
      });
    });
    writeMessage({
      jsonrpc: '2.0',
      id: requestId,
      method,
      params,
    });
    return await Promise.race([
      resultPromise,
      new Promise<never>((_, reject) => {
        const timeout = setTimeout(() => {
          if (pendingRequests.delete(requestId)) {
            reject(new Error(`soundscript helper request timed out: ${method}`));
          }
        }, requestTimeoutMs);
        resultPromise.finally(() => clearTimeout(timeout));
      }),
    ]);
  }

  async function request<TResult>(
    document: BridgeDocument,
    method: string,
    params: unknown,
  ): Promise<TResult | null> {
    await syncDocument(document);
    const diagnosticsGeneration = syncedDiagnosticsGeneration.get(document.uri) ?? 0;
    if ((publishedDiagnosticsGeneration.get(document.uri) ?? 0) < diagnosticsGeneration) {
      const published = await waitForPublishedDiagnostics(document.uri, diagnosticsGeneration);
      if (!published) {
        return null;
      }
    }
    return await issueRequest<TResult>(method, params);
  }

  return {
    async hover(document, position) {
      return await request<LspHover>(document, 'textDocument/hover', {
        textDocument: { uri: document.uri },
        position,
      });
    },

    async definition(document, position) {
      return await request<LspDefinitionLocation[] | null>(document, 'textDocument/definition', {
        textDocument: { uri: document.uri },
        position,
      });
    },

    dispose() {
      rejectAllPending('soundscript helper disposed.');
      if (child) {
        child.kill();
      }
      child = undefined;
      initialized = false;
      initializePromise = undefined;
      resolveInitialized = undefined;
      rejectInitialized = undefined;
      syncedDocuments.clear();
      openDocuments.clear();
    },

    hasSettledDiagnostics(document) {
      const syncedGeneration = syncedDiagnosticsGeneration.get(document.uri) ?? 0;
      return syncedGeneration > 0 &&
        (publishedDiagnosticsGeneration.get(document.uri) ?? 0) >= syncedGeneration;
    },

    async syncDocument(document) {
      await syncDocument(document);
    },
  };
}
