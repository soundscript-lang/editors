'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const ts = require('typescript');

const init = require('./index.js');

function createProjectService() {
  return {
    reloadCalls: 0,
    setHostConfigurationCalls: [],
    reloadProjects() {
      this.reloadCalls += 1;
    },
    setHostConfiguration(configuration) {
      this.setHostConfigurationCalls.push(configuration);
    },
  };
}

function createPlugin() {
  return init({
    typescript: {
      DiagnosticCategory: {
        Error: 1,
        Warning: 0,
        Message: 2,
      },
      ScriptKind: {
        TS: 3,
        TSX: 4,
      },
    },
  });
}

function createPluginWithModules(modules) {
  return init({
    typescript: ts,
    ...modules,
  });
}

function createLanguageServiceFixture(files, compilerOptions = {}) {
  const normalizedFiles = new Map(Object.entries(files));
  const options = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2020,
    ...compilerOptions,
  };

  const host = {
    directoryExists: (fileName) => ts.sys.directoryExists(fileName),
    fileExists: (fileName) => normalizedFiles.has(fileName) || ts.sys.fileExists(fileName),
    getCompilationSettings: () => options,
    getCurrentDirectory: () => '/',
    getDefaultLibFileName: (nextOptions) => ts.getDefaultLibFilePath(nextOptions),
    getDirectories: (fileName) => ts.sys.getDirectories(fileName),
    getScriptFileNames: () => [...normalizedFiles.keys()],
    getScriptSnapshot: (fileName) => {
      const text = normalizedFiles.get(fileName);
      if (text !== undefined) {
        return ts.ScriptSnapshot.fromString(text);
      }

      const fallback = ts.sys.readFile(fileName);
      return fallback === undefined ? undefined : ts.ScriptSnapshot.fromString(fallback);
    },
    getScriptVersion: () => '1',
    readDirectory: (...args) => ts.sys.readDirectory(...args),
    readFile: (fileName) => normalizedFiles.get(fileName) ?? ts.sys.readFile(fileName),
  };

  return ts.createLanguageService(host);
}

function createRealPluginFixture(files, compilerOptions) {
  const plugin = init({ typescript: ts });
  const projectService = createProjectService();
  const languageService = createLanguageServiceFixture(files, compilerOptions);
  const pluginLanguageService = plugin.create({
    languageService,
    project: {
      projectService,
    },
  });

  return {
    languageService: pluginLanguageService,
    projectService,
  };
}

function simplifyDiagnostics(diagnostics) {
  return diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  }));
}

test('tsserver plugin wraps the language service without mutating tsserver host configuration', () => {
  const plugin = createPlugin();
  const projectService = createProjectService();
  const languageService = { marker: 'language-service' };

  const returnedLanguageService = plugin.create({
    languageService,
    project: {
      projectService,
    },
  });
  plugin.create({
    languageService,
    project: {
      projectService,
    },
  });

  assert.notEqual(returnedLanguageService, languageService);
  assert.equal(returnedLanguageService.marker, 'language-service');
  assert.equal(typeof returnedLanguageService.getSemanticDiagnostics, 'function');
  assert.equal(typeof returnedLanguageService.getSuggestionDiagnostics, 'function');
  assert.deepEqual(projectService.setHostConfigurationCalls, []);
  assert.equal(projectService.reloadCalls, 0);
});

test('tsserver plugin configuration changes do not reload projects', () => {
  const plugin = createPlugin();
  const projectService = createProjectService();

  plugin.create({
    languageService: {},
    project: {
      projectService,
    },
  });

  plugin.onConfigurationChanged({
    stsScriptKind: 'tsx',
  });

  assert.deepEqual(projectService.setHostConfigurationCalls, []);
  assert.equal(projectService.reloadCalls, 0);
});

test('tsserver plugin suppresses suggestion diagnostics for aliased annotation-only imports', () => {
  const fixture = createRealPluginFixture({
    '/macro.ts': 'export const component = 1;\n',
    '/main.ts': [
      'import { component as componentMacro } from "./macro";',
      '// #[componentMacro]',
      'export class TodoView {}',
      '',
    ].join('\n'),
  });

  assert.deepEqual(
    simplifyDiagnostics(fixture.languageService.getSuggestionDiagnostics('/main.ts')),
    [],
  );
});

test('tsserver plugin suppresses semantic diagnostics for namespace annotation-only imports', () => {
  const fixture = createRealPluginFixture(
    {
      '/macro.ts': 'export const component = 1;\n',
      '/main.ts': [
        'import * as componentMacros from "./macro";',
        '// #[componentMacros]',
        'export class TodoView {}',
        '',
      ].join('\n'),
    },
    { noUnusedLocals: true },
  );

  assert.deepEqual(
    simplifyDiagnostics(fixture.languageService.getSemanticDiagnostics('/main.ts')),
    [],
  );
});

test('tsserver plugin keeps ordinary unused imports visible', () => {
  const fixture = createRealPluginFixture({
    '/macro.ts': 'export default 1;\n',
    '/main.ts': [
      'import foo from "./macro";',
      'export class TodoView {}',
      '',
    ].join('\n'),
  });

  assert.deepEqual(
    simplifyDiagnostics(fixture.languageService.getSuggestionDiagnostics('/main.ts')),
    [{
      code: 6133,
      message: "'foo' is declared but its value is never read.",
    }],
  );
});

test('tsserver plugin keeps mixed import declarations when non-annotation bindings are still unused', () => {
  const fixture = createRealPluginFixture(
    {
      '/macro.ts': 'export const component = 1; export const foo = 1;\n',
      '/main.ts': [
        'import { component as componentMacro, foo } from "./macro";',
        '// #[componentMacro]',
        'export class TodoView {}',
        '',
      ].join('\n'),
    },
    { noUnusedLocals: true },
  );

  assert.deepEqual(
    simplifyDiagnostics(fixture.languageService.getSemanticDiagnostics('/main.ts')),
    [{
      code: 6192,
      message: 'All imports in import declaration are unused.',
    }],
  );
});

test('tsserver plugin leaves sts semantic diagnostics on the base TypeScript path', () => {
  const plugin = createPlugin();
  const pluginLanguageService = plugin.create({
    config: {
      soundscriptArgsPrefix: ['run', '-A', '/repo/src/main.ts'],
      soundscriptCommand: 'deno',
    },
    languageService: {
      getSemanticDiagnostics: () => [{ code: 2322, messageText: 'Type error.' }],
      getSuggestionDiagnostics: () => [],
    },
    project: {
      getCurrentDirectory: () => '/workspace',
      projectService: createProjectService(),
    },
  });

  assert.deepEqual(pluginLanguageService.getSemanticDiagnostics('/workspace/src/main.sts'), [
    { code: 2322, messageText: 'Type error.' },
  ]);
});

test('tsserver plugin keeps configuration changes side-effect free', () => {
  const plugin = createPlugin();
  const projectService = createProjectService();
  plugin.create({
    config: {
      soundscriptArgsPrefix: [],
      soundscriptCommand: '/workspace/node_modules/.bin/soundscript',
    },
    languageService: {
      getSemanticDiagnostics: () => [],
      getSuggestionDiagnostics: () => [],
    },
    languageServiceHost: {
      getScriptSnapshot: () => ts.ScriptSnapshot.fromString('const value = 1;\n'),
      getScriptVersion: () => '1',
    },
    project: {
      getCurrentDirectory: () => '/workspace',
      projectService,
    },
  });

  plugin.onConfigurationChanged({
    soundscriptArgsPrefix: [],
    soundscriptCommand: '/workspace/bin/other-soundscript',
    stsScriptKind: 'ts',
  });

  assert.equal(projectService.reloadCalls, 0);
  assert.deepEqual(projectService.setHostConfigurationCalls, []);
});

test('tsserver plugin uses projected quick info and definitions for .sts files', () => {
  const rawText = 'console.log(answer);\n';
  const projectionPayload = {
    command: 'editor-project',
    filePath: '/workspace/main.sts',
    originalText: rawText,
    projectedText: [
      'declare const answer: 1;',
      'console.log(answer);',
      '',
    ].join('\n'),
    projectPath: '/workspace/tsconfig.json',
    rewriteStage: {
      replacements: [{
        originalSpan: { start: 0, end: 0 },
        rewrittenSpan: { start: 0, end: 'declare const answer: 1;\n'.length },
      }],
      rewrittenText: [
        'declare const answer: 1;',
        'console.log(answer);',
        '',
      ].join('\n'),
    },
    virtualModules: [],
  };
  const plugin = createPluginWithModules({
    fs: {
      existsSync: (candidatePath) => candidatePath === '/workspace/tsconfig.json',
      readFileSync: () => rawText,
    },
    spawnSync: () => ({
      error: undefined,
      status: 0,
      stderr: '',
      stdout: JSON.stringify(projectionPayload),
    }),
  });
  const projectService = createProjectService();
  const languageService = createLanguageServiceFixture({
    '/workspace/main.sts': rawText,
  });
  const pluginLanguageService = plugin.create({
    config: {
      soundscriptArgsPrefix: ['run', '-A', '/repo/src/main.ts'],
      soundscriptCommand: 'deno',
      stsScriptKind: 'ts',
    },
    languageService,
    languageServiceHost: {
      getCompilationSettings: () => ({
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ES2020,
      }),
      getCurrentDirectory: () => '/workspace',
      getScriptSnapshot: (fileName) => fileName === '/workspace/main.sts'
        ? ts.ScriptSnapshot.fromString(rawText)
        : undefined,
      getScriptVersion: () => '1',
    },
    project: {
      getProjectName: () => '/workspace/tsconfig.json',
      projectService,
    },
  });

  const answerPosition = rawText.indexOf('answer');
  const quickInfo = pluginLanguageService.getQuickInfoAtPosition('/workspace/main.sts', answerPosition);
  assert.ok(quickInfo);
  assert.equal(ts.displayPartsToString(quickInfo.displayParts ?? []), 'const answer: 1');
  assert.deepEqual(quickInfo.textSpan, {
    start: answerPosition,
    length: 'answer'.length,
  });

  const definitions = pluginLanguageService.getDefinitionAtPosition('/workspace/main.sts', answerPosition);
  assert.ok(definitions);
  assert.equal(definitions[0]?.fileName, '/workspace/main.sts');
});

test('tsserver plugin resolves cross-file Soundscript imports through projected sibling modules', () => {
  const rawText = [
    'import { safeDivide } from "./macros.sts";',
    '',
    'const result = safeDivide(10, 0);',
    '',
  ].join('\n');
  const macrosText = [
    'export function safeDivide(dividend: number, divisor: number) {',
    '  return dividend / divisor;',
    '}',
    '',
  ].join('\n');
  const projectionPayload = {
    command: 'editor-project',
    filePath: '/workspace/main.sts',
    originalText: rawText,
    projectedText: rawText,
    projectPath: '/workspace/tsconfig.json',
    rewriteStage: {
      replacements: [],
      rewrittenText: rawText,
    },
    virtualModules: [{
      fileName: '/workspace/macros.sts.ts',
      originalText: macrosText,
      rewriteStage: {
        replacements: [],
        rewrittenText: macrosText,
      },
      sourceFileName: '/workspace/macros.sts',
      specifier: '/workspace/macros.sts',
      text: macrosText,
    }],
  };
  const plugin = createPluginWithModules({
    fs: {
      existsSync: (candidatePath) =>
        candidatePath === '/workspace/tsconfig.json' ||
        candidatePath === '/workspace/main.sts' ||
        candidatePath === '/workspace/macros.sts',
      readFileSync: (candidatePath) => {
        if (candidatePath === '/workspace/main.sts') {
          return rawText;
        }
        if (candidatePath === '/workspace/macros.sts') {
          return macrosText;
        }
        return '';
      },
    },
    spawnSync: () => ({
      error: undefined,
      status: 0,
      stderr: '',
      stdout: JSON.stringify(projectionPayload),
    }),
  });
  const projectService = createProjectService();
  const languageService = createLanguageServiceFixture({
    '/workspace/main.sts': rawText,
    '/workspace/macros.sts': macrosText,
  });
  const pluginLanguageService = plugin.create({
    config: {
      soundscriptArgsPrefix: ['run', '-A', '/repo/src/main.ts'],
      soundscriptCommand: 'deno',
      stsScriptKind: 'ts',
    },
    languageService,
    languageServiceHost: {
      directoryExists: (candidatePath) => candidatePath === '/workspace' || candidatePath === '/',
      fileExists: (candidatePath) =>
        candidatePath === '/workspace/main.sts' ||
        candidatePath === '/workspace/macros.sts',
      getCompilationSettings: () => ({
        allowArbitraryExtensions: true,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ES2020,
      }),
      getCurrentDirectory: () => '/workspace',
      getDirectories: () => [],
      getScriptSnapshot: (fileName) => {
        if (fileName === '/workspace/main.sts') {
          return ts.ScriptSnapshot.fromString(rawText);
        }
        if (fileName === '/workspace/macros.sts') {
          return ts.ScriptSnapshot.fromString(macrosText);
        }
        return undefined;
      },
      getScriptVersion: () => '1',
      readFile: (candidatePath) => {
        if (candidatePath === '/workspace/main.sts') {
          return rawText;
        }
        if (candidatePath === '/workspace/macros.sts') {
          return macrosText;
        }
        return undefined;
      },
    },
    project: {
      getProjectName: () => '/workspace/tsconfig.json',
      projectService,
    },
  });

  const safeDivideUsagePosition = rawText.lastIndexOf('safeDivide');
  const quickInfo = pluginLanguageService.getQuickInfoAtPosition(
    '/workspace/main.sts',
    safeDivideUsagePosition,
  );
  assert.ok(quickInfo);
  assert.match(
    ts.displayPartsToString(quickInfo.displayParts ?? []),
    /safeDivide\(dividend: number, divisor: number\): number/,
  );
  assert.equal(quickInfo.textSpan.start, safeDivideUsagePosition);

  const definitions = pluginLanguageService.getDefinitionAtPosition(
    '/workspace/main.sts',
    safeDivideUsagePosition,
  );
  assert.ok(definitions);
  assert.equal(definitions[0]?.fileName, '/workspace/macros.sts');
});

test('tsserver plugin remaps projected semantic diagnostics back to .sts source spans', () => {
  const rawText = 'const count: string = 1;\n';
  const projectedText = [
    'declare const prelude: 0;',
    'const count: string = 1;',
    '',
  ].join('\n');
  const plugin = createPluginWithModules({
    fs: {
      existsSync: (candidatePath) => candidatePath === '/workspace/tsconfig.json',
      readFileSync: () => rawText,
    },
    spawnSync: () => ({
      error: undefined,
      status: 0,
      stderr: '',
      stdout: JSON.stringify({
        command: 'editor-project',
        filePath: '/workspace/main.sts',
        originalText: rawText,
        projectedText,
        projectPath: '/workspace/tsconfig.json',
        rewriteStage: {
          replacements: [{
            originalSpan: { start: 0, end: 0 },
            rewrittenSpan: { start: 0, end: 'declare const prelude: 0;\n'.length },
          }],
          rewrittenText: projectedText,
        },
        virtualModules: [],
      }),
    }),
  });
  const projectService = createProjectService();
  const languageService = createLanguageServiceFixture({
    '/workspace/main.sts': rawText,
  });
  const pluginLanguageService = plugin.create({
    config: {
      soundscriptArgsPrefix: ['run', '-A', '/repo/src/main.ts'],
      soundscriptCommand: 'deno',
      stsScriptKind: 'ts',
    },
    languageService,
    languageServiceHost: {
      getCompilationSettings: () => ({
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ES2020,
      }),
      getCurrentDirectory: () => '/workspace',
      getScriptSnapshot: (fileName) => fileName === '/workspace/main.sts'
        ? ts.ScriptSnapshot.fromString(rawText)
        : undefined,
      getScriptVersion: () => '1',
    },
    project: {
      getProjectName: () => '/workspace/tsconfig.json',
      projectService,
    },
  });

  const diagnostics = pluginLanguageService.getSemanticDiagnostics('/workspace/main.sts');
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.start, rawText.indexOf('count'));
});

test('tsserver plugin inserts the Deno heap flag for projected editor commands', () => {
  const rawText = 'console.log(answer);\n';
  const spawnCalls = [];
  const plugin = createPluginWithModules({
    fs: {
      existsSync: (candidatePath) => candidatePath === '/workspace/tsconfig.json',
      readFileSync: () => rawText,
    },
    spawnSync: (command, args) => {
      spawnCalls.push({ command, args });
      return {
        error: undefined,
        status: 0,
        stderr: '',
        stdout: JSON.stringify({
          command: 'editor-project',
          filePath: '/workspace/main.sts',
          originalText: rawText,
          projectedText: rawText,
          projectPath: '/workspace/tsconfig.json',
          rewriteStage: {
            replacements: [],
            rewrittenText: rawText,
          },
          virtualModules: [],
        }),
      };
    },
  });
  const projectService = createProjectService();
  const languageService = createLanguageServiceFixture({
    '/workspace/main.sts': rawText,
  });
  const pluginLanguageService = plugin.create({
    config: {
      soundscriptArgsPrefix: ['run', '-A', '/repo/src/main.ts'],
      soundscriptCommand: '/Users/jake/.deno/bin/deno',
      stsScriptKind: 'ts',
    },
    languageService,
    languageServiceHost: {
      getCompilationSettings: () => ({
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ES2020,
      }),
      getCurrentDirectory: () => '/workspace',
      getScriptSnapshot: (fileName) => fileName === '/workspace/main.sts'
        ? ts.ScriptSnapshot.fromString(rawText)
        : undefined,
      getScriptVersion: () => '1',
    },
    project: {
      getProjectName: () => '/workspace/tsconfig.json',
      projectService,
    },
  });

  pluginLanguageService.getQuickInfoAtPosition('/workspace/main.sts', rawText.indexOf('answer'));

  assert.deepEqual(spawnCalls, [{
    command: '/Users/jake/.deno/bin/deno',
    args: [
      'run',
      '--v8-flags=--max-old-space-size=8192',
      '-A',
      '/repo/src/main.ts',
      'editor-project',
      '--project',
      '/workspace/tsconfig.json',
      '--file',
      '/workspace/main.sts',
      '--stdin-file',
    ],
  }]);
});

test('tsserver plugin auto-resolves the workspace soundscript binary when editor configuration is unavailable', () => {
  const rawText = 'console.log(answer);\n';
  const spawnCalls = [];
  const projectionPayload = {
    command: 'editor-project',
    filePath: '/workspace/main.sts',
    originalText: rawText,
    projectedText: [
      'declare const answer: 1;',
      'console.log(answer);',
      '',
    ].join('\n'),
    projectPath: '/workspace/tsconfig.json',
    rewriteStage: {
      replacements: [{
        originalSpan: { start: 0, end: 0 },
        rewrittenSpan: { start: 0, end: 'declare const answer: 1;\n'.length },
      }],
      rewrittenText: [
        'declare const answer: 1;',
        'console.log(answer);',
        '',
      ].join('\n'),
    },
    virtualModules: [],
  };
  const plugin = createPluginWithModules({
    fs: {
      existsSync: (candidatePath) =>
        candidatePath === '/workspace/tsconfig.json' ||
        candidatePath === '/workspace/node_modules/.bin/soundscript',
      readFileSync: () => rawText,
    },
    spawnSync: (command, args) => {
      spawnCalls.push({ command, args });
      return {
        error: undefined,
        status: 0,
        stderr: '',
        stdout: JSON.stringify(projectionPayload),
      };
    },
  });
  const projectService = createProjectService();
  const languageService = createLanguageServiceFixture({
    '/workspace/main.sts': rawText,
  });
  const pluginLanguageService = plugin.create({
    languageService,
    languageServiceHost: {
      getCompilationSettings: () => ({
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ES2020,
      }),
      getCurrentDirectory: () => '/workspace',
      getScriptSnapshot: (fileName) => fileName === '/workspace/main.sts'
        ? ts.ScriptSnapshot.fromString(rawText)
        : undefined,
      getScriptVersion: () => '1',
    },
    project: {
      getCurrentDirectory: () => '/workspace',
      getProjectName: () => '/workspace/tsconfig.json',
      projectService,
    },
  });

  const answerPosition = rawText.indexOf('answer');
  const quickInfo = pluginLanguageService.getQuickInfoAtPosition('/workspace/main.sts', answerPosition);

  assert.ok(quickInfo);
  assert.deepEqual(spawnCalls, [{
    command: '/workspace/node_modules/.bin/soundscript',
    args: [
      'editor-project',
      '--project',
      '/workspace/tsconfig.json',
      '--file',
      '/workspace/main.sts',
      '--stdin-file',
    ],
  }]);
});
