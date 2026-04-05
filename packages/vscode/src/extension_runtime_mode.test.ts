import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveServerRuntimeMode } from './extension_runtime_mode';

test('resolveServerRuntimeMode preserves production mode by default', () => {
  assert.equal(resolveServerRuntimeMode('production', false), 'production');
});

test('resolveServerRuntimeMode treats test mode like development', () => {
  assert.equal(resolveServerRuntimeMode('test', false), 'development');
});

test('resolveServerRuntimeMode allows forcing development cli resolution', () => {
  assert.equal(resolveServerRuntimeMode('production', true), 'development');
});
