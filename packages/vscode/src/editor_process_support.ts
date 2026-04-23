import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import * as path from 'node:path';
import ts from 'typescript';

import type { ResolvedCliLaunch } from './server_resolution';

export interface EditorProjectSnapshot {
  command: 'editor-project';
  filePath: string;
  originalText: string;
  postRewriteStage?: unknown;
  projectedText: string;
  projectPath: string;
  rewriteStage: unknown;
  virtualModules: ReadonlyArray<{
    fileName: string;
    originalText?: string;
    postRewriteStage?: unknown;
    rewriteStage?: unknown;
    specifier: string;
    sourceFileName?: string;
    text: string;
  }>;
}

export interface DiagnosticsWorkerChildProcess {
  kill(): void;
  on(eventName: 'error' | 'exit', listener: (...args: unknown[]) => void): unknown;
  stderr: {
    on(eventName: 'data', listener: (chunk: Buffer | string) => void): unknown;
  };
  stdin: NodeJS.WritableStream & { writable: boolean };
  stdout: {
    on(eventName: 'data', listener: (chunk: Buffer | string) => void): unknown;
  };
}

export type SpawnDiagnosticsWorker = (
  command: string,
  args: readonly string[],
  options: { cwd: string; stdio: ['pipe', 'pipe', 'pipe'] },
) => DiagnosticsWorkerChildProcess;

const DEFAULT_CONFIG_EXCLUDE_PATTERNS = [
  'node_modules',
  'bower_components',
  'jspm_packages',
  '.git',
] as const;
const projectSoundscriptMatcherCache = new Map<string, (filePath: string) => boolean>();
const tsWildcardApi = ts as typeof ts & {
  getRegularExpressionForWildcard(
    specs: readonly string[],
    basePath: string,
    usage: 'exclude' | 'files',
  ): string | undefined;
};

function normalizePathForMatching(filePath: string): string {
  return path.resolve(filePath).replace(/\\/gu, '/');
}

function isSoundscriptSourceFile(filePath: string): boolean {
  return filePath.endsWith('.sts');
}

function isTypeScriptFamilySoundscriptAliasFile(filePath: string): boolean {
  const lowered = filePath.toLowerCase();
  return (
    lowered.endsWith('.ts') ||
    lowered.endsWith('.tsx') ||
    lowered.endsWith('.mts') ||
    lowered.endsWith('.cts')
  ) && !(
    lowered.endsWith('.d.ts') ||
    lowered.endsWith('.d.mts') ||
    lowered.endsWith('.d.cts')
  );
}

function createProjectSoundscriptMatcher(projectPath: string): (filePath: string) => boolean {
  const configFile = ts.readConfigFile(projectPath, ts.sys.readFile);
  if (configFile.error) {
    return () => false;
  }

  const rawConfig = configFile.config as {
    exclude?: readonly string[];
    soundscript?: {
      include?: readonly string[];
    };
  } | undefined;
  const includePatterns = Array.isArray(rawConfig?.soundscript?.include)
    ? rawConfig.soundscript.include.filter((value): value is string => typeof value === 'string')
    : [];
  if (includePatterns.length === 0) {
    return () => false;
  }

  const basePath = normalizePathForMatching(path.dirname(projectPath));
  const includePatternText = tsWildcardApi.getRegularExpressionForWildcard(
    includePatterns,
    basePath,
    'files',
  );
  if (!includePatternText) {
    return () => false;
  }

  const excludePatterns = Array.isArray(rawConfig?.exclude)
    ? rawConfig.exclude.filter((value): value is string => typeof value === 'string')
    : [...DEFAULT_CONFIG_EXCLUDE_PATTERNS];
  const excludePatternText = excludePatterns.length > 0
    ? tsWildcardApi.getRegularExpressionForWildcard(excludePatterns, basePath, 'exclude')
    : undefined;
  const includeRegex = new RegExp(includePatternText);
  const excludeRegex = excludePatternText ? new RegExp(excludePatternText) : undefined;

  return (filePath: string): boolean => {
    if (!isTypeScriptFamilySoundscriptAliasFile(filePath)) {
      return false;
    }

    const normalizedFilePath = normalizePathForMatching(filePath);
    return includeRegex.test(normalizedFilePath) && !(excludeRegex?.test(normalizedFilePath) ?? false);
  };
}

function getProjectSoundscriptMatcher(projectPath: string): (filePath: string) => boolean {
  const normalizedProjectPath = path.resolve(projectPath);
  const cached = projectSoundscriptMatcherCache.get(normalizedProjectPath);
  if (cached) {
    return cached;
  }

  const matcher = createProjectSoundscriptMatcher(normalizedProjectPath);
  projectSoundscriptMatcherCache.set(normalizedProjectPath, matcher);
  return matcher;
}

export function clearProjectSoundscriptMatcherCache(projectPath?: string): void {
  if (projectPath === undefined) {
    projectSoundscriptMatcherCache.clear();
    return;
  }

  projectSoundscriptMatcherCache.delete(path.resolve(projectPath));
}

export function buildCliArgs(
  cliLaunch: ResolvedCliLaunch,
  subcommand: string,
): readonly string[] {
  return [...cliLaunch.argsPrefix, subcommand];
}

function isDenoCommand(command: string): boolean {
  const normalizedCommand = command.replace(/\\/gu, '/');
  return normalizedCommand.endsWith('/deno') || normalizedCommand.endsWith('/deno.exe');
}

function buildHeapAdjustedDenoArgs(
  command: string,
  args: readonly string[],
): readonly string[] {
  if (!isDenoCommand(command) || args[0] !== 'run') {
    return args;
  }

  if (args.some((argument) => argument.startsWith('--v8-flags='))) {
    return args;
  }

  return [
    args[0],
    '--v8-flags=--max-old-space-size=8192',
    ...args.slice(1),
  ];
}

export function buildDiagnosticsWorkerArgs(
  cliLaunch: ResolvedCliLaunch,
): readonly string[] {
  return buildHeapAdjustedDenoArgs(
    cliLaunch.command,
    buildCliArgs(cliLaunch, 'editor-worker'),
  );
}

export function buildEditorProjectArgs(
  cliLaunch: ResolvedCliLaunch,
  projectPath: string,
  filePath: string,
): readonly string[] {
  return buildHeapAdjustedDenoArgs(
    cliLaunch.command,
    [
      ...buildCliArgs(cliLaunch, 'editor-project'),
      '--project',
      projectPath,
      '--file',
      filePath,
      '--stdin-file',
    ],
  );
}

export function findNearestSoundscriptProject(filePath: string): string | undefined {
  let currentDirectory = path.dirname(filePath);
  while (true) {
    const soundscriptConfigPath = path.join(currentDirectory, 'tsconfig.soundscript.json');
    if (existsSync(soundscriptConfigPath)) {
      return soundscriptConfigPath;
    }

    const tsconfigPath = path.join(currentDirectory, 'tsconfig.json');
    if (existsSync(tsconfigPath)) {
      return tsconfigPath;
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }
    currentDirectory = parentDirectory;
  }
}

export function isLocalSoundscriptFile(filePath: string): boolean {
  if (isSoundscriptSourceFile(filePath)) {
    return true;
  }

  if (!isTypeScriptFamilySoundscriptAliasFile(filePath)) {
    return false;
  }

  const projectPath = findNearestSoundscriptProject(filePath);
  if (!projectPath) {
    return false;
  }

  return getProjectSoundscriptMatcher(projectPath)(filePath);
}

export function runEditorProjectSnapshot(
  cliLaunch: ResolvedCliLaunch,
  projectPath: string,
  filePath: string,
  sourceText: string,
): EditorProjectSnapshot {
  const result = spawnSync(
    cliLaunch.command,
    buildEditorProjectArgs(cliLaunch, projectPath, filePath),
    {
      encoding: 'utf8',
      input: sourceText,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'editor-project command failed.');
  }

  const payload = JSON.parse(result.stdout) as EditorProjectSnapshot;
  if (payload.command !== 'editor-project') {
    throw new Error('editor-project returned an invalid payload.');
  }
  return payload;
}

export function spawnDiagnosticsWorker(
  cliLaunch: ResolvedCliLaunch,
  cwd: string,
): DiagnosticsWorkerChildProcess {
  return spawn(
    cliLaunch.command,
    [...buildDiagnosticsWorkerArgs(cliLaunch)],
    {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
}
