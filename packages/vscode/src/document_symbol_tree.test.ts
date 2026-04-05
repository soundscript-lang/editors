import assert from 'node:assert/strict';
import test from 'node:test';

import ts from 'typescript';

import { isNavigationTreeRoot, isSyntheticNavigationTreeItem } from './document_symbol_tree';

test('isSyntheticNavigationTreeItem hides Soundscript-generated locals', () => {
  assert.equal(isSyntheticNavigationTreeItem({ text: '__sts_match_value' }), true);
  assert.equal(isSyntheticNavigationTreeItem({ text: 'safeDivide' }), false);
});

test('isNavigationTreeRoot treats full-file quoted modules as root containers', () => {
  assert.equal(
    isNavigationTreeRoot(
      {
        kind: ts.ScriptElementKind.moduleElement,
        spans: [{ start: 0, length: 886 }],
        text: '"index"',
      },
      886,
    ),
    true,
  );
});

test('isNavigationTreeRoot preserves smaller quoted modules as real symbols', () => {
  assert.equal(
    isNavigationTreeRoot(
      {
        kind: ts.ScriptElementKind.moduleElement,
        spans: [{ start: 257, length: 106 }],
        text: '"virtual:match"',
      },
      886,
    ),
    false,
  );
});
