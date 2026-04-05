import { spawn } from 'node:child_process';
import * as vscode from 'vscode';

import type { ResolvedCliLaunch } from './server_resolution';
import {
  buildDiagnosticsWorkerArgs,
  findNearestSoundscriptProject,
  type SpawnDiagnosticsWorker,
} from './editor_process_support';

interface WorkerRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface WorkerResponse {
  error?: string;
  id?: number;
  result?: unknown;
}

interface WorkerDiagnostic {
  code?: string | number;
  message?: string;
  range?: {
    end: { character: number; line: number };
    start: { character: number; line: number };
  };
  severity?: number;
  source?: string;
}

interface DiagnosticsWorkerClientOptions {
  cliLaunch?: ResolvedCliLaunch;
  onLog(message: string): void;
  spawn?: SpawnDiagnosticsWorker;
}

interface PendingRequest {
  reject(error: Error): void;
  resolve(value: unknown): void;
}

interface WorkerState {
  buffer: string;
  client: DiagnosticsWorkerConnection;
}

function isSoundscriptDocument(document: vscode.TextDocument): boolean {
  return document.languageId === 'soundscript' && document.uri.scheme === 'file';
}

function workspaceKeyForDocument(document: vscode.TextDocument): string {
  return vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? '__default__';
}

function toDiagnosticSeverity(severity: number | undefined): vscode.DiagnosticSeverity {
  switch (severity) {
    case 2:
      return vscode.DiagnosticSeverity.Warning;
    case 3:
      return vscode.DiagnosticSeverity.Information;
    case 4:
      return vscode.DiagnosticSeverity.Hint;
    case 1:
    default:
      return vscode.DiagnosticSeverity.Error;
  }
}

function toVscodeDiagnostic(diagnostic: WorkerDiagnostic): vscode.Diagnostic {
  const range = diagnostic.range
    ? new vscode.Range(
      diagnostic.range.start.line,
      diagnostic.range.start.character,
      diagnostic.range.end.line,
      diagnostic.range.end.character,
    )
    : new vscode.Range(0, 0, 0, 0);
  const converted = new vscode.Diagnostic(
    range,
    diagnostic.message ?? '',
    toDiagnosticSeverity(diagnostic.severity),
  );
  converted.code = diagnostic.code;
  converted.source = diagnostic.source ?? 'soundscript';
  return converted;
}

class DiagnosticsWorkerConnection implements vscode.Disposable {
  private readonly childProcess;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private readonly state: WorkerState;

  constructor(
    private readonly outputChannel: vscode.OutputChannel,
    private readonly cwd: string,
    cliLaunch: ResolvedCliLaunch,
    spawnProcess: SpawnDiagnosticsWorker,
  ) {
    this.childProcess = spawnProcess(cliLaunch.command, [...buildDiagnosticsWorkerArgs(cliLaunch)], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.state = {
      buffer: '',
      client: this,
    };
    this.childProcess.stdout.on('data', (chunk) => {
      this.appendOutput(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    this.childProcess.stderr.on('data', (chunk) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this.outputChannel.appendLine(`[diagnostics-worker] stderr: ${text.trimEnd()}`);
    });
    this.childProcess.on('error', (error) => {
      this.rejectAll(error instanceof Error ? error : new Error(String(error)));
    });
    this.childProcess.on('exit', (code, signal) => {
      this.rejectAll(new Error(`Diagnostics worker exited (code=${String(code)}, signal=${String(signal)}).`));
    });
  }

  async initialize(): Promise<void> {
    await this.sendRequest('initialize');
  }

  async syncDocument(document: vscode.TextDocument): Promise<void> {
    await this.sendRequest('syncDocument', {
      filePath: document.uri.fsPath,
      text: document.getText(),
      version: document.version,
    });
  }

  async closeDocument(filePath: string): Promise<void> {
    await this.sendRequest('closeDocument', { filePath });
  }

  async requestDiagnostics(
    filePath: string,
    projectPath: string,
  ): Promise<readonly WorkerDiagnostic[]> {
    const response = await this.sendRequest('diagnostics', {
      filePath,
      projectPath,
    }) as { diagnostics?: readonly WorkerDiagnostic[] };
    return response.diagnostics ?? [];
  }

  dispose(): void {
    this.rejectAll(new Error('Diagnostics worker disposed.'));
    this.childProcess.kill();
  }

  private appendOutput(chunk: string): void {
    this.state.buffer += chunk;
    while (true) {
      const newlineIndex = this.state.buffer.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }

      const line = this.state.buffer.slice(0, newlineIndex).trim();
      this.state.buffer = this.state.buffer.slice(newlineIndex + 1);
      if (line.length === 0) {
        continue;
      }

      let message: WorkerResponse;
      try {
        message = JSON.parse(line) as WorkerResponse;
      } catch (error) {
        this.outputChannel.appendLine(
          `[diagnostics-worker] failed to parse message: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }

      const pending = typeof message.id === 'number'
        ? this.pendingRequests.get(message.id)
        : undefined;
      if (!pending) {
        continue;
      }

      this.pendingRequests.delete(message.id as number);
      if (message.error) {
        pending.reject(new Error(message.error));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private async sendRequest(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.childProcess.stdin.writable) {
      throw new Error('Diagnostics worker stdin is not writable.');
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const payload: WorkerRequest = { id, method, params };
    const encoded = `${JSON.stringify(payload)}\n`;
    const responsePromise = new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
    });

    await new Promise<void>((resolve, reject) => {
      this.childProcess.stdin.write(encoded, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    return await responsePromise;
  }
}

export interface SoundscriptDiagnosticsController extends vscode.Disposable {
  dumpDebugInfo(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<unknown>;
  refreshAll(): void;
}

export function activateSoundscriptDiagnostics(
  outputChannel: vscode.OutputChannel,
  cliLaunch?: ResolvedCliLaunch,
  spawnProcess?: SpawnDiagnosticsWorker,
): SoundscriptDiagnosticsController {
  const diagnostics = vscode.languages.createDiagnosticCollection('soundscript');
  const workersByWorkspace = new Map<string, DiagnosticsWorkerConnection>();
  const lastPublishedDiagnostics = new Map<string, readonly WorkerDiagnostic[]>();
  const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingDocuments = new Map<string, vscode.TextDocument>();

  async function getWorker(document: vscode.TextDocument): Promise<DiagnosticsWorkerConnection | undefined> {
    if (!cliLaunch) {
      return undefined;
    }

    const key = workspaceKeyForDocument(document);
    const existing = workersByWorkspace.get(key);
    if (existing) {
      return existing;
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const cwd = workspaceFolder?.uri.fsPath ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      document.uri.fsPath;
    const worker = new DiagnosticsWorkerConnection(
      outputChannel,
      cwd,
      cliLaunch,
      spawnProcess ?? (spawn as unknown as SpawnDiagnosticsWorker),
    );
    await worker.initialize();
    workersByWorkspace.set(key, worker);
    return worker;
  }

  async function publishDiagnostics(document: vscode.TextDocument): Promise<void> {
    if (!isSoundscriptDocument(document)) {
      return;
    }

    const projectPath = findNearestSoundscriptProject(document.uri.fsPath);
    if (!projectPath) {
      diagnostics.delete(document.uri);
      return;
    }

    const worker = await getWorker(document);
    if (!worker) {
      diagnostics.delete(document.uri);
      return;
    }

    await worker.syncDocument(document);
    const publishedDiagnostics = await worker.requestDiagnostics(document.uri.fsPath, projectPath);
    lastPublishedDiagnostics.set(document.uri.toString(), publishedDiagnostics);
    diagnostics.set(document.uri, publishedDiagnostics.map((diagnostic) => toVscodeDiagnostic(diagnostic)));
  }

  function schedulePublish(document: vscode.TextDocument, delayMs = 150): void {
    if (!isSoundscriptDocument(document)) {
      return;
    }

    const key = workspaceKeyForDocument(document);
    pendingDocuments.set(key, document);
    const existingTimer = pendingTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    pendingTimers.set(key, setTimeout(() => {
      pendingTimers.delete(key);
      const pendingDocument = pendingDocuments.get(key);
      pendingDocuments.delete(key);
      if (!pendingDocument) {
        return;
      }
      void publishDiagnostics(pendingDocument).catch((error) => {
        outputChannel.appendLine(
          `Failed to publish soundscript diagnostics for ${pendingDocument.uri.fsPath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }, delayMs));
  }

  function refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      schedulePublish(editor.document, 0);
    }
  }

  const disposable = vscode.Disposable.from(
    diagnostics,
    vscode.workspace.onDidOpenTextDocument((document) => {
      schedulePublish(document, 0);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      schedulePublish(event.document);
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      schedulePublish(document, 0);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (!isSoundscriptDocument(document)) {
        return;
      }
      diagnostics.delete(document.uri);
      const key = workspaceKeyForDocument(document);
      pendingDocuments.delete(key);
      const timer = pendingTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        pendingTimers.delete(key);
      }
      const worker = workersByWorkspace.get(key);
      if (worker) {
        void worker.closeDocument(document.uri.fsPath).catch(() => {});
      }
    }),
    {
      dispose() {
        for (const timer of pendingTimers.values()) {
          clearTimeout(timer);
        }
        pendingTimers.clear();
        pendingDocuments.clear();
        for (const worker of workersByWorkspace.values()) {
          worker.dispose();
        }
        workersByWorkspace.clear();
      },
    },
  );

  return {
    dispose() {
      disposable.dispose();
    },
    async dumpDebugInfo(document, position) {
      const projectPath = findNearestSoundscriptProject(document.uri.fsPath) ?? null;
      const worker = await getWorker(document);
      const workerDiagnostics = projectPath && worker
        ? await worker.requestDiagnostics(document.uri.fsPath, projectPath)
        : [];
      const hoverResult = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        document.uri,
        position,
      );
      const definitionResult = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeDefinitionProvider',
        document.uri,
        position,
      );

      return {
        cursor: {
          line: position.line,
          character: position.character,
        },
        document: {
          languageId: document.languageId,
          uri: document.uri.toString(),
          version: document.version,
        },
        projectPath,
        workerDiagnostics,
        lastPublishedDiagnostics: lastPublishedDiagnostics.get(document.uri.toString()) ?? [],
        soundscriptCollectionDiagnostics: vscode.languages.getDiagnostics(document.uri).map((diagnostic) => ({
          code: typeof diagnostic.code === 'object' ? diagnostic.code?.value : diagnostic.code,
          message: diagnostic.message,
          range: {
            start: {
              line: diagnostic.range.start.line,
              character: diagnostic.range.start.character,
            },
            end: {
              line: diagnostic.range.end.line,
              character: diagnostic.range.end.character,
            },
          },
          severity: vscode.DiagnosticSeverity[diagnostic.severity] ?? String(diagnostic.severity),
          source: diagnostic.source,
        })),
        executeHoverProviderResult: hoverResult?.map((hover) => ({
          contents: (Array.isArray(hover.contents) ? hover.contents : [hover.contents]).map((content) =>
            content instanceof vscode.MarkdownString
              ? { kind: 'markdown', value: content.value }
              : typeof content === 'string'
              ? { kind: 'string', value: content }
              : { kind: 'code', language: content.language, value: content.value }
          ),
          range: hover.range
            ? {
              start: {
                line: hover.range.start.line,
                character: hover.range.start.character,
              },
              end: {
                line: hover.range.end.line,
                character: hover.range.end.character,
              },
            }
            : null,
        })) ?? [],
        executeDefinitionProviderResult: definitionResult?.map((definition) => ({
          uri: definition.uri.toString(),
          range: {
            start: {
              line: definition.range.start.line,
              character: definition.range.start.character,
            },
            end: {
              line: definition.range.end.line,
              character: definition.range.end.character,
            },
          },
        })) ?? [],
      };
    },
    refreshAll,
  };
}
