import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { SpawnDiagnosticsWorker } from './editor_process_support';

type Listener<T> = (value: T) => unknown;
type ModuleWithLoad = typeof Module & {
  _load(
    request: string,
    parent: unknown,
    isMain: boolean,
  ): unknown;
};

interface FakeDocument {
  getText(): string;
  languageId: string;
  uri: {
    fsPath: string;
    scheme: string;
    toString(): string;
  };
  version: number;
}

function createEvent<T>(): {
  event(listener: Listener<T>): { dispose(): void };
  fire(value: T): void;
} {
  const listeners = new Set<Listener<T>>();
  return {
    event(listener) {
      listeners.add(listener);
      return {
        dispose() {
          listeners.delete(listener);
        },
      };
    },
    fire(value) {
      for (const listener of [...listeners]) {
        listener(value);
      }
    },
  };
}

function waitFor(predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 500;
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error('Timed out waiting for condition.'));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

function createFakeSpawn(): SpawnDiagnosticsWorker {
  return () => {
    const stdoutListeners = new Set<(chunk: string) => void>();
    return {
      kill() {},
      on() {},
      stderr: {
        on() {},
      },
      stdin: {
        writable: true,
        write(chunk: string | Buffer, callback?: (error?: Error | null) => void) {
          const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
          for (const line of text.split('\n')) {
            if (line.trim().length === 0) {
              continue;
            }
            const request = JSON.parse(line) as { id: number; method: string };
            const result = request.method === 'diagnostics'
              ? {
                diagnostics: [{
                  code: 'SOUNDTEST',
                  message: 'Example diagnostics.',
                  severity: 1,
                  source: 'soundscript',
                }],
              }
              : {};
            queueMicrotask(() => {
              for (const listener of [...stdoutListeners]) {
                listener(`${JSON.stringify({ id: request.id, result })}\n`);
              }
            });
          }
          callback?.();
          return true;
        },
      } as NodeJS.WritableStream & { writable: boolean },
      stdout: {
        on(eventName: string, listener: (chunk: string) => void) {
          if (eventName === 'data') {
            stdoutListeners.add(listener);
          }
        },
      },
    };
  };
}

test('diagnostics refresh when an already-open soundscript document becomes visible', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'soundscript-editor-diagnostics-'));
  const moduleWithLoad = Module as unknown as ModuleWithLoad;
  const originalLoad = moduleWithLoad._load;
  try {
    const filePath = join(workspace, 'src', 'main.sts');
    mkdirSync(join(workspace, 'src'), { recursive: true });
    writeFileSync(join(workspace, 'tsconfig.json'), '{}\n');
    writeFileSync(filePath, 'const value: string = 1;\n');

    const document: FakeDocument = {
      getText: () => 'const value: string = 1;\n',
      languageId: 'soundscript',
      uri: {
        fsPath: filePath,
        scheme: 'file',
        toString: () => `file://${filePath}`,
      },
      version: 1,
    };
    const visibleEditors: Array<{ document: FakeDocument }> = [];
    const visibleEditorsEvent = createEvent<Array<{ document: FakeDocument }>>();
    const published = new Map<string, readonly unknown[]>();
    const fakeVscode = {
      Diagnostic: class {
        code?: string | number;
        source?: string;
        constructor(
          public readonly range: unknown,
          public readonly message: string,
          public readonly severity: number,
        ) {}
      },
      DiagnosticSeverity: {
        Error: 0,
        Hint: 3,
        Information: 2,
        Warning: 1,
      },
      Disposable: {
        from(...disposables: Array<{ dispose(): void }>) {
          return {
            dispose() {
              for (const disposable of disposables) {
                disposable.dispose();
              }
            },
          };
        },
      },
      Range: class {
        constructor(
          public readonly startLine: number,
          public readonly startCharacter: number,
          public readonly endLine: number,
          public readonly endCharacter: number,
        ) {}
      },
      languages: {
        createDiagnosticCollection() {
          return {
            delete() {},
            dispose() {},
            set(uri: FakeDocument['uri'], diagnostics: readonly unknown[]) {
              published.set(uri.toString(), diagnostics);
            },
          };
        },
      },
      window: {
        get visibleTextEditors() {
          return visibleEditors;
        },
        onDidChangeVisibleTextEditors: visibleEditorsEvent.event,
      },
      workspace: {
        onDidChangeTextDocument() {
          return { dispose() {} };
        },
        onDidCloseTextDocument() {
          return { dispose() {} };
        },
        onDidOpenTextDocument() {
          return { dispose() {} };
        },
        onDidSaveTextDocument() {
          return { dispose() {} };
        },
      },
    };

    moduleWithLoad._load = (request, parent, isMain) => {
      if (request === 'vscode') {
        return fakeVscode;
      }
      return originalLoad(request, parent, isMain);
    };

    const { activateSoundscriptDiagnostics } = require('./editor_diagnostics_client') as typeof import(
      './editor_diagnostics_client'
    );
    const diagnostics = activateSoundscriptDiagnostics(
      { appendLine() {} } as never,
      { argsPrefix: [], command: 'soundscript', source: 'workspace' },
      createFakeSpawn(),
    );

    visibleEditors.push({ document });
    visibleEditorsEvent.fire([...visibleEditors]);

    await waitFor(() => (published.get(document.uri.toString())?.length ?? 0) > 0);
    diagnostics.dispose();
  } finally {
    moduleWithLoad._load = originalLoad;
    rmSync(workspace, { force: true, recursive: true });
  }
});
