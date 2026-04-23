import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  activateSoundscriptLanguageDetection,
  inferTypeScriptLanguageIdForPath,
  type DisposableLike,
  type SoundscriptLanguageDetectionHost,
  type TextDocumentLike,
} from './language_detection';

function createDocument(filePath: string, languageId = 'typescript'): TextDocumentLike {
  return {
    languageId,
    uri: {
      fsPath: filePath,
      scheme: 'file',
      toString: () => `file://${filePath}`,
    },
  };
}

function createEvent<T>(): {
  event(listener: (value: T) => unknown): DisposableLike;
  fire(value: T): void;
} {
  const listeners = new Set<(value: T) => unknown>();
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

function createHost(
  textDocuments: readonly TextDocumentLike[],
): SoundscriptLanguageDetectionHost & {
  calls: Array<{ filePath: string; languageId: string }>;
  open(document: TextDocumentLike): void;
  save(document: TextDocumentLike): void;
} {
  const openEvent = createEvent<TextDocumentLike>();
  const saveEvent = createEvent<TextDocumentLike>();
  const calls: Array<{ filePath: string; languageId: string }> = [];

  return {
    calls,
    onDidOpenTextDocument: openEvent.event,
    onDidSaveTextDocument: saveEvent.event,
    open: openEvent.fire,
    save: saveEvent.fire,
    async setTextDocumentLanguage(document, languageId) {
      calls.push({ filePath: document.uri.fsPath, languageId });
      document.languageId = languageId;
      return document;
    },
    textDocuments,
  };
}

test('inferTypeScriptLanguageIdForPath restores TS-family language ids', () => {
  assert.equal(inferTypeScriptLanguageIdForPath('/workspace/src/main.ts'), 'typescript');
  assert.equal(inferTypeScriptLanguageIdForPath('/workspace/src/main.mts'), 'typescript');
  assert.equal(inferTypeScriptLanguageIdForPath('/workspace/src/main.cts'), 'typescript');
  assert.equal(inferTypeScriptLanguageIdForPath('/workspace/src/main.tsx'), 'typescriptreact');
  assert.equal(inferTypeScriptLanguageIdForPath('/workspace/src/main.sts'), undefined);
});

test('language detection classifies configured TypeScript alias files as soundscript', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'soundscript-language-detection-'));
  try {
    const filePath = join(workspace, 'unthread', 'backend', 'src', 'soundscript-test.ts');
    mkdirSync(join(workspace, 'unthread', 'backend', 'src'), { recursive: true });
    writeFileSync(join(workspace, 'tsconfig.json'), '{}\n');
    writeFileSync(
      join(workspace, 'unthread', 'backend', 'tsconfig.json'),
      JSON.stringify({
        soundscript: {
          include: ['src/soundscript-test.ts'],
        },
      }),
    );
    writeFileSync(filePath, 'export const answer = 1;\n');

    const document = createDocument(filePath);
    const host = createHost([document]);
    const detection = activateSoundscriptLanguageDetection(host);
    await detection.refreshAll();

    assert.deepEqual(host.calls, [{ filePath, languageId: 'soundscript' }]);
    assert.equal(document.languageId, 'soundscript');
    detection.dispose();
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test('language detection leaves unmatched TypeScript files alone', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'soundscript-language-detection-'));
  try {
    const filePath = join(workspace, 'src', 'plain.ts');
    mkdirSync(join(workspace, 'src'), { recursive: true });
    writeFileSync(
      join(workspace, 'tsconfig.json'),
      JSON.stringify({
        soundscript: {
          include: ['src/soundscript/**/*.ts'],
        },
      }),
    );
    writeFileSync(filePath, 'export const answer = 1;\n');

    const document = createDocument(filePath);
    const host = createHost([document]);
    const detection = activateSoundscriptLanguageDetection(host);
    await detection.refreshAll();

    assert.deepEqual(host.calls, []);
    assert.equal(document.languageId, 'typescript');
    detection.dispose();
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test('language detection refreshes configured aliases after tsconfig changes', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'soundscript-language-detection-'));
  try {
    const configPath = join(workspace, 'tsconfig.json');
    const filePath = join(workspace, 'src', 'component.tsx');
    mkdirSync(join(workspace, 'src'), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        soundscript: {
          include: ['src/**/*.tsx'],
        },
      }),
    );
    writeFileSync(filePath, 'export const component = <div />;\n');

    const document = createDocument(filePath, 'typescriptreact');
    const configDocument = createDocument(configPath, 'jsonc');
    const host = createHost([document, configDocument]);
    const detection = activateSoundscriptLanguageDetection(host);
    await detection.refreshAll();

    writeFileSync(
      configPath,
      JSON.stringify({
        soundscript: {
          include: ['src/soundscript/**/*.tsx'],
        },
      }),
    );
    host.save(configDocument);
    await detection.refreshAll();

    assert.deepEqual(host.calls, [
      { filePath, languageId: 'soundscript' },
      { filePath, languageId: 'typescriptreact' },
    ]);
    assert.equal(document.languageId, 'typescriptreact');
    detection.dispose();
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test('language detection does not restore user-selected soundscript mode for unmatched TS files', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'soundscript-language-detection-'));
  try {
    const configPath = join(workspace, 'tsconfig.json');
    const filePath = join(workspace, 'src', 'plain.ts');
    mkdirSync(join(workspace, 'src'), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        soundscript: {
          include: ['src/soundscript/**/*.ts'],
        },
      }),
    );
    writeFileSync(filePath, 'export const answer = 1;\n');

    const document = createDocument(filePath, 'soundscript');
    const host = createHost([document]);
    const detection = activateSoundscriptLanguageDetection(host);
    await detection.refreshAll();

    assert.deepEqual(host.calls, []);
    assert.equal(document.languageId, 'soundscript');
    detection.dispose();
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});
