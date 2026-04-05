import * as vscode from 'vscode';

import { activateSoundscriptDiagnostics } from './editor_diagnostics_client';
import {
  findNearestSoundscriptProject,
  runEditorProjectSnapshot,
} from './editor_process_support';
import { activateProjectedTsBridge } from './projected_ts_bridge';
import {
  configureTypeScriptPlugin,
  isTypeScriptPluginConfigurationChange,
  formatSoundscriptCliCompatibilityIssue,
  resolveSoundscriptCliResolution,
  type SoundscriptCliCompatibilityIssue,
} from './typescript_extension_support';
import { ensureTypeScriptServerStarted } from './tsserver_startup';

let soundscriptOutputChannel: vscode.OutputChannel | undefined;
let lastCliCompatibilityIssueKey: string | undefined;

function describeError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function isMissingCommandError(commandId: string, error: unknown): boolean {
  const description = describeError(error);
  return description.includes(commandId) && description.includes('not found');
}

function reportTypeScriptStartupMode(
  outputChannel: vscode.OutputChannel,
  startupMode: Awaited<ReturnType<typeof ensureTypeScriptServerStarted>>,
): void {
  if (startupMode === 'unavailable') {
    outputChannel.appendLine(
      'TypeScript tsserverRequest is unavailable in this editor; skipping explicit soundscript tsserver startup.',
    );
    return;
  }

  outputChannel.appendLine(
    `Ensured the TypeScript server started for soundscript via ${startupMode}.`,
  );
}

async function restartTypeScriptIntegration(
  outputChannel: vscode.OutputChannel,
  extensionContext: vscode.ExtensionContext,
  diagnostics: { refreshAll(): void },
  projectedBridge: { refreshAll(): void },
): Promise<void> {
  const cliResolution = resolveSoundscriptCliResolution(extensionContext);
  reportCliCompatibilityIssue(outputChannel, cliResolution.compatibilityIssue);
  const configured = await configureTypeScriptPlugin(outputChannel, extensionContext, cliResolution);
  if (!configured) {
    throw new Error('Built-in TypeScript extension API is unavailable.');
  }

  try {
    await vscode.commands.executeCommand('typescript.restartTsServer');
  } catch (error) {
    if (!isMissingCommandError('typescript.restartTsServer', error)) {
      throw error;
    }
    outputChannel.appendLine(
      'TypeScript restart command is unavailable in this editor; skipping explicit tsserver restart.',
    );
  }
  const startupMode = await ensureTypeScriptServerStarted(
    (command, ...args) => vscode.commands.executeCommand(command, ...args),
    vscode.workspace.textDocuments,
    vscode.window.activeTextEditor?.document,
  );
  reportTypeScriptStartupMode(outputChannel, startupMode);
  diagnostics.refreshAll();
  projectedBridge.refreshAll();
  outputChannel.appendLine('Restarted the TypeScript server for soundscript.');
}

function cliCompatibilityIssueKey(issue: SoundscriptCliCompatibilityIssue): string {
  return `${issue.workspaceFolder}:${issue.detectedVersion}:${issue.minimumVersion}`;
}

function reportCliCompatibilityIssue(
  outputChannel: vscode.OutputChannel,
  issue: SoundscriptCliCompatibilityIssue | undefined,
): void {
  if (!issue) {
    return;
  }

  const issueKey = cliCompatibilityIssueKey(issue);
  if (lastCliCompatibilityIssueKey === issueKey) {
    return;
  }

  const message = formatSoundscriptCliCompatibilityIssue(issue);
  outputChannel.appendLine(message);
  void vscode.window.showWarningMessage(message);
  lastCliCompatibilityIssueKey = issueKey;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('soundscript');
  soundscriptOutputChannel = outputChannel;
  context.subscriptions.push(outputChannel);
  const cliResolution = resolveSoundscriptCliResolution(context);
  reportCliCompatibilityIssue(outputChannel, cliResolution.compatibilityIssue);
  const diagnostics = activateSoundscriptDiagnostics(outputChannel, cliResolution.cliLaunch);
  context.subscriptions.push(diagnostics);
  const projectedBridge = activateProjectedTsBridge(outputChannel, cliResolution.cliLaunch);
  context.subscriptions.push(projectedBridge);

  const restartCommand = vscode.commands.registerCommand(
    'soundscript.restartLanguageServer',
    async () => {
      try {
        await restartTypeScriptIntegration(outputChannel, context, diagnostics, projectedBridge);
        void vscode.window.showInformationMessage('soundscript TypeScript integration restarted.');
      } catch (error) {
        outputChannel.appendLine(`Failed to restart TypeScript integration: ${describeError(error)}`);
        void vscode.window.showErrorMessage(
          `Failed to restart soundscript TypeScript integration: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  );
  context.subscriptions.push(restartCommand);

  const dumpDebugInfoCommand = vscode.commands.registerCommand(
    'soundscript.dumpActiveDocumentDebugInfo',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'soundscript') {
        void vscode.window.showWarningMessage(
          'Open an active soundscript (.sts) editor to dump debug info.',
        );
        return;
      }

      try {
        const projectPath = findNearestSoundscriptProject(editor.document.uri.fsPath) ?? null;
        const projectionSnapshot = projectPath && cliResolution.cliLaunch
          ? runEditorProjectSnapshot(
            cliResolution.cliLaunch,
            projectPath,
            editor.document.uri.fsPath,
            editor.document.getText(),
          )
          : null;
        const diagnosticsSnapshot = await diagnostics.dumpDebugInfo(
          editor.document,
          editor.selection.active,
        );
        const projectedSnapshot = await projectedBridge.dumpDebugInfo(
          editor.document,
          editor.selection.active,
        );
        const snapshot = {
          ...((diagnosticsSnapshot ?? {}) as Record<string, unknown>),
          ...((projectedSnapshot ?? {}) as Record<string, unknown>),
          projectionSnapshot: projectionSnapshot
            ? {
              filePath: projectionSnapshot.filePath,
              projectPath: projectionSnapshot.projectPath,
              projectedText: projectionSnapshot.projectedText,
              virtualModules: projectionSnapshot.virtualModules.map((module) => ({
                fileName: module.fileName,
                specifier: module.specifier,
              })),
            }
            : null,
        };
        outputChannel.show(true);
        outputChannel.appendLine('soundscript debug snapshot:');
        outputChannel.appendLine(JSON.stringify(snapshot, null, 2));
        return snapshot;
      } catch (error) {
        outputChannel.appendLine(`Failed to dump soundscript debug info: ${describeError(error)}`);
        void vscode.window.showErrorMessage(
          `Failed to dump soundscript debug info: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  );
  context.subscriptions.push(dumpDebugInfoCommand);

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (!isTypeScriptPluginConfigurationChange(event)) {
      return;
    }

    void restartTypeScriptIntegration(outputChannel, context, diagnostics, projectedBridge).catch((error) => {
      outputChannel.appendLine(
        `Failed to apply updated soundscript TypeScript settings: ${describeError(error)}`,
      );
      void vscode.window.showErrorMessage(
        `Failed to apply updated soundscript TypeScript settings: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }));

  try {
    const configured = await configureTypeScriptPlugin(outputChannel, context, cliResolution);
    const startupMode = await ensureTypeScriptServerStarted(
      (command, ...args) => vscode.commands.executeCommand(command, ...args),
      vscode.workspace.textDocuments,
      vscode.window.activeTextEditor?.document,
    );
    reportTypeScriptStartupMode(outputChannel, startupMode);
    diagnostics.refreshAll();
    projectedBridge.refreshAll();
    if (!configured) {
      void vscode.window.showWarningMessage(
        'soundscript could not configure the built-in TypeScript extension.',
      );
    }
  } catch (error) {
    outputChannel.appendLine(`Failed to configure TypeScript integration: ${describeError(error)}`);
    void vscode.window.showErrorMessage(
      `Failed to configure soundscript TypeScript integration: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function deactivate(): Promise<void> {
  soundscriptOutputChannel = undefined;
}
