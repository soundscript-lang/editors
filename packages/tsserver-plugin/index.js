'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  getProjectedState,
  mapSourcePositionToProjected,
  remapDefinitionInfo,
  remapDiagnostic,
  remapTextSpan,
} = require('./projection_support.js');

const DEFAULT_CONFIGURATION = {
  soundscriptArgsPrefix: [],
  soundscriptCommand: undefined,
  stsScriptKind: 'ts',
};
const ANNOTATION_COMMENT_PATTERN = /\/\/\s*#\[([A-Za-z_$][A-Za-z0-9_$]*)\]/g;

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry) => typeof entry === 'string' && entry.length > 0)
    .map((entry) => entry);
}

function normalizeConfiguration(configuration) {
  return {
    soundscriptArgsPrefix: normalizeStringArray(configuration?.soundscriptArgsPrefix),
    soundscriptCommand:
      typeof configuration?.soundscriptCommand === 'string' &&
        configuration.soundscriptCommand.length > 0
        ? configuration.soundscriptCommand
        : undefined,
    stsScriptKind: configuration?.stsScriptKind === 'tsx' ? 'tsx' : 'ts',
  };
}

function configurationsEqual(left, right) {
  return left.stsScriptKind === right.stsScriptKind &&
    left.soundscriptCommand === right.soundscriptCommand &&
    stringArraysEqual(left.soundscriptArgsPrefix, right.soundscriptArgsPrefix);
}

function stringArraysEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function collectAnnotationMacroNames(sourceText) {
  const names = new Set();
  for (const match of sourceText.matchAll(ANNOTATION_COMMENT_PATTERN)) {
    if (match[1]) {
      names.add(match[1]);
    }
  }

  return names;
}

function findInnermostNodeAtPosition(ts, sourceFile, position) {
  let current = sourceFile;

  function visit(node) {
    if (position < node.getFullStart() || position >= node.getEnd()) {
      return;
    }

    current = node;
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return current;
}

function findRelevantImportNode(ts, sourceFile, diagnostic) {
  if (diagnostic.start === undefined) {
    return undefined;
  }

  let current = findInnermostNodeAtPosition(ts, sourceFile, diagnostic.start);
  while (current) {
    switch (current.kind) {
      case ts.SyntaxKind.ImportSpecifier:
      case ts.SyntaxKind.ImportClause:
      case ts.SyntaxKind.NamespaceImport:
      case ts.SyntaxKind.ImportDeclaration:
        return current;
      default:
        current = current.parent;
    }
  }

  return undefined;
}

function collectImportLocalNames(ts, node) {
  switch (node.kind) {
    case ts.SyntaxKind.ImportSpecifier:
      return [node.name.text];
    case ts.SyntaxKind.NamespaceImport:
      return [node.name.text];
    case ts.SyntaxKind.ImportClause: {
      const localNames = [];
      if (node.name) {
        localNames.push(node.name.text);
      }
      if (!node.namedBindings) {
        return localNames;
      }
      if (node.namedBindings.kind === ts.SyntaxKind.NamespaceImport) {
        localNames.push(node.namedBindings.name.text);
        return localNames;
      }
      for (const element of node.namedBindings.elements) {
        localNames.push(element.name.text);
      }
      return localNames;
    }
    case ts.SyntaxKind.ImportDeclaration:
      return node.importClause
        ? collectImportLocalNames(ts, node.importClause)
        : [];
    default:
      return [];
  }
}

function shouldSuppressAnnotationOnlyImportDiagnostic(ts, sourceFile, diagnostic) {
  const annotationNames = collectAnnotationMacroNames(sourceFile.text);
  if (annotationNames.size === 0) {
    return false;
  }

  const importNode = findRelevantImportNode(ts, sourceFile, diagnostic);
  if (!importNode) {
    return false;
  }

  const localNames = collectImportLocalNames(ts, importNode);
  return localNames.length > 0 &&
    localNames.every((localName) => annotationNames.has(localName));
}

function filterAnnotationMacroImportDiagnostics(ts, languageService, fileName, diagnostics) {
  if (diagnostics.length === 0) {
    return diagnostics;
  }

  const program = languageService.getProgram && languageService.getProgram();
  const sourceFile = program && program.getSourceFile(fileName);
  if (!sourceFile || !sourceFile.text.includes('#[')) {
    return diagnostics;
  }

  return diagnostics.filter((diagnostic) => !shouldSuppressAnnotationOnlyImportDiagnostic(ts, sourceFile, diagnostic));
}

function createPluginLogger(info) {
  const logger = info?.project?.projectService?.logger;
  return (message) => {
    try {
      logger?.info?.(`[soundscript-tsserver] ${message}`);
    } catch {
      // Ignore tsserver logging failures; plugin behavior should not depend on logging.
    }
  };
}

function clearProjectedState(state) {
  for (const projected of state.projectedByFile.values()) {
    try {
      projected.service.dispose();
    } catch {
      // Ignore cache disposal failures.
    }
  }
  state.projectedByFile.clear();
  state.projectSoundscriptMatcherByProjectPath.clear();
}

function createLanguageServiceProxy(
  ts,
  info,
  getConfiguration,
  log,
  fsApi,
  pathApi,
  spawnSyncImpl,
  state,
) {
  const proxy = Object.create(null);
  const languageService = info.languageService;

  for (const key of Object.keys(languageService)) {
    const value = languageService[key];
    proxy[key] = typeof value === 'function'
      ? (...args) => value.apply(languageService, args)
      : value;
  }

  function getProjected(fileName) {
    try {
      return getProjectedState(ts, {
        configuration: getConfiguration(),
        fileName,
        fsApi,
        info,
        pathApi,
        spawnSyncImpl,
        state,
      });
    } catch (error) {
      log(
        `projected state failed for ${fileName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    }
  }

  proxy.getSemanticDiagnostics = (fileName) => {
    const projected = getProjected(fileName);
    if (projected) {
      return projected.service.getSemanticDiagnostics(projected.lookupFileName)
        .map((diagnostic) => remapDiagnostic(ts, projected.preparedFile, diagnostic));
    }
    return filterAnnotationMacroImportDiagnostics(
      ts,
      languageService,
      fileName,
      languageService.getSemanticDiagnostics(fileName),
    );
  };
  proxy.getSuggestionDiagnostics = (fileName) =>
    filterAnnotationMacroImportDiagnostics(
      ts,
      languageService,
      fileName,
      languageService.getSuggestionDiagnostics(fileName),
    );
  proxy.getQuickInfoAtPosition = (fileName, position) => {
    const projected = getProjected(fileName);
    if (projected) {
      const mappedPosition = mapSourcePositionToProjected(projected.preparedFile, position).position;
      const quickInfo = projected.service.getQuickInfoAtPosition(
        projected.lookupFileName,
        mappedPosition,
      );
      if (quickInfo) {
        return {
          ...quickInfo,
          textSpan: remapTextSpan(ts, projected.preparedFile, quickInfo.textSpan),
        };
      }
    }

    return languageService.getQuickInfoAtPosition(fileName, position);
  };
  proxy.getDefinitionAtPosition = (fileName, position) => {
    const projected = getProjected(fileName);
    if (projected) {
      const mappedPosition = mapSourcePositionToProjected(projected.preparedFile, position).position;
      const definitions = projected.service.getDefinitionAtPosition(
        projected.lookupFileName,
        mappedPosition,
      );
      if (definitions) {
        return definitions.map((definition) =>
          remapDefinitionInfo(ts, fileName, projected.preparedFile, definition, projected.projection)
        );
      }
    }

    return languageService.getDefinitionAtPosition(fileName, position);
  };
  proxy.getCompletionsAtPosition = (fileName, position, options) => {
    const projected = getProjected(fileName);
    if (projected) {
      const mappedPosition = mapSourcePositionToProjected(projected.preparedFile, position).position;
      return projected.service.getCompletionsAtPosition(
        projected.lookupFileName,
        mappedPosition,
        options,
      );
    }

    return languageService.getCompletionsAtPosition(fileName, position, options);
  };
  proxy.getCompletionEntryDetails = (fileName, position, entryName, formatOptions, source, preferences, data) => {
    const projected = getProjected(fileName);
    if (projected) {
      const mappedPosition = mapSourcePositionToProjected(projected.preparedFile, position).position;
      return projected.service.getCompletionEntryDetails(
        projected.lookupFileName,
        mappedPosition,
        entryName,
        formatOptions,
        source,
        preferences,
        data,
      );
    }

    return languageService.getCompletionEntryDetails(
      fileName,
      position,
      entryName,
      formatOptions,
      source,
      preferences,
      data,
    );
  };
  proxy.getSignatureHelpItems = (fileName, position, options) => {
    const projected = getProjected(fileName);
    if (projected) {
      const mappedPosition = mapSourcePositionToProjected(projected.preparedFile, position).position;
      const items = projected.service.getSignatureHelpItems(
        projected.lookupFileName,
        mappedPosition,
        options,
      );
      if (items?.applicableSpan) {
        return {
          ...items,
          applicableSpan: remapTextSpan(ts, projected.preparedFile, items.applicableSpan),
        };
      }
      return items;
    }

    return languageService.getSignatureHelpItems(fileName, position, options);
  };

  return proxy;
}

module.exports = function init(modules) {
  const ts = modules.typescript;
  const fsApi = modules.fs ?? fs;
  const pathApi = modules.path ?? path;
  const spawnSyncImpl = modules.spawnSync ?? spawnSync;
  let configuration = DEFAULT_CONFIGURATION;
  const pluginStates = new Set();

  return {
    create(info) {
      configuration = normalizeConfiguration(info.config ?? configuration);
      const log = createPluginLogger(info);
      const state = {
        projectSoundscriptMatcherByProjectPath: new Map(),
        projectedByFile: new Map(),
      };
      log(
        `plugin create: project=${info.project.getProjectName?.() ?? info.project.projectName ?? 'unknown'} command=${
          configuration.soundscriptCommand ?? 'unresolved'
        } argsPrefix=${configuration.soundscriptArgsPrefix.join(' ')} scriptKind=${configuration.stsScriptKind}`,
      );
      pluginStates.add(state);
      return createLanguageServiceProxy(
        ts,
        info,
        () => configuration,
        log,
        fsApi,
        pathApi,
        spawnSyncImpl,
        state,
      );
    },

    onConfigurationChanged(nextConfiguration) {
      const normalized = normalizeConfiguration(nextConfiguration);
      if (configurationsEqual(normalized, configuration)) {
        return;
      }

      configuration = normalized;
      for (const state of pluginStates) {
        clearProjectedState(state);
      }
    },
  };
};
