import * as vscode from 'vscode';

import {
  createSoundscriptBridgeClient,
  type LspDefinitionLocation,
  type LspDiagnostic,
  type LspHover,
  type LspRange,
  type SoundscriptBridgeClient,
} from './soundscript_bridge_client';
import {
  fallbackCompletionItemsAt,
  fallbackDefinitionAt,
  fallbackHoverAt,
  implicitPreludeVirtualDocument,
  importedTsHoverTargetAt,
} from './soundscript_bridge_fallback';
import type { ResolvedCliLaunch } from './server_resolution';
import { shouldBypassHelperForFallbackHover } from './tsserver_bridge_support';

function isSoundscriptDocument(document: vscode.TextDocument): boolean {
  return document.languageId === 'soundscript' && document.uri.scheme === 'file';
}

function toVscodeRange(range: LspRange): vscode.Range {
  return new vscode.Range(
    new vscode.Position(range.start.line, range.start.character),
    new vscode.Position(range.end.line, range.end.character),
  );
}

function toVscodeHover(hover: LspHover): vscode.Hover | undefined {
  if (!hover.contents?.value || hover.contents.kind !== 'markdown') {
    return undefined;
  }

  const markdown = new vscode.MarkdownString(hover.contents.value, true);
  return new vscode.Hover(
    markdown,
    hover.range ? toVscodeRange(hover.range) : undefined,
  );
}

function toVscodeFallbackHover(
  hover: ReturnType<typeof fallbackHoverAt>,
): vscode.Hover | undefined {
  if (!hover) {
    return undefined;
  }

  const markdown = new vscode.MarkdownString(hover.markdown, true);
  return new vscode.Hover(
    markdown,
    new vscode.Range(
      new vscode.Position(hover.range.startLine, hover.range.startCharacter),
      new vscode.Position(hover.range.endLine, hover.range.endCharacter),
    ),
  );
}

function toVscodeHoverWithExplicitRange(
  hovers: readonly vscode.Hover[],
  range: vscode.Range,
): vscode.Hover | undefined {
  const seen = new Set<string>();
  const contents = hovers.flatMap((hover) =>
    Array.isArray(hover.contents) ? hover.contents : [hover.contents]
  ).filter((content) => {
    const key = content instanceof vscode.MarkdownString
      ? `md:${content.value}`
      : typeof content === 'string'
      ? `str:${content}`
      : `code:${content.language}:${content.value}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  return contents.length > 0 ? new vscode.Hover(contents, range) : undefined;
}

function toVscodeLocations(
  definitions: readonly LspDefinitionLocation[] | null,
): vscode.Location[] | undefined {
  if (!definitions || definitions.length === 0) {
    return undefined;
  }

  return definitions.map((definition) =>
    new vscode.Location(
      vscode.Uri.parse(definition.uri),
      toVscodeRange(definition.range),
    )
  );
}

function toVscodeCompletionItemKind(
  kind: 'class' | 'function' | 'interface' | 'keyword' | 'module' | 'type',
): vscode.CompletionItemKind {
  switch (kind) {
    case 'class':
      return vscode.CompletionItemKind.Class;
    case 'function':
      return vscode.CompletionItemKind.Function;
    case 'interface':
      return vscode.CompletionItemKind.Interface;
    case 'module':
      return vscode.CompletionItemKind.Module;
    case 'keyword':
      return vscode.CompletionItemKind.Keyword;
    case 'type':
    default:
      return vscode.CompletionItemKind.TypeParameter;
  }
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

function toVscodeDiagnostic(diagnostic: LspDiagnostic): vscode.Diagnostic {
  const range = diagnostic.range
    ? toVscodeRange(diagnostic.range)
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

function workspaceKeyForDocument(document: vscode.TextDocument): string {
  return vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? '__default__';
}

function createBridgeDocument(document: vscode.TextDocument) {
  return {
    languageId: document.languageId,
    text: document.getText(),
    uri: document.uri.toString(),
    version: document.version,
  };
}

function serializeRange(range: vscode.Range): {
  end: { character: number; line: number };
  start: { character: number; line: number };
} {
  return {
    start: {
      line: range.start.line,
      character: range.start.character,
    },
    end: {
      line: range.end.line,
      character: range.end.character,
    },
  };
}

function serializeDiagnostics(
  diagnostics: readonly vscode.Diagnostic[],
): Array<{
  code: string | number | undefined;
  message: string;
  range: ReturnType<typeof serializeRange>;
  severity: string;
  source: string | undefined;
}> {
  return diagnostics.map((diagnostic) => ({
    code: typeof diagnostic.code === 'object' ? diagnostic.code?.value : diagnostic.code,
    message: diagnostic.message,
    range: serializeRange(diagnostic.range),
    severity: vscode.DiagnosticSeverity[diagnostic.severity] ?? String(diagnostic.severity),
    source: diagnostic.source,
  }));
}

function serializeHoverContent(
  content: vscode.MarkdownString | vscode.MarkedString,
): {
  kind: 'code' | 'markdown' | 'string';
  language?: string;
  value: string;
} {
  if (content instanceof vscode.MarkdownString) {
    return {
      kind: 'markdown',
      value: content.value,
    };
  }

  if (typeof content === 'string') {
    return {
      kind: 'string',
      value: content,
    };
  }

  return {
    kind: 'code',
    language: content.language,
    value: content.value,
  };
}

function serializeHovers(
  hovers: readonly vscode.Hover[],
): Array<{
  contents: Array<ReturnType<typeof serializeHoverContent>>;
  range: ReturnType<typeof serializeRange> | null;
}> {
  return hovers.map((hover) => {
    const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents];
    return {
      contents: contents.map((entry) => serializeHoverContent(entry)),
      range: hover.range ? serializeRange(hover.range) : null,
    };
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function activateTsserverBridge(
  outputChannel: vscode.OutputChannel,
  cliLaunch?: ResolvedCliLaunch,
): vscode.Disposable & {
  dumpDebugInfo(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<unknown>;
  refreshAll(): void;
} {
  const helperClientsByWorkspace = new Map<string, SoundscriptBridgeClient>();
  const lastPublishedDiagnosticsByUri = new Map<string, readonly LspDiagnostic[]>();
  const pendingSyncTimersByWorkspace = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingSyncDocumentsByWorkspace = new Map<string, vscode.TextDocument>();
  const diagnostics = vscode.languages.createDiagnosticCollection('soundscript');
  const implicitPreludeDocument = implicitPreludeVirtualDocument();

  function getHelperClient(document: vscode.TextDocument): SoundscriptBridgeClient | undefined {
    if (!cliLaunch) {
      return undefined;
    }

    const key = workspaceKeyForDocument(document);
    const existing = helperClientsByWorkspace.get(key);
    if (existing) {
      return existing;
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const cwd = workspaceFolder?.uri.fsPath ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      document.uri.fsPath;
    const rootUri = workspaceFolder?.uri.toString() ??
      vscode.workspace.workspaceFolders?.[0]?.uri.toString() ??
      null;
    const created = createSoundscriptBridgeClient({
      argsPrefix: cliLaunch.argsPrefix,
      command: cliLaunch.command,
      cwd,
      diagnosticsWaitTimeoutMs: 1200,
      rootUri,
      onLog(message) {
        outputChannel.appendLine(message);
      },
      onPublishDiagnostics({ diagnostics: publishedDiagnostics, uri }) {
        lastPublishedDiagnosticsByUri.set(uri, publishedDiagnostics);
        diagnostics.set(
          vscode.Uri.parse(uri),
          publishedDiagnostics.map((diagnostic) => toVscodeDiagnostic(diagnostic)),
        );
      },
    });
    helperClientsByWorkspace.set(key, created);
    return created;
  }

  function flushScheduledSync(workspaceKey: string): void {
    const timer = pendingSyncTimersByWorkspace.get(workspaceKey);
    if (timer) {
      clearTimeout(timer);
      pendingSyncTimersByWorkspace.delete(workspaceKey);
    }
    const document = pendingSyncDocumentsByWorkspace.get(workspaceKey);
    if (!document || !isSoundscriptDocument(document)) {
      pendingSyncDocumentsByWorkspace.delete(workspaceKey);
      return;
    }

    pendingSyncDocumentsByWorkspace.delete(workspaceKey);
    const helper = getHelperClient(document);
    if (!helper) {
      return;
    }

    void helper.syncDocument(createBridgeDocument(document)).catch((error) => {
      outputChannel.appendLine(
        `Failed to prewarm soundscript helper for ${document.uri.fsPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  function scheduleDocumentSync(document: vscode.TextDocument, delayMs = 150): void {
    if (!isSoundscriptDocument(document)) {
      return;
    }

    const key = workspaceKeyForDocument(document);
    pendingSyncDocumentsByWorkspace.set(key, document);
    const existingTimer = pendingSyncTimersByWorkspace.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    pendingSyncTimersByWorkspace.set(
      key,
      setTimeout(() => {
        pendingSyncTimersByWorkspace.delete(key);
        flushScheduledSync(key);
      }, delayMs),
    );
  }

  function scheduleVisibleEditorSyncs(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      scheduleDocumentSync(editor.document, 0);
    }
  }

  const hoverProvider = vscode.languages.registerHoverProvider(
    { language: 'soundscript', scheme: 'file' },
    {
      async provideHover(document, position): Promise<vscode.Hover | undefined> {
        const importedTsHoverTarget = importedTsHoverTargetAt(
          document.uri.fsPath,
          document.getText(),
          { line: position.line, character: position.character },
        );
        const rawFallbackHover = fallbackHoverAt(
          document.uri.fsPath,
          document.getText(),
          { line: position.line, character: position.character },
        );
        const fallbackHover = toVscodeFallbackHover(rawFallbackHover);
        if (importedTsHoverTarget && !importedTsHoverTarget.projectedUnknown) {
          try {
            const tsHovers = await withTimeout(
              Promise.resolve(vscode.commands.executeCommand<vscode.Hover[]>(
                'vscode.executeHoverProvider',
                vscode.Uri.file(importedTsHoverTarget.importedFilePath),
                new vscode.Position(
                  importedTsHoverTarget.importedRange.startLine,
                  importedTsHoverTarget.importedRange.startCharacter,
                ),
              )),
              150,
              'Timed out waiting for imported TypeScript hover.',
            );
            const importedHover = toVscodeHoverWithExplicitRange(
              tsHovers ?? [],
              new vscode.Range(
                new vscode.Position(
                  importedTsHoverTarget.fallback.range.startLine,
                  importedTsHoverTarget.fallback.range.startCharacter,
                ),
                new vscode.Position(
                  importedTsHoverTarget.fallback.range.endLine,
                  importedTsHoverTarget.fallback.range.endCharacter,
                ),
              ),
            );
            if (importedHover) {
              return importedHover;
            }
          } catch {
            // Fall back to the syntax-only hover path.
          }
        }
        if (shouldBypassHelperForFallbackHover(rawFallbackHover)) {
          return fallbackHover;
        }

        const helper = getHelperClient(document);
        if (helper?.hasSettledDiagnostics(createBridgeDocument(document))) {
          try {
            const hover = await helper.hover(createBridgeDocument(document), {
              line: position.line,
              character: position.character,
            });
            if (hover?.contents?.kind === 'markdown' && hover.contents.value) {
              const vscodeHover = toVscodeHover(hover);
              if (vscodeHover) {
                return vscodeHover;
              }
            }
          } catch (error) {
            outputChannel.appendLine(
              `Failed to request soundscript helper hover for ${document.uri.fsPath}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }

        return fallbackHover;
      },
    },
  );

  const definitionProvider = vscode.languages.registerDefinitionProvider(
    { language: 'soundscript', scheme: 'file' },
    {
      async provideDefinition(document, position): Promise<vscode.Definition | undefined> {
        const fallbackDefinitions = fallbackDefinitionAt(
          document.uri.fsPath,
          document.getText(),
          { line: position.line, character: position.character },
        );
        if (fallbackDefinitions) {
          return fallbackDefinitions.map((definition) =>
            new vscode.Location(
              vscode.Uri.parse(definition.uri),
              new vscode.Range(
                new vscode.Position(definition.range.startLine, definition.range.startCharacter),
                new vscode.Position(definition.range.endLine, definition.range.endCharacter),
              ),
            )
          );
        }

        const helper = getHelperClient(document);
        if (!helper) {
          return undefined;
        }

        try {
          const definitions = await helper.definition(createBridgeDocument(document), {
            line: position.line,
            character: position.character,
          });
          return toVscodeLocations(definitions);
        } catch (error) {
          outputChannel.appendLine(
            `Failed to request soundscript helper definition for ${document.uri.fsPath}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return undefined;
        }
      },
    },
  );

  const completionProvider = vscode.languages.registerCompletionItemProvider(
    { language: 'soundscript', scheme: 'file' },
    {
      provideCompletionItems(document, position): vscode.CompletionItem[] {
        return fallbackCompletionItemsAt(
          document.uri.fsPath,
          document.getText(),
          { line: position.line, character: position.character },
        ).map((item) => {
          const completion = new vscode.CompletionItem(item.label, toVscodeCompletionItemKind(item.kind));
          completion.insertText = item.insertText;
          completion.detail = item.detail;
          completion.documentation = item.documentation
            ? new vscode.MarkdownString(item.documentation, true)
            : undefined;
          return completion;
        });
      },
    },
  );

  const implicitPreludeProvider = vscode.workspace.registerTextDocumentContentProvider(
    'soundscript-stdlib',
    {
      provideTextDocumentContent(uri): string {
        return uri.toString() === implicitPreludeDocument.uri ? implicitPreludeDocument.text : '';
      },
    },
  );

  const disposable = vscode.Disposable.from(
    diagnostics,
    hoverProvider,
    definitionProvider,
    completionProvider,
    implicitPreludeProvider,
    vscode.workspace.onDidOpenTextDocument((document) => {
      scheduleDocumentSync(document, 0);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      scheduleDocumentSync(event.document);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (isSoundscriptDocument(document)) {
        diagnostics.delete(document.uri);
      }
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => {
      scheduleVisibleEditorSyncs();
    }),
    {
      dispose() {
        for (const timer of pendingSyncTimersByWorkspace.values()) {
          clearTimeout(timer);
        }
        pendingSyncTimersByWorkspace.clear();
        pendingSyncDocumentsByWorkspace.clear();
        diagnostics.clear();
        for (const client of helperClientsByWorkspace.values()) {
          client.dispose();
        }
        helperClientsByWorkspace.clear();
      },
    },
  );

  return {
    dispose() {
      disposable.dispose();
    },
    async dumpDebugInfo(document, position) {
      const uri = document.uri.toString();
      const fallbackHover = fallbackHoverAt(
        document.uri.fsPath,
        document.getText(),
        { line: position.line, character: position.character },
      );
      const fallbackBypassesHelper = shouldBypassHelperForFallbackHover(fallbackHover);
      const helper = getHelperClient(document);
      let helperHover: LspHover | null | undefined;
      let helperHoverError: string | undefined;
      let executeHoverProviderDurationMs: number | undefined;
      let executeHoverProviderError: string | undefined;
      let executeHoverProviderResult:
        | Array<{
          contents: Array<ReturnType<typeof serializeHoverContent>>;
          range: ReturnType<typeof serializeRange> | null;
        }>
        | undefined;

      if (helper) {
        try {
          await helper.syncDocument(createBridgeDocument(document));
          helperHover = await helper.hover(createBridgeDocument(document), {
            line: position.line,
            character: position.character,
          });
        } catch (error) {
          helperHoverError = error instanceof Error ? error.message : String(error);
        }
      }

      try {
        const startedAt = Date.now();
        const hovers = await withTimeout(
          Promise.resolve(vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            document.uri,
            position,
          )),
          1500,
          'Timed out waiting for vscode.executeHoverProvider.',
        );
        executeHoverProviderDurationMs = Date.now() - startedAt;
        executeHoverProviderResult = serializeHovers(hovers ?? []);
      } catch (error) {
        executeHoverProviderError = error instanceof Error ? error.message : String(error);
      }

      return {
        cursor: {
          line: position.line,
          character: position.character,
        },
        document: {
          languageId: document.languageId,
          uri,
          version: document.version,
        },
        fallbackHover,
        fallbackBypassesHelper,
        helperAvailable: helper !== undefined,
        helperHover,
        helperHoverError,
        helperSettledDiagnostics: helper?.hasSettledDiagnostics(createBridgeDocument(document)) ?? false,
        helperPublishedDiagnostics: lastPublishedDiagnosticsByUri.get(uri) ?? [],
        executeHoverProviderDurationMs,
        executeHoverProviderError,
        executeHoverProviderResult,
        soundscriptCollectionDiagnostics: serializeDiagnostics(diagnostics.get(document.uri) ?? []),
        vscodeAllDiagnostics: serializeDiagnostics(vscode.languages.getDiagnostics(document.uri)),
      };
    },
    refreshAll() {
      for (const timer of pendingSyncTimersByWorkspace.values()) {
        clearTimeout(timer);
      }
      pendingSyncTimersByWorkspace.clear();
      pendingSyncDocumentsByWorkspace.clear();
      lastPublishedDiagnosticsByUri.clear();
      diagnostics.clear();
      for (const client of helperClientsByWorkspace.values()) {
        client.dispose();
      }
      helperClientsByWorkspace.clear();
      scheduleVisibleEditorSyncs();
    },
  };
}
