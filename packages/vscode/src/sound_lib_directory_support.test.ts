import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  resolveBundledLibDirectoryFromPackageRoots,
  resolveBundledLibDirectoryFromSoundscriptPackageRoot,
} from './sound_lib_directory_support';

test('resolveBundledLibDirectoryFromSoundscriptPackageRoot supports the current soundscript bundled lib layout', () => {
  const packageRoot = mkdtempSync(path.join(os.tmpdir(), 'soundscript-bundled-libs-current-'));
  const bundledLibDirectory = path.join(packageRoot, 'src', 'bundled', 'typescript', 'lib');
  mkdirSync(bundledLibDirectory, { recursive: true });
  writeFileSync(path.join(bundledLibDirectory, 'lib.es5.d.ts'), 'declare interface Object {}\n');

  assert.equal(
    resolveBundledLibDirectoryFromSoundscriptPackageRoot(packageRoot),
    bundledLibDirectory,
  );
});

test('resolveBundledLibDirectoryFromSoundscriptPackageRoot falls back to the legacy sound-libs layout', () => {
  const packageRoot = mkdtempSync(path.join(os.tmpdir(), 'soundscript-bundled-libs-legacy-'));
  const bundledLibDirectory = path.join(packageRoot, 'src', 'bundled', 'sound-libs');
  mkdirSync(bundledLibDirectory, { recursive: true });
  writeFileSync(path.join(bundledLibDirectory, 'lib.es5.d.ts'), 'declare interface Object {}\n');

  assert.equal(
    resolveBundledLibDirectoryFromSoundscriptPackageRoot(packageRoot),
    bundledLibDirectory,
  );
});

test('resolveBundledLibDirectoryFromPackageRoots returns the first matching package root', () => {
  const missingRoot = mkdtempSync(path.join(os.tmpdir(), 'soundscript-bundled-libs-missing-'));
  const packageRoot = mkdtempSync(path.join(os.tmpdir(), 'soundscript-bundled-libs-roots-'));
  const bundledLibDirectory = path.join(packageRoot, 'src', 'bundled', 'typescript', 'lib');
  mkdirSync(bundledLibDirectory, { recursive: true });
  writeFileSync(path.join(bundledLibDirectory, 'lib.es5.d.ts'), 'declare interface Object {}\n');

  assert.equal(
    resolveBundledLibDirectoryFromPackageRoots([missingRoot, packageRoot]),
    bundledLibDirectory,
  );
});
