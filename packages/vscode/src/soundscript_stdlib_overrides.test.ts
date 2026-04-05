import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import ts from 'typescript';

import {
  createSoundscriptLibOverrides,
  resolveSoundscriptLibOverrideDirectory,
} from './soundscript_stdlib_overrides';

test('resolveSoundscriptLibOverrideDirectory prefers workspace package sound-libs', () => {
  const tempDirectory = mkdtempSync(path.join(os.tmpdir(), 'soundscript-stdlib-overrides-'));
  const documentPath = path.join(tempDirectory, 'src/index.sts');
  const overrideDirectory = path.join(
    tempDirectory,
    'node_modules',
    '@soundscript',
    'soundscript',
    'src',
    'bundled',
    'sound-libs',
  );
  mkdirSync(overrideDirectory, { recursive: true });
  writeFileSync(path.join(overrideDirectory, 'lib.es5.d.ts'), 'declare type JsonValue = string;\n');

  assert.equal(resolveSoundscriptLibOverrideDirectory(documentPath), overrideDirectory);
});

test('createSoundscriptLibOverrides remaps default lib file paths to bundled soundscript libs', () => {
  const tempDirectory = mkdtempSync(path.join(os.tmpdir(), 'soundscript-stdlib-definition-'));
  const documentPath = path.join(tempDirectory, 'src/index.sts');
  const overrideDirectory = path.join(
    tempDirectory,
    'node_modules',
    '@soundscript',
    'soundscript',
    'src',
    'bundled',
    'sound-libs',
  );
  mkdirSync(overrideDirectory, { recursive: true });

  const compilerOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2020,
  };
  writeFileSync(path.join(overrideDirectory, 'lib.es5.d.ts'), 'declare interface Object {}\n');
  writeFileSync(
    path.join(overrideDirectory, ts.getDefaultLibFileName(compilerOptions)),
    'declare type JsonValue = string;\n',
  );

  const libOverrides = createSoundscriptLibOverrides(compilerOptions, documentPath);
  const defaultLibFilePath = ts.getDefaultLibFilePath(compilerOptions);
  assert.equal(
    libOverrides.resolveFile(defaultLibFilePath),
    path.join(overrideDirectory, path.basename(defaultLibFilePath)),
  );
});

test('createSoundscriptLibOverrides feeds JsonValue through a TypeScript language service', () => {
  const tempDirectory = mkdtempSync(path.join(os.tmpdir(), 'soundscript-stdlib-language-service-'));
  const documentPath = path.join(tempDirectory, 'src/index.sts');
  const lookupFileName = `${documentPath}.ts`;
  const overrideDirectory = path.join(
    tempDirectory,
    'node_modules',
    '@soundscript',
    'soundscript',
    'src',
    'bundled',
    'sound-libs',
  );
  mkdirSync(path.dirname(documentPath), { recursive: true });
  mkdirSync(overrideDirectory, { recursive: true });

  const compilerOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2020,
  };
  writeFileSync(path.join(overrideDirectory, 'lib.es5.d.ts'), 'declare interface Object {}\n');
  writeFileSync(
    path.join(overrideDirectory, ts.getDefaultLibFileName(compilerOptions)),
    [
      'declare type JsonValue = string | number | boolean | null;',
      'declare const console: { log(value: unknown): void };',
      '',
    ].join('\n'),
  );

  const sourceText = [
    'function myFunc(json: JsonValue) {',
    '  console.log(json);',
    '}',
    '',
  ].join('\n');
  const libOverrides = createSoundscriptLibOverrides(compilerOptions, documentPath);
  const normalizedLookupFileName = path.normalize(lookupFileName);
  const host: ts.LanguageServiceHost = {
    directoryExists: ts.sys.directoryExists,
    fileExists(fileName) {
      const normalized = path.normalize(fileName);
      return normalized === normalizedLookupFileName ||
        libOverrides.fileExists(fileName) ||
        ts.sys.fileExists(fileName);
    },
    getCompilationSettings: () => compilerOptions,
    getCurrentDirectory: () => tempDirectory,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    getDirectories: ts.sys.getDirectories,
    getScriptFileNames: () => [lookupFileName],
    getScriptKind: () => ts.ScriptKind.TS,
    getScriptSnapshot(fileName) {
      const normalized = path.normalize(fileName);
      if (normalized === normalizedLookupFileName) {
        return ts.ScriptSnapshot.fromString(sourceText);
      }
      const text = libOverrides.readFile(fileName) ?? ts.sys.readFile(fileName);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getScriptVersion: () => '1',
    readDirectory: ts.sys.readDirectory,
    readFile(fileName) {
      const normalized = path.normalize(fileName);
      if (normalized === normalizedLookupFileName) {
        return sourceText;
      }
      return libOverrides.readFile(fileName) ?? ts.sys.readFile(fileName);
    },
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
  };

  const service = ts.createLanguageService(host);
  const quickInfo = service.getQuickInfoAtPosition(
    lookupFileName,
    sourceText.indexOf('JsonValue') + 2,
  );

  assert.ok(quickInfo);
  const displayString = ts.displayPartsToString(quickInfo.displayParts);
  assert.ok(displayString.startsWith('type JsonValue = '));
  assert.ok(displayString.includes('string | number | boolean'));
  assert.equal(displayString.includes('/*unresolved*/ any'), false);
});
