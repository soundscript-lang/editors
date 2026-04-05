import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const packageDir = path.join(repoRoot, 'packages', 'tsserver-plugin');

const packOutput = execFileSync('npm', ['pack', '--json', '--dry-run'], {
  cwd: packageDir,
  encoding: 'utf8',
});
const [packResult] = JSON.parse(packOutput);

if (!packResult) {
  throw new Error('npm pack --json --dry-run did not return a result');
}

const includedFiles = new Set(packResult.files.map((file) => file.path));
const requiredFiles = [
  'LICENSE',
  'README.md',
  'index.js',
  'lsp_helper_client.js',
  'package.json',
  'projection_support.js',
];
const excludedFiles = [
  'index.test.js',
  'lsp_helper_client.test.js',
];

for (const requiredFile of requiredFiles) {
  if (!includedFiles.has(requiredFile)) {
    throw new Error(`packed tsserver-plugin is missing ${requiredFile}`);
  }
}

for (const excludedFile of excludedFiles) {
  if (includedFiles.has(excludedFile)) {
    throw new Error(`packed tsserver-plugin unexpectedly includes ${excludedFile}`);
  }
}

if (packResult.entryCount !== requiredFiles.length) {
  throw new Error(
    `expected ${requiredFiles.length} packed entries, got ${packResult.entryCount}`,
  );
}

console.log(
  JSON.stringify(
    {
      package: packResult.id,
      verifiedFiles: requiredFiles,
    },
    null,
    2,
  ),
);
