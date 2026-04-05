import assert from 'node:assert/strict';
import test from 'node:test';

import { createPublishArgs } from './publish_packages.mjs';

test('createPublishArgs includes SOUNDSCRIPT_NPM_OTP when provided', () => {
  assert.deepEqual(createPublishArgs('public', { SOUNDSCRIPT_NPM_OTP: '123456' }), [
    'publish',
    '--access',
    'public',
    '--otp',
    '123456',
  ]);
});

test('createPublishArgs falls back to NPM_CONFIG_OTP when provided', () => {
  assert.deepEqual(createPublishArgs('public', { NPM_CONFIG_OTP: '654321' }), [
    'publish',
    '--access',
    'public',
    '--otp',
    '654321',
  ]);
});

test('createPublishArgs omits OTP when none is provided', () => {
  assert.deepEqual(createPublishArgs('public', {}), ['publish', '--access', 'public']);
});
