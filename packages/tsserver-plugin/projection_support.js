'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

function isDenoCommand(command) {
  const normalizedCommand = String(command).replace(/\\/gu, '/');
  return normalizedCommand.endsWith('/deno') || normalizedCommand.endsWith('/deno.exe');
}

function buildEditorProjectArgs(command, argsPrefix, fileName, projectPath) {
  const baseArgs = [...argsPrefix, 'editor-project', '--project', projectPath, '--file', fileName, '--stdin-file'];
  if (!isDenoCommand(command) || baseArgs[0] !== 'run') {
    return baseArgs;
  }
  if (baseArgs.some((argument) => typeof argument === 'string' && argument.startsWith('--v8-flags='))) {
    return baseArgs;
  }
  return [
    baseArgs[0],
    '--v8-flags=--max-old-space-size=8192',
    ...baseArgs.slice(1),
  ];
}

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function resolveProjectPath(fsApi, pathApi, projectName, fileName) {
  if (typeof projectName === 'string' && projectName.endsWith('.json') && fsApi.existsSync(projectName)) {
    return projectName;
  }

  let currentDirectory = pathApi.dirname(fileName);
  while (true) {
    const soundscriptConfigPath = pathApi.join(currentDirectory, 'tsconfig.soundscript.json');
    if (fsApi.existsSync(soundscriptConfigPath)) {
      return soundscriptConfigPath;
    }

    const tsconfigPath = pathApi.join(currentDirectory, 'tsconfig.json');
    if (fsApi.existsSync(tsconfigPath)) {
      return tsconfigPath;
    }

    const parentDirectory = pathApi.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }
    currentDirectory = parentDirectory;
  }
}

function encodeScriptSnapshotText(snapshot) {
  if (!snapshot) {
    return undefined;
  }

  const length = snapshot.getLength();
  return snapshot.getText(0, length);
}

function getWorkspaceBinaryName() {
  return process.platform === 'win32' ? 'soundscript.cmd' : 'soundscript';
}

function getPathExecutableCandidates(executableName) {
  if (process.platform !== 'win32') {
    return [executableName];
  }

  return [
    executableName,
    `${executableName}.cmd`,
    `${executableName}.exe`,
  ];
}

function findExecutableOnPath(fsApi, pathApi, executableName) {
  const pathEnv = process.env.PATH;
  if (!pathEnv) {
    return undefined;
  }

  const delimiter = typeof pathApi.delimiter === 'string' && pathApi.delimiter.length > 0
    ? pathApi.delimiter
    : path.delimiter;
  for (const directory of pathEnv.split(delimiter)) {
    if (!directory) {
      continue;
    }

    for (const candidate of getPathExecutableCandidates(executableName)) {
      const candidatePath = pathApi.join(directory, candidate);
      if (fsApi.existsSync(candidatePath)) {
        return candidatePath;
      }
    }
  }

  return undefined;
}

function collectResolutionRoots(pathApi, info, fileName) {
  const roots = [];
  const seen = new Set();
  const addRoot = (candidate) => {
    if (typeof candidate !== 'string' || candidate.length === 0) {
      return;
    }
    const normalized = candidate.endsWith('.json') ? pathApi.dirname(candidate) : candidate;
    if (seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    roots.push(normalized);
  };

  addRoot(pathApi.dirname(fileName));
  addRoot(info.project.getProjectName?.() ?? info.project.projectName);
  addRoot(info.project.getCurrentDirectory?.());
  return roots;
}

function resolveWorkspaceSoundscriptCommand(fsApi, pathApi, info, fileName) {
  const binaryName = getWorkspaceBinaryName();
  const visitedDirectories = new Set();

  for (const root of collectResolutionRoots(pathApi, info, fileName)) {
    let currentDirectory = root;
    while (typeof currentDirectory === 'string' && currentDirectory.length > 0) {
      if (visitedDirectories.has(currentDirectory)) {
        break;
      }
      visitedDirectories.add(currentDirectory);

      const candidatePath = pathApi.join(currentDirectory, 'node_modules', '.bin', binaryName);
      if (fsApi.existsSync(candidatePath)) {
        return candidatePath;
      }

      const parentDirectory = pathApi.dirname(currentDirectory);
      if (parentDirectory === currentDirectory) {
        break;
      }
      currentDirectory = parentDirectory;
    }
  }

  return findExecutableOnPath(fsApi, pathApi, 'soundscript');
}

function resolveEffectiveConfiguration(configuration, fsApi, pathApi, info, fileName) {
  if (configuration.soundscriptCommand) {
    return configuration;
  }

  const resolvedCommand = resolveWorkspaceSoundscriptCommand(fsApi, pathApi, info, fileName);
  if (!resolvedCommand) {
    return configuration;
  }

  return {
    ...configuration,
    soundscriptCommand: resolvedCommand,
  };
}

function createStagePreparedFile(projection) {
  return {
    originalText: projection.originalText,
    postRewriteStage: projection.postRewriteStage,
    rewriteResult: projection.rewriteStage,
    rewrittenText: projection.projectedText,
  };
}

function createVirtualModulePreparedFile(module) {
  if (typeof module.originalText !== 'string' || !module.rewriteStage) {
    return undefined;
  }

  return {
    originalText: module.originalText,
    postRewriteStage: module.postRewriteStage,
    rewriteResult: module.rewriteStage,
    rewrittenText: module.text,
  };
}

function isStdlibVirtualModule(module) {
  return typeof module.specifier === 'string' && module.specifier.startsWith('sts:');
}

function findAlignedLineMapping(lineMappings, position, direction) {
  if (!Array.isArray(lineMappings)) {
    return undefined;
  }

  for (const mapping of lineMappings) {
    const start = direction === 'original' ? mapping.originalStart : mapping.rewrittenStart;
    const end = direction === 'original' ? mapping.originalEnd : mapping.rewrittenEnd;
    if (position >= start && position <= end) {
      return mapping;
    }
  }

  return undefined;
}

function hasSufficientAlignedLineContext(stage, targetMapping, direction) {
  const lineMappings = stage.lineMappings;
  if (!Array.isArray(lineMappings) || lineMappings.length === 0) {
    return false;
  }

  const targetIndex = lineMappings.indexOf(targetMapping);
  if (targetIndex === -1) {
    return false;
  }

  const previousReplacementBoundary = [...stage.replacements]
    .filter((replacement) => {
      const start = direction === 'original'
        ? replacement.originalSpan.start
        : replacement.rewrittenSpan.start;
      const end = direction === 'original'
        ? replacement.originalSpan.end
        : replacement.rewrittenSpan.end;
      return end > start;
    })
    .map((replacement) =>
      direction === 'original' ? replacement.originalSpan.end : replacement.rewrittenSpan.end
    )
    .filter((end) =>
      end <= (direction === 'original' ? targetMapping.originalStart : targetMapping.rewrittenStart)
    )
    .at(-1);

  if (previousReplacementBoundary === undefined) {
    return true;
  }

  let alignedLinesSincePreviousRewrite = 0;
  for (let index = targetIndex; index >= 0; index -= 1) {
    const mapping = lineMappings[index];
    const mappingStart = direction === 'original' ? mapping.originalStart : mapping.rewrittenStart;
    if (mappingStart < previousReplacementBoundary) {
      break;
    }
    alignedLinesSincePreviousRewrite += 1;
  }

  return alignedLinesSincePreviousRewrite >= 1;
}

function mapSourcePositionThroughReplacementSegments(replacement, sourcePosition) {
  for (const segment of replacement.mappedSegments ?? []) {
    if (sourcePosition < segment.originalStart || sourcePosition >= segment.originalEnd) {
      continue;
    }

    return Math.min(
      segment.rewrittenEnd,
      segment.rewrittenStart + (sourcePosition - segment.originalStart),
    );
  }

  return undefined;
}

function mapProgramPositionThroughReplacementSegments(replacement, programPosition) {
  for (const segment of replacement.mappedSegments ?? []) {
    if (programPosition < segment.rewrittenStart || programPosition >= segment.rewrittenEnd) {
      continue;
    }

    return Math.min(
      segment.originalEnd,
      segment.originalStart + (programPosition - segment.rewrittenStart),
    );
  }

  return undefined;
}

function mapProgramPositionThroughReplacementBoundarySegments(replacement, programPosition, affinity) {
  for (const segment of replacement.mappedSegments ?? []) {
    const isInside = programPosition >= segment.rewrittenStart &&
      programPosition < segment.rewrittenEnd;
    const isExactEnd = affinity === 'end' && programPosition === segment.rewrittenEnd;
    if (!isInside && !isExactEnd) {
      continue;
    }

    const clampedProgramPosition = Math.min(programPosition, segment.rewrittenEnd);
    return Math.min(
      segment.originalEnd,
      segment.originalStart + (clampedProgramPosition - segment.rewrittenStart),
    );
  }

  return undefined;
}

function mapProgramRangeThroughReplacementSegments(intersectingReplacements, programStart, programEnd) {
  if (intersectingReplacements.length !== 1) {
    return null;
  }

  const [replacement] = intersectingReplacements;
  const mappedSegment = (replacement.mappedSegments ?? []).find((segment) =>
    programStart >= segment.rewrittenStart &&
    programEnd <= segment.rewrittenEnd
  );
  if (!mappedSegment) {
    return null;
  }

  const start = mappedSegment.originalStart + (programStart - mappedSegment.rewrittenStart);
  const end = mappedSegment.originalStart + (programEnd - mappedSegment.rewrittenStart);
  return {
    intersectsReplacement: false,
    start,
    end: Math.max(start, end),
  };
}

function mapProgramPositionToAlignedStageLine(stage, position) {
  const mapping = findAlignedLineMapping(stage.lineMappings, position, 'rewritten');
  if (!mapping) {
    return undefined;
  }

  const intersectsReplacement = stage.replacements.some((replacement) =>
    !(mapping.rewrittenEnd <= replacement.rewrittenSpan.start ||
      mapping.rewrittenStart >= replacement.rewrittenSpan.end)
  );
  if (intersectsReplacement) {
    return undefined;
  }

  if (!hasSufficientAlignedLineContext(stage, mapping, 'rewritten')) {
    return undefined;
  }

  return Math.min(
    mapping.originalEnd,
    mapping.originalStart + (position - mapping.rewrittenStart),
  );
}

function mapSourcePositionToAlignedStageLine(stage, position) {
  const mapping = findAlignedLineMapping(stage.lineMappings, position, 'original');
  if (!mapping) {
    return undefined;
  }

  const intersectsReplacement = stage.replacements.some((replacement) =>
    !(mapping.originalEnd <= replacement.originalSpan.start ||
      mapping.originalStart >= replacement.originalSpan.end)
  );
  if (intersectsReplacement) {
    return undefined;
  }

  if (!hasSufficientAlignedLineContext(stage, mapping, 'original')) {
    return undefined;
  }

  return Math.min(
    mapping.rewrittenEnd,
    mapping.rewrittenStart + (position - mapping.originalStart),
  );
}

function mapSourcePositionToStage(stage, sourcePosition) {
  for (const replacement of stage.replacements) {
    if (sourcePosition < replacement.originalSpan.start) {
      break;
    }
    if (sourcePosition < replacement.originalSpan.end) {
      const mappedSegmentPosition = mapSourcePositionThroughReplacementSegments(
        replacement,
        sourcePosition,
      );
      if (mappedSegmentPosition !== undefined) {
        return {
          insideReplacement: false,
          position: mappedSegmentPosition,
        };
      }
      return {
        insideReplacement: true,
        position: replacement.rewrittenSpan.start,
      };
    }
  }

  const alignedPosition = mapSourcePositionToAlignedStageLine(stage, sourcePosition);
  if (alignedPosition !== undefined) {
    return {
      insideReplacement: false,
      position: alignedPosition,
    };
  }

  let delta = 0;
  for (const replacement of stage.replacements) {
    if (sourcePosition < replacement.originalSpan.start) {
      return {
        insideReplacement: false,
        position: sourcePosition + delta,
      };
    }
    delta += (replacement.rewrittenSpan.end - replacement.rewrittenSpan.start) -
      (replacement.originalSpan.end - replacement.originalSpan.start);
  }

  return {
    insideReplacement: false,
    position: Math.min(sourcePosition + delta, stage.rewrittenText.length),
  };
}

function mapProgramPositionToStageSource(stage, programPosition) {
  const clampedPosition = Math.min(programPosition, stage.rewrittenText.length);
  for (const replacement of stage.replacements) {
    if (clampedPosition < replacement.rewrittenSpan.start) {
      break;
    }
    if (clampedPosition < replacement.rewrittenSpan.end) {
      const mappedSegmentPosition = mapProgramPositionThroughReplacementSegments(
        replacement,
        clampedPosition,
      );
      if (mappedSegmentPosition !== undefined) {
        return {
          insideReplacement: false,
          position: mappedSegmentPosition,
        };
      }
      return {
        insideReplacement: true,
        position: replacement.originalSpan.start,
      };
    }
  }

  const alignedPosition = mapProgramPositionToAlignedStageLine(stage, clampedPosition);
  if (alignedPosition !== undefined) {
    return {
      insideReplacement: false,
      position: alignedPosition,
    };
  }

  let delta = 0;
  for (const replacement of stage.replacements) {
    if (clampedPosition < replacement.rewrittenSpan.start) {
      return {
        insideReplacement: false,
        position: clampedPosition - delta,
      };
    }
    delta += (replacement.rewrittenSpan.end - replacement.rewrittenSpan.start) -
      (replacement.originalSpan.end - replacement.originalSpan.start);
  }

  return {
    insideReplacement: false,
    position: Math.max(0, clampedPosition - delta),
  };
}

function mapProgramPositionToStageSourceBoundary(stage, programPosition, affinity) {
  const clampedPosition = Math.min(programPosition, stage.rewrittenText.length);
  for (const replacement of stage.replacements) {
    if (clampedPosition < replacement.rewrittenSpan.start) {
      break;
    }
    if (clampedPosition < replacement.rewrittenSpan.end) {
      const mappedSegmentPosition = mapProgramPositionThroughReplacementBoundarySegments(
        replacement,
        clampedPosition,
        affinity,
      );
      if (mappedSegmentPosition !== undefined) {
        return mappedSegmentPosition;
      }
      return affinity === 'start' ? replacement.originalSpan.start : replacement.originalSpan.end;
    }
  }

  const alignedPosition = mapProgramPositionToAlignedStageLine(stage, clampedPosition);
  if (alignedPosition !== undefined) {
    return alignedPosition;
  }

  let delta = 0;
  for (const replacement of stage.replacements) {
    if (clampedPosition < replacement.rewrittenSpan.start) {
      return Math.max(0, clampedPosition - delta);
    }
    delta += (replacement.rewrittenSpan.end - replacement.rewrittenSpan.start) -
      (replacement.originalSpan.end - replacement.originalSpan.start);
  }

  return Math.max(0, clampedPosition - delta);
}

function mapProgramRangeToStageSource(stage, programStart, programEnd) {
  const clampedStart = Math.min(programStart, stage.rewrittenText.length);
  const clampedEnd = Math.min(programEnd, stage.rewrittenText.length);
  const intersectingReplacements = stage.replacements.filter((replacement) =>
    !(clampedEnd <= replacement.rewrittenSpan.start ||
      clampedStart >= replacement.rewrittenSpan.end)
  );

  if (intersectingReplacements.length > 0) {
    const preciselyMappedRange = mapProgramRangeThroughReplacementSegments(
      intersectingReplacements,
      clampedStart,
      clampedEnd,
    );
    if (preciselyMappedRange) {
      return preciselyMappedRange;
    }
    return {
      intersectsReplacement: true,
      start: intersectingReplacements[0].originalSpan.start,
      end: intersectingReplacements[intersectingReplacements.length - 1].originalSpan.end,
    };
  }

  const mappedStart = mapProgramPositionToStageSource(stage, clampedStart).position;
  const mappedEnd = mapProgramPositionToStageSource(stage, clampedEnd).position;

  return {
    intersectsReplacement: false,
    start: mappedStart,
    end: Math.max(mappedStart, mappedEnd),
  };
}

function mapSourcePositionToProjected(preparedFile, sourcePosition) {
  const stageOne = mapSourcePositionToStage(preparedFile.rewriteResult, sourcePosition);
  if (!preparedFile.postRewriteStage) {
    return stageOne;
  }

  const stageTwo = mapSourcePositionToStage(preparedFile.postRewriteStage, stageOne.position);
  return {
    insideReplacement: stageOne.insideReplacement || stageTwo.insideReplacement,
    position: stageTwo.position,
  };
}

function mapProjectedPositionToSource(preparedFile, programPosition) {
  const stageTwo = preparedFile.postRewriteStage
    ? mapProgramPositionToStageSource(preparedFile.postRewriteStage, programPosition)
    : {
      insideReplacement: false,
      position: Math.min(programPosition, preparedFile.rewriteResult.rewrittenText.length),
    };
  const stageOne = mapProgramPositionToStageSource(preparedFile.rewriteResult, stageTwo.position);
  return {
    insideReplacement: stageOne.insideReplacement || stageTwo.insideReplacement,
    position: stageOne.position,
  };
}

function mapProjectedEnclosingRangeToSource(preparedFile, programStart, programEnd) {
  const finalTextLength = preparedFile.rewrittenText.length;
  const clampedStart = Math.min(programStart, finalTextLength);
  const clampedEnd = Math.min(programEnd, finalTextLength);
  const stageTwo = preparedFile.postRewriteStage;
  const mappedStageTwo = stageTwo
    ? mapProgramRangeToStageSource(stageTwo, clampedStart, clampedEnd)
    : {
      intersectsReplacement: false,
      start: clampedStart,
      end: clampedEnd,
    };
  const mappedStart = stageTwo
    ? mapProgramPositionToStageSourceBoundary(stageTwo, clampedStart, 'start')
    : clampedStart;
  const mappedEnd = stageTwo
    ? mapProgramPositionToStageSourceBoundary(stageTwo, clampedEnd, 'end')
    : clampedEnd;
  const stageOneStart = mapProgramPositionToStageSourceBoundary(
    preparedFile.rewriteResult,
    mappedStart,
    'start',
  );
  const stageOneEnd = mapProgramPositionToStageSourceBoundary(
    preparedFile.rewriteResult,
    mappedEnd,
    'end',
  );

  return {
    intersectsReplacement: mappedStageTwo.intersectsReplacement,
    start: Math.min(preparedFile.originalText.length, stageOneStart),
    end: Math.min(preparedFile.originalText.length, Math.max(stageOneStart, stageOneEnd)),
  };
}

function createModuleResolutionHost(ts, baseHost, virtualFiles, currentDirectory) {
  return {
    directoryExists: baseHost.directoryExists?.bind(baseHost) ?? ts.sys.directoryExists,
    fileExists(fileName) {
      return virtualFiles.has(fileName) || baseHost.fileExists?.(fileName) || fs.existsSync(fileName);
    },
    getCurrentDirectory: baseHost.getCurrentDirectory?.bind(baseHost) ?? (() => currentDirectory),
    getDirectories: baseHost.getDirectories?.bind(baseHost) ?? ts.sys.getDirectories,
    readFile(fileName) {
      if (virtualFiles.has(fileName)) {
        return virtualFiles.get(fileName);
      }
      return baseHost.readFile?.(fileName) ?? ts.sys.readFile(fileName);
    },
    realpath: baseHost.realpath?.bind(baseHost) ?? ts.sys.realpath,
    useCaseSensitiveFileNames: () =>
      baseHost.useCaseSensitiveFileNames?.() ?? ts.sys.useCaseSensitiveFileNames,
  };
}

function getExtensionForModuleFileName(ts, fileName) {
  if (fileName.endsWith('.d.ts')) {
    return ts.Extension.Dts;
  }
  if (fileName.endsWith('.tsx')) {
    return ts.Extension.Tsx;
  }
  if (fileName.endsWith('.ts')) {
    return ts.Extension.Ts;
  }
  if (fileName.endsWith('.jsx')) {
    return ts.Extension.Jsx;
  }
  if (fileName.endsWith('.js')) {
    return ts.Extension.Js;
  }
  return ts.Extension.Ts;
}

function createProjectedLanguageService(ts, baseHost, projection, fileName, scriptVersion, stsScriptKind) {
  const lookupFileName = `${fileName}.${stsScriptKind === 'tsx' ? 'tsx' : 'ts'}`;
  const virtualFiles = new Map(
    projection.virtualModules.map((module) => [module.fileName, module.text]),
  );
  virtualFiles.set(lookupFileName, projection.projectedText);
  const virtualModuleBySpecifier = new Map(
    projection.virtualModules.map((module) => [module.specifier, module]),
  );
  const virtualModuleBySourceFileName = new Map(
    projection.virtualModules.flatMap((module) =>
      typeof module.sourceFileName === 'string'
        ? [[path.normalize(module.sourceFileName), module]]
        : []
    ),
  );
  const virtualModuleByFileName = new Map(
    projection.virtualModules.map((module) => [path.normalize(module.fileName), module]),
  );
  const currentDirectory = path.dirname(projection.projectPath);
  const compilerOptions = {
    ...(baseHost.getCompilationSettings?.() ?? {}),
    allowArbitraryExtensions: true,
    allowJs: true,
  };
  const moduleResolutionHost = createModuleResolutionHost(ts, baseHost, virtualFiles, currentDirectory);
  const scriptVersionString = String(scriptVersion ?? '0');

  const host = {
    directoryExists: moduleResolutionHost.directoryExists,
    fileExists: moduleResolutionHost.fileExists,
    getCompilationSettings: () => compilerOptions,
    getCurrentDirectory: () => currentDirectory,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    getDirectories: moduleResolutionHost.getDirectories,
    getScriptFileNames: () => [lookupFileName, ...projection.virtualModules.map((module) => module.fileName)],
    getScriptKind: (candidateFileName) => {
      if (candidateFileName === lookupFileName) {
        return stsScriptKind === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      }
      return undefined;
    },
    getScriptSnapshot: (candidateFileName) => {
      if (virtualFiles.has(candidateFileName)) {
        return ts.ScriptSnapshot.fromString(virtualFiles.get(candidateFileName));
      }
      const snapshot = baseHost.getScriptSnapshot?.(candidateFileName);
      if (snapshot) {
        return snapshot;
      }
      const fileText = moduleResolutionHost.readFile(candidateFileName);
      return fileText === undefined ? undefined : ts.ScriptSnapshot.fromString(fileText);
    },
    getScriptVersion: (candidateFileName) => {
      if (candidateFileName === lookupFileName) {
        return scriptVersionString;
      }
      if (virtualFiles.has(candidateFileName)) {
        return '1';
      }
      return baseHost.getScriptVersion?.(candidateFileName) ?? '0';
    },
    readDirectory: baseHost.readDirectory?.bind(baseHost) ?? ts.sys.readDirectory,
    readFile: moduleResolutionHost.readFile,
    resolveModuleNames(moduleNames, containingFile) {
      return moduleNames.map((moduleName) => {
        const virtualModule = virtualModuleBySpecifier.get(moduleName);
        if (virtualModule) {
          return {
            extension: getExtensionForModuleFileName(ts, virtualModule.fileName),
            isExternalLibraryImport: isStdlibVirtualModule(virtualModule),
            resolvedFileName: virtualModule.fileName,
          };
        }
        const resolvedModule = ts.resolveModuleName(
          moduleName,
          containingFile,
          compilerOptions,
          moduleResolutionHost,
        ).resolvedModule;
        if (!resolvedModule) {
          return resolvedModule;
        }

        const remappedModule = virtualModuleBySourceFileName.get(
          path.normalize(resolvedModule.resolvedFileName),
        ) ?? virtualModuleByFileName.get(path.normalize(resolvedModule.resolvedFileName));
        if (!remappedModule) {
          return resolvedModule;
        }

        return {
          ...resolvedModule,
          extension: getExtensionForModuleFileName(ts, remappedModule.fileName),
          isExternalLibraryImport: isStdlibVirtualModule(remappedModule) ||
            resolvedModule.isExternalLibraryImport,
          resolvedFileName: remappedModule.fileName,
        };
      });
    },
    useCaseSensitiveFileNames: moduleResolutionHost.useCaseSensitiveFileNames,
  };

  return {
    lookupFileName,
    preparedFile: createStagePreparedFile(projection),
    service: ts.createLanguageService(host),
  };
}

function runEditorProjectCommand(spawnSyncImpl, command, argsPrefix, fileName, projectPath, sourceText) {
  const result = spawnSyncImpl(
    command,
    buildEditorProjectArgs(command, argsPrefix, fileName, projectPath),
    {
      encoding: 'utf8',
      input: sourceText,
      maxBuffer: MAX_BUFFER_BYTES,
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'editor-project command failed.');
  }
  const payload = JSON.parse(result.stdout);
  if (!isObject(payload) || payload.command !== 'editor-project') {
    throw new Error('editor-project returned an invalid payload.');
  }
  return payload;
}

function getProjectedState(ts, options) {
  const {
    configuration,
    fileName,
    fsApi = fs,
    info,
    pathApi = path,
    spawnSyncImpl = spawnSync,
    state,
  } = options;
  if (!fileName.endsWith('.sts')) {
    return undefined;
  }
  const effectiveConfiguration = resolveEffectiveConfiguration(
    configuration,
    fsApi,
    pathApi,
    info,
    fileName,
  );
  if (!effectiveConfiguration.soundscriptCommand) {
    return undefined;
  }

  const baseHost = info.languageServiceHost ?? {};
  const snapshot = baseHost.getScriptSnapshot?.(fileName);
  const sourceText = encodeScriptSnapshotText(snapshot) ??
    info.languageService.getProgram?.()?.getSourceFile(fileName)?.text ??
    fsApi.readFileSync(fileName, 'utf8');
  const scriptVersion = baseHost.getScriptVersion?.(fileName) ?? sourceText;
  const projectName = info.project.getProjectName?.() ?? info.project.projectName;
  const projectPath = resolveProjectPath(fsApi, pathApi, projectName, fileName);
  if (!projectPath) {
    return undefined;
  }

  const cacheKey = JSON.stringify({
    argsPrefix: effectiveConfiguration.soundscriptArgsPrefix,
    command: effectiveConfiguration.soundscriptCommand,
    fileName,
    projectPath,
    scriptVersion,
  });
  const cached = state.projectedByFile.get(fileName);
  if (cached?.cacheKey === cacheKey) {
    return cached;
  }

  const payload = runEditorProjectCommand(
    spawnSyncImpl,
    effectiveConfiguration.soundscriptCommand,
    effectiveConfiguration.soundscriptArgsPrefix,
    fileName,
    projectPath,
    sourceText,
  );
  const projected = createProjectedLanguageService(
    ts,
    baseHost,
    payload,
    fileName,
    scriptVersion,
    effectiveConfiguration.stsScriptKind,
  );
  const nextState = {
    cacheKey,
    lookupFileName: projected.lookupFileName,
    preparedFile: projected.preparedFile,
    projectPath,
    projection: payload,
    service: projected.service,
  };
  state.projectedByFile.set(fileName, nextState);
  return nextState;
}

function remapTextSpan(ts, preparedFile, textSpan) {
  if (!textSpan) {
    return textSpan;
  }

  const start = textSpan.start;
  const end = textSpan.start + textSpan.length;
  const mapped = mapProjectedEnclosingRangeToSource(preparedFile, start, end);
  return ts.createTextSpanFromBounds(mapped.start, mapped.end);
}

function remapDiagnostic(ts, preparedFile, diagnostic) {
  if (!diagnostic.file || diagnostic.start === undefined) {
    return diagnostic;
  }
  const end = diagnostic.start + (diagnostic.length ?? 0);
  const mapped = mapProjectedEnclosingRangeToSource(preparedFile, diagnostic.start, end);
  return {
    ...diagnostic,
    file: undefined,
    length: Math.max(0, mapped.end - mapped.start),
    start: mapped.start,
  };
}

function remapDefinitionInfo(ts, fileName, preparedFile, info, projection) {
  if (info.fileName === `${fileName}.ts` || info.fileName === `${fileName}.tsx`) {
    return {
      ...info,
      fileName,
      contextSpan: remapTextSpan(ts, preparedFile, info.contextSpan),
      originalTextSpan: remapTextSpan(ts, preparedFile, info.originalTextSpan),
      textSpan: remapTextSpan(ts, preparedFile, info.textSpan),
    };
  }

  const virtualModule = projection?.virtualModules?.find((module) => module.fileName === info.fileName);
  if (!virtualModule || typeof virtualModule.sourceFileName !== 'string') {
    return info;
  }

  const virtualPreparedFile = createVirtualModulePreparedFile(virtualModule);
  if (!virtualPreparedFile) {
    return {
      ...info,
      fileName: virtualModule.sourceFileName,
    };
  }

  return {
    ...info,
    fileName: virtualModule.sourceFileName,
    contextSpan: remapTextSpan(ts, virtualPreparedFile, info.contextSpan),
    originalTextSpan: remapTextSpan(ts, virtualPreparedFile, info.originalTextSpan),
    textSpan: remapTextSpan(ts, virtualPreparedFile, info.textSpan),
  };
}

module.exports = {
  getProjectedState,
  mapProjectedEnclosingRangeToSource,
  mapProjectedPositionToSource,
  mapSourcePositionToProjected,
  remapDefinitionInfo,
  remapDiagnostic,
  remapTextSpan,
  resolveProjectPath,
};
