const fs = require('fs');
const path = require('path');
const os = require('os');
const child_process = require('child_process');

function getAntigravityPaths() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const baseDir = path.join(localAppData, 'Programs', 'antigravity');
  const resourcesDir = path.join(baseDir, 'resources');
  const appAsar = path.join(resourcesDir, 'app.asar');
  const appAsarBackup = path.join(resourcesDir, 'app.asar.backup');
  const unpackedDir = path.join(resourcesDir, 'app.asar.unpacked');
  const cdtMcpSrc = path.join(unpackedDir, 'node_modules', 'chrome-devtools-mcp', 'build', 'src');
  const browserJs = path.join(cdtMcpSrc, 'browser.js');
  const browserJsBackup = path.join(cdtMcpSrc, 'browser.js.backup');
  const browserManagerJs = path.join(cdtMcpSrc, 'BrowserManager.js');
  const browserManagerJsBackup = path.join(cdtMcpSrc, 'BrowserManager.js.backup');
  const edgeLauncherEsm = path.join(cdtMcpSrc, 'edgeLauncher.js');
  const mcpConfig = path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');
  const edgeProfile = path.join(os.homedir(), '.gemini', 'antigravity', 'edge_profile');

  return {
    baseDir,
    resourcesDir,
    appAsar,
    appAsarBackup,
    unpackedDir,
    cdtMcpSrc,
    browserJs,
    browserJsBackup,
    browserManagerJs,
    browserManagerJsBackup,
    edgeLauncherEsm,
    mcpConfig,
    edgeProfile
  };
}

function isAntigravityRunning() {
  try {
    const stdout = child_process.execSync('tasklist /FI "IMAGENAME eq Antigravity.exe" /NH', { encoding: 'utf8' });
    return stdout.toLowerCase().includes('antigravity.exe');
  } catch {
    return false;
  }
}

function extractAsarSafe(asarPath, destDir, unpackedDir) {
  const fd = fs.openSync(asarPath, 'r');
  const sizeBuf = Buffer.alloc(8);
  fs.readSync(fd, sizeBuf, 0, 8, 4);
  const headerSize = sizeBuf.readUInt32LE(0);
  const headerBuf = Buffer.alloc(headerSize);
  fs.readSync(fd, headerBuf, 0, headerSize, 16);
  const str = headerBuf.toString('utf8').trim();
  const header = JSON.parse(str.slice(0, str.lastIndexOf('}') + 1));
  const baseOffset = 16 + headerSize;

  function walk(dirObj, curDest) {
    fs.mkdirSync(curDest, { recursive: true });
    for (const [name, entry] of Object.entries(dirObj.files)) {
      const destPath = path.join(curDest, name);
      if (entry.files) {
        walk(entry, destPath);
      } else if (!entry.unpacked && entry.offset !== undefined) {
        const buf = Buffer.alloc(entry.size);
        fs.readSync(fd, buf, 0, entry.size, baseOffset + parseInt(entry.offset, 10));
        fs.writeFileSync(destPath, buf);
      }
    }
  }

  walk(header, destDir);
  fs.closeSync(fd);

  // Synchronize unpacked node_modules/chrome-devtools-mcp into temp destDir for repacking
  if (unpackedDir && fs.existsSync(unpackedDir)) {
    const cdtSrc = path.join(unpackedDir, 'node_modules', 'chrome-devtools-mcp');
    const cdtDest = path.join(destDir, 'node_modules', 'chrome-devtools-mcp');
    if (fs.existsSync(cdtSrc)) {
      fs.cpSync(cdtSrc, cdtDest, { recursive: true });
    }
  }
}

function checkStatus() {
  const paths = getAntigravityPaths();
  const checks = {
    antigravityInstalled: fs.existsSync(paths.baseDir),
    appAsarExists: fs.existsSync(paths.appAsar),
    appAsarBackupExists: fs.existsSync(paths.appAsarBackup),
    edgeLauncherUnpackedExists: fs.existsSync(paths.edgeLauncherEsm),
    browserJsPatched: false,
    appAsarPatched: false,
    mcpConfigConfigured: false
  };

  if (fs.existsSync(paths.browserJs)) {
    const content = fs.readFileSync(paths.browserJs, 'utf8');
    checks.browserJsPatched = content.includes('edgeLauncher') || content.includes('http://127.0.0.1:9222');
  }

  checks.browserManagerJsPatched = true;
  if (fs.existsSync(paths.browserManagerJs)) {
    const content = fs.readFileSync(paths.browserManagerJs, 'utf8');
    checks.browserManagerJsPatched = content.includes('ensureEdgeRunning');
  }

  if (fs.existsSync(paths.appAsar)) {
    try {
      const content = fs.readFileSync(paths.appAsar).toString('latin1');
      checks.appAsarPatched = content.includes('setupEdgeAutoLauncher');
    } catch {}
  }

  if (fs.existsSync(paths.mcpConfig)) {
    try {
      const content = fs.readFileSync(paths.mcpConfig, 'utf8');
      const json = JSON.parse(content);
      checks.mcpConfigConfigured = !!(json.mcpServers && json.mcpServers.chrome_devtools);
    } catch {}
  }

  const isFullyPatched = checks.edgeLauncherUnpackedExists && checks.browserJsPatched && checks.browserManagerJsPatched && checks.appAsarPatched && checks.mcpConfigConfigured;
  const isCompletelyOriginal = !checks.edgeLauncherUnpackedExists && !checks.browserJsPatched && checks.browserManagerJsPatched && !checks.appAsarPatched;

  let state = 'PARTIAL';
  if (isFullyPatched) state = 'PATCHED';
  else if (isCompletelyOriginal) state = 'UNPATCHED';

  return {
    state,
    checks,
    paths
  };
}

function install(options = {}) {
  const paths = getAntigravityPaths();
  const srcDir = path.resolve(__dirname, '..', 'src');

  console.log('=====================================================');
  console.log('  Antigravity Microsoft Edge Integration Installer');
  console.log('=====================================================\n');

  if (!fs.existsSync(paths.baseDir)) {
    throw new Error(`Antigravity was not found at: ${paths.baseDir}`);
  }

  if (isAntigravityRunning() && !options.force) {
    throw new Error('Antigravity is currently running. Please close Antigravity before applying the patch (or pass --force).');
  }

  // 1. Back up app.asar (only when pristine or no backup exists)
  const asarBuf = fs.readFileSync(paths.appAsar);
  const isAsarPatched = asarBuf.toString('latin1').includes('setupEdgeAutoLauncher');

  if (fs.existsSync(paths.appAsar) && !isAsarPatched) {
    console.log('[1/5] Backing up pristine app.asar -> app.asar.backup...');
    fs.copyFileSync(paths.appAsar, paths.appAsarBackup);
  } else if (fs.existsSync(paths.appAsarBackup)) {
    console.log('[1/5] app.asar is already patched; preserving existing app.asar.backup.');
  }

  // 2. Back up browser.js (only when pristine or no backup exists)
  const currentBrowser = fs.existsSync(paths.browserJs) ? fs.readFileSync(paths.browserJs, 'utf8') : '';
  const isBrowserPatched = currentBrowser.includes('ensureEdgeRunning');

  if (!fs.existsSync(paths.browserJsBackup) && fs.existsSync(paths.browserJs)) {
    console.log('[2/5] Backing up browser.js -> browser.js.backup...');
    if (!isBrowserPatched) {
      fs.copyFileSync(paths.browserJs, paths.browserJsBackup);
    } else {
      const cleanBrowser = currentBrowser
        .replace(/import\s*\{\s*ensureEdgeRunning\s*\}\s*from\s*'\.\/edgeLauncher\.js';\r?\n?/, '')
        .replace(/\r?\n\s*await ensureEdgeRunning\(\)\.catch\([\s\S]*?options\.browserURL = "http:\/\/127\.0\.0\.1:9222";\r?\n\s*\}/, '');
      fs.writeFileSync(paths.browserJsBackup, cleanBrowser, 'utf8');
    }
  } else if (fs.existsSync(paths.browserJsBackup)) {
    console.log('[2/5] browser.js.backup already exists, preserving original.');
  }

  // 3. Deploy unpacked files (edgeLauncher.esm.js and dynamically patched browser.js)
  console.log('[3/5] Deploying Edge launcher & dynamically patching browser.js in app.asar.unpacked...');
  const edgeLauncherSrc = path.join(srcDir, 'edgeLauncher.esm.js');
  const browserJsSrc = path.join(srcDir, 'browser.js');

  fs.mkdirSync(paths.cdtMcpSrc, { recursive: true });
  fs.copyFileSync(edgeLauncherSrc, paths.edgeLauncherEsm);

  // If browser.js is pristine, use it directly as base. Otherwise use backup or clean current.
  let baseBrowserContent = '';
  if (!isBrowserPatched && currentBrowser) {
    baseBrowserContent = currentBrowser;
  } else if (fs.existsSync(paths.browserJsBackup)) {
    baseBrowserContent = fs.readFileSync(paths.browserJsBackup, 'utf8');
  } else if (currentBrowser) {
    baseBrowserContent = currentBrowser
      .replace(/import\s*\{\s*ensureEdgeRunning\s*\}\s*from\s*'\.\/edgeLauncher\.js';\r?\n?/, '')
      .replace(/\r?\n\s*await ensureEdgeRunning\(\)\.catch\([\s\S]*?options\.browserURL = "http:\/\/127\.0\.0\.1:9222";\r?\n\s*\}/, '');
  } else {
    baseBrowserContent = fs.readFileSync(browserJsSrc, 'utf8');
  }

  // Dynamically inject Edge integration without overwriting upstream module structure
  if (!baseBrowserContent.includes("import { ensureEdgeRunning } from './edgeLauncher.js';")) {
    baseBrowserContent = "import { ensureEdgeRunning } from './edgeLauncher.js';\n" + baseBrowserContent;
  }
  const connectRegex = /(if\s*\(\s*browser\?\.connected\s*\)\s*\{\s*return\s+browser;\s*\})/;
  if (connectRegex.test(baseBrowserContent) && !baseBrowserContent.includes('await ensureEdgeRunning()')) {
    baseBrowserContent = baseBrowserContent.replace(
      connectRegex,
      `$1\n    await ensureEdgeRunning().catch((err) => {\n        console.error("[EdgeLauncher] ensureEdgeRunning error:", err.message);\n    });\n    if (!options.browserURL && !options.wsEndpoint && !options.userDataDir) {\n        options.browserURL = "http://127.0.0.1:9222";\n    }`
    );
  }
  fs.writeFileSync(paths.browserJs, baseBrowserContent, 'utf8');

  // Dynamically patch BrowserManager.js if present (chrome-devtools-mcp v1.11+)
  if (fs.existsSync(paths.browserManagerJs)) {
    const currentBm = fs.readFileSync(paths.browserManagerJs, 'utf8');
    const isBmPatched = currentBm.includes('ensureEdgeRunning');

    if (!fs.existsSync(paths.browserManagerJsBackup)) {
      console.log('      Backing up BrowserManager.js -> BrowserManager.js.backup...');
      if (!isBmPatched) {
        fs.copyFileSync(paths.browserManagerJs, paths.browserManagerJsBackup);
      } else {
        const cleanBm = currentBm
          .replace(/import\s*\{\s*ensureEdgeRunning\s*\}\s*from\s*'\.\/edgeLauncher\.js';\r?\n?/, '')
          .replace(/\r?\n\s*await ensureEdgeRunning\(\)\.catch\([\s\S]*?this\.#config\.resolved\.browserUrl = ['"]http:\/\/127\.0\.0\.1:9222['"];\r?\n\s*\}/, '');
        fs.writeFileSync(paths.browserManagerJsBackup, cleanBm, 'utf8');
      }
    }

    let baseBmContent = fs.existsSync(paths.browserManagerJsBackup)
      ? fs.readFileSync(paths.browserManagerJsBackup, 'utf8')
      : currentBm;

    if (!baseBmContent.includes("import { ensureEdgeRunning } from './edgeLauncher.js';")) {
      baseBmContent = "import { ensureEdgeRunning } from './edgeLauncher.js';\n" + baseBmContent;
    }

    const initTarget = /(async\s+#initBrowser\s*\(\s*\)\s*\{)/;
    if (initTarget.test(baseBmContent) && !baseBmContent.includes('await ensureEdgeRunning()')) {
      baseBmContent = baseBmContent.replace(
        initTarget,
        `$1\n        await ensureEdgeRunning().catch((err) => {\n            console.error('[EdgeLauncher] ensureEdgeRunning error:', err.message);\n        });\n        if (!this.#config.resolved.browserUrl && !this.#config.resolved.wsEndpoint && !this.#config.resolved.userDataDir) {\n            this.#config.resolved.browserUrl = 'http://127.0.0.1:9222';\n        }`
      );
    }
    fs.writeFileSync(paths.browserManagerJs, baseBmContent, 'utf8');
  }

  // 4. Patch app.asar (if not already patched)
  console.log('[4/5] Checking and patching app.asar (Electron main process)...');
  if (!isAsarPatched || options.force) {
    console.log('      Extracting app.asar safely (bypassing missing unpacked files)...');
    const tempExtractDir = path.join(os.tmpdir(), 'antigravity_asar_patch_' + Date.now());
    extractAsarSafe(paths.appAsar, tempExtractDir, paths.unpackedDir);

    // Copy edgeLauncher.cjs.js to dist/edgeLauncher.js
    const edgeLauncherCjsSrc = path.join(srcDir, 'edgeLauncher.cjs.js');
    const distDir = path.join(tempExtractDir, 'dist');
    fs.copyFileSync(edgeLauncherCjsSrc, path.join(distDir, 'edgeLauncher.js'));

    // Patch dist/main.js
    const mainJsPath = path.join(distDir, 'main.js');
    let mainContent = fs.readFileSync(mainJsPath, 'utf8');

    if (!mainContent.includes('setupEdgeAutoLauncher')) {
      // Add require
      mainContent = 'const edgeLauncher_1 = require("./edgeLauncher");\n' + mainContent;
      // Add auto-launcher setup call
      const targetPoint = '(0, updater_1.initAutoUpdater)(HEADLESS, settingsService);';
      if (mainContent.includes(targetPoint)) {
        mainContent = mainContent.replace(
          targetPoint,
          targetPoint + '\n    // Auto-launch Edge for /browser slash command\n    (0, edgeLauncher_1.setupEdgeAutoLauncher)(electron_1.session);'
        );
      } else {
        // Fallback: append after app startup
        mainContent += '\n(0, edgeLauncher_1.setupEdgeAutoLauncher)(electron_1.session);\n';
      }
      fs.writeFileSync(mainJsPath, mainContent, 'utf8');
    }

    console.log('      Repacking patched app.asar with unpacked chrome-devtools-mcp...');
    child_process.execSync(`npx asar pack "${tempExtractDir}" "${paths.appAsar}" --unpack-dir "node_modules/chrome-devtools-mcp"`, { stdio: 'inherit' });

    // Clean temp
    try { fs.rmSync(tempExtractDir, { recursive: true, force: true }); } catch {}
  } else {
    console.log('      app.asar is already patched.');
  }

  // 5. Ensure mcp_config.json has chrome_devtools and edge_profile exists
  console.log('[5/5] Configuring global MCP registry and dedicated profile directory...');
  fs.mkdirSync(paths.edgeProfile, { recursive: true });

  // Lock Agent profile name to "Browser-Agent"
  try {
    const agentLocalState = path.join(paths.edgeProfile, 'Local State');
    if (fs.existsSync(agentLocalState)) {
      const ls = JSON.parse(fs.readFileSync(agentLocalState, 'utf8'));
      if (ls.profile?.info_cache?.Default) {
        ls.profile.info_cache.Default.name = 'Browser-Agent';
        ls.profile.info_cache.Default.is_using_default_name = false;
        fs.writeFileSync(agentLocalState, JSON.stringify(ls, null, 2), 'utf8');
      }
    }
    const agentPref = path.join(paths.edgeProfile, 'Default', 'Preferences');
    if (fs.existsSync(agentPref)) {
      const pref = JSON.parse(fs.readFileSync(agentPref, 'utf8'));
      if (!pref.profile) pref.profile = {};
      pref.profile.name = 'Browser-Agent';
      pref.profile.using_default_name = false;
      fs.writeFileSync(agentPref, JSON.stringify(pref, null, 2), 'utf8');
    }
  } catch {}

  // Clean stale personal DevToolsActivePort if present
  try {
    const personalActivePort = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data', 'DevToolsActivePort');
    if (fs.existsSync(personalActivePort)) fs.unlinkSync(personalActivePort);
  } catch {}

  // Enforce NTFS ACL permissions so non-admin processes never encounter permission quirks
  try {
    const currentUser = os.userInfo().username;
    child_process.execSync(`icacls "${paths.edgeProfile}" /grant "${currentUser}:(OI)(CI)F" /T /C`, { stdio: 'ignore' });
  } catch {}

  const mcpConfigDir = path.dirname(paths.mcpConfig);
  fs.mkdirSync(mcpConfigDir, { recursive: true });

  let mcpJson = { mcpServers: {} };
  if (fs.existsSync(paths.mcpConfig)) {
    try {
      const raw = fs.readFileSync(paths.mcpConfig, 'utf8');
      mcpJson = JSON.parse(raw);
    } catch {}
  }

  if (!mcpJson.mcpServers) mcpJson.mcpServers = {};
  mcpJson.mcpServers.chrome_devtools = {
    command: "node",
    args: [
      path.join(paths.unpackedDir, 'node_modules', 'chrome-devtools-mcp', 'build', 'src', 'bin', 'chrome-devtools-mcp.js'),
      "--no-usage-statistics",
      "--no-performance-crux",
      "--browserUrl",
      "http://127.0.0.1:9222"
    ]
  };

  // Write clean UTF-8 without BOM
  fs.writeFileSync(paths.mcpConfig, JSON.stringify(mcpJson, null, 2) + '\n', 'utf8');

  // Refresh language server MCP registry if running
  refreshLanguageServer();

  console.log('\n=====================================================');
  console.log('  SUCCESS: Microsoft Edge integration applied!');
  console.log('  You can now start Antigravity and use /browser.');
  console.log('=====================================================\n');
}

function refreshLanguageServer() {
  try {
    const script = `
      $proc = Get-CimInstance Win32_Process -Filter "Name = 'language_server.exe'" | Select-Object -First 1 ProcessId, CommandLine
      if ($proc) {
        $csrf = if ($proc.CommandLine -match '--csrf_token\\s+([a-f0-9\\-]+)') { $matches[1] } else { '' }
        $ports = Get-NetTCPConnection -OwningProcess $proc.ProcessId -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort
        foreach ($p in $ports) {
          try {
            $uri = "http://127.0.0.1:$p/exa.language_server_pb.LanguageServerService/RefreshMcpServers"
            $headers = @{ 'x-codeium-csrf-token' = $csrf; 'Content-Type' = 'application/json' }
            Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body '{}' -TimeoutSec 2 | Out-Null
            Write-Output "Refreshed on port $p"
          } catch {}
        }
      }
    `;
    const out = child_process.execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim();
    if (out) console.log('  [OK] Language server MCP registry refreshed.');
  } catch {}
}

function uninstall(options = {}) {
  const paths = getAntigravityPaths();

  console.log('=====================================================');
  console.log('  Antigravity Microsoft Edge Integration Uninstaller');
  console.log('=====================================================\n');

  if (!fs.existsSync(paths.baseDir)) {
    throw new Error(`Antigravity was not found at: ${paths.baseDir}`);
  }

  if (isAntigravityRunning() && !options.force) {
    throw new Error('Antigravity is currently running. Please close Antigravity before uninstalling the patch (or pass --force).');
  }

  // 1. Restore app.asar from backup
  if (fs.existsSync(paths.appAsarBackup)) {
    console.log('[1/4] Restoring pristine app.asar from backup...');
    fs.copyFileSync(paths.appAsarBackup, paths.appAsar);
  } else {
    console.log('[1/4] Warning: app.asar.backup not found; cannot restore app.asar.');
  }

  // 2. Restore browser.js and BrowserManager.js from backup
  if (fs.existsSync(paths.browserJsBackup)) {
    console.log('[2/4] Restoring pristine browser.js from backup...');
    fs.copyFileSync(paths.browserJsBackup, paths.browserJs);
  }
  if (fs.existsSync(paths.browserManagerJsBackup)) {
    console.log('[2/4] Restoring pristine BrowserManager.js from backup...');
    fs.copyFileSync(paths.browserManagerJsBackup, paths.browserManagerJs);
  }

  // 3. Remove edgeLauncher.js from unpacked directory
  if (fs.existsSync(paths.edgeLauncherEsm)) {
    console.log('[3/4] Removing edgeLauncher.js from app.asar.unpacked...');
    try { fs.unlinkSync(paths.edgeLauncherEsm); } catch {}
  }

  // 4. Remove chrome_devtools from mcp_config.json if requested
  console.log('[4/4] Cleaning global mcp_config.json...');
  if (fs.existsSync(paths.mcpConfig)) {
    try {
      const raw = fs.readFileSync(paths.mcpConfig, 'utf8');
      const json = JSON.parse(raw);
      if (json.mcpServers && json.mcpServers.chrome_devtools) {
        delete json.mcpServers.chrome_devtools;
        fs.writeFileSync(paths.mcpConfig, JSON.stringify(json, null, 2) + '\n', 'utf8');
      }
    } catch {}
  }

  console.log('\n=====================================================');
  console.log('  SUCCESS: Microsoft Edge integration reverted.');
  console.log('  Antigravity restored to factory Chrome configuration.');
  console.log('=====================================================\n');
}

module.exports = {
  getAntigravityPaths,
  isAntigravityRunning,
  checkStatus,
  install,
  uninstall
};
