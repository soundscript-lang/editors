import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tsserverPluginDirectory = 'packages/tsserver-plugin';
const registryVerifyAttempts = 12;
const registryVerifyDelayMs = 5000;

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed in ${cwd}.`);
  }
}

function runCapture(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    throw new Error(
      `${command} ${args.join(' ')} failed in ${cwd}.${stderr ? `\n${stderr}` : stdout ? `\n${stdout}` : ''}`,
    );
  }
  return result.stdout.trim();
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readManifest(directory) {
  return JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8'));
}

export function createPublishArgs(access, env = process.env) {
  const args = access === 'public' ? ['publish', '--access', 'public'] : ['publish'];
  const otp = env.SOUNDSCRIPT_NPM_OTP ?? env.NPM_CONFIG_OTP;
  if (typeof otp === 'string' && otp.length > 0) {
    args.push('--otp', otp);
  }
  return args;
}

function waitForPublishedVersion(packageName, version) {
  for (let attempt = 1; attempt <= registryVerifyAttempts; attempt += 1) {
    const result = spawnSync('npm', ['view', packageName, 'version'], {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status === 0 && result.stdout.trim() === version) {
      return;
    }
    if (attempt < registryVerifyAttempts) {
      sleep(registryVerifyDelayMs);
    }
  }
  throw new Error(`Published package ${packageName}@${version} did not become visible on npm.`);
}

const tsserverPluginManifest = readManifest(tsserverPluginDirectory);

if (import.meta.main) {
  run('npm', createPublishArgs('public'), join(root, tsserverPluginDirectory));
  waitForPublishedVersion(tsserverPluginManifest.name, tsserverPluginManifest.version);
  if (process.env.SOUNDSCRIPT_SKIP_VSCODE_PUBLISH !== '1') {
    run('npm', ['--workspace', 'soundscript-vscode', 'run', 'publish']);
  }
}
