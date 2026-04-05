import assert from 'node:assert/strict';
import test from 'node:test';

import {
  flattenDisplayParts,
  renderQuickInfoSections,
  shouldBypassHelperForFallbackHover,
  toDiagnosticRange,
  tsserverCategoryToSeverity,
} from './tsserver_bridge_support';

test('tsserverCategoryToSeverity maps tsserver categories to vscode severities', () => {
  assert.equal(tsserverCategoryToSeverity('error'), 'error');
  assert.equal(tsserverCategoryToSeverity('warning'), 'warning');
  assert.equal(tsserverCategoryToSeverity('message'), 'information');
  assert.equal(tsserverCategoryToSeverity('suggestion'), 'hint');
  assert.equal(tsserverCategoryToSeverity(undefined), 'warning');
});

test('toDiagnosticRange converts one-based tsserver locations to zero-based ranges', () => {
  assert.deepEqual(
    toDiagnosticRange({
      end: { line: 3, offset: 9 },
      start: { line: 2, offset: 4 },
      text: 'example',
    }),
    {
      startLine: 1,
      startCharacter: 3,
      endLine: 2,
      endCharacter: 8,
    },
  );
});

test('flattenDisplayParts joins tsserver display parts', () => {
  assert.equal(
    flattenDisplayParts([
      { text: 'const ' },
      { text: 'value' },
      { text: ': number' },
    ]),
    'const value: number',
  );
});

test('renderQuickInfoSections formats quick info documentation and tags', () => {
  assert.deepEqual(
    renderQuickInfoSections({
      displayString: 'const value: number',
      documentation: [{ text: 'A value.' }],
      tags: [
        { name: 'deprecated', text: [{ text: 'Use otherValue.' }] },
        { name: 'example' },
      ],
    }),
    {
      signature: 'const value: number',
      documentation: 'A value.',
      tags: ['@deprecated Use otherValue.', '@example'],
    },
  );
});

test('shouldBypassHelperForFallbackHover keeps high-confidence fallback hovers local', () => {
  assert.equal(
    shouldBypassHelperForFallbackHover({
      markdown: '```ts\nconst value: unknown\n```',
    }),
    true,
  );
  assert.equal(
    shouldBypassHelperForFallbackHover({
      markdown: '```ts\ninterface Environment\n```',
    }),
    true,
  );
  assert.equal(
    shouldBypassHelperForFallbackHover({
      markdown: '```ts\nconst dict: BareObject\n```',
    }),
    true,
  );
  assert.equal(
    shouldBypassHelperForFallbackHover({
      markdown: '```ts\nerr: Error\n```',
    }),
    true,
  );
});

test('shouldBypassHelperForFallbackHover defers low-confidence any hovers to the helper', () => {
  assert.equal(
    shouldBypassHelperForFallbackHover({
      markdown: '```ts\nconst value: any\n```',
    }),
    false,
  );
  assert.equal(
    shouldBypassHelperForFallbackHover({
      markdown: '```ts\nvar err: any\n```',
    }),
    false,
  );
  assert.equal(shouldBypassHelperForFallbackHover(null), false);
});
