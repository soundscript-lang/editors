import * as path from 'node:path';

import {
  clearProjectSoundscriptMatcherCache,
  isLocalSoundscriptFile,
} from './editor_process_support';

export interface DisposableLike {
  dispose(): unknown;
}

export interface UriLike {
  fsPath: string;
  scheme: string;
  toString(): string;
}

export interface TextDocumentLike {
  languageId: string;
  uri: UriLike;
}

export interface FileSystemWatcherLike extends DisposableLike {
  onDidChange(listener: (uri: UriLike) => unknown): DisposableLike;
  onDidCreate(listener: (uri: UriLike) => unknown): DisposableLike;
  onDidDelete(listener: (uri: UriLike) => unknown): DisposableLike;
}

export interface SoundscriptLanguageDetectionHost {
  appendLine?(message: string): void;
  createFileSystemWatcher?(pattern: string): FileSystemWatcherLike;
  onDidOpenTextDocument(listener: (document: TextDocumentLike) => unknown): DisposableLike;
  onDidSaveTextDocument(listener: (document: TextDocumentLike) => unknown): DisposableLike;
  setTextDocumentLanguage(
    document: TextDocumentLike,
    languageId: string,
  ): PromiseLike<TextDocumentLike>;
  textDocuments: readonly TextDocumentLike[];
}

export interface SoundscriptLanguageDetectionController extends DisposableLike {
  refreshAll(): Promise<void>;
}

function documentKey(document: TextDocumentLike): string {
  return document.uri.toString();
}

function isFileDocument(document: TextDocumentLike): boolean {
  return document.uri.scheme === 'file' && document.uri.fsPath.length > 0;
}

function isSoundscriptConfigPath(filePath: string): boolean {
  const fileName = path.basename(filePath);
  return fileName === 'tsconfig.json' || fileName === 'tsconfig.soundscript.json';
}

export function inferTypeScriptLanguageIdForPath(filePath: string): string | undefined {
  const lowered = filePath.toLowerCase();
  if (lowered.endsWith('.tsx')) {
    return 'typescriptreact';
  }
  if (
    lowered.endsWith('.ts') ||
    lowered.endsWith('.mts') ||
    lowered.endsWith('.cts')
  ) {
    return 'typescript';
  }
  return undefined;
}

export function shouldUseSoundscriptLanguage(document: TextDocumentLike): boolean {
  return isFileDocument(document) && isLocalSoundscriptFile(document.uri.fsPath);
}

function combineDisposables(disposables: readonly DisposableLike[]): DisposableLike {
  return {
    dispose(): void {
      for (const disposable of disposables) {
        disposable.dispose();
      }
    },
  };
}

export function activateSoundscriptLanguageDetection(
  host: SoundscriptLanguageDetectionHost,
): SoundscriptLanguageDetectionController {
  const autoClassifiedDocumentKeys = new Set<string>();
  let disposed = false;

  async function setLanguage(document: TextDocumentLike, languageId: string): Promise<void> {
    try {
      await host.setTextDocumentLanguage(document, languageId);
    } catch (error) {
      host.appendLine?.(
        `Failed to classify ${document.uri.fsPath} as ${languageId}: ${
          error instanceof Error ? error.stack ?? error.message : String(error)
        }`,
      );
    }
  }

  async function classifyDocument(document: TextDocumentLike): Promise<void> {
    if (disposed || !isFileDocument(document)) {
      return;
    }

    const key = documentKey(document);
    if (shouldUseSoundscriptLanguage(document)) {
      if (document.languageId !== 'soundscript') {
        autoClassifiedDocumentKeys.add(key);
        await setLanguage(document, 'soundscript');
      }
      return;
    }

    if (document.languageId !== 'soundscript' || !autoClassifiedDocumentKeys.has(key)) {
      autoClassifiedDocumentKeys.delete(key);
      return;
    }

    const restoredLanguageId = inferTypeScriptLanguageIdForPath(document.uri.fsPath);
    autoClassifiedDocumentKeys.delete(key);
    if (restoredLanguageId) {
      await setLanguage(document, restoredLanguageId);
    }
  }

  async function refreshAll(): Promise<void> {
    await Promise.all(host.textDocuments.map((document) => classifyDocument(document)));
  }

  function refreshAfterConfigChange(): void {
    clearProjectSoundscriptMatcherCache();
    void refreshAll();
  }

  const openSubscription = host.onDidOpenTextDocument((document) => {
    void classifyDocument(document);
  });
  const saveSubscription = host.onDidSaveTextDocument((document) => {
    if (isFileDocument(document) && isSoundscriptConfigPath(document.uri.fsPath)) {
      refreshAfterConfigChange();
      return;
    }

    void classifyDocument(document);
  });

  const watcherSubscriptions: DisposableLike[] = [];
  for (const pattern of ['**/tsconfig.json', '**/tsconfig.soundscript.json']) {
    const watcher = host.createFileSystemWatcher?.(pattern);
    if (!watcher) {
      continue;
    }

    watcherSubscriptions.push(
      watcher,
      watcher.onDidChange(refreshAfterConfigChange),
      watcher.onDidCreate(refreshAfterConfigChange),
      watcher.onDidDelete(refreshAfterConfigChange),
    );
  }

  const subscriptions = combineDisposables([
    openSubscription,
    saveSubscription,
    ...watcherSubscriptions,
  ]);

  return {
    async refreshAll(): Promise<void> {
      clearProjectSoundscriptMatcherCache();
      await refreshAll();
    },
    dispose(): void {
      disposed = true;
      subscriptions.dispose();
    },
  };
}
