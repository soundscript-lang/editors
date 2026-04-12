import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import {
  resolveBundledLibDirectoryFromPackageRoots,
  resolveBundledLibDirectoryFromSiblingCheckouts,
} from './sound_lib_directory_support';

const overrideContentsByDirectory = new Map<string, ReadonlyMap<string, string>>();

function normalizePathForComparison(filePath: string): string {
  const normalized = path.normalize(filePath);
  return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
}

function looksLikeSoundLibDirectory(directoryPath: string): boolean {
  return existsSync(path.join(directoryPath, 'lib.es5.d.ts'));
}

function searchWorkspacePackageSoundLibs(searchFromPath: string): string | undefined {
  let currentDirectory = path.dirname(searchFromPath);
  while (true) {
    const candidate = resolveBundledLibDirectoryFromPackageRoots([
      path.join(currentDirectory, 'node_modules', '@soundscript', 'soundscript'),
    ]);
    if (candidate && looksLikeSoundLibDirectory(candidate)) {
      return candidate;
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }
    currentDirectory = parentDirectory;
  }
}

function candidateOverrideDirectories(searchFromPath: string): readonly string[] {
  return [
    searchWorkspacePackageSoundLibs(searchFromPath),
    path.resolve(__dirname, '..', 'sound-libs'),
    resolveBundledLibDirectoryFromSiblingCheckouts(__dirname, ['soundscript', 'soundscript-core']),
  ].filter((candidate): candidate is string => typeof candidate === 'string');
}

function loadOverrideContents(directoryPath: string): ReadonlyMap<string, string> {
  const cached = overrideContentsByDirectory.get(directoryPath);
  if (cached) {
    return cached;
  }

  const contents = new Map<string, string>();
  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith('lib.') || !entry.name.endsWith('.d.ts')) {
      continue;
    }
    contents.set(entry.name, readFileSync(path.join(directoryPath, entry.name), 'utf8'));
  }

  overrideContentsByDirectory.set(directoryPath, contents);
  return contents;
}

export function resolveSoundscriptLibOverrideDirectory(searchFromPath: string): string | undefined {
  for (const candidate of candidateOverrideDirectories(searchFromPath)) {
    if (looksLikeSoundLibDirectory(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

export function createSoundscriptLibOverrides(
  compilerOptions: ts.CompilerOptions,
  searchFromPath: string,
): {
  fileExists(fileName: string): boolean;
  readFile(fileName: string): string | undefined;
  resolveFile(fileName: string): string | undefined;
} {
  const overrideDirectory = resolveSoundscriptLibOverrideDirectory(searchFromPath);
  if (!overrideDirectory) {
    return {
      fileExists: () => false,
      readFile: () => undefined,
      resolveFile: () => undefined,
    };
  }

  const resolvedOverrideDirectory = overrideDirectory;
  const overrideContents = loadOverrideContents(overrideDirectory);
  const normalizedDefaultLibDirectory = normalizePathForComparison(
    path.dirname(ts.getDefaultLibFilePath(compilerOptions)),
  );

  function resolveOverrideFile(fileName: string): string | undefined {
    const baseName = path.basename(fileName);
    if (!overrideContents.has(baseName)) {
      return undefined;
    }

    const normalizedFileName = normalizePathForComparison(fileName);
    if (!normalizedFileName.startsWith(normalizedDefaultLibDirectory)) {
      return undefined;
    }

    return path.join(resolvedOverrideDirectory, baseName);
  }

  function readOverride(fileName: string): string | undefined {
    const overrideFile = resolveOverrideFile(fileName);
    if (!overrideFile) {
      return undefined;
    }
    return overrideContents.get(path.basename(overrideFile));
  }

  return {
    fileExists(fileName) {
      return readOverride(fileName) !== undefined;
    },
    readFile(fileName) {
      return readOverride(fileName);
    },
    resolveFile(fileName) {
      return resolveOverrideFile(fileName);
    },
  };
}
