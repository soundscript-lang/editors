import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readTypeScriptPluginConfiguration,
  SOUNDSCRIPT_TSSERVER_PLUGIN_NAME,
} from './typescript_plugin_configuration';

test('readTypeScriptPluginConfiguration defaults to TS parsing for .sts files', () => {
  const configuration = readTypeScriptPluginConfiguration({
    get: <T>(_section: string, defaultValue: T): T => defaultValue,
  });

  assert.deepEqual(configuration, {
    soundscriptArgsPrefix: [],
    soundscriptCommand: undefined,
    stsScriptKind: 'ts',
  });
});

test('readTypeScriptPluginConfiguration respects explicit settings', () => {
  const configuration = readTypeScriptPluginConfiguration({
    get: <T>(section: string, defaultValue: T): T => {
      switch (section) {
        case 'tsserver.stsScriptKind':
          return 'tsx' as T;
        default:
          return defaultValue;
      }
    },
  }, {
    argsPrefix: ['run', '-A', '/repo/src/main.ts'],
    command: 'deno',
  });

  assert.deepEqual(configuration, {
    soundscriptArgsPrefix: ['run', '-A', '/repo/src/main.ts'],
    soundscriptCommand: 'deno',
    stsScriptKind: 'tsx',
  });
});

test('Soundscript tsserver plugin name stays stable', () => {
  assert.equal(SOUNDSCRIPT_TSSERVER_PLUGIN_NAME, '@soundscript/tsserver-plugin');
});
