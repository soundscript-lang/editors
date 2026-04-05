import assert from 'node:assert/strict';
import test from 'node:test';

import { ensureTypeScriptServerStarted } from './tsserver_startup';

test('ensureTypeScriptServerStarted prefers projectInfo for the active soundscript document', async () => {
  const calls: Array<{ args: unknown[]; command: string }> = [];

  const mode = await ensureTypeScriptServerStarted(
    async (command: string, ...args: unknown[]) => {
      calls.push({ command, args });
      return undefined;
    },
    [
      { languageId: 'soundscript', uri: { fsPath: '/workspace/src/demo.sts' } },
      { languageId: 'typescript', uri: { fsPath: '/workspace/src/demo.ts' } },
    ],
    { languageId: 'soundscript', uri: { fsPath: '/workspace/src/demo.sts' } },
  );

  assert.equal(mode, 'projectInfo');
  assert.deepEqual(calls, [{
    command: 'typescript.tsserverRequest',
    args: [
      'projectInfo',
      {
        file: '/workspace/src/demo.sts',
        needFileNameList: false,
      },
    ],
  }]);
});

test('ensureTypeScriptServerStarted falls back to compilerOptionsForInferredProjects', async () => {
  const calls: Array<{ args: unknown[]; command: string }> = [];

  const mode = await ensureTypeScriptServerStarted(
    async (command: string, ...args: unknown[]) => {
      calls.push({ command, args });
      if (args[0] === 'projectInfo') {
        throw new Error('projectInfo failed');
      }
      return undefined;
    },
    [
      { languageId: 'soundscript', uri: { fsPath: '/workspace/src/demo.sts' } },
    ],
  );

  assert.equal(mode, 'compilerOptions');
  assert.deepEqual(calls, [
    {
      command: 'typescript.tsserverRequest',
      args: [
        'projectInfo',
        {
          file: '/workspace/src/demo.sts',
          needFileNameList: false,
        },
      ],
    },
    {
      command: 'typescript.tsserverRequest',
      args: [
        'compilerOptionsForInferredProjects',
        {
          options: {
            allowJs: true,
            allowNonTsExtensions: true,
          },
        },
      ],
    },
  ]);
});

test('ensureTypeScriptServerStarted reports unavailable when tsserverRequest is missing', async () => {
  const calls: Array<{ args: unknown[]; command: string }> = [];

  const mode = await ensureTypeScriptServerStarted(
    async (command: string, ...args: unknown[]) => {
      calls.push({ command, args });
      throw new Error("command 'typescript.tsserverRequest' not found");
    },
    [
      { languageId: 'soundscript', uri: { fsPath: '/workspace/src/demo.sts' } },
    ],
  );

  assert.equal(mode, 'unavailable');
  assert.deepEqual(calls, [{
    command: 'typescript.tsserverRequest',
    args: [
      'projectInfo',
      {
        file: '/workspace/src/demo.sts',
        needFileNameList: false,
      },
    ],
  }]);
});
