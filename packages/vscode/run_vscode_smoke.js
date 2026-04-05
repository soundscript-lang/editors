const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function resolveCodeCli() {
  const envOverride = process.env.VSCODE_CLI;
  if (envOverride && fs.existsSync(envOverride)) {
    return envOverride;
  }

  const candidates = process.platform === 'darwin'
    ? [
      '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code',
    ]
    : process.platform === 'win32'
    ? []
    : ['/usr/bin/code', '/usr/local/bin/code'];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return 'code';
}

function main() {
  const extensionRoot = __dirname;
  const codeCli = resolveCodeCli();
  const testsPath = path.join(extensionRoot, 'out', 'mixed_smoke.js');
  const fixtureName = process.env.SOUNDSCRIPT_SMOKE_FIXTURE || 'mixed-ts-sts';
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soundscript-vscode-user-'));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soundscript-vscode-ext-'));
  const reportFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'soundscript-vscode-report-')),
    `${fixtureName}-smoke-report.json`,
  );
  const workspacePath = path.join(extensionRoot, 'fixtures', fixtureName);
  const args = [
    `--extensionDevelopmentPath=${extensionRoot}`,
    `--extensionTestsPath=${testsPath}`,
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${extensionsDir}`,
    '--disable-workspace-trust',
    '--new-window',
    '--skip-welcome',
    '--skip-release-notes',
    '--wait',
    workspacePath,
  ];

  const child = spawn(codeCli, args, {
    env: {
      ...process.env,
      SOUNDSCRIPT_FORCE_DEVELOPMENT_CLI: '1',
      SOUNDSCRIPT_SMOKE_FIXTURE: fixtureName,
      SOUNDSCRIPT_SMOKE_REPORT_FILE: reportFile,
      SOUNDSCRIPT_SMOKE: '1',
    },
    stdio: 'inherit',
  });

  child.on('exit', (code, signal) => {
    try {
      fs.rmSync(userDataDir, { force: true, recursive: true });
      fs.rmSync(extensionsDir, { force: true, recursive: true });
    } catch {
      // best effort cleanup
    }

    let reportWritten = false;
    try {
      if (fs.existsSync(reportFile)) {
        reportWritten = true;
        const report = fs.readFileSync(reportFile, 'utf8');
        process.stdout.write(`SOUNDSCRIPT_SMOKE_REPORT_START ${fixtureName}\n`);
        process.stdout.write(`${report}\n`);
        process.stdout.write(`SOUNDSCRIPT_SMOKE_REPORT_END ${fixtureName}\n`);
      } else {
        process.stderr.write(`Smoke report file was not written: ${reportFile}\n`);
      }
      fs.rmSync(path.dirname(reportFile), { force: true, recursive: true });
    } catch (error) {
      process.stderr.write(`Failed to read smoke report: ${error}\n`);
    }

    if (signal) {
      process.stderr.write(`Smoke fixture ${fixtureName} exited via signal ${signal}\n`);
      process.exit(1);
    }
    if ((code ?? 1) !== 0) {
      process.stderr.write(`Smoke fixture ${fixtureName} exited with code ${code ?? 1}\n`);
      process.exit(code ?? 1);
    }
    if (!reportWritten) {
      process.stderr.write(`Smoke fixture ${fixtureName} did not produce a report\n`);
      process.exit(1);
    }
    process.exit(0);
  });
}

main();
