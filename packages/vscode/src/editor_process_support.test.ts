import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildEditorProjectArgs,
  buildDiagnosticsWorkerArgs,
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
