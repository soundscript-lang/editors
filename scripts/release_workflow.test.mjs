import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workflowText = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8');

test('release workflow enables npm trusted publishing and publishes the tsserver plugin', () => {
  assert.equal(workflowText.includes('id-token: write'), true);
  assert.equal(workflowText.includes('registry-url: https://registry.npmjs.org'), true);
  assert.equal(workflowText.includes('npm run release:publish'), true);
  assert.equal(workflowText.includes("SOUNDSCRIPT_SKIP_VSCODE_PUBLISH: '1'"), true);
});

test('release workflow builds the VSIX before trying to upload it to GitHub releases', () => {
  assert.equal(workflowText.includes('name: Build and verify the VSIX'), true);
  assert.equal(workflowText.includes('run: npm run package:vscode'), true);
  assert.equal(
    workflowText.indexOf('run: npm run package:vscode') <
      workflowText.indexOf('gh release upload "$RELEASE_TAG" "$VSIX_PATH" --clobber'),
    true,
  );
});

test('release workflow can create or update the GitHub release before uploading the VSIX', () => {
  assert.equal(workflowText.includes('gh release create "$RELEASE_TAG"'), true);
  assert.equal(workflowText.includes('gh release edit "$RELEASE_TAG"'), true);
});
