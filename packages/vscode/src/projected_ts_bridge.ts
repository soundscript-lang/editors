import * as path from 'node:path';

import ts from 'typescript';
import * as vscode from 'vscode';

import {
  isNavigationTreeRoot,
  isSyntheticNavigationTreeItem,
} from './document_symbol_tree';
import { recoverProjectedIdentifierOffset } from './definition_position_recovery';
import type { ResolvedCliLaunch } from './server_resolution';
import { mapNavigationTreeItemToSourceRanges } from './document_symbol_mapping';
import {
  findNearestSoundscriptProject,
  runEditorProjectSnapshot,
  type EditorProjectSnapshot,
} from './editor_process_support';
import {
  mapProjectedEnclosingRangeToSource,
  mapSourcePositionToProjected,
} from './projection_mapping';
import {
  fallbackCompletionItemsAt,
  fallbackDefinitionAt,
  fallbackHoverAt,
  type BridgeFallbackPosition,
  type BridgeFallbackRange,
} from './soundscript_bridge_fallback';
import { createSoundscriptLibOverrides } from './soundscript_stdlib_overrides';
import { renderQuickInfoSections } from './tsserver_bridge_support';

const STDLIB_SCHEME = 'soundscript-stdlib';

function isSoundscriptDocument(document: vscode.TextDocument): boolean {
  return document.languageId === 'soundscript' && document.uri.scheme === 'file';
}

function documentOffsetAt(text: string, line: number, character: number): number {
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

function sourceOffsetAt(text: string, position: vscode.Position): number {
  return documentOffsetAt(text, position.line, position.character);
}

function positionAt(text: string, offset: number): vscode.Position {
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
  return new vscode.Position(line, character);
}

function toProjectedPosition(
  snapshot: EditorProjectSnapshot,
  position: vscode.Position,
): vscode.Position {
  const sourceOffset = sourceOffsetAt(snapshot.originalText, position);
  const mapped = mapSourcePositionToProjected(snapshot, sourceOffset);
  return positionAt(snapshot.projectedText, mapped.position);
}

function toProjectedOffset(
  snapshot: EditorProjectSnapshot,
  position: vscode.Position,
): number {
  return sourceOffsetAt(snapshot.projectedText, toProjectedPosition(snapshot, position));
}

function toProjectedDefinitionOffset(
  snapshot: EditorProjectSnapshot,
  position: vscode.Position,
): number {
  const sourceOffset = sourceOffsetAt(snapshot.originalText, position);
  const projected = mapSourcePositionToProjected(snapshot, sourceOffset);
  if (!projected.insideReplacement) {
    return projected.position;
  }

  return recoverProjectedIdentifierOffset(
    snapshot,
    sourceOffset,
    projected.position,
  ) ?? projected.position;
}

function rangeFromOffsets(
  originalText: string,
  mapped: { start: number; end: number },
): vscode.Range {
  return new vscode.Range(
    positionAt(originalText, mapped.start),
    positionAt(originalText, mapped.end),
  );
}

function remapRange(
  snapshot: Pick<
    EditorProjectSnapshot,
    'originalText' | 'postRewriteStage' | 'projectedText' | 'rewriteStage'
  >,
  start: number,
  end: number,
): vscode.Range {
  return rangeFromOffsets(
    snapshot.originalText,
    mapProjectedEnclosingRangeToSource(snapshot, start, end),
  );
}

function toStdlibUri(specifier: string): vscode.Uri {
  const leafName = specifier.slice('sts:'.length).split(':').join('/');
  return vscode.Uri.from({
    scheme: STDLIB_SCHEME,
    path: `/${leafName}.d.ts`,
  });
}

function isStdlibVirtualModule(
  module: EditorProjectSnapshot['virtualModules'][number],
): boolean {
  return module.specifier.startsWith('sts:');
}

function toVirtualModuleProjection(
  module: EditorProjectSnapshot['virtualModules'][number],
): Pick<
  EditorProjectSnapshot,
  'originalText' | 'postRewriteStage' | 'projectedText' | 'rewriteStage'
> | undefined {
  if (
    typeof module.originalText !== 'string' ||
    module.rewriteStage === undefined
  ) {
    return undefined;
  }

  return {
    originalText: module.originalText,
    postRewriteStage: module.postRewriteStage,
    projectedText: module.text,
    rewriteStage: module.rewriteStage,
  };
}

function toVscodeRangeFromFallback(range: BridgeFallbackRange): vscode.Range {
  return new vscode.Range(
    range.startLine,
    range.startCharacter,
    range.endLine,
    range.endCharacter,
  );
}

function toFallbackPosition(position: vscode.Position): BridgeFallbackPosition {
  return {
    line: position.line,
    character: position.character,
  };
}

function completionKindFromTs(kind: string): vscode.CompletionItemKind {
  switch (kind) {
    case ts.ScriptElementKind.classElement:
      return vscode.CompletionItemKind.Class;
    case ts.ScriptElementKind.interfaceElement:
      return vscode.CompletionItemKind.Interface;
    case ts.ScriptElementKind.enumElement:
      return vscode.CompletionItemKind.Enum;
    case ts.ScriptElementKind.enumMemberElement:
      return vscode.CompletionItemKind.EnumMember;
    case ts.ScriptElementKind.functionElement:
    case ts.ScriptElementKind.memberFunctionElement:
    case ts.ScriptElementKind.constructSignatureElement:
      return vscode.CompletionItemKind.Function;
    case ts.ScriptElementKind.memberVariableElement:
    case ts.ScriptElementKind.variableElement:
    case ts.ScriptElementKind.localVariableElement:
      return vscode.CompletionItemKind.Variable;
    case ts.ScriptElementKind.constElement:
      return vscode.CompletionItemKind.Constant;
    case ts.ScriptElementKind.typeElement:
    case ts.ScriptElementKind.typeParameterElement:
      return vscode.CompletionItemKind.TypeParameter;
    case ts.ScriptElementKind.moduleElement:
      return vscode.CompletionItemKind.Module;
    case ts.ScriptElementKind.directory:
      return vscode.CompletionItemKind.Folder;
    case ts.ScriptElementKind.string:
      return vscode.CompletionItemKind.Value;
    case ts.ScriptElementKind.warning:
      return vscode.CompletionItemKind.Text;
    case ts.ScriptElementKind.keyword:
      return vscode.CompletionItemKind.Keyword;
    case ts.ScriptElementKind.scriptElement:
      return vscode.CompletionItemKind.File;
    default:
      return vscode.CompletionItemKind.Text;
  }
}

function symbolKindFromTs(kind: string): vscode.SymbolKind {
  switch (kind) {
    case ts.ScriptElementKind.moduleElement:
      return vscode.SymbolKind.Module;
    case ts.ScriptElementKind.classElement:
      return vscode.SymbolKind.Class;
    case ts.ScriptElementKind.interfaceElement:
      return vscode.SymbolKind.Interface;
    case ts.ScriptElementKind.typeElement:
      return vscode.SymbolKind.Struct;
    case ts.ScriptElementKind.enumElement:
      return vscode.SymbolKind.Enum;
    case ts.ScriptElementKind.enumMemberElement:
      return vscode.SymbolKind.EnumMember;
    case ts.ScriptElementKind.functionElement:
    case ts.ScriptElementKind.localFunctionElement:
      return vscode.SymbolKind.Function;
    case ts.ScriptElementKind.memberFunctionElement:
      return vscode.SymbolKind.Method;
    case ts.ScriptElementKind.constructorImplementationElement:
    case ts.ScriptElementKind.constructSignatureElement:
      return vscode.SymbolKind.Constructor;
    case ts.ScriptElementKind.variableElement:
    case ts.ScriptElementKind.localVariableElement:
      return vscode.SymbolKind.Variable;
    case ts.ScriptElementKind.constElement:
      return vscode.SymbolKind.Constant;
    case ts.ScriptElementKind.memberVariableElement:
    case ts.ScriptElementKind.memberGetAccessorElement:
    case ts.ScriptElementKind.memberSetAccessorElement:
      return vscode.SymbolKind.Property;
    case ts.ScriptElementKind.typeParameterElement:
      return vscode.SymbolKind.TypeParameter;
    case ts.ScriptElementKind.parameterElement:
      return vscode.SymbolKind.Variable;
    case ts.ScriptElementKind.alias:
      return vscode.SymbolKind.Variable;
    default:
      return vscode.SymbolKind.Object;
  }
}

function findDeepestNodeContainingPosition(root: ts.Node, position: number): ts.Node | null {
  if (position < root.getFullStart() || position >= root.getEnd()) {
    return null;
  }

  const child = root.forEachChild((candidate) => findDeepestNodeContainingPosition(candidate, position));
  return child ?? root;
}

function hasImportAncestor(node: ts.Node | null): boolean {
  let current = node;
  while (current && !ts.isSourceFile(current)) {
    if (
      ts.isImportDeclaration(current) ||
      ts.isImportClause(current) ||
      ts.isImportSpecifier(current) ||
      ts.isNamespaceImport(current) ||
      ts.isNamedImports(current)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isEmptyRange(range: vscode.Range): boolean {
  return range.start.line === range.end.line && range.start.character === range.end.character;
}

function shouldIncludeDocumentSymbol(
  snapshot: EditorProjectSnapshot,
  sourceFile: ts.SourceFile,
  selectionRange: vscode.Range,
  bodyRange: vscode.Range,
): boolean {
  if (isEmptyRange(selectionRange) || isEmptyRange(bodyRange)) {
    return false;
  }

  const selectionOffset = sourceOffsetAt(snapshot.originalText, selectionRange.start);
  const probeOffset = Math.min(
    snapshot.originalText.length,
    Math.max(0, selectionOffset),
  );
  const node = findDeepestNodeContainingPosition(
    sourceFile,
    probeOffset >= sourceFile.getEnd() ? Math.max(0, probeOffset - 1) : probeOffset,
  );
  return !hasImportAncestor(node);
}

function toDocumentSymbols(
  snapshot: EditorProjectSnapshot,
  tree: ts.NavigationTree,
): vscode.DocumentSymbol[] {
  const symbols: vscode.DocumentSymbol[] = [];
  const originalSourceFile = ts.createSourceFile(
    snapshot.filePath,
    snapshot.originalText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const visit = (item: ts.NavigationTree): vscode.DocumentSymbol | null => {
    const children = (item.childItems ?? [])
      .map((child) => visit(child))
      .filter((child): child is vscode.DocumentSymbol => child !== null);

    if (isNavigationTreeRoot(item, snapshot.projectedText.length)) {
      symbols.push(...children);
      return null;
    }

    if (isSyntheticNavigationTreeItem(item)) {
      symbols.push(...children);
      return null;
    }

    const mappedRanges = mapNavigationTreeItemToSourceRanges(
      snapshot,
      originalSourceFile,
      item,
    );
    if (!mappedRanges) {
      symbols.push(...children);
      return null;
    }

    const selectionRange = rangeFromOffsets(snapshot.originalText, mappedRanges.selectionRange);
    const bodyRange = rangeFromOffsets(snapshot.originalText, mappedRanges.range);
    const symbolRange = children.length === 0 ? selectionRange : bodyRange;
    const symbol = new vscode.DocumentSymbol(
      item.text,
      '',
      symbolKindFromTs(item.kind),
      symbolRange,
      selectionRange,
    );
    if (!shouldIncludeDocumentSymbol(snapshot, originalSourceFile, selectionRange, symbol.range)) {
      return null;
    }
    symbol.children = children;
    return symbol;
  };

  const rootSymbol = visit(tree);
  if (rootSymbol) {
    symbols.push(rootSymbol);
  }
  return symbols;
}

function getOpenFileOverrides(): ReadonlyMap<string, string> {
  const overrides = new Map<string, string>();
  for (const document of vscode.workspace.textDocuments) {
    if (document.uri.scheme !== 'file') {
      continue;
    }
    overrides.set(document.uri.fsPath, document.getText());
  }
  return overrides;
}

function createModuleResolutionHost(
  virtualFiles: ReadonlyMap<string, string>,
  openFileOverrides: ReadonlyMap<string, string>,
  currentDirectory: string,
  libOverrides: {
    fileExists(fileName: string): boolean;
    readFile(fileName: string): string | undefined;
  },
): ts.ModuleResolutionHost & {
  directoryExists(directoryPath: string): boolean;
  getDirectories(directoryPath: string): readonly string[];
  readFile(fileName: string): string | undefined;
  useCaseSensitiveFileNames: boolean;
} {
  const normalizedVirtualFiles = new Map(
    [...virtualFiles.entries()].map(([fileName, text]) => [path.normalize(fileName), text]),
  );
  const normalizedOpenFileOverrides = new Map(
    [...openFileOverrides.entries()].map(([fileName, text]) => [path.normalize(fileName), text]),
  );
  const sys = ts.sys;
  return {
    directoryExists(directoryPath) {
      return sys.directoryExists?.(directoryPath) ?? false;
    },
    fileExists(fileName) {
      const normalized = path.normalize(fileName);
      return normalizedVirtualFiles.has(normalized) ||
        normalizedOpenFileOverrides.has(normalized) ||
        libOverrides.fileExists(normalized) ||
        sys.fileExists(normalized);
    },
    getDirectories(directoryPath) {
      return sys.getDirectories?.(directoryPath) ?? [];
    },
    readFile(fileName) {
      const normalized = path.normalize(fileName);
      if (normalizedVirtualFiles.has(normalized)) {
        return normalizedVirtualFiles.get(normalized);
      }
      if (normalizedOpenFileOverrides.has(normalized)) {
        return normalizedOpenFileOverrides.get(normalized);
      }
      const overriddenLibText = libOverrides.readFile(normalized);
      if (overriddenLibText !== undefined) {
        return overriddenLibText;
      }
      return sys.readFile(normalized);
    },
    realpath(fileName) {
      return sys.realpath?.(fileName) ?? fileName;
    },
    useCaseSensitiveFileNames: sys.useCaseSensitiveFileNames,
  };
}

function getExtensionForModuleFileName(fileName: string): ts.Extension {
  if (fileName.endsWith('.d.ts')) {
    return ts.Extension.Dts;
  }
  if (fileName.endsWith('.tsx')) {
    return ts.Extension.Tsx;
  }
  if (fileName.endsWith('.jsx')) {
    return ts.Extension.Jsx;
  }
  if (fileName.endsWith('.js')) {
    return ts.Extension.Js;
  }
  return ts.Extension.Ts;
}

function loadCompilerOptions(projectPath: string): ts.CompilerOptions {
  const configFile = ts.readConfigFile(projectPath, ts.sys.readFile);
  if (configFile.error) {
    return {
      allowArbitraryExtensions: true,
      allowJs: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2020,
    };
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(projectPath),
    undefined,
    projectPath,
  );
  return {
    ...parsed.options,
    allowArbitraryExtensions: true,
    allowJs: true,
  };
}

interface ProjectedLanguageServiceState {
  libOverrides: ReturnType<typeof createSoundscriptLibOverrides>;
  lookupFileName: string;
  service: ts.LanguageService;
  snapshot: EditorProjectSnapshot;
  virtualModulesByFileName: ReadonlyMap<string, EditorProjectSnapshot['virtualModules'][number]>;
  virtualModulesBySourceFileName: ReadonlyMap<string, EditorProjectSnapshot['virtualModules'][number]>;
}

function createProjectedLanguageServiceState(
  snapshot: EditorProjectSnapshot,
  scriptVersion: string,
  stsScriptKind: 'ts' | 'tsx',
): ProjectedLanguageServiceState {
  const lookupFileName = `${snapshot.filePath}.${stsScriptKind === 'tsx' ? 'tsx' : 'ts'}`;
  const openFileOverrides = getOpenFileOverrides();
  const virtualFiles = new Map<string, string>(
    snapshot.virtualModules.map((module) => [module.fileName, module.text]),
  );
  virtualFiles.set(lookupFileName, snapshot.projectedText);
  const virtualModulesBySpecifier = new Map(
    snapshot.virtualModules.map((module) => [module.specifier, module]),
  );
  const virtualModulesByFileName = new Map(
    snapshot.virtualModules.map((module) => [path.normalize(module.fileName), module]),
  );
  const virtualModulesBySourceFileName = new Map(
    snapshot.virtualModules.flatMap((module) =>
      typeof module.sourceFileName === 'string'
        ? [[path.normalize(module.sourceFileName), module] as const]
        : []
    ),
  );
  const compilerOptions = loadCompilerOptions(snapshot.projectPath);
  const currentDirectory = path.dirname(snapshot.projectPath);
  const libOverrides = createSoundscriptLibOverrides(compilerOptions, snapshot.filePath);
  const moduleResolutionHost = createModuleResolutionHost(
    virtualFiles,
    openFileOverrides,
    currentDirectory,
    libOverrides,
  );

  const host: ts.LanguageServiceHost = {
    directoryExists: moduleResolutionHost.directoryExists,
    fileExists: moduleResolutionHost.fileExists,
    getCompilationSettings: () => compilerOptions,
    getCurrentDirectory: () => currentDirectory,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    getDirectories: moduleResolutionHost.getDirectories,
    getScriptFileNames: () => [lookupFileName, ...snapshot.virtualModules.map((module) => module.fileName)],
    getScriptKind: (fileName) => {
      if (fileName === lookupFileName) {
        return stsScriptKind === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      }
      return ts.ScriptKind.Unknown;
    },
    getScriptSnapshot: (fileName) => {
      const normalized = path.normalize(fileName);
      const virtualFile = virtualFiles.get(normalized) ?? virtualFiles.get(fileName);
      if (virtualFile !== undefined) {
        return ts.ScriptSnapshot.fromString(virtualFile);
      }
      const override = openFileOverrides.get(normalized) ?? openFileOverrides.get(fileName);
      if (override !== undefined) {
        return ts.ScriptSnapshot.fromString(override);
      }
      const overriddenLibText = libOverrides.readFile(fileName);
      if (overriddenLibText !== undefined) {
        return ts.ScriptSnapshot.fromString(overriddenLibText);
      }
      const text = ts.sys.readFile(fileName);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getScriptVersion: (fileName) => {
      if (fileName === lookupFileName) {
        return scriptVersion;
      }
      if (virtualModulesByFileName.has(path.normalize(fileName))) {
        return '1';
      }
      return '0';
    },
    readDirectory: ts.sys.readDirectory,
    readFile: moduleResolutionHost.readFile,
    resolveModuleNames: (moduleNames, containingFile) => moduleNames.map((moduleName) => {
      const virtualModule = virtualModulesBySpecifier.get(moduleName);
      if (virtualModule) {
        return {
          extension: getExtensionForModuleFileName(virtualModule.fileName),
          isExternalLibraryImport: isStdlibVirtualModule(virtualModule),
          resolvedFileName: virtualModule.fileName,
        };
      }
      const resolvedModule = ts.resolveModuleName(
        moduleName,
        containingFile,
        compilerOptions,
        moduleResolutionHost,
      ).resolvedModule;
      if (!resolvedModule) {
        return resolvedModule;
      }

      const remappedModule = virtualModulesBySourceFileName.get(
        path.normalize(resolvedModule.resolvedFileName),
      ) ?? virtualModulesByFileName.get(path.normalize(resolvedModule.resolvedFileName));
      if (!remappedModule) {
        return resolvedModule;
      }

      return {
        ...resolvedModule,
        extension: getExtensionForModuleFileName(remappedModule.fileName),
        isExternalLibraryImport: isStdlibVirtualModule(remappedModule) ||
          resolvedModule.isExternalLibraryImport,
        resolvedFileName: remappedModule.fileName,
      };
    }),
    useCaseSensitiveFileNames: () => moduleResolutionHost.useCaseSensitiveFileNames,
  };

  return {
    libOverrides,
    lookupFileName,
    service: ts.createLanguageService(host),
    snapshot,
    virtualModulesByFileName,
    virtualModulesBySourceFileName,
  };
}

function formatQuickInfo(info: ts.QuickInfo): vscode.MarkdownString {
  const sections = renderQuickInfoSections({
    displayString: ts.displayPartsToString(info.displayParts),
    documentation: info.documentation?.map((part) => ({ text: part.text })) ?? [],
    tags: (info.tags ?? []).map((tag) => ({
      name: tag.name,
      text: tag.text?.map((part) => ({ text: part.text })) ?? [],
    })),
  });
  const markdown = new vscode.MarkdownString(undefined, true);
  if (sections.signature.length > 0) {
    markdown.appendCodeblock(sections.signature, 'typescript');
  }
  if (sections.documentation.length > 0) {
    if (sections.signature.length > 0) {
      markdown.appendMarkdown('\n\n');
    }
    markdown.appendMarkdown(sections.documentation);
  }
  if (sections.tags.length > 0) {
    markdown.appendMarkdown(`\n\n${sections.tags.join('\n\n')}`);
  }
  markdown.isTrusted = true;
  return markdown;
}

function unwrapMarkdownCodeFence(markdown: string): string {
  const trimmed = markdown.trim();
  const match = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

function identifierAtPosition(text: string, position: vscode.Position): string | null {
  const lineText = text.split('\n')[position.line] ?? '';
  if (position.character > lineText.length) {
    return null;
  }

  let start = position.character;
  let end = position.character;
  while (start > 0 && /[\w$]/.test(lineText[start - 1] ?? '')) {
    start -= 1;
  }
  while (end < lineText.length && /[\w$]/.test(lineText[end] ?? '')) {
    end += 1;
  }

  const identifier = lineText.slice(start, end);
  return identifier.length > 0 ? identifier : null;
}

function identifierPrefixAtPosition(text: string, position: vscode.Position): string {
  const lineText = text.split('\n')[position.line] ?? '';
  const clampedCharacter = Math.min(position.character, lineText.length);
  let start = clampedCharacter;
  while (start > 0 && /[\w$]/.test(lineText[start - 1] ?? '')) {
    start -= 1;
  }
  return lineText.slice(start, clampedCharacter);
}

function matchesCompletionPrefix(name: string, prefix: string): boolean {
  if (prefix.length === 0) {
    return true;
  }
  if (/[A-Z]/.test(prefix)) {
    return name.startsWith(prefix);
  }
  return name.toLowerCase().startsWith(prefix.toLowerCase());
}

function resolveCompletionEntryDeclarations(
  state: ProjectedLanguageServiceState,
  position: vscode.Position,
  entry: ts.CompletionEntry,
): readonly ts.Declaration[] {
  const program = state.service.getProgram();
  if (!program) {
    return [];
  }

  const sourceFile = program.getSourceFile(state.lookupFileName);
  if (!sourceFile) {
    return [];
  }

  const projectedOffset = toProjectedOffset(state.snapshot, position);
  const probeOffset = projectedOffset >= sourceFile.getEnd()
    ? Math.max(0, projectedOffset - 1)
    : projectedOffset;
  const location = findDeepestNodeContainingPosition(sourceFile, probeOffset) ?? sourceFile;
  const checker = program.getTypeChecker();
  const resolved = checker.resolveName(
    entry.name,
    location,
    ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Namespace,
    false,
  );
  if (!resolved) {
    return [];
  }
  const symbol = resolved.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(resolved)
    : resolved;
  return symbol.declarations ?? [];
}

function shouldIncludeTsCompletionEntry(
  state: ProjectedLanguageServiceState,
  position: vscode.Position,
  entry: ts.CompletionEntry,
  fallbackLabels: ReadonlySet<string>,
): boolean {
  if (fallbackLabels.size === 0 || fallbackLabels.has(entry.name)) {
    return true;
  }

  if (entry.source) {
    return true;
  }

  const program = state.service.getProgram();
  if (!program) {
    return true;
  }

  const declarations = resolveCompletionEntryDeclarations(state, position, entry);
  if (declarations.length === 0) {
    return false;
  }

  const projectDirectory = path.normalize(path.dirname(state.snapshot.projectPath));
  const nodeModulesSegment = `${path.sep}node_modules${path.sep}`;
  const normalizedLookupFileName = path.normalize(state.lookupFileName);
  return declarations.some((declaration) => {
    const sourceFile = declaration.getSourceFile();
    const normalizedFileName = path.normalize(sourceFile.fileName);
    if (normalizedFileName === normalizedLookupFileName) {
      return true;
    }
    if (state.virtualModulesByFileName.has(normalizedFileName)) {
      return true;
    }
    if (program.isSourceFileDefaultLibrary(sourceFile)) {
      return false;
    }
    if (normalizedFileName.includes(nodeModulesSegment)) {
      return false;
    }
    return normalizedFileName === projectDirectory ||
      normalizedFileName.startsWith(`${projectDirectory}${path.sep}`);
  });
}

function isWeakQuickInfo(
  sourceText: string,
  position: vscode.Position,
  info: ts.QuickInfo,
  fallbackMarkdown: string | null,
): boolean {
  const signature = ts.displayPartsToString(info.displayParts).trim();
  if (signature.length === 0) {
    return true;
  }
  if (signature.startsWith('import ')) {
    return true;
  }
  if (/(\W|^)(any|never)(\W|$)/.test(signature)) {
    return true;
  }

  const identifier = identifierAtPosition(sourceText, position);
  if (identifier && !signature.includes(identifier)) {
    return true;
  }

  if (fallbackMarkdown) {
    if (
      fallbackMarkdown.includes('**annotation**') ||
      fallbackMarkdown.includes('**macro**') ||
      fallbackMarkdown.includes('**macro helper**')
    ) {
      return true;
    }
    const fallbackCode = unwrapMarkdownCodeFence(fallbackMarkdown);
    if (
      fallbackCode.includes('Result<') &&
      !signature.includes('Result<')
    ) {
      return true;
    }
    if (
      fallbackCode.includes(': boolean') &&
      !signature.includes(': boolean')
    ) {
      return true;
    }
  }

  return false;
}

function toVscodeRangeFromTextSpan(
  text: string,
  textSpan: ts.TextSpan,
): vscode.Range {
  return new vscode.Range(
    positionAt(text, textSpan.start),
    positionAt(text, textSpan.start + textSpan.length),
  );
}

function toSignatureHelp(
  items: ts.SignatureHelpItems,
): vscode.SignatureHelp {
  const result = new vscode.SignatureHelp();
  result.activeParameter = items.argumentIndex;
  result.activeSignature = items.selectedItemIndex;
  result.signatures = items.items.map((item) => {
    const signature = new vscode.SignatureInformation(
      ts.displayPartsToString(item.prefixDisplayParts) +
        item.parameters.map((parameter, index) =>
          ts.displayPartsToString(parameter.displayParts) +
          (index < item.parameters.length - 1
            ? ts.displayPartsToString(item.separatorDisplayParts)
            : '')
        ).join('') +
        ts.displayPartsToString(item.suffixDisplayParts),
      ts.displayPartsToString(item.documentation),
    );
    signature.parameters = item.parameters.map((parameter) =>
      new vscode.ParameterInformation(
        ts.displayPartsToString(parameter.displayParts),
        ts.displayPartsToString(parameter.documentation),
      )
    );
    return signature;
  });
  return result;
}

function readStsScriptKind(): 'ts' | 'tsx' {
  const value = vscode.workspace.getConfiguration('soundscript').get<string>('tsserver.stsScriptKind');
  return value === 'tsx' ? 'tsx' : 'ts';
}

export interface ProjectedTsBridgeController extends vscode.Disposable {
  dumpDebugInfo(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<unknown>;
  refreshAll(): void;
}

export function activateProjectedTsBridge(
  outputChannel: vscode.OutputChannel,
  cliLaunch?: ResolvedCliLaunch,
): ProjectedTsBridgeController {
  const statesByDocumentVersion = new Map<string, { key: string; state: ProjectedLanguageServiceState }>();
  const stdlibDocumentsByUri = new Map<string, string>();

  async function getState(
    document: vscode.TextDocument,
  ): Promise<ProjectedLanguageServiceState | undefined> {
    if (!cliLaunch || !isSoundscriptDocument(document)) {
      return undefined;
    }

    const projectPath = findNearestSoundscriptProject(document.uri.fsPath);
    if (!projectPath) {
      return undefined;
    }

    const cacheKey = `${document.uri.toString()}:${document.version}:${projectPath}:${readStsScriptKind()}`;
    const cached = statesByDocumentVersion.get(document.uri.toString());
    if (cached?.key === cacheKey) {
      return cached.state;
    }

    const snapshot = runEditorProjectSnapshot(
      cliLaunch,
      projectPath,
      document.uri.fsPath,
      document.getText(),
    );
    for (const module of snapshot.virtualModules) {
      if (!isStdlibVirtualModule(module)) {
        continue;
      }
      stdlibDocumentsByUri.set(toStdlibUri(module.specifier).toString(), module.text);
    }

    const state = createProjectedLanguageServiceState(
      snapshot,
      String(document.version),
      readStsScriptKind(),
    );
    statesByDocumentVersion.set(document.uri.toString(), { key: cacheKey, state });
    return state;
  }

  const stdlibContentProvider = vscode.workspace.registerTextDocumentContentProvider(
    STDLIB_SCHEME,
    {
      provideTextDocumentContent(uri): string {
        return stdlibDocumentsByUri.get(uri.toString()) ?? '';
      },
    },
  );

  const hoverProvider = vscode.languages.registerHoverProvider(
    { language: 'soundscript', scheme: 'file' },
    {
      async provideHover(document, position): Promise<vscode.Hover | undefined> {
        const state = await getState(document);
        if (!state) {
          return undefined;
        }

        const fallbackHover = fallbackHoverAt(
          document.uri.fsPath,
          document.getText(),
          toFallbackPosition(position),
        );
        const quickInfo = state.service.getQuickInfoAtPosition(
          state.lookupFileName,
          toProjectedOffset(state.snapshot, position),
        );
        if (!quickInfo) {
          return fallbackHover
            ? new vscode.Hover(
              new vscode.MarkdownString(fallbackHover.markdown, true),
              toVscodeRangeFromFallback(fallbackHover.range),
            )
            : undefined;
        }

        if (
          fallbackHover &&
          isWeakQuickInfo(state.snapshot.originalText, position, quickInfo, fallbackHover.markdown)
        ) {
          return new vscode.Hover(
            new vscode.MarkdownString(fallbackHover.markdown, true),
            toVscodeRangeFromFallback(fallbackHover.range),
          );
        }

        return new vscode.Hover(
          formatQuickInfo(quickInfo),
          remapRange(
            state.snapshot,
            quickInfo.textSpan.start,
            quickInfo.textSpan.start + quickInfo.textSpan.length,
          ),
        );
      },
    },
  );

  const definitionProvider = vscode.languages.registerDefinitionProvider(
    { language: 'soundscript', scheme: 'file' },
    {
      async provideDefinition(document, position): Promise<vscode.Definition | undefined> {
        const fallbackDefinitions = fallbackDefinitionAt(
          document.uri.fsPath,
          document.getText(),
          toFallbackPosition(position),
        );
        if (fallbackDefinitions && fallbackDefinitions.length > 0) {
          return fallbackDefinitions.map((definition) =>
            new vscode.Location(
              vscode.Uri.parse(definition.uri),
              toVscodeRangeFromFallback(definition.range),
            )
          );
        }

        const state = await getState(document);
        if (!state) {
          return undefined;
        }

        const definitions = state.service.getDefinitionAtPosition(
          state.lookupFileName,
          toProjectedDefinitionOffset(state.snapshot, position),
        );
        if (!definitions || definitions.length === 0) {
          return undefined;
        }

        return definitions.map((definition) => {
          const normalizedFileName = path.normalize(definition.fileName);
          const virtualModule = state.virtualModulesByFileName.get(normalizedFileName);
          if (virtualModule && isStdlibVirtualModule(virtualModule)) {
            return new vscode.Location(
              toStdlibUri(virtualModule.specifier),
              toVscodeRangeFromTextSpan(virtualModule.text, definition.textSpan),
            );
          }
          if (virtualModule) {
            const virtualProjection = toVirtualModuleProjection(virtualModule);
            if (virtualProjection && typeof virtualModule.sourceFileName === 'string') {
              return new vscode.Location(
                vscode.Uri.file(virtualModule.sourceFileName),
                remapRange(
                  virtualProjection,
                  definition.textSpan.start,
                  definition.textSpan.start + definition.textSpan.length,
                ),
              );
            }

            return new vscode.Location(
              vscode.Uri.file(virtualModule.sourceFileName ?? definition.fileName),
              toVscodeRangeFromTextSpan(virtualModule.text, definition.textSpan),
            );
          }
          if (normalizedFileName === path.normalize(state.lookupFileName)) {
            return new vscode.Location(
              document.uri,
              remapRange(
                state.snapshot,
                definition.textSpan.start,
                definition.textSpan.start + definition.textSpan.length,
              ),
            );
          }
          const targetUri = vscode.Uri.file(definition.fileName);
          const remappedLibFileName = state.libOverrides.resolveFile(definition.fileName);
          const targetFileName = remappedLibFileName ?? definition.fileName;
          const targetText = getOpenFileOverrides().get(targetFileName) ??
            getOpenFileOverrides().get(path.normalize(targetFileName)) ??
            state.libOverrides.readFile(definition.fileName) ??
            ts.sys.readFile(targetFileName) ??
            '';
          return new vscode.Location(
            vscode.Uri.file(targetFileName),
            toVscodeRangeFromTextSpan(targetText, definition.textSpan),
          );
        });
      },
    },
  );

  const completionProvider = vscode.languages.registerCompletionItemProvider(
    { language: 'soundscript', scheme: 'file' },
    {
      async provideCompletionItems(document, position): Promise<vscode.CompletionList | undefined> {
        const state = await getState(document);
        const prefix = identifierPrefixAtPosition(document.getText(), position);
        const fallbackItems = fallbackCompletionItemsAt(
          document.uri.fsPath,
          document.getText(),
          toFallbackPosition(position),
        ).map((entry) => {
          const item = new vscode.CompletionItem(entry.label, completionKindFromTs(entry.kind));
          item.detail = entry.detail;
          item.documentation = entry.documentation;
          item.insertText = entry.insertText;
          item.sortText = `0_${entry.label}`;
          return item;
        });
        const fallbackLabels = new Set(
          fallbackItems.map((item) => typeof item.label === 'string' ? item.label : item.label.label),
        );
        if (!state) {
          return fallbackItems.length > 0 ? new vscode.CompletionList(fallbackItems, false) : undefined;
        }

        const completions = state.service.getCompletionsAtPosition(
          state.lookupFileName,
          toProjectedOffset(state.snapshot, position),
          {},
        );
        const items = new Map<string, vscode.CompletionItem>();
        for (const item of fallbackItems) {
          const label = typeof item.label === 'string' ? item.label : item.label.label;
          items.set(label, item);
        }
        for (const entry of completions?.entries ?? []) {
          if (!matchesCompletionPrefix(entry.name, prefix)) {
            continue;
          }
          if (!shouldIncludeTsCompletionEntry(state, position, entry, fallbackLabels)) {
            continue;
          }
          const item = new vscode.CompletionItem(entry.name, completionKindFromTs(entry.kind));
          item.sortText = fallbackLabels.size > 0
            ? `1_${entry.sortText ?? entry.name}`
            : entry.sortText;
          item.insertText = entry.insertText ?? entry.name;
          item.filterText = entry.filterText;
          item.commitCharacters = entry.commitCharacters;
          const label = typeof item.label === 'string' ? item.label : item.label.label;
          items.set(label, item);
        }
        if (items.size === 0) {
          return undefined;
        }
        return new vscode.CompletionList([...items.values()], completions?.isMemberCompletion ?? false);
      },
    },
  );

  const signatureHelpProvider = vscode.languages.registerSignatureHelpProvider(
    { language: 'soundscript', scheme: 'file' },
    {
      async provideSignatureHelp(document, position): Promise<vscode.SignatureHelp | undefined> {
        const state = await getState(document);
        if (!state) {
          return undefined;
        }

        const signatureHelp = state.service.getSignatureHelpItems(
          state.lookupFileName,
          toProjectedOffset(state.snapshot, position),
          undefined,
        );
        return signatureHelp ? toSignatureHelp(signatureHelp) : undefined;
      },
    },
    '(',
    ',',
  );

  const documentSymbolProvider = vscode.languages.registerDocumentSymbolProvider(
    { language: 'soundscript', scheme: 'file' },
    {
      async provideDocumentSymbols(document): Promise<vscode.DocumentSymbol[]> {
        const state = await getState(document);
        if (!state) {
          return [];
        }

        const navigationTree = state.service.getNavigationTree(state.lookupFileName);
        return toDocumentSymbols(state.snapshot, navigationTree);
      },
    },
  );

  return {
    dispose() {
      hoverProvider.dispose();
      definitionProvider.dispose();
      completionProvider.dispose();
      signatureHelpProvider.dispose();
      documentSymbolProvider.dispose();
      stdlibContentProvider.dispose();
      statesByDocumentVersion.clear();
      stdlibDocumentsByUri.clear();
    },
    async dumpDebugInfo(document, position) {
      const state = await getState(document);
      if (!state) {
        return {
          projectedSnapshot: null,
        };
      }

      const projectedOffset = toProjectedOffset(state.snapshot, position);
      const quickInfo = state.service.getQuickInfoAtPosition(state.lookupFileName, projectedOffset);
      const definitions = state.service.getDefinitionAtPosition(
        state.lookupFileName,
        toProjectedDefinitionOffset(state.snapshot, position),
      ) ?? [];
      return {
        projectedSnapshot: {
          filePath: state.snapshot.filePath,
          projectPath: state.snapshot.projectPath,
          projectedText: state.snapshot.projectedText,
          virtualModules: state.snapshot.virtualModules.map((module) => ({
            fileName: module.fileName,
            specifier: module.specifier,
            sourceFileName: module.sourceFileName,
          })),
        },
        mappedPosition: positionAt(state.snapshot.projectedText, projectedOffset),
        projectedQuickInfo: quickInfo
          ? {
            displayString: ts.displayPartsToString(quickInfo.displayParts),
            documentation: ts.displayPartsToString(quickInfo.documentation),
            range: {
              start: quickInfo.textSpan.start,
              end: quickInfo.textSpan.start + quickInfo.textSpan.length,
            },
          }
          : null,
        projectedDefinitionResult: definitions.map((definition) => ({
          fileName: definition.fileName,
          textSpan: {
            start: definition.textSpan.start,
            length: definition.textSpan.length,
          },
        })),
      };
    },
    refreshAll() {
      statesByDocumentVersion.clear();
      for (const editor of vscode.window.visibleTextEditors) {
        if (!isSoundscriptDocument(editor.document)) {
          continue;
        }
        void getState(editor.document).catch((error) => {
          outputChannel.appendLine(
            `Failed to refresh projected snapshot for ${editor.document.uri.fsPath}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      }
    },
  };
}
