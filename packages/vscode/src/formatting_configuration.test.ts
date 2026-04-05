import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isFormattingEnabled,
  syncFormattingRegistration,
  type DisposableLike,
} from './formatting_configuration';

test('isFormattingEnabled defaults to true', () => {
  const enabled = isFormattingEnabled({
    get: <T>(_section: string, defaultValue: T): T => defaultValue,
  });

  assert.equal(enabled, true);
});

test('isFormattingEnabled respects explicit false', () => {
  const enabled = isFormattingEnabled({
    get: <T>(_section: string, _defaultValue: T): T => false as T,
  });

  assert.equal(enabled, false);
});

test('syncFormattingRegistration registers once when formatting is enabled', () => {
  let registerCalls = 0;
  const registration: DisposableLike = {
    dispose() {
      throw new Error('dispose should not be called while registration stays enabled');
    },
  };

  const nextRegistration = syncFormattingRegistration(undefined, true, () => {
    registerCalls += 1;
    return registration;
  });
  const stableRegistration = syncFormattingRegistration(nextRegistration, true, () => {
    registerCalls += 1;
    return registration;
  });

  assert.equal(nextRegistration, registration);
  assert.equal(stableRegistration, registration);
  assert.equal(registerCalls, 1);
});

test('syncFormattingRegistration disposes the provider when formatting is disabled', () => {
  let disposeCalls = 0;
  const registration: DisposableLike = {
    dispose() {
      disposeCalls += 1;
    },
  };

  const nextRegistration = syncFormattingRegistration(registration, false, () => {
    throw new Error('register should not be called when formatting is disabled');
  });

  assert.equal(nextRegistration, undefined);
  assert.equal(disposeCalls, 1);
});
