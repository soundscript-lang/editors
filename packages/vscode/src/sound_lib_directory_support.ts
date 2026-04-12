import { existsSync } from 'node:fs';
import path from 'node:path';

const SOUNDSCRIPT_BUNDLED_LIB_RELATIVE_DIRECTORIES = [
  path.join('src', 'bundled', 'typescript', 'lib'),
  path.join('src', 'bundled', 'sound-libs'),
] as const;

export function looksLikeSoundscriptBundledLibDirectory(directoryPath: string): boolean {
  return existsSync(path.join(directoryPath, 'lib.es5.d.ts'));
}

export function resolveBundledLibDirectoryFromSoundscriptPackageRoot(
  soundscriptPackageRoot: string,
): string | undefined {
  for (const relativeDirectory of SOUNDSCRIPT_BUNDLED_LIB_RELATIVE_DIRECTORIES) {
    const candidate = path.join(soundscriptPackageRoot, relativeDirectory);
    if (looksLikeSoundscriptBundledLibDirectory(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

export function resolveBundledLibDirectoryFromPackageRoots(
  soundscriptPackageRoots: readonly string[],
): string | undefined {
  for (const soundscriptPackageRoot of soundscriptPackageRoots) {
    const candidate = resolveBundledLibDirectoryFromSoundscriptPackageRoot(soundscriptPackageRoot);
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}

export function resolveBundledLibDirectoryFromSiblingCheckouts(
  searchFromDirectory: string,
  checkoutDirectoryNames: readonly string[],
  maxAscents = 4,
): string | undefined {
  const packageRoots: string[] = [];
  let currentDirectory = searchFromDirectory;

  for (let ascent = 0; ascent <= maxAscents; ascent += 1) {
    for (const checkoutDirectoryName of checkoutDirectoryNames) {
      packageRoots.push(path.join(currentDirectory, checkoutDirectoryName));
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      break;
    }
    currentDirectory = parentDirectory;
  }

  return resolveBundledLibDirectoryFromPackageRoots(packageRoots);
}
