import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildEditorProjectArgs,
  buildDiagnosticsWorkerArgs,
  isLocalSoundscriptFile,
} from './editor_process_support';

test('buildDiagnosticsWorkerArgs inserts the Deno heap flag after run', () => {
  assert.deepEqual(
    buildDiagnosticsWorkerArgs({
      command: '/Users/jake/.deno/bin/deno',
      argsPrefix: ['run', '-A', '/repo/src/main.ts'],
      source: 'development',
    }),
    [
      'run',
      '--v8-flags=--max-old-space-size=8192',
      '-A',
      '/repo/src/main.ts',
      'editor-worker',
    ],
  );
});

test('buildDiagnosticsWorkerArgs does not duplicate an existing Deno heap flag', () => {
  assert.deepEqual(
    buildDiagnosticsWorkerArgs({
      command: '/Users/jake/.deno/bin/deno',
      argsPrefix: ['run', '--v8-flags=--max-old-space-size=8192', '-A', '/repo/src/main.ts'],
      source: 'development',
    }),
    [
      'run',
      '--v8-flags=--max-old-space-size=8192',
      '-A',
      '/repo/src/main.ts',
      'editor-worker',
    ],
  );
});

test('buildDiagnosticsWorkerArgs leaves non-Deno launches unchanged', () => {
  assert.deepEqual(
    buildDiagnosticsWorkerArgs({
      command: '/workspace/node_modules/.bin/soundscript',
      argsPrefix: [],
      source: 'workspace',
    }),
    ['editor-worker'],
  );
});

test('buildEditorProjectArgs inserts the Deno heap flag after run', () => {
  assert.deepEqual(
    buildEditorProjectArgs(
      {
        command: '/Users/jake/.deno/bin/deno',
        argsPrefix: ['run', '-A', '/repo/src/main.ts'],
        source: 'development',
      },
      '/workspace/tsconfig.json',
      '/workspace/src/demo.sts',
    ),
    [
      'run',
      '--v8-flags=--max-old-space-size=8192',
      '-A',
      '/repo/src/main.ts',
      'editor-project',
      '--project',
      '/workspace/tsconfig.json',
      '--file',
      '/workspace/src/demo.sts',
      '--stdin-file',
    ],
  );
});

test('isLocalSoundscriptFile matches configured TypeScript files from soundscript.include', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'soundscript-editors-'));
  try {
    mkdirSync(join(workspace, 'src', 'nested'), { recursive: true });
    writeFileSync(
      join(workspace, 'tsconfig.json'),
      JSON.stringify({
        soundscript: {
          include: ['src/**/*.ts', 'src/**/*.d.ts'],
        },
      }),
    );
    writeFileSync(join(workspace, 'src', 'nested', 'main.ts'), 'export const answer = 1;\n');
    writeFileSync(join(workspace, 'src', 'nested', 'types.d.ts'), 'export declare const answer: 1;\n');

    assert.equal(
      isLocalSoundscriptFile(join(workspace, 'src', 'nested', 'main.ts')),
      true,
    );
    assert.equal(
      isLocalSoundscriptFile(join(workspace, 'src', 'nested', 'types.d.ts')),
      false,
    );
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test('isLocalSoundscriptFile ignores unmatched TypeScript files', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'soundscript-editors-'));
  try {
    mkdirSync(join(workspace, 'src', 'plain'), { recursive: true });
    writeFileSync(
      join(workspace, 'tsconfig.json'),
      JSON.stringify({
        soundscript: {
          include: ['src/sound/**/*.ts'],
        },
      }),
    );
    writeFileSync(join(workspace, 'src', 'plain', 'main.ts'), 'export const answer = 1;\n');

    assert.equal(
      isLocalSoundscriptFile(join(workspace, 'src', 'plain', 'main.ts')),
      false,
    );
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});
