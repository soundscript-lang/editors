import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type TypeScriptServerPluginContribution = {
  configNamespace?: string;
  enableForWorkspaceTypeScriptVersions?: boolean;
  languages?: string[];
  name: string;
};

function readPackageJson(): {
  icon?: string;
  engines?: {
    vscode?: string;
  };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  contributes?: {
    languages?: Array<{
      icon?: {
        dark?: string;
        light?: string;
      };
    }>;
    commands?: Array<{
      command: string;
      title: string;
    }>;
    typescriptServerPlugins?: TypeScriptServerPluginContribution[];
  };
} {
  return JSON.parse(
    readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
  ) as {
    icon?: string;
    engines?: {
      vscode?: string;
    };
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    contributes?: {
      languages?: Array<{
        icon?: {
          dark?: string;
          light?: string;
        };
      }>;
      commands?: Array<{
        command: string;
        title: string;
      }>;
      typescriptServerPlugins?: TypeScriptServerPluginContribution[];
    };
  };
}

test('VS Code package contributes the Soundscript tsserver plugin for JS/TS workspaces', () => {
  const packageJson = readPackageJson();
  const contribution = packageJson.contributes?.typescriptServerPlugins?.find((plugin) =>
    plugin.name === '@soundscript/tsserver-plugin'
  );

  assert.deepEqual(contribution, {
    configNamespace: 'soundscript',
    enableForWorkspaceTypeScriptVersions: true,
    languages: ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'],
    name: '@soundscript/tsserver-plugin',
  });
});

test('VS Code package contributes the Soundscript debug dump command', () => {
  const packageJson = readPackageJson();
  const contribution = packageJson.contributes?.commands?.find((command) =>
    command.command === 'soundscript.dumpActiveDocumentDebugInfo'
  );

  assert.deepEqual(contribution, {
    command: 'soundscript.dumpActiveDocumentDebugInfo',
    title: 'soundscript: Dump Active File Debug Info',
  });
});

test('VS Code package declares a Cursor-compatible engine floor', () => {
  const packageJson = readPackageJson();
  assert.equal(packageJson.engines?.vscode, '^1.105.0');
});

test('VS Code package declares runtime dependencies needed inside the VSIX', () => {
  const packageJson = readPackageJson();
  assert.equal(packageJson.dependencies?.['typescript'], '^5.9.3');
  assert.equal(packageJson.devDependencies?.['typescript'], undefined);
});

test('VS Code package uses separate icons for the extension listing and .sts files', () => {
  const packageJson = readPackageJson();

  assert.equal(packageJson.icon, 'images/extension-icon.png');
  assert.deepEqual(packageJson.contributes?.languages?.[0]?.icon, {
    light: './images/icon.png',
    dark: './images/icon.png',
  });
});
