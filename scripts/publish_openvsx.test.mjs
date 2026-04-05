import assert from 'node:assert/strict';
import test from 'node:test';

import { createOpenVsxPublishArgs } from './publish_openvsx.mjs';

test('createOpenVsxPublishArgs includes SOUNDSCRIPT_OPENVSX_TOKEN when provided', () => {
  assert.deepEqual(
    createOpenVsxPublishArgs('packages/vscode/soundscript-vscode-0.1.3.vsix', {
      SOUNDSCRIPT_OPENVSX_TOKEN: 'token-123',
    }),
    ['--yes', 'ovsx', 'publish', 'packages/vscode/soundscript-vscode-0.1.3.vsix', '-p', 'token-123'],
  );
});

test('createOpenVsxPublishArgs falls back to OVSX_PAT when provided', () => {
  assert.deepEqual(
    createOpenVsxPublishArgs('packages/vscode/soundscript-vscode-0.1.3.vsix', {
      OVSX_PAT: 'token-456',
    }),
    ['--yes', 'ovsx', 'publish', 'packages/vscode/soundscript-vscode-0.1.3.vsix', '-p', 'token-456'],
  );
});

test('createOpenVsxPublishArgs omits token when none is provided', () => {
  assert.deepEqual(
    createOpenVsxPublishArgs('packages/vscode/soundscript-vscode-0.1.3.vsix', {}),
    ['--yes', 'ovsx', 'publish', 'packages/vscode/soundscript-vscode-0.1.3.vsix'],
  );
});
