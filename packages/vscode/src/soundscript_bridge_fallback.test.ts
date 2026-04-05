import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  fallbackCompletionItemsAt,
  fallbackDefinitionAt,
  fallbackHoverAt,
  implicitPreludeVirtualDocument,
  projectedImportHoverAt,
} from './soundscript_bridge_fallback';

test('projectedImportHoverAt projects mixed local .ts value imports to unknown at usage sites', () => {
  const text = [
    '// #[interop]',
    'import { type Environment, literalSchema, a } from "./types.ts";',
    'console.log(a);',
    '',
  ].join('\n');
  mkdirSync('/tmp/soundscript-bridge-fallback-projects', { recursive: true });
  writeFileSync(
    '/tmp/soundscript-bridge-fallback-projects/types.ts',
    'export interface Environment {}\nexport const literalSchema: any = {}\nexport const a: any = 1;\n',
  );

  const hover = projectedImportHoverAt('/tmp/soundscript-bridge-fallback-projects/index.sts', text, {
    line: 2,
    character: 'console.log('.length,
  });

  assert.deepEqual(hover, {
    markdown: '```ts\nconst a: unknown\n```',
    range: {
      startLine: 2,
      startCharacter: 'console.log('.length,
      endLine: 2,
      endCharacter: 'console.log(a'.length,
    },
  });
});

test('projectedImportHoverAt resolves mixed local .ts type import bindings', () => {
  const text = [
    '// #[interop]',
    'import { type Environment, literalSchema } from "./types.ts";',
    'void 0;',
    '',
  ].join('\n');
  mkdirSync('/tmp/soundscript-bridge-fallback-type-projects', { recursive: true });
  writeFileSync(
    '/tmp/soundscript-bridge-fallback-type-projects/types.ts',
    'export interface Environment { mode: string }\nexport const literalSchema: any = {}\n',
  );

  const hover = projectedImportHoverAt('/tmp/soundscript-bridge-fallback-type-projects/index.sts', text, {
    line: 1,
    character: 'import { type '.length,
  });

  assert.deepEqual(hover, {
    markdown: '```ts\ninterface Environment\n```',
    range: {
      startLine: 1,
      startCharacter: 'import { type '.length,
      endLine: 1,
      endCharacter: 'import { type Environment'.length,
    },
  });
});

test('projectedImportHoverAt ignores shadowed locals', () => {
  const text = [
    '// #[interop]',
    'import { a } from "./types.ts";',
    'function read(a: number) {',
    '  return a;',
    '}',
    '',
  ].join('\n');

  const hover = projectedImportHoverAt('/workspace/src/index.sts', text, {
    line: 3,
    character: '  return '.length,
  });

  assert.equal(hover, null);
});

test('projectedImportHoverAt preserves trusted local .ts value imports', () => {
  const text = [
    '// #[interop]',
    'import { value } from "./types.ts";',
    'console.log(value);',
    '',
  ].join('\n');

  const filePath = '/tmp/soundscript-bridge-fallback-preserves/index.sts';
  const importedPath = '/tmp/soundscript-bridge-fallback-preserves/types.ts';
  mkdirSync('/tmp/soundscript-bridge-fallback-preserves', { recursive: true });
  writeFileSync(importedPath, 'export const value: number = 1;\n');

  const hover = projectedImportHoverAt(filePath, text, {
    line: 1,
    character: 'import { '.length,
  });

  assert.deepEqual(hover, {
    markdown: '```ts\nconst value: number\n```',
    range: {
      startLine: 1,
      startCharacter: 'import { '.length,
      endLine: 1,
      endCharacter: 'import { value'.length,
    },
  });
});

test('projectedImportHoverAt preserves trusted local .ts value imports at usage sites', () => {
  const text = [
    '// #[interop]',
    'import { value } from "./types.ts";',
    'console.log(value);',
    '',
  ].join('\n');

  const filePath = '/tmp/soundscript-bridge-fallback-preserves-usage/index.sts';
  const importedPath = '/tmp/soundscript-bridge-fallback-preserves-usage/types.ts';
  mkdirSync('/tmp/soundscript-bridge-fallback-preserves-usage', { recursive: true });
  writeFileSync(importedPath, 'export const value = 1;\n');

  const hover = projectedImportHoverAt(filePath, text, {
    line: 2,
    character: 'console.log('.length,
  });

  assert.deepEqual(hover, {
    markdown: '```ts\nconst value = 1\n```',
    range: {
      startLine: 2,
      startCharacter: 'console.log('.length,
      endLine: 2,
      endCharacter: 'console.log(value'.length,
    },
  });
});

test('projectedImportHoverAt resolves trusted local .ts value usage hovers at identifier end positions', () => {
  const text = [
    '// #[interop]',
    'import { value } from "./types.ts";',
    'console.log(value);',
    '',
  ].join('\n');

  const filePath = '/tmp/soundscript-bridge-fallback-preserves-usage-end/index.sts';
  const importedPath = '/tmp/soundscript-bridge-fallback-preserves-usage-end/types.ts';
  mkdirSync('/tmp/soundscript-bridge-fallback-preserves-usage-end', { recursive: true });
  writeFileSync(importedPath, 'export const value = 1;\n');

  const hover = projectedImportHoverAt(filePath, text, {
    line: 2,
    character: 'console.log(value'.length,
  });

  assert.deepEqual(hover, {
    markdown: '```ts\nconst value = 1\n```',
    range: {
      startLine: 2,
      startCharacter: 'console.log('.length,
      endLine: 2,
      endCharacter: 'console.log(value'.length,
    },
  });
});

test('projectedImportHoverAt shows unannotated trusted imported declarations with initializer snippets', () => {
  const text = [
    '// #[interop]',
    'import { literalSchema } from "./types.ts";',
    'console.log(literalSchema);',
    '',
  ].join('\n');

  const filePath = '/tmp/soundscript-bridge-fallback-literal-schema/index.sts';
  const importedPath = '/tmp/soundscript-bridge-fallback-literal-schema/types.ts';
  mkdirSync('/tmp/soundscript-bridge-fallback-literal-schema', { recursive: true });
  writeFileSync(
    importedPath,
    'export const literalSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);\n',
  );

  const hover = projectedImportHoverAt(filePath, text, {
    line: 2,
    character: 'console.log(literalSchema'.length,
  });

  assert.deepEqual(hover, {
    markdown: '```ts\nconst literalSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])\n```',
    range: {
      startLine: 2,
      startCharacter: 'console.log('.length,
      endLine: 2,
      endCharacter: 'console.log(literalSchema'.length,
    },
  });
});

test('projectedImportHoverAt projects mixed local .ts value import bindings to unknown', () => {
  const text = [
    '// #[interop]',
    'import { type Environment, literalSchema, a } from "./types.ts";',
    'void 0;',
    '',
  ].join('\n');
  mkdirSync('/tmp/soundscript-bridge-fallback-mixed-bindings', { recursive: true });
  writeFileSync(
    '/tmp/soundscript-bridge-fallback-mixed-bindings/types.ts',
    'export interface Environment {}\nexport const literalSchema: any = {}\nexport const a: any = 1;\n',
  );

  const hover = projectedImportHoverAt('/tmp/soundscript-bridge-fallback-mixed-bindings/index.sts', text, {
    line: 1,
    character: 'import { type Environment, '.length,
  });

  assert.deepEqual(hover, {
    markdown: '```ts\nconst literalSchema: unknown\n```',
    range: {
      startLine: 1,
      startCharacter: 'import { type Environment, '.length,
      endLine: 1,
      endCharacter: 'import { type Environment, literalSchema'.length,
    },
  });
});

test('projectedImportHoverAt resolves stdlib module import bindings from an installed package', () => {
  const text = [
    "import { parseJson } from 'sts:json';",
    'void parseJson;',
    '',
  ].join('\n');

  const projectRoot = '/tmp/soundscript-bridge-fallback-stdlib';
  mkdirSync(`${projectRoot}/node_modules/@soundscript/soundscript`, { recursive: true });
  writeFileSync(
    `${projectRoot}/node_modules/@soundscript/soundscript/json.d.ts`,
    [
      'export type JsonValue = string;',
      'export interface JsonParseFailure { readonly message: string }',
      'export function parseJson(text: string): Result<JsonValue, JsonParseFailure>;',
      '',
    ].join('\n'),
  );

  const hover = projectedImportHoverAt(`${projectRoot}/src/index.sts`, text, {
    line: 0,
    character: 'import { '.length,
  });

  assert.deepEqual(hover, {
    markdown: '```ts\nfunction parseJson(text: string): Result<JsonValue, JsonParseFailure>\n```',
    range: {
      startLine: 0,
      startCharacter: 'import { '.length,
      endLine: 0,
      endCharacter: 'import { parseJson'.length,
    },
  });
});

test('fallbackHoverAt resolves ordinary local symbols without helper state', () => {
  const text = [
    'const value = 1;',
    'console.log(value);',
    '',
  ].join('\n');

  const hover = fallbackHoverAt('/tmp/soundscript-bridge-fallback-ordinary/index.sts', text, {
    line: 1,
    character: 'console.log('.length,
  });

  assert.deepEqual(hover, {
    markdown: '```ts\nconst value: 1\n```',
    range: {
      startLine: 1,
      startCharacter: 'console.log('.length,
      endLine: 1,
      endCharacter: 'console.log(value'.length,
    },
  });
});

test('fallbackHoverAt models Object.create(null) locals as BareObject without helper state', () => {
  const text = [
    'const dict = Object.create(null);',
    'void dict;',
    '',
  ].join('\n');

  const hover = fallbackHoverAt('/tmp/soundscript-bridge-fallback-bare-object/index.sts', text, {
    line: 1,
    character: 'void '.length,
  });

  assert.deepEqual(hover, {
    markdown: '```ts\nconst dict: BareObject\n```',
    range: {
      startLine: 1,
      startCharacter: 'void '.length,
      endLine: 1,
      endCharacter: 'void dict'.length,
    },
  });
});

test('fallbackHoverAt uses the soundscript Object.create(null) overload for method hovers', { concurrency: false }, () => {
  const text = [
    'const dict = Object.create(null);',
    '',
  ].join('\n');

  const hover = fallbackHoverAt('/tmp/soundscript-bridge-fallback-object-create/index.sts', text, {
    line: 0,
    character: 'const dict = Object.cr'.length,
  });

  assert.deepEqual(hover, {
    markdown: '```ts\n(method) ObjectConstructor.create(o: null): BareObject\n```',
    range: {
      startLine: 0,
      startCharacter: 'const dict = Object.'.length,
      endLine: 0,
      endCharacter: 'const dict = Object.create'.length,
    },
  });
});

test('fallbackHoverAt normalizes catch bindings to Error without helper state', () => {
  const text = [
    'try {',
    '  throw new Error("boom");',
    '} catch (err) {',
    '  void err;',
    '}',
    '',
  ].join('\n');

  const hover = fallbackHoverAt('/tmp/soundscript-bridge-fallback-catch/index.sts', text, {
    line: 3,
    character: '  void '.length,
  });

  assert.deepEqual(hover, {
    markdown: '```ts\nerr: Error\n```',
    range: {
      startLine: 3,
      startCharacter: '  void '.length,
      endLine: 3,
      endCharacter: '  void err'.length,
    },
  });
});

test('fallbackHoverAt exposes builtin annotation hover docs', () => {
  const text = [
    '// #[interop]',
    'import { value } from "./types.ts";',
    '',
  ].join('\n');

  const hover = fallbackHoverAt('/tmp/soundscript-bridge-fallback-annotation/index.sts', text, {
    line: 0,
    character: '// #['.length,
  });

  assert.deepEqual(hover, {
    markdown: [
      '**annotation** `interop`',
      '',
      '```ts',
      '// #[interop]',
      '```',
      '',
      'Marks an import-like boundary where unsound foreign values enter soundscript.',
      '',
      'Use `#[interop]` on imports, `require(...)`, or dynamic `import(...)` boundaries that intentionally cross from `.ts`, JavaScript, or declaration-only code into `.sts`.',
      '',
      'Validate the imported value at the boundary before relying on stronger types inside soundscript.',
    ].join('\n'),
    range: {
      startLine: 0,
      startCharacter: '// #['.length,
      endLine: 0,
      endCharacter: '// #[interop'.length,
    },
  });
});

test('fallbackHoverAt exposes implicit prelude type hovers without helper state', () => {
  const text = [
    'declare const value: Result<number, string>;',
    'void value;',
    '',
  ].join('\n');

  const hover = fallbackHoverAt('/tmp/soundscript-bridge-fallback-prelude-type/index.sts', text, {
    line: 0,
    character: 'declare const value: '.length,
  });

  assert.deepEqual(hover, {
    markdown: '```ts\ntype Result<T, E> = Ok<T> | Err<E>\n```',
    range: {
      startLine: 0,
      startCharacter: 'declare const value: '.length,
      endLine: 0,
      endCharacter: 'declare const value: Result'.length,
    },
  });
});

test('fallbackHoverAt exposes implicit prelude macro hovers without helper state', () => {
  const text = [
    'declare const value: Result<number, string>;',
    'const next = Try(value);',
    '',
  ].join('\n');

  const hover = fallbackHoverAt('/tmp/soundscript-bridge-fallback-prelude-value/index.sts', text, {
    line: 1,
    character: 'const next = '.length,
  });

  assert.deepEqual(hover, {
    markdown: [
      '**macro** `Try`',
      '',
      '```ts',
      'function Try<T, E>(value: Result<T, E>): T',
      'function Try<T, E>(value: Promise<Result<T, E>>): Promise<T>',
      '```',
      '',
      'Unwraps `Result<Ok, Err>`. If the operand is `err`, the enclosing function returns that error immediately.',
    ].join('\n'),
    range: {
      startLine: 1,
      startCharacter: 'const next = '.length,
      endLine: 1,
      endCharacter: 'const next = Try'.length,
    },
  });
});

test('fallbackHoverAt infers Match-based function returns without helper state', () => {
  const text = [
    'function safeDivide(divisor: number, denominator: number): Result<number, string> {',
    '  if (denominator === 0) {',
    "    return err('divide_by_zero');",
    '  }',
    '  return ok(divisor / denominator);',
    '}',
    '',
    'function matchDivision() {',
    '  return Match(safeDivide(10, 0), [',
    '    ({ value }: Ok<number>) => true,',
    '    ({ error }: Err<string>) => false,',
    '  ]);',
    '}',
    '',
  ].join('\n');

  const hover = fallbackHoverAt('/tmp/soundscript-bridge-fallback-prelude-match/index.sts', text, {
    line: 7,
    character: 'function '.length,
  });

  assert.deepEqual(hover, {
    markdown: '```ts\nfunction matchDivision(): boolean\n```',
    range: {
      startLine: 7,
      startCharacter: 'function '.length,
      endLine: 7,
      endCharacter: 'function matchDivision'.length,
    },
  });
});

test('fallbackHoverAt infers Try-lifted function returns without helper state', () => {
  const text = [
    'function safeDivide(divisor: number, denominator: number): Result<number, string> {',
    '  if (denominator === 0) {',
    "    return err('divide_by_zero');",
    '  }',
    '  return ok(divisor / denominator);',
    '}',
    '',
    'function tryDivision() {',
    '  const value = Try(safeDivide(10, 0));',
    '  return value;',
    '}',
    '',
  ].join('\n');

  const hover = fallbackHoverAt('/tmp/soundscript-bridge-fallback-prelude-try/index.sts', text, {
    line: 7,
    character: 'function '.length,
  });

  assert.deepEqual(hover, {
    markdown: '```ts\nfunction tryDivision(): Result<number, string>\n```',
    range: {
      startLine: 7,
      startCharacter: 'function '.length,
      endLine: 7,
      endCharacter: 'function tryDivision'.length,
    },
  });
});

test('fallbackHoverAt infers Match Err bindings without collapsing to any', () => {
  const text = [
    'function safeDivide(divisor: number, denominator: number): Result<number, string> {',
    '  if (denominator === 0) {',
    "    return err('divide_by_zero');",
    '  }',
    '  return ok(divisor / denominator);',
    '}',
    '',
    'function matchDivision() {',
    '  return Match(safeDivide(10, 0), [',
    '    ({ value }: Ok<number>) => true,',
    '    ({ err }: Err<string>) => false,',
    '  ]);',
    '}',
    '',
  ].join('\n');

  const hover = fallbackHoverAt('/tmp/soundscript-bridge-fallback-prelude-match-err/index.sts', text, {
    line: 10,
    character: '    ({ '.length,
  });

  assert.deepEqual(hover, {
    markdown: '```ts\nerr: string\n```',
    range: {
      startLine: 10,
      startCharacter: '    ({ '.length,
      endLine: 10,
      endCharacter: '    ({ err'.length,
    },
  });
});

test('fallbackDefinitionAt resolves implicit prelude types without helper state', () => {
  const text = [
    'declare const value: Result<number, string>;',
    'void value;',
    '',
  ].join('\n');

  const definitions = fallbackDefinitionAt(
    '/tmp/soundscript-bridge-fallback-prelude-definition-type/index.sts',
    text,
    {
      line: 0,
      character: 'declare const value: '.length,
    },
  );

  assert.deepEqual(definitions, [{
    uri: implicitPreludeVirtualDocument().uri,
    range: {
      startLine: 4,
      startCharacter: 'export type '.length,
      endLine: 4,
      endCharacter: 'export type Result'.length,
    },
  }]);
});

test('fallbackDefinitionAt resolves implicit prelude macros without helper state', () => {
  const text = [
    'declare const value: Result<number, string>;',
    'const next = Try(value);',
    '',
  ].join('\n');

  const definitions = fallbackDefinitionAt(
    '/tmp/soundscript-bridge-fallback-prelude-definition-value/index.sts',
    text,
    {
      line: 1,
      character: 'const next = '.length,
    },
  );

  assert.deepEqual(definitions, [{
    uri: implicitPreludeVirtualDocument().uri,
    range: {
      startLine: 31,
      startCharacter: 'export function '.length,
      endLine: 31,
      endCharacter: 'export function Try'.length,
    },
  }]);
});

test('fallbackDefinitionAt resolves imported local .ts values at usage sites', () => {
  const text = [
    '// #[interop]',
    'import { literalSchema } from "./types.ts";',
    'console.log(literalSchema);',
    '',
  ].join('\n');

  const workspacePath = '/tmp/soundscript-bridge-fallback-definition-import';
  const documentPath = `${workspacePath}/index.sts`;
  const importedPath = `${workspacePath}/types.ts`;
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(
    importedPath,
    'export const literalSchema: any = {\n  kind: "literal",\n};\n',
  );

  const definitions = fallbackDefinitionAt(
    documentPath,
    text,
    {
      line: 2,
      character: 'console.log('.length,
    },
  );

  assert.deepEqual(definitions, [{
    uri: pathToFileURL(importedPath).toString(),
    range: {
      startLine: 0,
      startCharacter: 'export const '.length,
      endLine: 0,
      endCharacter: 'export const literalSchema'.length,
    },
  }]);
});

test('fallbackCompletionItemsAt offers implicit prelude globals at bare identifiers', () => {
  const text = [
    'const next = Tr',
    '',
  ].join('\n');

  const items = fallbackCompletionItemsAt(
    '/tmp/soundscript-bridge-fallback-prelude-completion/index.sts',
    text,
    {
      line: 0,
      character: 'const next = Tr'.length,
    },
  );

  assert.ok(items.some((item) => item.label === 'Try'));
  assert.ok(items.every((item) => item.label.startsWith('Tr')));
});
