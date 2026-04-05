import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import * as vscode from 'vscode';

interface SerializedPosition {
  character: number;
  line: number;
}

interface SerializedRange {
  end: SerializedPosition;
  start: SerializedPosition;
}

interface SerializedHoverContent {
  kind: 'code' | 'markdown' | 'string';
  language?: string;
  value: string;
}

interface SerializedHover {
  contents: SerializedHoverContent[];
  range: SerializedRange | null;
}

interface TimedHovers {
  durationMs: number;
  hovers: SerializedHover[];
}

interface TimedDefinitions {
  definitions: Array<{
    range: SerializedRange;
    uri: string;
  }>;
  durationMs: number;
}

interface TimedCompletions {
  durationMs: number;
  items: Array<{
    detail: string | undefined;
    documentation: string | undefined;
    label: string;
  }>;
}

interface SerializedDocumentSymbol {
  kind: string;
  name: string;
  range: SerializedRange;
  selectionRange: SerializedRange;
}

interface StageSnapshot {
  activeDocument: string | null;
  diagnostics: Array<{
    code: string | number | undefined;
    message: string;
    range: SerializedRange;
    severity: string;
    source: string | undefined;
  }>;
  diagnosticsSettled: boolean;
  hoverAtAUsage: TimedHovers;
  hoverAtAnswerUsage: TimedHovers;
  hoverAtCatchBinding: TimedHovers;
  hoverAtDictUsage: TimedHovers;
  hoverAtEnvironmentImport: TimedHovers;
  hoverAtInteropAnnotation: TimedHovers;
  hoverAtJsonImport: TimedHovers;
  hoverAtLiteralSchemaImport: TimedHovers;
  hoverAtMatchDivision: TimedHovers;
  hoverAtMatchErrBinding: TimedHovers;
  hoverAtPreludeResult: TimedHovers;
  hoverAtPreludeTry: TimedHovers;
  hoverAtTryDivision: TimedHovers;
  completionAtPreludePrefix: TimedCompletions;
  definitionAtLiteralSchemaUsage: TimedDefinitions;
  definitionAtPreludeTry: TimedDefinitions;
  documentSymbols: SerializedDocumentSymbol[];
  soundscriptDebugAtAUsage: unknown;
  tsExtensionActive: boolean;
}

function hoverContains(stageHover: TimedHovers, snippet: string): boolean {
  return stageHover.hovers.some((hover) =>
    hover.contents.some((content) => content.value.includes(snippet))
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serializePosition(position: vscode.Position): SerializedPosition {
  return {
    line: position.line,
    character: position.character,
  };
}

function serializeRange(range: vscode.Range): SerializedRange {
  return {
    start: serializePosition(range.start),
    end: serializePosition(range.end),
  };
}

function serializeHoverContent(
  content: vscode.MarkdownString | vscode.MarkedString,
): SerializedHoverContent {
  if (content instanceof vscode.MarkdownString) {
    return {
      kind: 'markdown',
      value: content.value,
    };
  }

  if (typeof content === 'string') {
    return {
      kind: 'string',
      value: content,
    };
  }

  return {
    kind: 'code',
    language: content.language,
    value: content.value,
  };
}

function serializeHover(hover: vscode.Hover): SerializedHover {
  const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents];
  return {
    contents: contents.map((entry) => serializeHoverContent(entry)),
    range: hover.range ? serializeRange(hover.range) : null,
  };
}

function serializeDiagnostics(document: vscode.TextDocument) {
  return vscode.languages.getDiagnostics(document.uri).map((diagnostic) => ({
    code: typeof diagnostic.code === 'object' ? diagnostic.code?.value : diagnostic.code,
    message: diagnostic.message,
    range: serializeRange(diagnostic.range),
    severity: vscode.DiagnosticSeverity[diagnostic.severity] ?? String(diagnostic.severity),
    source: diagnostic.source,
  }));
}

function positionOf(text: string, needle: string, occurrence = 0): vscode.Position {
  let searchFrom = 0;
  let index = -1;
  for (let current = 0; current <= occurrence; current += 1) {
    index = text.indexOf(needle, searchFrom);
    if (index === -1) {
      throw new Error(`Could not find "${needle}" occurrence ${occurrence}.`);
    }
    searchFrom = index + needle.length;
  }

  const before = text.slice(0, index);
  const lines = before.split('\n');
  const lastLine = lines.length > 0 ? lines[lines.length - 1] : '';
  return new vscode.Position(lines.length - 1, lastLine.length);
}

async function openFile(relativePath: string): Promise<vscode.TextEditor> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, 'Expected smoke workspace to be open.');
  const uri = vscode.Uri.joinPath(workspaceFolder.uri, relativePath);
  const document = await vscode.workspace.openTextDocument(uri);
  return vscode.window.showTextDocument(document, { preview: false });
}

async function waitForExtensionActivation(): Promise<void> {
  const extension = vscode.extensions.getExtension('soundscript.soundscript-vscode');
  assert.ok(extension, 'Expected Soundscript VS Code extension to be installed in smoke host.');
  await extension.activate();
}

async function waitForDiagnostics(
  document: vscode.TextDocument,
  timeoutMs: number,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (vscode.languages.getDiagnostics(document.uri).length > 0) {
      return true;
    }
    await sleep(100);
  }
  return vscode.languages.getDiagnostics(document.uri).length > 0;
}

async function captureHover(
  editor: vscode.TextEditor,
  position: vscode.Position,
): Promise<TimedHovers> {
  editor.selection = new vscode.Selection(position, position);
  await vscode.window.showTextDocument(editor.document, { preview: false, selection: editor.selection });
  await sleep(75);
  const startedAt = Date.now();
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider',
    editor.document.uri,
    position,
  );
  return {
    durationMs: Date.now() - startedAt,
    hovers: (hovers ?? []).map((hover) => serializeHover(hover)),
  };
}

async function captureDebugSnapshot(
  editor: vscode.TextEditor,
  position: vscode.Position,
): Promise<unknown> {
  editor.selection = new vscode.Selection(position, position);
  await vscode.window.showTextDocument(editor.document, { preview: false, selection: editor.selection });
  await sleep(75);
  return vscode.commands.executeCommand('soundscript.dumpActiveDocumentDebugInfo');
}

async function captureDefinitions(
  editor: vscode.TextEditor,
  position: vscode.Position,
): Promise<TimedDefinitions> {
  editor.selection = new vscode.Selection(position, position);
  await vscode.window.showTextDocument(editor.document, { preview: false, selection: editor.selection });
  await sleep(75);
  const startedAt = Date.now();
  const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
    'vscode.executeDefinitionProvider',
    editor.document.uri,
    position,
  );
  return {
    durationMs: Date.now() - startedAt,
    definitions: (definitions ?? []).map((definition) => ({
      uri: definition.uri.toString(),
      range: serializeRange(definition.range),
    })),
  };
}

async function captureCompletions(
  editor: vscode.TextEditor,
  position: vscode.Position,
): Promise<TimedCompletions> {
  editor.selection = new vscode.Selection(position, position);
  await vscode.window.showTextDocument(editor.document, { preview: false, selection: editor.selection });
  await sleep(75);
  const startedAt = Date.now();
  const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
    'vscode.executeCompletionItemProvider',
    editor.document.uri,
    position,
  );
  return {
    durationMs: Date.now() - startedAt,
    items: (completions?.items ?? []).map((item) => ({
      label: typeof item.label === 'string' ? item.label : item.label.label,
      detail: item.detail,
      documentation: item.documentation instanceof vscode.MarkdownString
        ? item.documentation.value
        : typeof item.documentation === 'string'
        ? item.documentation
        : undefined,
    })),
  };
}

function symbolKindToName(kind: vscode.SymbolKind): string {
  return vscode.SymbolKind[kind] ?? String(kind);
}

function flattenDocumentSymbols(
  symbols: readonly vscode.DocumentSymbol[],
): SerializedDocumentSymbol[] {
  const flattened: SerializedDocumentSymbol[] = [];
  const visit = (symbol: vscode.DocumentSymbol) => {
    flattened.push({
      kind: symbolKindToName(symbol.kind),
      name: symbol.name,
      range: serializeRange(symbol.range),
      selectionRange: serializeRange(symbol.selectionRange),
    });
    for (const child of symbol.children) {
      visit(child);
    }
  };

  for (const symbol of symbols) {
    visit(symbol);
  }
  return flattened;
}

async function captureDocumentSymbols(
  editor: vscode.TextEditor,
): Promise<SerializedDocumentSymbol[]> {
  await vscode.window.showTextDocument(editor.document, { preview: false });
  await sleep(75);
  const symbols = await vscode.commands.executeCommand<
    readonly vscode.DocumentSymbol[] | readonly vscode.SymbolInformation[]
  >(
    'vscode.executeDocumentSymbolProvider',
    editor.document.uri,
  );
  if (!symbols || symbols.length === 0) {
    return [];
  }

  const [first] = symbols;
  if (first instanceof vscode.DocumentSymbol) {
    return flattenDocumentSymbols(symbols as readonly vscode.DocumentSymbol[]);
  }

  return (symbols as readonly vscode.SymbolInformation[]).map((symbol) => ({
    kind: symbolKindToName(symbol.kind),
    name: symbol.name,
    range: serializeRange(symbol.location.range),
    selectionRange: serializeRange(symbol.location.range),
  }));
}

async function capturePreludeCompletions(editor: vscode.TextEditor): Promise<TimedCompletions> {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  assert.ok(workspaceFolder, 'Expected smoke workspace to be open for completion probe.');
  const probeUri = vscode.Uri.joinPath(workspaceFolder.uri, 'src', '__completion_probe__.sts');
  await vscode.workspace.fs.writeFile(probeUri, Buffer.from('const completionPrelude = Tr;\n', 'utf8'));

  try {
    const probeDocument = await vscode.workspace.openTextDocument(probeUri);
    const probeEditor = await vscode.window.showTextDocument(probeDocument, { preview: false });
    const position = new vscode.Position(0, 'const completionPrelude = Tr'.length);
    return await captureCompletions(probeEditor, position);
  } finally {
    await vscode.workspace.fs.delete(probeUri, { useTrash: false });
  }
}

async function captureStage(
  editor: vscode.TextEditor,
  positions: {
    aUsage: vscode.Position;
    answerUsage: vscode.Position;
    catchBinding: vscode.Position;
    dictUsage: vscode.Position;
    environmentImport: vscode.Position;
    interopAnnotation: vscode.Position;
    jsonImport: vscode.Position;
    literalSchemaImport: vscode.Position;
    literalSchemaUsage: vscode.Position;
    matchDivision: vscode.Position;
    matchErrBinding: vscode.Position;
    preludeResult: vscode.Position;
    preludeTry: vscode.Position;
    tryDivision: vscode.Position;
  },
): Promise<StageSnapshot> {
  const tsExtension = vscode.extensions.getExtension('vscode.typescript-language-features');
  const diagnosticsSettled = await waitForDiagnostics(editor.document, 2500);
  return {
    activeDocument: vscode.window.activeTextEditor?.document.uri.toString() ?? null,
    diagnostics: serializeDiagnostics(editor.document),
    diagnosticsSettled,
    hoverAtAUsage: await captureHover(editor, positions.aUsage),
    hoverAtAnswerUsage: await captureHover(editor, positions.answerUsage),
    hoverAtCatchBinding: await captureHover(editor, positions.catchBinding),
    hoverAtDictUsage: await captureHover(editor, positions.dictUsage),
    hoverAtEnvironmentImport: await captureHover(editor, positions.environmentImport),
    hoverAtInteropAnnotation: await captureHover(editor, positions.interopAnnotation),
    hoverAtJsonImport: await captureHover(editor, positions.jsonImport),
    hoverAtLiteralSchemaImport: await captureHover(editor, positions.literalSchemaImport),
    hoverAtMatchDivision: await captureHover(editor, positions.matchDivision),
    hoverAtMatchErrBinding: await captureHover(editor, positions.matchErrBinding),
    hoverAtPreludeResult: await captureHover(editor, positions.preludeResult),
    hoverAtPreludeTry: await captureHover(editor, positions.preludeTry),
    hoverAtTryDivision: await captureHover(editor, positions.tryDivision),
    completionAtPreludePrefix: await capturePreludeCompletions(editor),
    definitionAtLiteralSchemaUsage: await captureDefinitions(editor, positions.literalSchemaUsage),
    definitionAtPreludeTry: await captureDefinitions(editor, positions.preludeTry),
    documentSymbols: await captureDocumentSymbols(editor),
    soundscriptDebugAtAUsage: await captureDebugSnapshot(editor, positions.aUsage),
    tsExtensionActive: Boolean(tsExtension?.isActive),
  };
}

export async function run(): Promise<void> {
  const fixtureName = process.env.SOUNDSCRIPT_SMOKE_FIXTURE ?? 'unknown';
  const reportFile = process.env.SOUNDSCRIPT_SMOKE_REPORT_FILE;

  try {
    await waitForExtensionActivation();

    const stsEditor = await openFile('src/soundscript.sts');
    const stsText = stsEditor.document.getText();
    const positions = {
      environmentImport: positionOf(stsText, 'Environment'),
      interopAnnotation: positionOf(stsText, 'interop'),
      jsonImport: positionOf(stsText, 'parseJson'),
      literalSchemaImport: positionOf(stsText, 'literalSchema'),
      literalSchemaUsage: positionOf(stsText, 'console.log(literalSchema)').translate(0, 'console.log('.length),
      answerUsage: positionOf(stsText, 'console.log(answer)').translate(0, 'console.log('.length),
      aUsage: positionOf(stsText, 'console.log(a)').translate(0, 'console.log('.length),
      dictUsage: positionOf(stsText, 'console.log(dict)').translate(0, 'console.log('.length),
      catchBinding: positionOf(stsText, 'console.log(err)').translate(0, 'console.log('.length),
      matchDivision: positionOf(stsText, 'function matchDivision()').translate(0, 'function '.length),
      matchErrBinding: positionOf(stsText, '({ err }: Err<string>) => false').translate(0, '({ '.length),
      preludeResult: positionOf(stsText, 'Result<number, string>'),
      preludeTry: positionOf(stsText, 'Try(value)'),
      tryDivision: positionOf(stsText, 'function tryDivision()').translate(0, 'function '.length),
    };

    await sleep(1500);
    const beforeTsOpen = await captureStage(stsEditor, positions);

    const tsEditor = await openFile('src/types.ts');
    await sleep(1500);
    const afterTsOpen = await captureStage(stsEditor, positions);

    const report = {
      afterTsOpen,
      beforeTsOpen,
      fixtureName,
      files: {
        sts: basename(stsEditor.document.uri.fsPath),
        ts: basename(tsEditor.document.uri.fsPath),
      },
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    };

    const serializedReport = JSON.stringify(report, null, 2);
    if (reportFile) {
      await writeFile(reportFile, serializedReport, 'utf8');
    }

    const nominalSourcePosition = positionOf(stsText, 'const c: C = b;').translate(0, 'const c: C = '.length);

    assert.ok(
      hoverContains(beforeTsOpen.hoverAtInteropAnnotation, '**annotation** `interop`'),
      'Expected builtin annotation hover docs before opening any .ts file.',
    );
    assert.ok(
      hoverContains(beforeTsOpen.hoverAtInteropAnnotation, 'unsound foreign values enter soundscript'),
      'Expected builtin annotation hover details before opening any .ts file.',
    );
    assert.ok(
      hoverContains(
        beforeTsOpen.hoverAtJsonImport,
        'function parseJson(text: string): Result<JsonValue, JsonParseFailure>',
      ),
      'Expected stdlib module import hover before helper diagnostics settle.',
    );
    assert.ok(
      hoverContains(beforeTsOpen.hoverAtPreludeResult, 'type Result<'),
      'Expected prelude Result hover before opening any .ts file.',
    );
    assert.ok(
      hoverContains(beforeTsOpen.hoverAtPreludeTry, 'function Try<'),
      'Expected prelude Try hover before opening any .ts file.',
    );
    assert.ok(
      hoverContains(beforeTsOpen.hoverAtPreludeTry, '**macro** `Try`'),
      'Expected prelude Try hover to include macro docs before opening any .ts file.',
    );
    assert.ok(
      hoverContains(beforeTsOpen.hoverAtMatchDivision, 'function matchDivision(): boolean'),
      'Expected Match-based fallback hover to infer boolean before helper diagnostics settle.',
    );
    assert.ok(
      hoverContains(beforeTsOpen.hoverAtTryDivision, 'function tryDivision(): Result<number, string>'),
      'Expected Try-based fallback hover to lift the enclosing function to Result before helper diagnostics settle.',
    );
    assert.ok(
      hoverContains(beforeTsOpen.hoverAtMatchErrBinding, 'err: string'),
      'Expected Match Err shorthand binding hover to resolve as string before helper diagnostics settle.',
    );
    assert.ok(
      hoverContains(beforeTsOpen.hoverAtAUsage, 'const a: unknown'),
      'Expected imported explicit-any values to project to unknown before opening any .ts file.',
    );
    assert.ok(
      hoverContains(beforeTsOpen.hoverAtEnvironmentImport, 'Environment'),
      'Expected trusted type imports to stay real before opening any .ts file.',
    );
    assert.ok(
      hoverContains(beforeTsOpen.hoverAtDictUsage, 'BareObject'),
      'Expected BareObject projection before opening any .ts file.',
    );
    assert.ok(
      beforeTsOpen.definitionAtPreludeTry.definitions.some((definition) =>
        definition.uri === 'soundscript-stdlib:/prelude.d.ts'
      ),
      'Expected implicit prelude definitions to resolve to the virtual prelude document.',
    );
    assert.ok(
      beforeTsOpen.definitionAtLiteralSchemaUsage.definitions.some((definition) =>
        definition.uri.endsWith('/src/types.ts')
      ),
      'Expected literalSchema usage definitions to resolve to the imported types.ts declaration before opening any .ts file.',
    );
    const tryDivisionSymbol = beforeTsOpen.documentSymbols.find((symbol) => symbol.name === 'tryDivision');
    assert.ok(
      tryDivisionSymbol,
      'Expected document symbols to include tryDivision before opening any .ts file.',
    );
    assert.deepEqual(
      tryDivisionSymbol.selectionRange.start,
      serializePosition(positions.tryDivision),
      'Expected tryDivision document symbol selection range to land on the function name.',
    );
    const matchDivisionSymbol = beforeTsOpen.documentSymbols.find((symbol) => symbol.name === 'matchDivision');
    assert.ok(
      matchDivisionSymbol,
      'Expected document symbols to include matchDivision before opening any .ts file.',
    );
    assert.deepEqual(
      matchDivisionSymbol.selectionRange.start,
      serializePosition(positions.matchDivision),
      'Expected matchDivision document symbol selection range to land on the function name.',
    );
    assert.equal(
      beforeTsOpen.documentSymbols.some((symbol) => symbol.name === 'Try'),
      false,
      'Expected implicit prelude helpers to stay out of document symbols.',
    );
    assert.equal(
      beforeTsOpen.documentSymbols.some((symbol) => symbol.name === 'literalSchema'),
      false,
      'Expected imported bindings to stay out of document symbols.',
    );
    assert.ok(
      beforeTsOpen.completionAtPreludePrefix.items.some((item) => item.label === 'Try'),
      'Expected prelude completion items to include Try before opening any .ts file.',
    );
    assert.deepEqual(
      beforeTsOpen.completionAtPreludePrefix.items.map((item) => item.label),
      ['Try'],
      'Expected prelude completion probe to collapse down to the Soundscript prelude result.',
    );
    assert.deepEqual(
      afterTsOpen.diagnostics.map((diagnostic) => diagnostic.code),
      ['SOUND1019'],
      `Expected only the nominal class diagnostic after opening the TS sidecar in fixture ${fixtureName}.`,
    );
    assert.deepEqual(
      afterTsOpen.diagnostics[0]?.range.start,
      serializePosition(nominalSourcePosition),
      `Expected the nominal class diagnostic to land on the assignment source expression in fixture ${fixtureName}.`,
    );
    assert.ok(
      hoverContains(afterTsOpen.hoverAtAnswerUsage, 'const answer: 1'),
      `Expected trusted imported value hover to retain its real type in fixture ${fixtureName}.`,
    );
    console.log('SOUNDSCRIPT_SMOKE_REPORT_START');
    console.log(serializedReport);
    console.log('SOUNDSCRIPT_SMOKE_REPORT_END');
  } catch (error) {
    if (reportFile) {
      await writeFile(
        reportFile,
        JSON.stringify(
          {
            error: {
              message: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            },
            fixtureName,
          },
          null,
          2,
        ),
        'utf8',
      );
    }
    throw error;
  }
}
