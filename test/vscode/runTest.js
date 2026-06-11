/* Runs the VS Code + C/C++ provider integration suite against the user's
 * INSTALLED VS Code (no download). PROVIDER=clangd (default) or cpptools selects
 * which language provider answers the call-hierarchy commands. Skips (exit 0) if
 * Code/clangd can't be located. */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { runTests, downloadAndUnzipVSCode } = require('@vscode/test-electron');

const PROVIDER = (process.env.PROVIDER || 'clangd').toLowerCase();

function findClangd() {
  if (process.env.CLANGD && fs.existsSync(process.env.CLANGD)) return process.env.CLANGD;
  try {
    const s = fs.readFileSync(
      path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'settings.json'),
      'utf8',
    );
    const m = s.match(/"clangd\.path"\s*:\s*"([^"]+)"/);
    if (m) {
      const p = m[1].replace(/\\\\/g, '\\');
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  const w = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['clangd']);
  const p = (w.stdout || '').toString().split(/\r?\n/)[0].trim();
  return p && fs.existsSync(p) ? p : undefined;
}

function findCode() {
  return [
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe'),
    'C:/Program Files/Microsoft VS Code/Code.exe',
  ].find((p) => fs.existsSync(p));
}

async function main() {
  const repo = path.resolve(__dirname, '..', '..');
  const exampleLarge = path.join(repo, 'example-large');
  // Use the user's installed Code only when asked (USE_INSTALLED=1); otherwise
  // download a clean instance — avoids the "Code is being updated" lock from
  // launching the running install. Resolve the executable up front so a DOWNLOAD
  // failure (offline / firewalled — e.g. inside `vsce package`'s prepublish on a
  // locked-down box) SKIPS the suite (exit 0) instead of failing the release; a
  // real TEST failure further down still exits non-zero.
  let code = process.env.USE_INSTALLED ? findCode() : undefined;
  if (!code) {
    try {
      code = await downloadAndUnzipVSCode(process.env.VSCODE_VERSION || 'stable');
    } catch (e) {
      console.log(`SKIP vscode integration: could not obtain VS Code (${e && e.message ? e.message : e}).`);
      return;
    }
  }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-ud-'));
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });

  const compileCommands = path.join(exampleLarge, 'compile_commands.json').replace(/\\/g, '/');
  let settings;
  let disableExt = [];

  if (PROVIDER === 'cpptools') {
    settings = {
      'C_Cpp.intelliSenseEngine': 'default',
      'C_Cpp.default.compileCommands': compileCommands,
      'C_Cpp.intelliSenseEngineFallback': 'enabled',
      'C_Cpp.default.cppStandard': 'c11',
      'security.workspace.trust.enabled': false,
      'extensions.ignoreRecommendations': true,
    };
    // Make sure clangd doesn't also answer.
    disableExt = ['--disable-extension', 'llvm-vs-code-extensions.vscode-clangd'];
  } else {
    const clangd = findClangd();
    if (!clangd) {
      console.log('SKIP clangd provider: clangd not found.');
      return;
    }
    settings = {
      'clangd.path': clangd,
      'clangd.arguments': ['--background-index', `--compile-commands-dir=${exampleLarge}`],
      'C_Cpp.intelliSenseEngine': 'disabled',
      'security.workspace.trust.enabled': false,
      'extensions.ignoreRecommendations': true,
    };
    disableExt = ['--disable-extension', 'ms-vscode.cpptools'];
  }

  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify(settings, null, 2));
  const userExt = path.join(os.homedir(), '.vscode', 'extensions');

  console.log(`=== provider: ${PROVIDER}${process.env.VSCODE_VERSION ? ' @ ' + process.env.VSCODE_VERSION : ''} ===`);
  await runTests({
    vscodeExecutablePath: code, // resolved above (installed or downloaded)
    extensionDevelopmentPath: repo,
    extensionTestsPath: path.join(__dirname, 'suite', 'index.js'),
    extensionTestsEnv: { PROVIDER },
    launchArgs: [
      exampleLarge,
      '--extensions-dir',
      userExt,
      '--user-data-dir',
      userData,
      ...disableExt,
      // disable the INSTALLED copy so the dev build (extensionDevelopmentPath) is
      // the one that activates and exposes its tree provider for the test
      '--disable-extension',
      'halistahasahin.c-call-hierarchy-references',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
    ],
  });
}

main().catch((e) => {
  console.error(`vscode integration (${PROVIDER}) FAILED:`, e && e.message ? e.message : e);
  process.exit(1);
});
