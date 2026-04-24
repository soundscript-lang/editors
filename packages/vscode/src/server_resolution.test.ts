import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareReleaseVersions,
  findExecutableOnPath,
  resolveCliLaunchForProject,
  resolveCliLaunch,
  resolveDevelopmentCliArgs,
  resolveNearestWorkspaceServerCommand,
  resolveNearestWorkspaceSoundscriptPackage,
  resolveServerLaunch,
  resolveWorkspaceServerCommand,
  resolveWorkspaceSoundscriptPackage,
} from './server_resolution';

test('resolveWorkspaceServerCommand prefers a workspace-installed binary', () => {
  const resolved = resolveWorkspaceServerCommand(
    ['/workspace/app'],
    'darwin',
    (candidatePath) => candidatePath === '/workspace/app/node_modules/.bin/soundscript',
  );

  assert.equal(resolved, '/workspace/app/node_modules/.bin/soundscript');
});

test('resolveWorkspaceServerCommand uses the Windows .cmd shim', () => {
  const resolved = resolveWorkspaceServerCommand(
    ['C:\\workspace\\app'],
    'win32',
    (candidatePath) => candidatePath === 'C:\\workspace\\app\\node_modules\\.bin\\soundscript.cmd',
  );

  assert.equal(resolved, 'C:\\workspace\\app\\node_modules\\.bin\\soundscript.cmd');
});

test('resolveNearestWorkspaceServerCommand finds a nested package install from a project config', () => {
  const resolved = resolveNearestWorkspaceServerCommand(
    '/workspace/repo/packages/backend/tsconfig.json',
    'darwin',
    (candidatePath) =>
      candidatePath === '/workspace/repo/packages/backend/node_modules/.bin/soundscript',
  );

  assert.equal(resolved, '/workspace/repo/packages/backend/node_modules/.bin/soundscript');
});

test('findExecutableOnPath resolves a global soundscript binary from PATH', () => {
  const resolved = findExecutableOnPath(
    'soundscript',
    '/usr/local/bin:/usr/bin',
    'linux',
    (candidatePath) => candidatePath === '/usr/local/bin/soundscript',
  );

  assert.equal(resolved, '/usr/local/bin/soundscript');
});

test('resolveServerLaunch prefers a workspace install over the global PATH binary', () => {
  const resolved = resolveServerLaunch({
    configuredArgs: undefined,
    configuredCommand: undefined,
    extensionMode: 'production',
    extensionPath: '/extension',
    pathEnv: '/usr/local/bin:/usr/bin',
    platform: 'linux',
    workspaceFolders: ['/workspace/app'],
    existsSync: (candidatePath) =>
      candidatePath === '/workspace/app/node_modules/.bin/soundscript' ||
      candidatePath === '/usr/local/bin/soundscript',
  });

  assert.deepEqual(resolved, {
    args: ['lsp'],
    command: '/workspace/app/node_modules/.bin/soundscript',
    source: 'workspace',
  });
});

test('resolveServerLaunch falls back to a configured command before workspace/global lookup', () => {
  const resolved = resolveServerLaunch({
    configuredArgs: ['custom', 'lsp'],
    configuredCommand: '/custom/soundscript',
    extensionMode: 'production',
    extensionPath: '/extension',
    pathEnv: '/usr/local/bin:/usr/bin',
    platform: 'linux',
    workspaceFolders: ['/workspace/app'],
    existsSync: () => false,
  });

  assert.deepEqual(resolved, {
    args: ['custom', 'lsp'],
    command: '/custom/soundscript',
    source: 'configured',
  });
});

test('resolveServerLaunch uses an absolute Deno path in development mode', () => {
  const resolved = resolveServerLaunch({
    configuredArgs: undefined,
    configuredCommand: undefined,
    extensionMode: 'development',
    extensionPath: '/repo/editors/packages/vscode',
    pathEnv: '/opt/homebrew/bin:/usr/bin',
    platform: 'darwin',
    workspaceFolders: ['/workspace/app'],
    existsSync: (candidatePath) => candidatePath === '/opt/homebrew/bin/deno',
  });

  assert.deepEqual(resolved, {
    args: ['run', '-A', '/repo/soundscript/src/main.ts', 'lsp'],
    command: '/opt/homebrew/bin/deno',
    source: 'development',
  });
});

test('resolveDevelopmentCliArgs uses the repo-local Deno launcher without the lsp subcommand', () => {
  assert.deepEqual(resolveDevelopmentCliArgs('/repo/editors/packages/vscode'), [
    'run',
    '-A',
    '/repo/soundscript/src/main.ts',
  ]);
});

test('resolveCliLaunch prefers a workspace install in production mode', () => {
  const resolved = resolveCliLaunch({
    extensionMode: 'production',
    extensionPath: '/extension',
    pathEnv: '/usr/local/bin:/usr/bin',
    platform: 'linux',
    workspaceFolders: ['/workspace/app'],
    existsSync: (candidatePath) =>
      candidatePath === '/workspace/app/node_modules/.bin/soundscript' ||
      candidatePath === '/usr/local/bin/soundscript',
  });

  assert.deepEqual(resolved, {
    argsPrefix: [],
    command: '/workspace/app/node_modules/.bin/soundscript',
    source: 'workspace',
  });
});

test('resolveCliLaunchForProject prefers a nested project install over global PATH', () => {
  const resolved = resolveCliLaunchForProject(
    {
      extensionMode: 'production',
      extensionPath: '/extension',
      pathEnv: '/usr/local/bin:/usr/bin',
      platform: 'linux',
      workspaceFolders: ['/workspace/repo'],
      existsSync: (candidatePath) =>
        candidatePath === '/workspace/repo/packages/backend/node_modules/.bin/soundscript' ||
        candidatePath === '/usr/local/bin/soundscript',
    },
    '/workspace/repo/packages/backend/tsconfig.json',
  );

  assert.deepEqual(resolved, {
    argsPrefix: [],
    command: '/workspace/repo/packages/backend/node_modules/.bin/soundscript',
    source: 'workspace',
  });
});

test('resolveCliLaunch uses an absolute Deno path in development mode', () => {
  const resolved = resolveCliLaunch({
    extensionMode: 'development',
    extensionPath: '/repo/editors/packages/vscode',
    pathEnv: '/opt/homebrew/bin:/usr/bin',
    platform: 'darwin',
    workspaceFolders: ['/workspace/app'],
    existsSync: (candidatePath) => candidatePath === '/opt/homebrew/bin/deno',
  });

  assert.deepEqual(resolved, {
    argsPrefix: ['run', '-A', '/repo/soundscript/src/main.ts'],
    command: '/opt/homebrew/bin/deno',
    source: 'development',
  });
});

test('resolveCliLaunch falls back to the standard user Deno install location in development mode', () => {
  const resolved = resolveCliLaunch({
    extensionMode: 'development',
    extensionPath: '/repo/editors/packages/vscode',
    homeDir: '/Users/jake',
    pathEnv: undefined,
    platform: 'darwin',
    workspaceFolders: ['/workspace/app'],
    existsSync: (candidatePath) => candidatePath === '/Users/jake/.deno/bin/deno',
  });

  assert.deepEqual(resolved, {
    argsPrefix: ['run', '-A', '/repo/soundscript/src/main.ts'],
    command: '/Users/jake/.deno/bin/deno',
    source: 'development',
  });
});

test('resolveWorkspaceSoundscriptPackage reads the workspace package version', () => {
  const resolved = resolveWorkspaceSoundscriptPackage(
    ['/workspace/app'],
    'linux',
    (candidatePath) => candidatePath === '/workspace/app/node_modules/@soundscript/soundscript/package.json',
    () => JSON.stringify({ version: '0.1.2' }),
  );

  assert.deepEqual(resolved, {
    packageJsonPath: '/workspace/app/node_modules/@soundscript/soundscript/package.json',
    version: '0.1.2',
    workspaceFolder: '/workspace/app',
  });
});

test('resolveNearestWorkspaceSoundscriptPackage reads the nested project package version', () => {
  const resolved = resolveNearestWorkspaceSoundscriptPackage(
    '/workspace/repo/packages/backend/tsconfig.json',
    'linux',
    (candidatePath) =>
      candidatePath ===
        '/workspace/repo/packages/backend/node_modules/@soundscript/soundscript/package.json',
    () => JSON.stringify({ version: '0.1.42' }),
  );

  assert.deepEqual(resolved, {
    packageJsonPath: '/workspace/repo/packages/backend/node_modules/@soundscript/soundscript/package.json',
    version: '0.1.42',
    workspaceFolder: '/workspace/repo/packages/backend',
  });
});

test('compareReleaseVersions orders ordinary semver releases', () => {
  assert.equal(compareReleaseVersions('0.1.2', '0.1.3'), -1);
  assert.equal(compareReleaseVersions('0.1.3', '0.1.3'), 0);
  assert.equal(compareReleaseVersions('0.1.4', '0.1.3'), 1);
});

test('compareReleaseVersions tolerates a leading v and prerelease suffixes', () => {
  assert.equal(compareReleaseVersions('v0.1.3', '0.1.3'), 0);
  assert.equal(compareReleaseVersions('0.1.3-beta.1', '0.1.3'), 0);
});
