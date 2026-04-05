import { existsSync } from 'node:fs';

import * as vscode from 'vscode';

import { resolveServerRuntimeMode } from './extension_runtime_mode';
import {
  readTypeScriptPluginConfiguration,
  SOUNDSCRIPT_TSSERVER_PLUGIN_NAME,
} from './typescript_plugin_configuration';
import {
  compareReleaseVersions,
  type ResolvedCliLaunch,
  resolveCliLaunch,
  resolveWorkspaceSoundscriptPackage,
} from './server_resolution';

const MINIMUM_SUPPORTED_WORKSPACE_SOUNDSCRIPT_VERSION = '0.1.3';

export interface SoundscriptCliCompatibilityIssue {
  detectedVersion: string;
  minimumVersion: string;
  packageJsonPath: string;
  workspaceFolder: string;
}

export interface ResolvedSoundscriptCli {
  cliLaunch?: ResolvedCliLaunch;
  compatibilityIssue?: SoundscriptCliCompatibilityIssue;
}

export function formatSoundscriptCliCompatibilityIssue(
  issue: SoundscriptCliCompatibilityIssue,
): string {
  return [
    `soundscript workspace dependency ${issue.detectedVersion} is older than the editor integration requires (>=${issue.minimumVersion}).`,
    `Update @soundscript/soundscript in ${issue.workspaceFolder}, for example with: npm install @soundscript/soundscript@${issue.minimumVersion}`,
    'Reload the window after upgrading.',
  ].join(' ');
}

interface TypeScriptExtensionApi {
  configurePlugin(pluginId: string, configuration: unknown): void;
}

interface TypeScriptExtensionExports {
  getAPI(version: 0): TypeScriptExtensionApi | undefined;
}

const TYPESCRIPT_EXTENSION_ID = 'vscode.typescript-language-features';

export function isTypeScriptPluginConfigurationChange(
  event: vscode.ConfigurationChangeEvent,
): boolean {
  return event.affectsConfiguration('soundscript.tsserver');
}

export function resolveSoundscriptCliResolution(
  extensionContext: vscode.ExtensionContext,
): ResolvedSoundscriptCli {
  const extensionMode = extensionContext.extensionMode === vscode.ExtensionMode.Production
    ? 'production'
    : extensionContext.extensionMode === vscode.ExtensionMode.Test
    ? 'test'
    : 'development';
  const cliLaunch = resolveCliLaunch({
    existsSync,
    extensionMode: resolveServerRuntimeMode(
      extensionMode,
      process.env.SOUNDSCRIPT_FORCE_DEVELOPMENT_CLI === '1',
    ),
    extensionPath: extensionContext.extensionPath,
    homeDir: process.env.HOME,
    pathEnv: process.env.PATH,
    platform: process.platform,
    workspaceFolders: vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [],
  });

  if (cliLaunch?.source !== 'workspace') {
    return { cliLaunch };
  }

  const workspacePackage = resolveWorkspaceSoundscriptPackage(
    vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [],
    process.platform,
    existsSync,
  );
  if (!workspacePackage) {
    return { cliLaunch };
  }

  const versionComparison = compareReleaseVersions(
    workspacePackage.version,
    MINIMUM_SUPPORTED_WORKSPACE_SOUNDSCRIPT_VERSION,
  );
  if (versionComparison !== undefined && versionComparison < 0) {
    return {
      compatibilityIssue: {
        detectedVersion: workspacePackage.version,
        minimumVersion: MINIMUM_SUPPORTED_WORKSPACE_SOUNDSCRIPT_VERSION,
        packageJsonPath: workspacePackage.packageJsonPath,
        workspaceFolder: workspacePackage.workspaceFolder,
      },
    };
  }

  return { cliLaunch };
}

export async function configureTypeScriptPlugin(
  outputChannel: vscode.OutputChannel,
  extensionContext: vscode.ExtensionContext,
  cliResolution: ResolvedSoundscriptCli = resolveSoundscriptCliResolution(extensionContext),
): Promise<boolean> {
  const extension = vscode.extensions.getExtension<TypeScriptExtensionExports>(
    TYPESCRIPT_EXTENSION_ID,
  );
  if (!extension) {
    outputChannel.appendLine(
      'Built-in TypeScript extension was not found; skipping soundscript tsserver plugin configuration.',
    );
    return false;
  }

  const extensionExports = extension.isActive
    ? extension.exports
    : await extension.activate();
  const api = extensionExports?.getAPI(0);
  if (!api) {
    outputChannel.appendLine(
      'Built-in TypeScript extension API is unavailable in this editor; soundscript will rely on tsserver plugin auto-resolution.',
    );
    return true;
  }

  const configuration = readTypeScriptPluginConfiguration(
    vscode.workspace.getConfiguration('soundscript'),
    cliResolution.cliLaunch,
  );
  api.configurePlugin(SOUNDSCRIPT_TSSERVER_PLUGIN_NAME, configuration);
  outputChannel.appendLine(
    `Configured soundscript tsserver plugin: stsScriptKind=${configuration.stsScriptKind}, soundscriptCommand=${
      configuration.soundscriptCommand ?? 'unresolved'
    }, soundscriptArgsPrefix=${configuration.soundscriptArgsPrefix.join(' ')}`,
  );
  if (cliResolution.compatibilityIssue) {
    outputChannel.appendLine(
      formatSoundscriptCliCompatibilityIssue(cliResolution.compatibilityIssue),
    );
  } else if (!cliResolution.cliLaunch) {
    outputChannel.appendLine(
      'soundscript CLI could not be resolved for the tsserver plugin; soundscript diagnostics will be unavailable.',
    );
  }
  return true;
}
