const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const childProcess = require('node:child_process');

const packageRoot = __dirname;
const pluginRoot = path.resolve(packageRoot, '..', 'tsserver-plugin');
const stageRoot = path.join(os.tmpdir(), 'soundscript-vscode-vsix-stage');
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));

function resolveSoundLibsRoot() {
  const candidates = [
    path.join(packageRoot, 'sound-libs'),
    path.resolve(packageRoot, '..', '..', '..', 'soundscript', 'src', 'bundled', 'sound-libs'),
    path.resolve(packageRoot, '..', '..', '..', '..', 'soundscript', 'src', 'bundled', 'sound-libs'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'lib.es5.d.ts'))) {
      return candidate;
    }
  }
  throw new Error('Could not find soundscript bundled sound-libs for VSIX packaging.');
}

function copyFile(sourcePath, destinationPath) {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath);
}

function copyDirectory(sourcePath, destinationPath) {
  fs.mkdirSync(destinationPath, { recursive: true });
  for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
    const sourceEntryPath = path.join(sourcePath, entry.name);
    const destinationEntryPath = path.join(destinationPath, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourceEntryPath, destinationEntryPath);
    } else {
      copyFile(sourceEntryPath, destinationEntryPath);
    }
  }
}

function resolveDependencyRoot(packageName) {
  const manifestPath = require.resolve(`${packageName}/package.json`, { paths: [packageRoot] });
  return path.dirname(manifestPath);
}

fs.rmSync(stageRoot, { recursive: true, force: true });
fs.mkdirSync(stageRoot, { recursive: true });

for (const relativePath of [
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'language-configuration.json',
]) {
  copyFile(path.join(packageRoot, relativePath), path.join(stageRoot, relativePath));
}

copyDirectory(path.join(packageRoot, 'images'), path.join(stageRoot, 'images'));
copyDirectory(path.join(packageRoot, 'out'), path.join(stageRoot, 'out'));
copyDirectory(resolveSoundLibsRoot(), path.join(stageRoot, 'sound-libs'));
for (const fileName of fs.readdirSync(path.join(stageRoot, 'out'))) {
  if (/\.test\.js(\.map)?$/u.test(fileName) || fileName === 'mixed_smoke.js' || fileName === 'mixed_smoke.js.map') {
    fs.rmSync(path.join(stageRoot, 'out', fileName), { force: true });
  }
}
copyDirectory(path.join(packageRoot, 'syntaxes'), path.join(stageRoot, 'syntaxes'));

const stagedPackageJson = { ...packageJson };
delete stagedPackageJson.scripts;
delete stagedPackageJson.devDependencies;
fs.writeFileSync(
  path.join(stageRoot, 'package.json'),
  `${JSON.stringify(stagedPackageJson, null, 2)}\n`,
);
fs.writeFileSync(path.join(stageRoot, '.vscodeignore'), '');

const pluginPackageJson = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'));
const stagedPluginRoot = path.join(stageRoot, 'node_modules', '@soundscript', 'tsserver-plugin');
const stagedPluginPackageJson = { ...pluginPackageJson };
delete stagedPluginPackageJson.peerDependencies;
copyFile(path.join(pluginRoot, 'README.md'), path.join(stagedPluginRoot, 'README.md'));
copyFile(path.join(pluginRoot, 'LICENSE'), path.join(stagedPluginRoot, 'LICENSE'));
fs.mkdirSync(stagedPluginRoot, { recursive: true });
fs.writeFileSync(
  path.join(stagedPluginRoot, 'package.json'),
  `${JSON.stringify(stagedPluginPackageJson, null, 2)}\n`,
);
for (const relativePath of pluginPackageJson.files ?? []) {
  if (relativePath === 'README.md' || relativePath === 'LICENSE') {
    continue;
  }
  copyFile(path.join(pluginRoot, relativePath), path.join(stagedPluginRoot, relativePath));
}

for (const dependencyName of Object.keys(packageJson.dependencies ?? {})) {
  if (dependencyName === '@soundscript/tsserver-plugin') {
    continue;
  }
  const sourceDependencyRoot = resolveDependencyRoot(dependencyName);
  const stagedDependencyRoot = path.join(stageRoot, 'node_modules', ...dependencyName.split('/'));
  copyDirectory(sourceDependencyRoot, stagedDependencyRoot);
}

const packagePath = path.join(packageRoot, `soundscript-vscode-${packageJson.version}.vsix`);
const vsceCommand = process.argv[2] === 'publish' ? 'publish' : 'package';
const args = vsceCommand === 'publish' ? ['publish'] : ['package', '--out', packagePath];
const result = childProcess.spawnSync('vsce', args, {
  cwd: stageRoot,
  stdio: 'inherit',
});
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
