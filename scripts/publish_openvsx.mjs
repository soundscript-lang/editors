import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vscodePackageDirectory = join(root, 'packages', 'vscode');
const vscodeManifest = JSON.parse(readFileSync(join(vscodePackageDirectory, 'package.json'), 'utf8'));
const vsixPath = join(vscodePackageDirectory, `soundscript-vscode-${vscodeManifest.version}.vsix`);

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

export function createOpenVsxPublishArgs(vsixFilePath, env = process.env) {
  const args = ['--yes', 'ovsx', 'publish', vsixFilePath];
  const token = env.SOUNDSCRIPT_OPENVSX_TOKEN ?? env.OVSX_PAT;
  if (typeof token === 'string' && token.length > 0) {
    args.push('-p', token);
  }
  return args;
}

if (import.meta.main) {
  if (process.env.SOUNDSCRIPT_SKIP_PACKAGE_VSCODE !== '1') {
    run('npm', ['run', 'package:vscode']);
  }
  run('npx', createOpenVsxPublishArgs(vsixPath));
}
