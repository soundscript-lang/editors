import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import * as path from 'node:path';

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
