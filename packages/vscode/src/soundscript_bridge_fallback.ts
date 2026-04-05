import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';

export interface BridgeFallbackPosition {
  character: number;
  line: number;
}

export interface BridgeFallbackRange {
  endCharacter: number;
  endLine: number;
  startCharacter: number;
  startLine: number;
}

export interface ProjectedImportHoverFallback {
  markdown: string;
  range: BridgeFallbackRange;
}

export interface ImportedTsHoverTarget {
  fallback: ProjectedImportHoverFallback;
  importedFilePath: string;
  importedRange: BridgeFallbackRange;
  projectedUnknown: boolean;
}

export interface BridgeFallbackDefinitionTarget {
  range: BridgeFallbackRange;
  uri: string;
}

export interface BridgeFallbackCompletionItem {
  detail?: string;
  documentation?: string;
  insertText: string;
  kind: 'class' | 'function' | 'interface' | 'keyword' | 'module' | 'type';
  label: string;
}

interface ParsedAnnotationHoverItem {
  argumentsText?: string;
  end: number;
  name: string;
  nameEnd: number;
  nameStart: number;
  start: number;
  text: string;
}

const SAFE_MODULE_EXTENSIONS = new Set(['.d.cts', '.d.mts', '.d.ts', '.sts']);
const UNSOUND_MODULE_EXTENSIONS = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
]);

const SIBLING_REPO_STDLIB_DECLARATION_DIRECTORY = resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'soundscript',
  'src',
  'stdlib',
);

function codeFence(code: string): string {
  return `\`\`\`ts\n${code}\n\`\`\``;
}

function richMarkdown(title: string, code: string, details: readonly string[]): string {
  return [
    title,
    '',
    codeFence(code),
    ...details.flatMap((detail) => ['', detail]),
  ].join('\n');
}

const BUILTIN_ANNOTATION_HOVER_DETAILS: Readonly<
  Record<string, {
    readonly details: readonly string[];
    readonly summary: string;
    readonly syntax: string;
  }>
> = {
  extern: {
    summary: 'Marks a local ambient runtime declaration as an explicit extern boundary.',
    syntax: '// #[extern]',
    details: [
      'Use `#[extern]` only for same-file runtime-provided declarations such as host globals or compiler-injected helpers.',
      'This attaches to local ambient declarations, not to ordinary imports.',
    ],
  },
  interop: {
    summary: 'Marks an import-like boundary where unsound foreign values enter soundscript.',
    syntax: '// #[interop]',
    details: [
      'Use `#[interop]` on imports, `require(...)`, or dynamic `import(...)` boundaries that intentionally cross from `.ts`, JavaScript, or declaration-only code into `.sts`.',
      'Validate the imported value at the boundary before relying on stronger types inside soundscript.',
    ],
  },
  unsafe: {
    summary: 'Marks a local proof-override site inside soundscript.',
    syntax: '// #[unsafe]',
    details: [
      'Use `#[unsafe]` only when you are intentionally overriding a local proof obligation.',
      'This is a local escape hatch, not a foreign-boundary marker.',
    ],
  },
  variance: {
    summary: 'Declares a checked variance contract on a generic interface or type alias.',
    syntax: '// #[variance(T: out, U: in)]',
    details: [
      'Use named arguments such as `T: out`, `U: in`, `R: inout`, or `X: independent`, once per declared type parameter.',
      'The contract is checked, not trusted: soundscript verifies that the declaration surface actually proves the stated variance.',
    ],
  },
};

const IMPLICIT_PRELUDE_HOVER_MARKDOWN_BY_NAME = new Map<string, string>([
  ['Ok', codeFence("type Ok<T> = { readonly tag: 'ok'; readonly value: T }")],
  ['Err', codeFence("type Err<E> = { readonly tag: 'err'; readonly error: E }")],
  ['Result', codeFence('type Result<T, E> = Ok<T> | Err<E>')],
  ['Some', codeFence('type Some<T> = Ok<T>')],
  ['None', codeFence('type None = Err<void>')],
  ['Option', codeFence('type Option<T> = Result<T, void>')],
  ['ok', codeFence('function ok<T>(value: T): Result<T, never>')],
  ['err', codeFence('function err(): Result<never, void>\nfunction err<E>(error: E): Result<never, E>')],
  ['some', codeFence('function some<T>(value: T): Option<T>')],
  ['none', codeFence('function none(): Option<never>')],
  ['isOk', codeFence('function isOk<T, E>(value: Result<T, E>): value is Ok<T>')],
  ['isErr', codeFence('function isErr<T, E>(value: Result<T, E>): value is Err<E>')],
  ['isSome', codeFence('function isSome<T>(value: Option<T>): value is Some<T>')],
  ['isNone', codeFence('function isNone<T>(value: Option<T>): value is None')],
  ['Failure', codeFence('class Failure')],
  ['Try', richMarkdown(
    '**macro** `Try`',
    'function Try<T, E>(value: Result<T, E>): T\nfunction Try<T, E>(value: Promise<Result<T, E>>): Promise<T>',
    ['Unwraps `Result<Ok, Err>`. If the operand is `err`, the enclosing function returns that error immediately.'],
  )],
  ['where', richMarkdown(
    '**macro helper** `where`',
    'function where<TValue, TResult>(arm: (value: TValue) => TResult, predicate: (value: TValue) => unknown): (value: TValue) => TResult',
    ['Use `where(arm, predicate)` to layer guard predicates onto `Match(...)` arms.'],
  )],
  ['Match', richMarkdown(
    '**macro** `Match`',
    'function Match<TArm extends MatchArm<any, any>>(value: unknown, arms: readonly [TArm, ...TArm[]]): ReturnType<TArm>',
    [
      'Evaluates the scrutinee once and returns the first matching arm.',
      'Preferred form: `Match (value) [ ({ value }: Ok) => value, (x: string) => x.length, (_) => 0 ]`.',
      'Guards layer through `where(arm, predicate)`.',
    ],
  )],
  ['Defer', richMarkdown(
    '**macro** `Defer`',
    'function Defer(cleanup: () => unknown): never',
    ['Registers cleanup work that runs when the enclosing function exits.', 'Use `Defer(() => { ... })` inside a function or method body.'],
  )],
  ['todo', richMarkdown(
    '**macro** `todo`',
    'function todo(message?: string): never',
    ['Throws a `TODO` error immediately and marks an intentionally unfinished path.'],
  )],
  ['unreachable', richMarkdown(
    '**macro** `unreachable`',
    'function unreachable(message?: string): never',
    ['Throws an `Unreachable` error immediately and marks a path that should be impossible.'],
  )],
]);

const IMPLICIT_PRELUDE_VIRTUAL_URI = 'soundscript-stdlib:/prelude.d.ts';
const IMPLICIT_PRELUDE_SIGNATURES_BY_NAME = new Map<string, {
  detail: string;
  kind: BridgeFallbackCompletionItem['kind'];
  signature: string;
}>([
  ['Ok', { kind: 'type', detail: 'type Ok<T>', signature: "export type Ok<T> = { readonly tag: 'ok'; readonly value: T };" }],
  ['Err', { kind: 'type', detail: 'type Err<E>', signature: "export type Err<E> = { readonly tag: 'err'; readonly error: E };" }],
  ['Result', { kind: 'type', detail: 'type Result<T, E>', signature: 'export type Result<T, E> = Ok<T> | Err<E>;' }],
  ['Some', { kind: 'type', detail: 'type Some<T>', signature: 'export type Some<T> = Ok<T>;' }],
  ['None', { kind: 'type', detail: 'type None', signature: 'export type None = Err<void>;' }],
  ['Option', { kind: 'type', detail: 'type Option<T>', signature: 'export type Option<T> = Result<T, void>;' }],
  ['ok', { kind: 'function', detail: 'function ok<T>(value: T): Result<T, never>', signature: 'export function ok<T>(value: T): Result<T, never>;' }],
  ['err', { kind: 'function', detail: 'function err(...): Result<...>', signature: 'export function err(): Result<never, void>;\nexport function err<E>(error: E): Result<never, E>;' }],
  ['some', { kind: 'function', detail: 'function some<T>(value: T): Option<T>', signature: 'export function some<T>(value: T): Option<T>;' }],
  ['none', { kind: 'function', detail: 'function none(): Option<never>', signature: 'export function none(): Option<never>;' }],
  ['isOk', { kind: 'function', detail: 'function isOk<T, E>(value: Result<T, E>): value is Ok<T>', signature: 'export function isOk<T, E>(value: Result<T, E>): value is Ok<T>;' }],
  ['isErr', { kind: 'function', detail: 'function isErr<T, E>(value: Result<T, E>): value is Err<E>', signature: 'export function isErr<T, E>(value: Result<T, E>): value is Err<E>;' }],
  ['isSome', { kind: 'function', detail: 'function isSome<T>(value: Option<T>): value is Some<T>', signature: 'export function isSome<T>(value: Option<T>): value is Some<T>;' }],
  ['isNone', { kind: 'function', detail: 'function isNone<T>(value: Option<T>): value is None', signature: 'export function isNone<T>(value: Option<T>): value is None;' }],
  ['Failure', { kind: 'class', detail: 'class Failure', signature: 'export class Failure {}' }],
  ['Try', { kind: 'function', detail: 'function Try<T, E>(value: Result<T, E>): T', signature: 'export function Try<T, E>(value: Result<T, E>): T;\nexport function Try<T, E>(value: Promise<Result<T, E>>): Promise<T>;' }],
  ['where', { kind: 'function', detail: 'function where<TValue, TResult>(...)', signature: 'export function where<TValue, TResult>(arm: (value: TValue) => TResult, predicate: (value: TValue) => unknown): (value: TValue) => TResult;' }],
  ['Match', { kind: 'function', detail: 'function Match<TArm extends MatchArm<any, any>>(...)', signature: 'export function Match<TArm extends MatchArm<any, any>>(value: unknown, arms: readonly [TArm, ...TArm[]]): ReturnType<TArm>;' }],
  ['Defer', { kind: 'function', detail: 'function Defer(cleanup: () => unknown): never', signature: 'export function Defer(cleanup: () => unknown): never;' }],
  ['todo', { kind: 'function', detail: 'function todo(message?: string): never', signature: 'export function todo(message?: string): never;' }],
  ['unreachable', { kind: 'function', detail: 'function unreachable(message?: string): never', signature: 'export function unreachable(message?: string): never;' }],
]);

const IMPLICIT_PRELUDE_VIRTUAL_TEXT = [...IMPLICIT_PRELUDE_SIGNATURES_BY_NAME.values()].map((entry) => entry.signature).join('\n\n');
const IMPLICIT_PRELUDE_GLOBAL_DECLARATION_FILE = '/__soundscript_implicit_prelude__.d.ts';
const IMPLICIT_PRELUDE_GLOBAL_DECLARATION_TEXT = [
  'declare const __soundBareObjectBrand: unique symbol;',
  'interface BareObject {',
  '  readonly [__soundBareObjectBrand]?: never;',
  '}',
  'interface PropertyDescriptor {}',
  'interface PropertyDescriptorMap {',
  '  [key: string]: PropertyDescriptor;',
  '}',
  'interface ThisType<T> {}',
  'interface ObjectConstructor {',
  '  create(o: null): BareObject;',
  '  create<T extends object>(o: T): T;',
  '  create(o: null, properties: PropertyDescriptorMap & ThisType<unknown>): BareObject;',
  '  create<T extends object>(o: T, properties: PropertyDescriptorMap & ThisType<any>): T;',
  '}',
  'declare const Object: ObjectConstructor;',
  'interface Promise<T> {}',
  'type MatchArm<TValue = unknown, TResult = unknown> = (value: TValue) => TResult;',
  [...IMPLICIT_PRELUDE_SIGNATURES_BY_NAME.entries()].map(([name, entry]) => {
    if (name === 'Match') {
      return 'function Match<TResult>(value: unknown, arms: readonly [MatchArm<any, TResult>, ...MatchArm<any, TResult>[]]): TResult;';
    }
    return entry.signature.replace(/^export\s+/gm, '');
  }).join('\n\n'),
].join('\n\n');
const IMPLICIT_PRELUDE_DEFINITION_TARGETS_BY_NAME = (() => {
  const byName = new Map<string, BridgeFallbackRange>();
  let line = 0;
  for (const [name, entry] of IMPLICIT_PRELUDE_SIGNATURES_BY_NAME.entries()) {
    const firstLine = entry.signature.split('\n')[0] ?? '';
    const startCharacter = Math.max(firstLine.indexOf(name), 0);
    byName.set(name, {
      startLine: line,
      startCharacter,
      endLine: line,
      endCharacter: startCharacter + name.length,
    });
    line += entry.signature.split('\n').length + 1;
  }
  return byName;
})();

function lookupFilePathForDocument(filePath: string): string {
  return filePath.endsWith('.sts') ? `${filePath}.ts` : filePath;
}

function offsetAt(text: string, line: number, character: number): number {
  let currentLine = 0;
  let offset = 0;
  while (currentLine < line && offset < text.length) {
    if (text[offset] === '\n') {
      currentLine += 1;
    }
    offset += 1;
  }
  return Math.min(text.length, offset + character);
}

function positionFromOffset(text: string, offset: number): BridgeFallbackPosition {
  let line = 0;
  let character = 0;
  for (let index = 0; index < Math.min(offset, text.length); index += 1) {
    if (text[index] === '\n') {
      line += 1;
      character = 0;
    } else {
      character += 1;
    }
  }
  return { line, character };
}

function createSingleFileProgram(
  filePath: string,
  text: string,
): {
  lookupFilePath: string;
  program: ts.Program;
} {
  const lookupFilePath = lookupFilePathForDocument(filePath);
  const options: ts.CompilerOptions = {
    allowJs: true,
    module: ts.ModuleKind.ESNext,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const host = ts.createCompilerHost(options, true);
  host.getSourceFile = (candidatePath, languageVersion) => {
    if (candidatePath === lookupFilePath) {
      return ts.createSourceFile(candidatePath, text, languageVersion, true, ts.ScriptKind.TS);
    }
    if (candidatePath === IMPLICIT_PRELUDE_GLOBAL_DECLARATION_FILE) {
      return ts.createSourceFile(
        candidatePath,
        IMPLICIT_PRELUDE_GLOBAL_DECLARATION_TEXT,
        languageVersion,
        true,
        ts.ScriptKind.TS,
      );
    }
    return undefined;
  };
  host.fileExists = (candidatePath) =>
    candidatePath === lookupFilePath || candidatePath === IMPLICIT_PRELUDE_GLOBAL_DECLARATION_FILE;
  host.readFile = (candidatePath) => {
    if (candidatePath === lookupFilePath) {
      return text;
    }
    if (candidatePath === IMPLICIT_PRELUDE_GLOBAL_DECLARATION_FILE) {
      return IMPLICIT_PRELUDE_GLOBAL_DECLARATION_TEXT;
    }
    return undefined;
  };
  host.writeFile = () => {};
  return {
    lookupFilePath,
    program: ts.createProgram([lookupFilePath, IMPLICIT_PRELUDE_GLOBAL_DECLARATION_FILE], options, host),
  };
}

function findDeepestNodeContainingPosition(root: ts.Node, position: number): ts.Node | null {
  if (position < root.getFullStart() || position >= root.getEnd()) {
    return null;
  }

  const child = root.forEachChild((candidate) => findDeepestNodeContainingPosition(candidate, position));
  return child ?? root;
}

function findIdentifierNodeForHover(
  sourceFile: ts.SourceFile,
  position: number,
): ts.Identifier | null {
  const directNode = findDeepestNodeContainingPosition(sourceFile, position);
  if (directNode && ts.isIdentifier(directNode)) {
    return directNode;
  }

  if (position <= 0) {
    return null;
  }

  const previousNode = findDeepestNodeContainingPosition(sourceFile, position - 1);
  if (!previousNode || !ts.isIdentifier(previousNode)) {
    return null;
  }

  const start = previousNode.getStart(sourceFile);
  const end = previousNode.getEnd();
  return position >= start && position <= end ? previousNode : null;
}

function isIdentifierPart(character: string | undefined): boolean {
  return character !== undefined && /[\p{ID_Continue}_$\u200C\u200D]/u.test(character);
}

function identifierPrefixAt(text: string, offset: number): string {
  let start = offset;
  while (start > 0 && isIdentifierPart(text[start - 1])) {
    start -= 1;
  }
  return text.slice(start, offset);
}

function importDeclarationForNode(node: ts.Node): ts.ImportDeclaration | null {
  let current: ts.Node | undefined = node;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isImportDeclaration(current)) {
      return current;
    }
    current = current.parent;
  }

  return null;
}

function importBindingHoverKindForDeclaration(
  declaration: ts.Declaration,
): 'type' | 'value' | null {
  if (ts.isImportSpecifier(declaration)) {
    const importClause = declaration.parent.parent as ts.Node;
    return declaration.isTypeOnly || (ts.isImportClause(importClause) && importClause.isTypeOnly)
      ? 'type'
      : 'value';
  }
  if (ts.isNamespaceImport(declaration)) {
    const importClause = declaration.parent.parent as ts.Node;
    return ts.isImportClause(importClause) && importClause.isTypeOnly
      ? 'type'
      : 'value';
  }
  if (ts.isImportClause(declaration)) {
    return declaration.isTypeOnly ? 'type' : 'value';
  }

  return null;
}

function importBindingDeclarationForSymbol(symbol: ts.Symbol): ts.Declaration | null {
  const declarations = symbol.declarations ?? (symbol.valueDeclaration ? [symbol.valueDeclaration] : []);
  return declarations.find((declaration) =>
    ts.isImportSpecifier(declaration) ||
    ts.isNamespaceImport(declaration) ||
    ts.isImportClause(declaration)
  ) ?? null;
}

function resolveUnsoundModulePath(specifierText: string, documentPath: string): string | null {
  if (!specifierText.startsWith('.') && !specifierText.startsWith('/')) {
    return null;
  }

  const absolutePath = resolve(dirname(documentPath), specifierText);
  const extension = extname(absolutePath);
  if (SAFE_MODULE_EXTENSIONS.has(extension)) {
    return null;
  }
  if (UNSOUND_MODULE_EXTENSIONS.has(extension)) {
    return absolutePath;
  }

  for (const candidateExtension of UNSOUND_MODULE_EXTENSIONS) {
    const candidatePath = `${absolutePath}${candidateExtension}`;
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  for (const candidateExtension of UNSOUND_MODULE_EXTENSIONS) {
    const candidatePath = resolve(absolutePath, `index${candidateExtension}`);
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
}

function resolveInstalledSoundscriptPackageRoot(documentPath: string): string | null {
  let currentDirectory = dirname(documentPath);
  while (true) {
    const candidateDirectory = resolve(
      currentDirectory,
      'node_modules',
      '@soundscript',
      'soundscript',
    );
    if (existsSync(candidateDirectory)) {
      return candidateDirectory;
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return null;
    }
    currentDirectory = parentDirectory;
  }
}

function resolveInstalledStdlibDeclarationPath(
  packageRoot: string,
  remainder: string,
): string | null {
  let relativeDeclarationPath: string;
  switch (remainder) {
    case 'prelude':
      relativeDeclarationPath = 'index.d.ts';
      break;
    default:
      relativeDeclarationPath = `${remainder}.d.ts`;
      break;
  }

  const declarationPath = resolve(packageRoot, relativeDeclarationPath);
  return existsSync(declarationPath) ? declarationPath : null;
}

function resolveSiblingRepoStdlibDeclarationPath(remainder: string): string | null {
  let relativeDeclarationPath: string;
  switch (remainder) {
    case 'prelude':
      relativeDeclarationPath = 'index.d.ts';
      break;
    case 'experimental/sql':
      relativeDeclarationPath = 'sql.d.ts';
      break;
    case 'experimental/css':
      relativeDeclarationPath = 'css.d.ts';
      break;
    case 'experimental/graphql':
      relativeDeclarationPath = 'graphql.d.ts';
      break;
    case 'experimental/component':
      relativeDeclarationPath = 'component.d.ts';
      break;
    case 'experimental/debug':
      relativeDeclarationPath = 'debug.d.ts';
      break;
    default:
      relativeDeclarationPath = `${remainder}.d.ts`;
      break;
  }

  const declarationPath = resolve(
    SIBLING_REPO_STDLIB_DECLARATION_DIRECTORY,
    relativeDeclarationPath,
  );
  return existsSync(declarationPath) ? declarationPath : null;
}

function resolveStdlibDeclarationPath(specifierText: string, documentPath: string): string | null {
  if (!specifierText.startsWith('sts:')) {
    return null;
  }

  const remainder = specifierText.slice('sts:'.length);
  const installedPackageRoot = resolveInstalledSoundscriptPackageRoot(documentPath);
  if (installedPackageRoot) {
    const installedDeclarationPath = resolveInstalledStdlibDeclarationPath(
      installedPackageRoot,
      remainder,
    );
    if (installedDeclarationPath) {
      return installedDeclarationPath;
    }
  }

  return resolveSiblingRepoStdlibDeclarationPath(remainder);
}

function resolveHoverModulePath(specifierText: string, documentPath: string): string | null {
  return resolveUnsoundModulePath(specifierText, documentPath) ??
    resolveStdlibDeclarationPath(specifierText, documentPath);
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false);
}

function isExplicitAnyTypeNode(typeNode: ts.TypeNode | undefined): boolean {
  return typeNode?.kind === ts.SyntaxKind.AnyKeyword;
}

function collectProjectedUnknownValueExportNames(importedFilePath: string): ReadonlySet<string> {
  const sourceText = readFileSync(importedFilePath, 'utf8');
  const sourceFile = ts.createSourceFile(importedFilePath, sourceText, ts.ScriptTarget.Latest, true);
  const locallyDeclaredAnyNames = new Set<string>();
  const exportedNames = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && isExplicitAnyTypeNode(declaration.type)) {
          locallyDeclaredAnyNames.add(declaration.name.text);
          if (hasExportModifier(statement)) {
            exportedNames.add(declaration.name.text);
          }
        }
      }
      continue;
    }

    if (ts.isFunctionDeclaration(statement) && statement.name && isExplicitAnyTypeNode(statement.type)) {
      locallyDeclaredAnyNames.add(statement.name.text);
      if (hasExportModifier(statement)) {
        exportedNames.add(statement.name.text);
      }
    }
  }

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        const localName = (element.propertyName ?? element.name).text;
        if (locallyDeclaredAnyNames.has(localName)) {
          exportedNames.add(element.name.text);
        }
      }
    }
  }

  return exportedNames;
}

function resolveSymbolAtNode(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) {
    return undefined;
  }
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    const aliasedSymbol = checker.getAliasedSymbol(symbol);
    if (aliasedSymbol) {
      return aliasedSymbol;
    }
  }
  return symbol;
}

function hasImplicitPreludeDeclaration(symbol: ts.Symbol | undefined): boolean {
  if (!symbol) {
    return false;
  }
  const declarations = symbol.declarations ?? (symbol.valueDeclaration ? [symbol.valueDeclaration] : []);
  return declarations.some((declaration) =>
    declaration.getSourceFile().fileName === IMPLICIT_PRELUDE_GLOBAL_DECLARATION_FILE
  );
}

function variableKeywordForDeclaration(node: ts.VariableDeclaration): 'const' | 'let' | 'var' {
  if ((node.parent.flags & ts.NodeFlags.Const) !== 0) {
    return 'const';
  }
  if ((node.parent.flags & ts.NodeFlags.Let) !== 0) {
    return 'let';
  }
  return 'var';
}

function isUserFacingSymbolName(name: string): boolean {
  return name.length > 0 && name !== 'default' && !name.startsWith('__');
}

function isNullLiteralExpression(node: ts.Expression): boolean {
  return node.kind === ts.SyntaxKind.NullKeyword;
}

function isObjectCreateNullExpression(node: ts.Expression): boolean {
  if (!ts.isCallExpression(node) || node.arguments.length !== 1) {
    return false;
  }
  if (!isNullLiteralExpression(node.arguments[0]!)) {
    return false;
  }
  return ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'Object' &&
    node.expression.name.text === 'create';
}

function isCatchClauseVariableDeclaration(node: ts.VariableDeclaration): boolean {
  return ts.isCatchClause(node.parent) && node.parent.variableDeclaration === node;
}

function formatSignatureHover(
  checker: ts.TypeChecker,
  node: ts.Node,
  symbol: ts.Symbol,
  labelPrefix: string,
  signatureKind: ts.SignatureKind,
): string | undefined {
  const type = checker.getTypeOfSymbolAtLocation(symbol, node);
  const [signature] = checker.getSignaturesOfType(type, signatureKind);
  if (!signature) {
    return undefined;
  }
  return `${labelPrefix}${
    checker.signatureToString(
      signature,
      node,
      ts.TypeFormatFlags.NoTruncation,
      signatureKind,
    )
  }`;
}

interface TryOperandFamilyInfo {
  readonly errorText: string;
  readonly family: 'Option' | 'Result';
  readonly promised: boolean;
}

function typeReferenceArguments(checker: ts.TypeChecker, type: ts.Type): readonly ts.Type[] {
  if (!(type.flags & ts.TypeFlags.Object)) {
    return [];
  }
  try {
    return checker.getTypeArguments(type as ts.TypeReference);
  } catch {
    return [];
  }
}

function tryOperandFamilyInfo(
  checker: ts.TypeChecker,
  type: ts.Type,
  node: ts.Node,
): TryOperandFamilyInfo | null {
  const aliasSymbol = (type as ts.Type & { aliasSymbol?: ts.Symbol }).aliasSymbol;
  const aliasTypeArguments = (type as ts.Type & { aliasTypeArguments?: readonly ts.Type[] }).aliasTypeArguments ?? [];
  if (aliasSymbol?.getName() === 'Result' && aliasTypeArguments.length >= 2) {
    return {
      family: 'Result',
      promised: false,
      errorText: checker.typeToString(aliasTypeArguments[1]!, node, ts.TypeFormatFlags.NoTruncation),
    };
  }
  if (aliasSymbol?.getName() === 'Option' && aliasTypeArguments.length >= 1) {
    return {
      family: 'Option',
      promised: false,
      errorText: 'void',
    };
  }

  const symbolName = type.symbol?.getName();
  const typeArguments = typeReferenceArguments(checker, type);
  if (symbolName === 'Promise' && typeArguments.length >= 1) {
    const inner = tryOperandFamilyInfo(checker, typeArguments[0]!, node);
    return inner ? { ...inner, promised: true } : null;
  }

  return null;
}

function functionLikeContainsTry(
  root: ts.Node,
): readonly ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (node !== root && ts.isFunctionLike(node)) {
      return;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Try') {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return calls;
}

function liftedFunctionReturnHoverCode(
  checker: ts.TypeChecker,
  declaration: ts.FunctionDeclaration,
  sourceFile: ts.SourceFile,
): string | null {
  if (!declaration.name || declaration.type || !declaration.body) {
    return null;
  }

  const tryCalls = functionLikeContainsTry(declaration.body);
  if (tryCalls.length === 0) {
    return null;
  }

  let family: TryOperandFamilyInfo['family'] | null = null;
  let promised = false;
  const errorTexts = new Set<string>();
  for (const call of tryCalls) {
    const operand = call.arguments[0];
    if (!operand) {
      continue;
    }
    const info = tryOperandFamilyInfo(checker, checker.getTypeAtLocation(operand), operand);
    if (!info) {
      continue;
    }
    family ??= info.family;
    promised ||= info.promised;
    errorTexts.add(info.errorText);
  }

  if (!family || errorTexts.size === 0) {
    return null;
  }

  const signature = checker.getSignatureFromDeclaration(declaration);
  if (!signature) {
    return null;
  }

  let successType = signature.getReturnType();
  const successTypeArguments = typeReferenceArguments(checker, successType);
  if ((declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false) && successType.symbol?.getName() === 'Promise' && successTypeArguments.length >= 1) {
    successType = successTypeArguments[0]!;
  }

  const successText = checker.typeToString(successType, declaration, ts.TypeFormatFlags.NoTruncation);
  const errorText = [...errorTexts].sort().join(' | ');
  const liftedReturnText = family === 'Option'
    ? `Option<${successText}>`
    : `Result<${successText}, ${errorText}>`;
  const finalReturnText = promised ? `Promise<${liftedReturnText}>` : liftedReturnText;
  const params = declaration.parameters.map((parameter) => parameter.getText(sourceFile)).join(', ');
  return `function ${declaration.name.text}(${params}): ${finalReturnText}`;
}

function singleTypeArgumentText(
  typeNode: ts.TypeNode | undefined,
  expectedName: string,
  sourceFile: ts.SourceFile,
): string | null {
  if (!typeNode || !ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName) || typeNode.typeName.text !== expectedName) {
    return null;
  }
  const [typeArgument] = typeNode.typeArguments ?? [];
  return typeArgument ? typeArgument.getText(sourceFile) : null;
}

function bindingElementHoverCode(
  declaration: ts.BindingElement,
): string | null {
  if (!ts.isIdentifier(declaration.name) || !ts.isObjectBindingPattern(declaration.parent)) {
    return null;
  }

  const typedContainer = declaration.parent.parent;
  if (
    !ts.isParameter(typedContainer) &&
    !ts.isVariableDeclaration(typedContainer)
  ) {
    return null;
  }

  const sourceFile = declaration.getSourceFile();
  const propertyName = declaration.propertyName && ts.isIdentifier(declaration.propertyName)
    ? declaration.propertyName.text
    : declaration.name.text;
  const okType = singleTypeArgumentText(typedContainer.type, 'Ok', sourceFile);
  if (okType && propertyName === 'value') {
    return `${declaration.name.text}: ${okType}`;
  }

  const errType = singleTypeArgumentText(typedContainer.type, 'Err', sourceFile);
  if (errType && (propertyName === 'error' || propertyName === 'err')) {
    return `${declaration.name.text}: ${errType}`;
  }

  return null;
}

function formatSymbolHoverCode(
  checker: ts.TypeChecker,
  node: ts.Node,
): string | null {
  const symbol = resolveSymbolAtNode(checker, node);
  if (!symbol) {
    const type = checker.getTypeAtLocation(node);
    const typeText = checker.typeToString(type, node, ts.TypeFormatFlags.NoTruncation);
    return typeText.length > 0 ? typeText : null;
  }

  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  const name = symbol.getName();
  if (!declaration || !isUserFacingSymbolName(name)) {
    const type = checker.getTypeAtLocation(node);
    const typeText = checker.typeToString(type, node, ts.TypeFormatFlags.NoTruncation);
    return typeText.length > 0 ? typeText : null;
  }

  const displayType = checker.typeToString(
    checker.getTypeAtLocation(node),
    node,
    ts.TypeFormatFlags.NoTruncation,
  );

  if (ts.isVariableDeclaration(declaration)) {
    return `${variableKeywordForDeclaration(declaration)} ${name}: ${displayType}`;
  }
  if (ts.isFunctionDeclaration(declaration)) {
    return formatSignatureHover(checker, node, symbol, `function ${name}`, ts.SignatureKind.Call) ??
      `function ${name}: ${displayType}`;
  }
  if (ts.isMethodSignature(declaration) || ts.isMethodDeclaration(declaration)) {
    const parentName = ts.isInterfaceDeclaration(declaration.parent) && declaration.parent.name
      ? declaration.parent.name.text
      : ts.isClassLike(declaration.parent) && declaration.parent.name
      ? declaration.parent.name.text
      : null;
    const labelPrefix = parentName ? `(method) ${parentName}.${name}` : `(method) ${name}`;
    return formatSignatureHover(checker, node, symbol, labelPrefix, ts.SignatureKind.Call) ??
      `${labelPrefix}: ${displayType}`;
  }
  if (ts.isClassDeclaration(declaration)) {
    return `class ${name}`;
  }
  if (ts.isInterfaceDeclaration(declaration)) {
    return `interface ${name}`;
  }
  if (ts.isTypeAliasDeclaration(declaration)) {
    const declaredType = checker.getDeclaredTypeOfSymbol(symbol);
    return `type ${name} = ${
      checker.typeToString(declaredType, node, ts.TypeFormatFlags.NoTruncation)
    }`;
  }

  return displayType.length > 0 ? displayType : null;
}

function highConfidenceHoverCodeForDeclaration(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
): string | null {
  if (ts.isFunctionDeclaration(declaration)) {
    return liftedFunctionReturnHoverCode(checker, declaration, declaration.getSourceFile());
  }

  if (ts.isBindingElement(declaration)) {
    return bindingElementHoverCode(declaration);
  }

  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) {
    return null;
  }

  if (isCatchClauseVariableDeclaration(declaration)) {
    return `${declaration.name.text}: Error`;
  }

  if (declaration.initializer && isObjectCreateNullExpression(declaration.initializer)) {
    return `${variableKeywordForDeclaration(declaration)} ${declaration.name.text}: BareObject`;
  }

  return null;
}

function importedBindingExportName(
  declaration: ts.Declaration,
): string | null {
  if (ts.isImportSpecifier(declaration)) {
    return (declaration.propertyName ?? declaration.name).text;
  }
  if (ts.isImportClause(declaration) && declaration.name) {
    return 'default';
  }
  if (ts.isNamespaceImport(declaration)) {
    return declaration.name.text;
  }
  return null;
}

function collectTopLevelDeclarationsByName(sourceFile: ts.SourceFile): Map<string, ts.Declaration> {
  const declarations = new Map<string, ts.Declaration>();
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          declarations.set(declaration.name.text, declaration);
        }
      }
      continue;
    }

    if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      declarations.set(statement.name.text, statement);
    }
  }

  return declarations;
}

function exportedDeclarationForName(
  sourceFile: ts.SourceFile,
  exportedName: string,
): ts.Declaration | null {
  const declarationsByName = collectTopLevelDeclarationsByName(sourceFile);

  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === exportedName) {
          return declaration;
        }
      }
      continue;
    }

    if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name &&
      hasExportModifier(statement) &&
      statement.name.text === exportedName
    ) {
      return statement;
    }

    if (
      ts.isExportDeclaration(statement) && !statement.moduleSpecifier &&
      statement.exportClause && ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        if (element.name.text !== exportedName) {
          continue;
        }
        const localName = (element.propertyName ?? element.name).text;
        return declarationsByName.get(localName) ?? null;
      }
    }
  }

  return null;
}

function functionDeclarationHoverCode(
  declaration: ts.FunctionDeclaration,
  sourceFile: ts.SourceFile,
): string | null {
  if (!declaration.name) {
    return null;
  }
  const params = declaration.parameters.map((parameter) => parameter.getText(sourceFile)).join(', ');
  const returnType = declaration.type ? `: ${declaration.type.getText(sourceFile)}` : '';
  return `function ${declaration.name.text}(${params})${returnType}`;
}

function compactInitializerText(text: string, maxLength = 120): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 3).trimEnd()}...`;
}

function declarationHoverCode(
  declaration: ts.Declaration,
  sourceFile: ts.SourceFile,
): string | null {
  if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
    if (declaration.type) {
      return `${variableKeywordForDeclaration(declaration)} ${declaration.name.text}: ${
        declaration.type.getText(sourceFile)
      }`;
    }
    if (declaration.initializer) {
      return `${variableKeywordForDeclaration(declaration)} ${declaration.name.text} = ${
        compactInitializerText(declaration.initializer.getText(sourceFile))
      }`;
    }
    return `${variableKeywordForDeclaration(declaration)} ${declaration.name.text}`;
  }
  if (ts.isFunctionDeclaration(declaration)) {
    return functionDeclarationHoverCode(declaration, sourceFile);
  }
  if (ts.isClassDeclaration(declaration) && declaration.name) {
    return `class ${declaration.name.text}`;
  }
  if (ts.isInterfaceDeclaration(declaration)) {
    return `interface ${declaration.name.text}`;
  }
  if (ts.isTypeAliasDeclaration(declaration)) {
    return `type ${declaration.name.text} = ${declaration.type.getText(sourceFile)}`;
  }
  if (ts.isEnumDeclaration(declaration)) {
    return `enum ${declaration.name.text}`;
  }
  return null;
}

function declarationNameNode(declaration: ts.Declaration): ts.Node | null {
  if (
    (ts.isVariableDeclaration(declaration) || ts.isFunctionDeclaration(declaration) ||
      ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration) ||
      ts.isTypeAliasDeclaration(declaration) || ts.isEnumDeclaration(declaration)) &&
    declaration.name
  ) {
    return declaration.name;
  }

  return null;
}

function declarationRange(
  declaration: ts.Declaration,
  sourceFile: ts.SourceFile,
): BridgeFallbackRange {
  const nameNode = declarationNameNode(declaration);
  const targetNode = nameNode ?? declaration;
  const start = ts.getLineAndCharacterOfPosition(sourceFile, targetNode.getStart(sourceFile));
  const end = ts.getLineAndCharacterOfPosition(sourceFile, targetNode.getEnd());
  return {
    startLine: start.line,
    startCharacter: start.character,
    endLine: end.line,
    endCharacter: end.character,
  };
}

function scanQuotedAnnotationString(text: string, start: number): number {
  const quote = text[start];
  let index = start + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === quote) {
      return index + 1;
    }
    index += 1;
  }
  return text.length;
}

function parseAnnotationHoverItem(
  rawItemText: string,
  absoluteStart: number,
  absoluteEnd: number,
): ParsedAnnotationHoverItem | null {
  const trimmedText = rawItemText.trim();
  if (trimmedText.length === 0) {
    return null;
  }

  const leadingWhitespaceLength = rawItemText.length - rawItemText.trimStart().length;
  const itemStart = absoluteStart + leadingWhitespaceLength;
  const itemEnd = absoluteEnd - (rawItemText.length - rawItemText.trimEnd().length);
  const openParenIndex = trimmedText.indexOf('(');
  if (openParenIndex === -1) {
    return {
      end: itemEnd,
      name: trimmedText,
      nameEnd: itemStart + trimmedText.length,
      nameStart: itemStart,
      start: itemStart,
      text: trimmedText,
    };
  }

  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let closeParenIndex = -1;
  for (let index = openParenIndex; index < trimmedText.length; index += 1) {
    const character = trimmedText[index];
    if (character === '"' || character === "'") {
      index = scanQuotedAnnotationString(trimmedText, index) - 1;
      continue;
    }
    if (character === '(') {
      parenDepth += 1;
      continue;
    }
    if (character === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        closeParenIndex = index;
        break;
      }
      continue;
    }
    if (character === '[') {
      bracketDepth += 1;
      continue;
    }
    if (character === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (character === '{') {
      braceDepth += 1;
      continue;
    }
    if (character === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
  }

  const name = trimmedText.slice(0, openParenIndex).trim();
  const rawNamePrefix = rawItemText.slice(0, rawItemText.indexOf(name));
  const nameStart = absoluteStart + rawNamePrefix.length;
  return {
    argumentsText: closeParenIndex === -1
      ? undefined
      : trimmedText.slice(openParenIndex + 1, closeParenIndex),
    end: itemEnd,
    name,
    nameEnd: nameStart + name.length,
    nameStart,
    start: itemStart,
    text: trimmedText,
  };
}

function findAnnotationHoverItemAtPosition(
  originalText: string,
  sourcePosition: number,
): ParsedAnnotationHoverItem | null {
  const lineStart = originalText.lastIndexOf('\n', Math.max(0, sourcePosition - 1)) + 1;
  const newlineIndex = originalText.indexOf('\n', sourcePosition);
  const lineEnd = newlineIndex === -1 ? originalText.length : newlineIndex;
  const lineText = originalText.slice(lineStart, lineEnd);
  const openMatch = /\/\/\s*#\[/u.exec(lineText);
  if (!openMatch) {
    return null;
  }

  const bodyStart = lineStart + openMatch.index + openMatch[0].length;
  let closingBracketIndex = -1;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  for (let index = bodyStart; index < lineEnd; index += 1) {
    const character = originalText[index];
    if (character === '"' || character === "'") {
      index = scanQuotedAnnotationString(originalText, index) - 1;
      continue;
    }
    if (character === '(') {
      parenDepth += 1;
      continue;
    }
    if (character === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (character === '[') {
      bracketDepth += 1;
      continue;
    }
    if (character === ']') {
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        closingBracketIndex = index;
        break;
      }
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (character === '{') {
      braceDepth += 1;
      continue;
    }
    if (character === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
  }

  if (
    closingBracketIndex === -1 || sourcePosition < bodyStart || sourcePosition > closingBracketIndex
  ) {
    return null;
  }

  let itemStart = bodyStart;
  parenDepth = 0;
  bracketDepth = 0;
  braceDepth = 0;
  for (let index = bodyStart; index <= closingBracketIndex; index += 1) {
    const character = index === closingBracketIndex ? ',' : originalText[index];
    if (index < closingBracketIndex && (character === '"' || character === "'")) {
      index = scanQuotedAnnotationString(originalText, index) - 1;
      continue;
    }
    if (index < closingBracketIndex && character === '(') {
      parenDepth += 1;
      continue;
    }
    if (index < closingBracketIndex && character === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (index < closingBracketIndex && character === '[') {
      bracketDepth += 1;
      continue;
    }
    if (index < closingBracketIndex && character === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (index < closingBracketIndex && character === '{') {
      braceDepth += 1;
      continue;
    }
    if (index < closingBracketIndex && character === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (character === ',' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      if (sourcePosition >= itemStart && sourcePosition <= index) {
        return parseAnnotationHoverItem(originalText.slice(itemStart, index), itemStart, index);
      }
      itemStart = index + 1;
    }
  }

  return null;
}

function builtinAnnotationHoverAt(
  originalText: string,
  position: BridgeFallbackPosition,
): ProjectedImportHoverFallback | null {
  const sourcePosition = offsetAt(originalText, position.line, position.character);
  const annotation = findAnnotationHoverItemAtPosition(originalText, sourcePosition);
  if (!annotation || annotation.name.length === 0) {
    return null;
  }

  const builtin = BUILTIN_ANNOTATION_HOVER_DETAILS[annotation.name];
  const syntax = annotation.argumentsText === undefined
    ? `// #[${annotation.name}]`
    : `// #[${annotation.name}(${annotation.argumentsText})]`;
  const markdown = builtin
    ? [
      `**annotation** \`${annotation.name}\``,
      '',
      codeFence(builtin.syntax),
      '',
      builtin.summary,
      ...builtin.details.flatMap((detail) => ['', detail]),
    ].join('\n')
    : [
      `**annotation** \`${annotation.name}\``,
      '',
      codeFence(syntax),
      '',
      'soundscript parsed this as an annotation comment.',
    ].join('\n');

  const start = positionFromOffset(originalText, annotation.nameStart);
  const end = positionFromOffset(originalText, annotation.nameEnd);
  return {
    markdown,
    range: {
      startLine: start.line,
      startCharacter: start.character,
      endLine: end.line,
      endCharacter: end.character,
    },
  };
}

function implicitPreludeHoverAtIdentifier(
  sourceFile: ts.SourceFile,
  node: ts.Identifier,
): ProjectedImportHoverFallback | null {
  const markdown = IMPLICIT_PRELUDE_HOVER_MARKDOWN_BY_NAME.get(node.text);
  if (!markdown) {
    return null;
  }

  const start = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile));
  const end = ts.getLineAndCharacterOfPosition(sourceFile, node.getEnd());
  return {
    markdown,
    range: {
      startLine: start.line,
      startCharacter: start.character,
      endLine: end.line,
      endCharacter: end.character,
    },
  };
}

function isPreludeFallbackEligibleSymbol(
  checker: ts.TypeChecker,
  node: ts.Identifier,
): boolean {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) {
    return true;
  }
  if (hasImplicitPreludeDeclaration(symbol)) {
    return true;
  }
  if (importBindingDeclarationForSymbol(symbol)) {
    return false;
  }
  return formatSymbolHoverCode(checker, node) === '/*unresolved*/ any';
}

export function implicitPreludeVirtualDocument(): { text: string; uri: string } {
  return {
    uri: IMPLICIT_PRELUDE_VIRTUAL_URI,
    text: IMPLICIT_PRELUDE_VIRTUAL_TEXT,
  };
}

function importedBindingHoverMarkdown(
  importedFilePath: string,
  exportedName: string,
): string | null {
  if (exportedName === 'default') {
    return null;
  }

  const sourceText = readFileSync(importedFilePath, 'utf8');
  const sourceFile = ts.createSourceFile(importedFilePath, sourceText, ts.ScriptTarget.Latest, true);
  const declaration = exportedDeclarationForName(sourceFile, exportedName);
  if (!declaration) {
    return null;
  }

  const code = declarationHoverCode(declaration, sourceFile);
  return code ? `\`\`\`ts\n${code}\n\`\`\`` : null;
}

export function importedTsHoverTargetAt(
  documentPath: string,
  text: string,
  position: BridgeFallbackPosition,
): ImportedTsHoverTarget | null {
  const { program, lookupFilePath } = createSingleFileProgram(documentPath, text);
  const sourceFile = program.getSourceFile(lookupFilePath);
  if (!sourceFile) {
    return null;
  }

  const sourcePosition = ts.getPositionOfLineAndCharacter(sourceFile, position.line, position.character);
  const node = findIdentifierNodeForHover(sourceFile, sourcePosition);
  if (!node) {
    return null;
  }

  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) {
    return null;
  }

  const bindingDeclaration = importBindingDeclarationForSymbol(symbol);
  if (!bindingDeclaration) {
    return null;
  }

  const hoverKind = importBindingHoverKindForDeclaration(bindingDeclaration);
  if (!hoverKind) {
    return null;
  }

  const importDeclaration = importDeclarationForNode(bindingDeclaration);
  if (!importDeclaration || !ts.isStringLiteral(importDeclaration.moduleSpecifier)) {
    return null;
  }
  const importedFilePath = resolveHoverModulePath(importDeclaration.moduleSpecifier.text, documentPath);
  if (!importedFilePath) {
    return null;
  }

  const start = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile));
  const end = ts.getLineAndCharacterOfPosition(sourceFile, node.getEnd());
  const range = {
    startLine: start.line,
    startCharacter: start.character,
    endLine: end.line,
    endCharacter: end.character,
  };

  if (
    hoverKind === 'value' &&
    ts.isImportSpecifier(bindingDeclaration) &&
    collectProjectedUnknownValueExportNames(importedFilePath).has(
      (bindingDeclaration.propertyName ?? bindingDeclaration.name).text,
    )
  ) {
    const exportedName = importedBindingExportName(bindingDeclaration);
    if (!exportedName || exportedName === 'default') {
      return null;
    }
    const sourceText = readFileSync(importedFilePath, 'utf8');
    const importedSourceFile = ts.createSourceFile(
      importedFilePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
    );
    const declaration = exportedDeclarationForName(importedSourceFile, exportedName);
    if (!declaration) {
      return null;
    }
    return {
      projectedUnknown: true,
      importedFilePath,
      importedRange: declarationRange(declaration, importedSourceFile),
      fallback: {
        markdown: `\`\`\`ts\nconst ${node.text}: unknown\n\`\`\``,
        range,
      },
    };
  }

  const exportedName = importedBindingExportName(bindingDeclaration);
  if (!exportedName || exportedName === 'default') {
    return null;
  }

  const sourceText = readFileSync(importedFilePath, 'utf8');
  const importedSourceFile = ts.createSourceFile(
    importedFilePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = exportedDeclarationForName(importedSourceFile, exportedName);
  if (!declaration) {
    return null;
  }

  const code = declarationHoverCode(declaration, importedSourceFile);
  if (!code) {
    return null;
  }

  return {
    projectedUnknown: false,
    importedFilePath,
    importedRange: declarationRange(declaration, importedSourceFile),
    fallback: {
      markdown: `\`\`\`ts\n${code}\n\`\`\``,
      range,
    },
  };
}

export function projectedImportHoverAt(
  documentPath: string,
  text: string,
  position: BridgeFallbackPosition,
): ProjectedImportHoverFallback | null {
  return importedTsHoverTargetAt(documentPath, text, position)?.fallback ?? null;
}

export function fallbackDefinitionAt(
  documentPath: string,
  text: string,
  position: BridgeFallbackPosition,
): readonly BridgeFallbackDefinitionTarget[] | null {
  const importedTarget = importedTsHoverTargetAt(documentPath, text, position);
  if (importedTarget) {
    return [{
      uri: pathToFileURL(importedTarget.importedFilePath).toString(),
      range: importedTarget.importedRange,
    }];
  }

  const { program, lookupFilePath } = createSingleFileProgram(documentPath, text);
  const sourceFile = program.getSourceFile(lookupFilePath);
  if (!sourceFile) {
    return null;
  }

  const sourcePosition = ts.getPositionOfLineAndCharacter(sourceFile, position.line, position.character);
  const node = findIdentifierNodeForHover(sourceFile, sourcePosition);
  if (!node) {
    return null;
  }

  const checker = program.getTypeChecker();
  if (!isPreludeFallbackEligibleSymbol(checker, node)) {
    return null;
  }

  const range = IMPLICIT_PRELUDE_DEFINITION_TARGETS_BY_NAME.get(node.text);
  if (!range) {
    return null;
  }

  return [{
    uri: IMPLICIT_PRELUDE_VIRTUAL_URI,
    range,
  }];
}

export function fallbackCompletionItemsAt(
  documentPath: string,
  text: string,
  position: BridgeFallbackPosition,
): readonly BridgeFallbackCompletionItem[] {
  const { program, lookupFilePath } = createSingleFileProgram(documentPath, text);
  const sourceFile = program.getSourceFile(lookupFilePath);
  if (!sourceFile) {
    return [];
  }

  const offset = sourceFile.getPositionOfLineAndCharacter(position.line, position.character);
  const precedingCharacter = offset > 0 ? text[offset - 1] : undefined;
  if (precedingCharacter === '.') {
    return [];
  }

  const prefix = identifierPrefixAt(text, offset);
  const node = findIdentifierNodeForHover(sourceFile, offset);
  if (node && !isPreludeFallbackEligibleSymbol(program.getTypeChecker(), node)) {
    return [];
  }

  return [...IMPLICIT_PRELUDE_SIGNATURES_BY_NAME.entries()]
    .filter(([name]) => prefix.length === 0 || name.startsWith(prefix))
    .map(([name, entry]) => ({
      label: name,
      insertText: name,
      kind: entry.kind,
      detail: entry.detail,
      documentation: IMPLICIT_PRELUDE_HOVER_MARKDOWN_BY_NAME.get(name),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function fallbackHoverAt(
  documentPath: string,
  text: string,
  position: BridgeFallbackPosition,
): ProjectedImportHoverFallback | null {
  const annotationHover = builtinAnnotationHoverAt(text, position);
  if (annotationHover) {
    return annotationHover;
  }

  const projectedImportHover = projectedImportHoverAt(documentPath, text, position);
  if (projectedImportHover) {
    return projectedImportHover;
  }

  const { program, lookupFilePath } = createSingleFileProgram(documentPath, text);
  const sourceFile = program.getSourceFile(lookupFilePath);
  if (!sourceFile) {
    return null;
  }

  const sourcePosition = ts.getPositionOfLineAndCharacter(sourceFile, position.line, position.character);
  const node = findIdentifierNodeForHover(sourceFile, sourcePosition);
  if (!node) {
    return null;
  }

  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(node);
  const implicitPreludeHover = implicitPreludeHoverAtIdentifier(sourceFile, node);
  if (!symbol) {
    return implicitPreludeHover;
  }
  if (hasImplicitPreludeDeclaration(symbol) && implicitPreludeHover) {
    return implicitPreludeHover;
  }
  if (importBindingDeclarationForSymbol(symbol)) {
    return null;
  }

  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  const code = (declaration ? highConfidenceHoverCodeForDeclaration(checker, declaration) : null) ??
    formatSymbolHoverCode(checker, node);
  if (!code) {
    return null;
  }
  if (code === '/*unresolved*/ any') {
    return implicitPreludeHoverAtIdentifier(sourceFile, node);
  }
  const markdown = `\`\`\`ts\n${code}\n\`\`\``;

  const start = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile));
  const end = ts.getLineAndCharacterOfPosition(sourceFile, node.getEnd());
  return {
    markdown,
    range: {
      startLine: start.line,
      startCharacter: start.character,
      endLine: end.line,
      endCharacter: end.character,
    },
  };
}
