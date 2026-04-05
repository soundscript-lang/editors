export interface DocumentLike {
  languageId: string;
  uri: unknown;
}

export type TypeScriptServerStartupMode = 'projectInfo' | 'compilerOptions' | 'unavailable';

function describeError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function isMissingTsServerRequestCommand(error: unknown): boolean {
  const description = describeError(error);
  return description.includes('typescript.tsserverRequest') && description.includes('not found');
}

function toTsServerFileArgument(uri: unknown): unknown {
  if (typeof uri === 'string') {
    return uri;
  }

  if (uri && typeof uri === 'object' && 'fsPath' in uri && typeof uri.fsPath === 'string') {
    return uri.fsPath;
  }

  return uri;
}

function pickSoundscriptDocumentFileArgument(
  documents: readonly DocumentLike[],
  activeDocument?: DocumentLike,
): unknown {
  if (activeDocument?.languageId === 'soundscript') {
    return toTsServerFileArgument(activeDocument.uri);
  }

  const matchingDocument = documents.find((document) => document.languageId === 'soundscript');
  return matchingDocument ? toTsServerFileArgument(matchingDocument.uri) : undefined;
}

export async function ensureTypeScriptServerStarted(
  executeCommand: (command: string, ...args: unknown[]) => PromiseLike<unknown>,
  documents: readonly DocumentLike[],
  activeDocument?: DocumentLike,
): Promise<TypeScriptServerStartupMode> {
  const soundscriptFile = pickSoundscriptDocumentFileArgument(documents, activeDocument);
  if (soundscriptFile !== undefined) {
    try {
      await executeCommand('typescript.tsserverRequest', 'projectInfo', {
        file: soundscriptFile,
        needFileNameList: false,
      });
      return 'projectInfo';
    } catch (error) {
      if (isMissingTsServerRequestCommand(error)) {
        return 'unavailable';
      }
      // Fall through to a request that does not depend on a managed file.
    }
  }

  try {
    await executeCommand('typescript.tsserverRequest', 'compilerOptionsForInferredProjects', {
      options: {
        allowJs: true,
        allowNonTsExtensions: true,
      },
    });
    return 'compilerOptions';
  } catch (error) {
    if (isMissingTsServerRequestCommand(error)) {
      return 'unavailable';
    }
    throw error;
  }
}
