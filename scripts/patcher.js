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
  const cdtMcpDir = path.join(unpackedDir, 'node_modules', 'chrome-devtools-mcp');
  const cdtMcpPkgJson = path.join(cdtMcpDir, 'package.json');
  const cdtMcpSrc = path.join(cdtMcpDir, 'build', 'src');
  const browserJs = path.join(cdtMcpSrc, 'browser.js');
  const browserJsBackup = path.join(cdtMcpSrc, 'browser.js.backup');
  const browserManagerJs = path.join(cdtMcpSrc, 'BrowserManager.js');
  const browserManagerJsBackup = path.join(cdtMcpSrc, 'BrowserManager.js.backup');
  const mcpPageJs = path.join(cdtMcpSrc, 'McpPage.js');
  const mcpPageJsBackup = path.join(cdtMcpSrc, 'McpPage.js.backup');
  const mcpContextJs = path.join(cdtMcpSrc, 'McpContext.js');
  const mcpContextJsBackup = path.join(cdtMcpSrc, 'McpContext.js.backup');
  const edgeLauncherEsm = path.join(cdtMcpSrc, 'edgeLauncher.js');
  const mcpConfig = path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');
  const edgeProfile = path.join(os.homedir(), '.gemini', 'antigravity', 'edge_profile');

  return {
    baseDir,
    resourcesDir,
    appAsar,
    appAsarBackup,
    unpackedDir,
    cdtMcpDir,
    cdtMcpPkgJson,
    cdtMcpSrc,
    browserJs,
    browserJsBackup,
    browserManagerJs,
    browserManagerJsBackup,
    mcpPageJs,
    mcpPageJsBackup,
    mcpContextJs,
    mcpContextJsBackup,
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

function getInstalledCdtMcpVersion(paths) {
  if (paths.cdtMcpPkgJson && fs.existsSync(paths.cdtMcpPkgJson)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(paths.cdtMcpPkgJson, 'utf8'));
      return pkg.version || null;
    } catch {
      return null;
    }
  }
  return null;
}

function getLatestCdtMcpVersion() {
  try {
    const stdout = child_process.execSync('npm view chrome-devtools-mcp version', {
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (/^\d+\.\d+\.\d+/.test(stdout)) {
      return stdout;
    }
    return null;
  } catch {
    return null;
  }
}

function stopRunningCdtMcpProcesses() {
  try {
    const script = `
      Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like "*chrome-devtools-mcp*" } | ForEach-Object {
        try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
      }
    `;
    child_process.execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { stdio: 'ignore' });
  } catch {}
}

function updateChromeDevToolsMcp(paths, targetVersion = 'latest') {
  const tempDir = path.join(os.tmpdir(), 'cdt_mcp_update_' + Date.now());
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    stopRunningCdtMcpProcesses();
    console.log(`      Downloading chrome-devtools-mcp@${targetVersion} via npm pack...`);
    child_process.execSync(`npm pack chrome-devtools-mcp@${targetVersion}`, {
      cwd: tempDir,
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: 45000
    });

    const tgz = fs.readdirSync(tempDir).find(f => f.endsWith('.tgz'));
    if (!tgz) {
      throw new Error('Failed to find downloaded chrome-devtools-mcp tarball in ' + tempDir);
    }

    console.log(`      Extracting ${tgz}...`);
    child_process.execSync(`tar -xzf "${tgz}"`, {
      cwd: tempDir,
      stdio: ['ignore', 'inherit', 'inherit']
    });

    const extractedPkgDir = path.join(tempDir, 'package');
    if (!fs.existsSync(extractedPkgDir) || !fs.existsSync(path.join(extractedPkgDir, 'package.json'))) {
      throw new Error('Extracted package contents are invalid in ' + extractedPkgDir);
    }

    console.log(`      Deploying chrome-devtools-mcp to ${paths.cdtMcpDir}...`);
    fs.mkdirSync(path.dirname(paths.cdtMcpDir), { recursive: true });

    if (fs.existsSync(paths.cdtMcpDir)) {
      fs.rmSync(paths.cdtMcpDir, { recursive: true, force: true });
    }

    fs.cpSync(extractedPkgDir, paths.cdtMcpDir, { recursive: true });

    // Clean up stale backup files so fresh backups are taken from the new version
    const backupsToClean = [
      paths.browserJsBackup,
      paths.browserManagerJsBackup,
      paths.mcpPageJsBackup,
      paths.mcpContextJsBackup
    ];
    for (const b of backupsToClean) {
      if (fs.existsSync(b)) {
        try { fs.unlinkSync(b); } catch {}
      }
    }

    const newVersion = getInstalledCdtMcpVersion(paths);
    console.log(`      [OK] chrome-devtools-mcp updated to v${newVersion || targetVersion}.`);
    return true;
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
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
  const baseOffset = 8 + headerSize;

  function walk(dirObj, curDest) {
    fs.mkdirSync(curDest, { recursive: true });
    for (const [name, entry] of Object.entries(dirObj.files)) {
      const destPath = path.join(curDest, name);
      if (entry.files) {
        walk(entry, destPath);
      } else if (!entry.unpacked && entry.offset !== undefined) {
        const buf = Buffer.alloc(entry.size);
        if (entry.size > 0) {
          fs.readSync(fd, buf, 0, entry.size, baseOffset + parseInt(entry.offset, 10));
        }
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
    if (fs.existsSync(cdtDest)) {
      fs.rmSync(cdtDest, { recursive: true, force: true });
    }
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
  } else {
    // In chrome-devtools-mcp v1.11+, BrowserManager.js replaced browser.js
    checks.browserJsPatched = true;
  }

  checks.browserManagerJsPatched = true;
  if (fs.existsSync(paths.browserManagerJs)) {
    const content = fs.readFileSync(paths.browserManagerJs, 'utf8');
    checks.browserManagerJsPatched = content.includes('ensureEdgeRunning');
  }

  checks.mcpPageJsPatched = true;
  if (fs.existsSync(paths.mcpPageJs)) {
    const content = fs.readFileSync(paths.mcpPageJs, 'utf8');
    checks.mcpPageJsPatched = content.includes('this.#pptrPage?.url() || this.target.url()');
  }

  checks.mcpContextJsPatched = true;
  if (fs.existsSync(paths.mcpContextJs)) {
    const content = fs.readFileSync(paths.mcpContextJs, 'utf8');
    checks.mcpContextJsPatched = content.includes('!url') && content.includes("return target.type() === 'page';");
  }

  checks.cdtMcpVersion = getInstalledCdtMcpVersion(paths);
  checks.cdtMcpLatestVersion = getLatestCdtMcpVersion();

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

  const isFullyPatched = checks.edgeLauncherUnpackedExists && checks.browserJsPatched && checks.browserManagerJsPatched && checks.mcpPageJsPatched && checks.mcpContextJsPatched && checks.appAsarPatched && checks.mcpConfigConfigured;
  const isCompletelyOriginal = !checks.edgeLauncherUnpackedExists && !checks.browserJsPatched && !checks.appAsarPatched;

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

  // 1. Ensure latest chrome-devtools-mcp is installed
  console.log('[1/6] Checking chrome-devtools-mcp version...');
  const currentVersion = getInstalledCdtMcpVersion(paths);
  const latestVersion = getLatestCdtMcpVersion();
  let mcpUpdated = false;

  if (latestVersion && (currentVersion !== latestVersion || options.forceUpdateMcp)) {
    console.log(`      Updating chrome-devtools-mcp: v${currentVersion || 'none'} -> v${latestVersion}...`);
    mcpUpdated = updateChromeDevToolsMcp(paths, latestVersion);
  } else if (latestVersion) {
    console.log(`      chrome-devtools-mcp is up to date (v${currentVersion}).`);
  } else {
    console.log(`      [Info] Unable to query npm registry (offline). Using installed v${currentVersion || 'unknown'}.`);
  }

  // 2. Back up app.asar (only when pristine or no backup exists)
  const asarBuf = fs.readFileSync(paths.appAsar);
  const isAsarPatched = asarBuf.toString('latin1').includes('setupEdgeAutoLauncher');

  if (fs.existsSync(paths.appAsar) && !isAsarPatched) {
    console.log('[2/6] Backing up pristine app.asar -> app.asar.backup...');
    fs.copyFileSync(paths.appAsar, paths.appAsarBackup);
  } else if (fs.existsSync(paths.appAsarBackup)) {
    console.log('[2/6] app.asar is already patched; preserving existing app.asar.backup.');
  }

  // 3. Back up upstream files (only when pristine or no backup exists)
  console.log('[3/6] Backing up upstream files...');
  if (fs.existsSync(paths.browserJs)) {
    const currentBrowser = fs.readFileSync(paths.browserJs, 'utf8');
    const isBrowserPatched = currentBrowser.includes('ensureEdgeRunning');

    if (!fs.existsSync(paths.browserJsBackup)) {
      if (!isBrowserPatched) {
        fs.copyFileSync(paths.browserJs, paths.browserJsBackup);
      } else {
        const cleanBrowser = currentBrowser
          .replace(/import\s*\{\s*ensureEdgeRunning\s*\}\s*from\s*'\.\/edgeLauncher\.js';\r?\n?/, '')
          .replace(/\r?\n\s*await ensureEdgeRunning\(\)\.catch\([\s\S]*?options\.browserURL = "http:\/\/127\.0\.0\.1:9222";\r?\n\s*\}/, '')
          .replace(/\r?\n\s*\/\/ Wait for initial page target to be ready in Puppeteer[\s\S]*?await new Promise\(r => setTimeout\(r, 25\)\);\r?\n\s*\}/, '');
        fs.writeFileSync(paths.browserJsBackup, cleanBrowser, 'utf8');
      }
    }
  }

  // 4. Deploy unpacked files (edgeLauncher.esm.js and dynamically patched browser.js / BrowserManager.js / McpPage.js / McpContext.js)
  console.log('[4/6] Deploying Edge launcher & dynamically patching MCP files in app.asar.unpacked...');
  const edgeLauncherSrc = path.join(srcDir, 'edgeLauncher.esm.js');
  const browserJsSrc = path.join(srcDir, 'browser.js');

  fs.mkdirSync(paths.cdtMcpSrc, { recursive: true });
  fs.copyFileSync(edgeLauncherSrc, paths.edgeLauncherEsm);

  // If browser.js exists, patch it
  if (fs.existsSync(paths.browserJs)) {
    let baseBrowserContent = fs.existsSync(paths.browserJsBackup)
      ? fs.readFileSync(paths.browserJsBackup, 'utf8')
      : fs.readFileSync(paths.browserJs, 'utf8');

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
    const pptrConnectedTarget = /(browser\s*=\s*connected;\s*\r?\n\s*\}\s*\r?\n\s*catch)/;
    if (pptrConnectedTarget.test(baseBrowserContent) && !baseBrowserContent.includes('targetDeadline')) {
      baseBrowserContent = baseBrowserContent.replace(
        pptrConnectedTarget,
        `browser = connected;
        // Wait for initial page target to be ready in Puppeteer
        const targetDeadline = Date.now() + 1000;
        while (Date.now() < targetDeadline) {
            const pTargets = connected.targets().filter(t => t.type() === 'page');
            if (pTargets.length > 0 && pTargets.some(t => t.url() && t.url() !== 'about:blank')) {
                break;
            }
            await new Promise(r => setTimeout(r, 25));
        }
    }
    catch`
      );
    }
    fs.writeFileSync(paths.browserJs, baseBrowserContent, 'utf8');
  }

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
          .replace(/\r?\n\s*await ensureEdgeRunning\(\)\.catch\([\s\S]*?this\.#config\.resolved\.browserUrl = ['"]http:\/\/127\.0\.0\.1:9222['"];\r?\n\s*\}/, '')
          .replace(/\r?\n\s*\/\/ Wait for initial page target to be ready in Puppeteer[\s\S]*?await new Promise\(r => setTimeout\(r, 25\)\);\r?\n\s*\}/, '');
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

    const connectTarget = /(this\.#browser\s*=\s*connected;\s*\r?\n\s*connected\.once\('disconnected')/;
    if (connectTarget.test(baseBmContent) && !baseBmContent.includes('targetDeadline')) {
      baseBmContent = baseBmContent.replace(
        connectTarget,
        `this.#browser = connected;
            // Wait for initial page target to be ready in Puppeteer
            const targetDeadline = Date.now() + 1000;
            while (Date.now() < targetDeadline) {
                const pTargets = connected.targets().filter(t => t.type() === 'page');
                if (pTargets.length > 0 && pTargets.some(t => t.url() && t.url() !== 'about:blank')) {
                    break;
                }
                await new Promise(r => setTimeout(r, 25));
            }
            connected.once('disconnected'`
      );
    }

    fs.writeFileSync(paths.browserManagerJs, baseBmContent, 'utf8');
  }

  // Dynamically patch McpPage.js if present (fixing initial target URL fallback for Edge)
  if (fs.existsSync(paths.mcpPageJs)) {
    const currentMcpPage = fs.readFileSync(paths.mcpPageJs, 'utf8');
    const isMcpPagePatched = currentMcpPage.includes('this.#pptrPage?.url() || this.target.url()');

    if (!fs.existsSync(paths.mcpPageJsBackup)) {
      console.log('      Backing up McpPage.js -> McpPage.js.backup...');
      if (!isMcpPagePatched) {
        fs.copyFileSync(paths.mcpPageJs, paths.mcpPageJsBackup);
      } else {
        const cleanMcpPage = currentMcpPage.replace(
          /return\s*\(this\.#pptrPage\?\.url\(\)\s*\|\|\s*this\.target\.url\(\)\)\s*\?\?\s*'';/,
          'return this.#pptrPage?.url() ?? this.target.url();'
        );
        fs.writeFileSync(paths.mcpPageJsBackup, cleanMcpPage, 'utf8');
      }
    }

    let baseMcpPageContent = fs.existsSync(paths.mcpPageJsBackup)
      ? fs.readFileSync(paths.mcpPageJsBackup, 'utf8')
      : currentMcpPage;

    const urlRegex = /(url\(\)\s*\{\s*return\s+)this\.#pptrPage\?\.url\(\)\s*\?\?\s*this\.target\.url\(\);(\s*\})/;
    if (urlRegex.test(baseMcpPageContent)) {
      baseMcpPageContent = baseMcpPageContent.replace(
        urlRegex,
        `$1(this.#pptrPage?.url() || this.target.url()) ?? '';$2`
      );
    }
    fs.writeFileSync(paths.mcpPageJs, baseMcpPageContent, 'utf8');
  }

  // Dynamically patch McpContext.js if present (fixing target readiness filter and premature page pruning)
  if (fs.existsSync(paths.mcpContextJs)) {
    const currentMcpContext = fs.readFileSync(paths.mcpContextJs, 'utf8');
    const isMcpContextPatched = currentMcpContext.includes('!url') && currentMcpContext.includes("return target.type() === 'page';");

    if (!fs.existsSync(paths.mcpContextJsBackup)) {
      console.log('      Backing up McpContext.js -> McpContext.js.backup...');
      if (!isMcpContextPatched) {
        fs.copyFileSync(paths.mcpContextJs, paths.mcpContextJsBackup);
      } else {
        const cleanMcpContext = currentMcpContext.replace(
          /const url = \(existingMcpPage \? existingMcpPage\.url\(\) : target\.url\(\)\) \|\| target\.url\(\);\r?\n\s*if \(!url\) \{\r?\n\s*return target\.type\(\) === 'page';\r?\n\s*\}/,
          'const url = existingMcpPage ? existingMcpPage.url() : target.url();'
        );
        fs.writeFileSync(paths.mcpContextJsBackup, cleanMcpContext, 'utf8');
      }
    }

    let baseMcpContextContent = fs.existsSync(paths.mcpContextJsBackup)
      ? fs.readFileSync(paths.mcpContextJsBackup, 'utf8')
      : currentMcpContext;

    const targetUrlCheck = /(#isPageTarget\s*\(\s*target\s*\)\s*\{[\s\S]*?const\s+url\s*=\s*)(existingMcpPage\s*\?\s*existingMcpPage\.url\(\)\s*:\s*target\.url\(\));/;
    if (targetUrlCheck.test(baseMcpContextContent)) {
      baseMcpContextContent = baseMcpContextContent.replace(
        targetUrlCheck,
        `$1($2) || target.url();\n        if (!url) {\n            return target.type() === 'page';\n        }`
      );
    }
    fs.writeFileSync(paths.mcpContextJs, baseMcpContextContent, 'utf8');
  }

  // 5. Patch app.asar (if not already patched or if forced / updated)
  console.log('[5/6] Checking and patching app.asar (Electron main process)...');
  if (!isAsarPatched || options.force || mcpUpdated) {
    console.log('      Extracting app.asar safely (bypassing missing unpacked files)...');
    const tempExtractDir = path.join(os.tmpdir(), 'antigravity_asar_patch_' + Date.now());
    const sourceAsar = (paths.appAsarBackup && fs.existsSync(paths.appAsarBackup)) ? paths.appAsarBackup : paths.appAsar;
    extractAsarSafe(sourceAsar, tempExtractDir, paths.unpackedDir);

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

  // 6. Ensure mcp_config.json has chrome_devtools and edge_profile exists
  console.log('[6/6] Configuring global MCP registry and dedicated profile directory...');
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

  // 2. Restore browser.js, BrowserManager.js, McpPage.js, and McpContext.js from backup
  if (fs.existsSync(paths.browserJsBackup)) {
    console.log('[2/4] Restoring pristine browser.js from backup...');
    fs.copyFileSync(paths.browserJsBackup, paths.browserJs);
  }
  if (fs.existsSync(paths.browserManagerJsBackup)) {
    console.log('[2/4] Restoring pristine BrowserManager.js from backup...');
    fs.copyFileSync(paths.browserManagerJsBackup, paths.browserManagerJs);
  }
  if (fs.existsSync(paths.mcpPageJsBackup)) {
    console.log('[2/4] Restoring pristine McpPage.js from backup...');
    fs.copyFileSync(paths.mcpPageJsBackup, paths.mcpPageJs);
  }
  if (fs.existsSync(paths.mcpContextJsBackup)) {
    console.log('[2/4] Restoring pristine McpContext.js from backup...');
    fs.copyFileSync(paths.mcpContextJsBackup, paths.mcpContextJs);
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
  uninstall,
  getInstalledCdtMcpVersion,
  getLatestCdtMcpVersion,
  updateChromeDevToolsMcp
};
