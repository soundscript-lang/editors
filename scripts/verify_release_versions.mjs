import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(root, relativePath), 'utf8'));
}

const tsserverPlugin = readJson('packages/tsserver-plugin/package.json');
const vscodeExtension = readJson('packages/vscode/package.json');
const packageLock = readJson('package-lock.json');

assert.equal(
  tsserverPlugin.version,
  vscodeExtension.version,
  'tsserver-plugin and soundscript-vscode should use the same release version.',
);
assert.equal(
  vscodeExtension.dependencies?.['@soundscript/tsserver-plugin'],
  `^${tsserverPlugin.version}`,
  'soundscript-vscode should depend on the matching tsserver-plugin release line.',
);
assert.equal(
  packageLock.packages?.['packages/vscode']?.dependencies?.['@soundscript/tsserver-plugin'],
  `^${tsserverPlugin.version}`,
  'package-lock.json should pin soundscript-vscode to the matching tsserver-plugin release line.',
);

console.log(
  JSON.stringify(
    {
      releaseVersion: tsserverPlugin.version,
      packages: [tsserverPlugin.name, vscodeExtension.name],
      lockfileDependency: packageLock.packages?.['packages/vscode']?.dependencies?.['@soundscript/tsserver-plugin'],
    },
    null,
    2,
  ),
);
