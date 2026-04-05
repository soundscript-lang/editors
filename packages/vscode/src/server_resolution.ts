import * as path from 'node:path';
import { readFileSync } from 'node:fs';

export type ServerLaunchSource = 'configured' | 'development' | 'global' | 'workspace';

export interface ResolvedServerLaunch {
  args: string[];
  command: string;
  source: ServerLaunchSource;
}

export interface ResolvedCliLaunch {
  argsPrefix: string[];
  command: string;
  source: Exclude<ServerLaunchSource, 'configured'>;
}

export interface ResolveServerLaunchOptions {
  configuredArgs?: string[];
  configuredCommand?: string;
  extensionMode: 'development' | 'production';
  extensionPath: string;
  existsSync: (candidatePath: string) => boolean;
  homeDir?: string;
  pathEnv?: string;
  platform: NodeJS.Platform;
  workspaceFolders: readonly string[];
}

export interface ResolvedWorkspaceSoundscriptPackage {
  packageJsonPath: string;
  version: string;
  workspaceFolder: string;
}

function resolveDevelopmentMainEntry(extensionPath: string): string {
  return path.resolve(extensionPath, '..', '..', '..', 'soundscript', 'src', 'main.ts');
}

export function resolveDevelopmentServerArgs(extensionPath: string): string[] {
  const mainEntry = resolveDevelopmentMainEntry(extensionPath);
  return ['run', '-A', mainEntry, 'lsp'];
}

export function resolveDevelopmentCliArgs(extensionPath: string): string[] {
  const mainEntry = resolveDevelopmentMainEntry(extensionPath);
  return ['run', '-A', mainEntry];
}

function getDenoExecutableCandidates(
  platform: NodeJS.Platform,
  homeDir: string | undefined,
): string[] {
  if (platform === 'win32') {
    const candidates: string[] = [];
    if (homeDir) {
      candidates.push(path.win32.join(homeDir, '.deno', 'bin', 'deno.exe'));
    }
    return candidates;
  }

  const candidates = [
    '/opt/homebrew/bin/deno',
    '/usr/local/bin/deno',
    '/usr/bin/deno',
  ];
  if (homeDir) {
    candidates.unshift(path.posix.join(homeDir, '.deno', 'bin', 'deno'));
  }
  return candidates;
}

function resolveDevelopmentDenoCommand(
  pathEnv: string | undefined,
  platform: NodeJS.Platform,
  existsSync: (candidatePath: string) => boolean,
  homeDir: string | undefined,
): string | undefined {
  const pathExecutable = findExecutableOnPath(
    'deno',
    pathEnv,
    platform,
    existsSync,
  );
  if (pathExecutable) {
    return pathExecutable;
  }

  for (const candidate of getDenoExecutableCandidates(platform, homeDir)) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function getPathApi(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === 'win32' ? path.win32 : path.posix;
}

function getWorkspaceBinaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'soundscript.cmd' : 'soundscript';
}

function getPathExecutableCandidates(
  executableName: string,
  platform: NodeJS.Platform,
): string[] {
  if (platform !== 'win32') {
    return [executableName];
  }

  return [
    executableName,
    `${executableName}.cmd`,
    `${executableName}.exe`,
  ];
}

function getDefaultServerArgs(
  configuredArgs: readonly string[] | undefined,
  extensionMode: 'development' | 'production',
  extensionPath: string,
): string[] {
  if (configuredArgs && configuredArgs.length > 0) {
    return [...configuredArgs];
  }

  return extensionMode === 'development'
    ? resolveDevelopmentServerArgs(extensionPath)
    : ['lsp'];
}

export function resolveWorkspaceServerCommand(
  workspaceFolders: readonly string[],
  platform: NodeJS.Platform,
  existsSync: (candidatePath: string) => boolean,
): string | undefined {
  const binaryName = getWorkspaceBinaryName(platform);
  const pathApi = getPathApi(platform);

  for (const workspaceFolder of workspaceFolders) {
    const candidatePath = pathApi.join(
      workspaceFolder,
      'node_modules',
      '.bin',
      binaryName,
    );
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return undefined;
}

export function resolveWorkspaceSoundscriptPackage(
  workspaceFolders: readonly string[],
  platform: NodeJS.Platform,
  existsSync: (candidatePath: string) => boolean,
  readTextFile: (candidatePath: string) => string = (candidatePath) => readFileSync(candidatePath, 'utf8'),
): ResolvedWorkspaceSoundscriptPackage | undefined {
  const pathApi = getPathApi(platform);

  for (const workspaceFolder of workspaceFolders) {
    const packageJsonPath = pathApi.join(
      workspaceFolder,
      'node_modules',
      '@soundscript',
      'soundscript',
      'package.json',
    );
    if (!existsSync(packageJsonPath)) {
      continue;
    }

    try {
      const manifest = JSON.parse(readTextFile(packageJsonPath)) as { version?: unknown };
      if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
        continue;
      }
      return {
        packageJsonPath,
        version: manifest.version,
        workspaceFolder,
      };
    } catch {
      continue;
    }
  }

  return undefined;
}

function parseReleaseVersion(version: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version.trim());
  if (!match) {
    return undefined;
  }

  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
}

export function compareReleaseVersions(left: string, right: string): number | undefined {
  const parsedLeft = parseReleaseVersion(left);
  const parsedRight = parseReleaseVersion(right);
  if (!parsedLeft || !parsedRight) {
    return undefined;
  }

  for (let index = 0; index < parsedLeft.length; index += 1) {
    const difference = parsedLeft[index]! - parsedRight[index]!;
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

export function findExecutableOnPath(
  executableName: string,
  pathEnv: string | undefined,
  platform: NodeJS.Platform,
  existsSync: (candidatePath: string) => boolean,
): string | undefined {
  if (!pathEnv) {
    return undefined;
  }

  const pathApi = getPathApi(platform);
  const candidates = getPathExecutableCandidates(executableName, platform);
  for (const directory of pathEnv.split(pathApi.delimiter)) {
    if (directory.length === 0) {
      continue;
    }

    for (const candidate of candidates) {
      const candidatePath = pathApi.join(directory, candidate);
      if (existsSync(candidatePath)) {
        return candidatePath;
      }
    }
  }

  return undefined;
}

export function resolveServerLaunch(
  options: ResolveServerLaunchOptions,
): ResolvedServerLaunch | undefined {
  const args = getDefaultServerArgs(
    options.configuredArgs,
    options.extensionMode,
    options.extensionPath,
  );

  if (options.configuredCommand && options.configuredCommand.length > 0) {
    return {
      args,
      command: options.configuredCommand,
      source: 'configured',
    };
  }

  if (options.extensionMode === 'development') {
    const developmentDeno = resolveDevelopmentDenoCommand(
      options.pathEnv,
      options.platform,
      options.existsSync,
      options.homeDir,
    );
    if (!developmentDeno) {
      return undefined;
    }
    return {
      args,
      command: developmentDeno,
      source: 'development',
    };
  }

  const workspaceCommand = resolveWorkspaceServerCommand(
    options.workspaceFolders,
    options.platform,
    options.existsSync,
  );
  if (workspaceCommand) {
    return {
      args,
      command: workspaceCommand,
      source: 'workspace',
    };
  }

  const globalCommand = findExecutableOnPath(
    'soundscript',
    options.pathEnv,
    options.platform,
    options.existsSync,
  );
  if (globalCommand) {
    return {
      args,
      command: globalCommand,
      source: 'global',
    };
  }

  return undefined;
}

export function resolveCliLaunch(
  options: Omit<ResolveServerLaunchOptions, 'configuredArgs' | 'configuredCommand'>,
): ResolvedCliLaunch | undefined {
  if (options.extensionMode === 'development') {
    const developmentDeno = resolveDevelopmentDenoCommand(
      options.pathEnv,
      options.platform,
      options.existsSync,
      options.homeDir,
    );
    if (!developmentDeno) {
      return undefined;
    }
    return {
      argsPrefix: resolveDevelopmentCliArgs(options.extensionPath),
      command: developmentDeno,
      source: 'development',
    };
  }

  const workspaceCommand = resolveWorkspaceServerCommand(
    options.workspaceFolders,
    options.platform,
    options.existsSync,
  );
  if (workspaceCommand) {
    return {
      argsPrefix: [],
      command: workspaceCommand,
      source: 'workspace',
    };
  }

  const globalCommand = findExecutableOnPath(
    'soundscript',
    options.pathEnv,
    options.platform,
    options.existsSync,
  );
  if (globalCommand) {
    return {
      argsPrefix: [],
      command: globalCommand,
      source: 'global',
    };
  }

  return undefined;
}
