import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vscodePackageJsonPath = join(root, 'packages', 'vscode', 'package.json');
const vscodePackageJson = JSON.parse(readFileSync(vscodePackageJsonPath, 'utf8'));
const vsixPath = join(
  root,
  'packages',
  'vscode',
  `soundscript-vscode-${vscodePackageJson.version}.vsix`,
);

assert.equal(existsSync(vsixPath), true, `Missing VSIX artifact at ${vsixPath}`);

const archiveEntries = new Set(
  execFileSync('unzip', ['-Z1', vsixPath], { encoding: 'utf8' })
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean),
);

for (const requiredEntry of [
  'extension/package.json',
  'extension/out/extension.js',
  'extension/node_modules/@soundscript/tsserver-plugin/package.json',
  'extension/node_modules/@soundscript/tsserver-plugin/index.js',
  'extension/node_modules/@soundscript/tsserver-plugin/lsp_helper_client.js',
  'extension/node_modules/@soundscript/tsserver-plugin/projection_support.js',
  'extension/node_modules/typescript/package.json',
  'extension/node_modules/typescript/lib/typescript.js',
]) {
  assert.equal(
    archiveEntries.has(requiredEntry),
    true,
    `Expected ${requiredEntry} to be packaged in the VSIX.`,
  );
}

for (const excludedEntry of [
  'extension/out/server_resolution.test.js',
  'extension/out/editor_process_support.test.js',
  'extension/out/mixed_smoke.js',
  'extension/node_modules/@soundscript/tsserver-plugin/index.test.js',
  'extension/node_modules/@soundscript/tsserver-plugin/lsp_helper_client.test.js',
]) {
  assert.equal(
    archiveEntries.has(excludedEntry),
    false,
    `Did not expect ${excludedEntry} to be packaged in the VSIX.`,
  );
}

const stagedExtensionPackageJson = JSON.parse(
  execFileSync('unzip', ['-p', vsixPath, 'extension/package.json'], { encoding: 'utf8' }),
);
assert.equal(stagedExtensionPackageJson.scripts, undefined);
assert.equal(stagedExtensionPackageJson.devDependencies, undefined);
assert.equal(stagedExtensionPackageJson.dependencies?.typescript, '^5.9.3');

const stagedPluginPackageJson = JSON.parse(
  execFileSync('unzip', ['-p', vsixPath, 'extension/node_modules/@soundscript/tsserver-plugin/package.json'], {
    encoding: 'utf8',
  }),
);
assert.equal(stagedPluginPackageJson.peerDependencies, undefined);

console.log(
  JSON.stringify(
    {
      vsixPath,
      verifiedEntries: [
        'extension/package.json',
        'extension/out/extension.js',
        'extension/node_modules/@soundscript/tsserver-plugin/package.json',
      ],
    },
    null,
    2,
  ),
);
