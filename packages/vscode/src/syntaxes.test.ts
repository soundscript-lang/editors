import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const grammarPath = join(__dirname, '..', 'syntaxes', 'soundscript.tmLanguage.json');

function readGrammar(): {
  patterns: Array<{ include: string }>;
  repository: Record<string, unknown>;
} {
  return JSON.parse(readFileSync(grammarPath, 'utf8')) as {
    patterns: Array<{ include: string }>;
    repository: Record<string, unknown>;
  };
}

test('Soundscript grammar highlights TS-native declaration annotations and DSL tags', () => {
  const grammar = readGrammar();

  assert.deepEqual(
    grammar.patterns.map((pattern) => pattern.include),
    ['#annotation-comment', '#dsl-tag', '#builtin-macro-call', 'source.tsx'],
  );
  assert.ok('annotation-comment' in grammar.repository);
  assert.ok('annotation-arguments' in grammar.repository);
  assert.ok('annotation-builtins' in grammar.repository);
  assert.ok('annotation-name' in grammar.repository);
  assert.ok('dsl-tag' in grammar.repository);
  assert.ok('builtin-macro-call' in grammar.repository);
});

test('Soundscript grammar tokenizes annotation bodies with arguments and builtins', () => {
  const grammar = readGrammar() as {
    repository: Record<string, {
      patterns?: Array<{
        begin?: string;
        end?: string;
        include?: string;
        match?: string;
        patterns?: Array<{ include?: string; match?: string }>;
      }>;
    }>;
  };

  const annotationComment = grammar.repository['annotation-comment'];
  assert.ok(annotationComment);
  const annotationRule = annotationComment.patterns?.[0];
  assert.equal(annotationRule?.begin, '(//\\s*)(#\\[)');
  assert.equal(annotationRule?.end, '(\\])');
  assert.deepEqual(
    annotationRule?.patterns?.map((pattern) => pattern.include ?? pattern.match),
    [
      '#annotation-arguments',
      '#annotation-builtins',
      '#annotation-name',
      ',',
    ],
  );

  const annotationBuiltins = grammar.repository['annotation-builtins'];
  assert.ok(annotationBuiltins.patterns?.[0]?.match?.includes('variance'));

  const annotationArguments = grammar.repository['annotation-arguments'];
  assert.equal(annotationArguments.patterns?.[0]?.begin, '\\(');
  assert.equal(annotationArguments.patterns?.[0]?.end, '\\)');
});

test('Soundscript grammar no longer carries legacy hash macro rules', () => {
  const grammar = readGrammar();

  assert.equal('macro-block' in grammar.repository, false);
  assert.equal('macro-invocation' in grammar.repository, false);
});
