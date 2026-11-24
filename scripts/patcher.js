const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const child_process = require('child_process');

/**
 * Resolves Antigravity installation paths, app.asar, Edge profile directory,
 * and legacy chrome-devtools-mcp artifact locations (for cleanup/uninstall).
 */
function getAntigravityPaths() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const baseDir = path.join(localAppData, 'Programs', 'antigravity');
  const resourcesDir = path.join(baseDir, 'resources');
  const appAsar = path.join(resourcesDir, 'app.asar');
  const appAsarBackup = path.join(resourcesDir, 'app.asar.backup');
  const unpackedDir = path.join(resourcesDir, 'app.asar.unpacked');

  const cdtMcpDir = path.join(unpackedDir, 'node_modules', 'chrome-devtools-mcp');
  const cdtMcpSrcOut = path.join(cdtMcpDir, 'out', 'Default', 'gen', 'src');
  const cdtMcpSrc = fs.existsSync(cdtMcpSrcOut) ? cdtMcpSrcOut : path.join(cdtMcpDir, 'build', 'src');

  return {
    baseDir,
    resourcesDir,
    appAsar,
    appAsarBackup,
    unpackedDir,
    cdtMcpDir,
    cdtMcpSrc,
    legacyEdgeLauncherEsm: path.join(cdtMcpSrc, 'edgeLauncher.js'),
    legacyMcpBackups: [
      path.join(cdtMcpSrc, 'browser.js.backup'),
      path.join(cdtMcpSrc, 'BrowserManager.js.backup'),
      path.join(cdtMcpSrc, 'McpPage.js.backup'),
      path.join(cdtMcpSrc, 'McpContext.js.backup'),
    ],
    mcpConfig: path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json'),
    edgeProfile: path.join(os.homedir(), '.gemini', 'antigravity', 'edge_profile'),
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

/**
 * Removes legacy v1 chrome-devtools-mcp patch artifacts from app.asar.unpacked
 * and removes unused chrome_devtools server entries from ~/.gemini/config/mcp_config.json.
 */
function cleanupLegacyMcpArtifacts(paths) {
  let cleanedSomething = false;

  for (const backupPath of paths.legacyMcpBackups) {
    if (fs.existsSync(backupPath)) {
      const targetPath = backupPath.replace(/\.backup$/, '');
      try {
        fs.copyFileSync(backupPath, targetPath);
        fs.unlinkSync(backupPath);
        cleanedSomething = true;
      } catch {}
    }
  }

  if (fs.existsSync(paths.legacyEdgeLauncherEsm)) {
    try {
      fs.unlinkSync(paths.legacyEdgeLauncherEsm);
      cleanedSomething = true;
    } catch {}
  }

  if (fs.existsSync(paths.mcpConfig)) {
    try {
      const raw = fs.readFileSync(paths.mcpConfig, 'utf8');
      const json = JSON.parse(raw);
      if (json && json.mcpServers && Object.prototype.hasOwnProperty.call(json.mcpServers, 'chrome_devtools')) {
        delete json.mcpServers.chrome_devtools;
        fs.writeFileSync(paths.mcpConfig, JSON.stringify(json, null, 2) + '\n', 'utf8');
        cleanedSomething = true;
      }
    } catch {}
  }

  return cleanedSomething;
}

/**
 * Extracts `asarPath` to `destDir` and mirrors existing `unpackedDir` contents
 * into `destDir/node_modules` so repacking preserves factory unpacked modules.
 */
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

function applyPatch(label, src, pattern, replacement) {
  const matched = typeof pattern === 'string' ? src.includes(pattern) : pattern.test(src);
  if (!matched) {
    throw new Error(`[EdgePatcher] Failed to match patch target: ${label}`);
  }
  return src.replace(pattern, replacement);
}

/** Evaluates current v3 installation and legacy cleanup status. */
function checkStatus() {
  const paths = getAntigravityPaths();
  const checks = {
    antigravityInstalled: fs.existsSync(paths.baseDir),
    appAsarExists: fs.existsSync(paths.appAsar),
    appAsarBackupExists: fs.existsSync(paths.appAsarBackup),
    edgeCdpEnginePatched: false,
    edgeCdpIsolatedWorldPatched: false,
    edgeCompanionUiPatched: false,
    legacyMcpCleaned: false,
  };

  let asarHasLegacyMainHook = false;
  if (fs.existsSync(paths.appAsar)) {
    try {
      const latin1 = fs.readFileSync(paths.appAsar).toString('latin1');
      checks.edgeCdpEnginePatched =
        latin1.includes('edgeVirtualEngine') &&
        latin1.includes('acquireInteractiveUrl') &&
        latin1.includes('dispatchAgentMouse');
      checks.edgeCdpIsolatedWorldPatched = latin1.includes('executeInMainIsolatedWorld');
      checks.edgeCompanionUiPatched =
        latin1.includes('installEdgeCompanionSurface') &&
        latin1.includes('wcv:get-edge-companion-state');
      asarHasLegacyMainHook = latin1.includes('setupEdgeAutoLauncher');
    } catch {}
  }

  let mcpHasChromeDevtools = false;
  if (fs.existsSync(paths.mcpConfig)) {
    try {
      const json = JSON.parse(fs.readFileSync(paths.mcpConfig, 'utf8'));
      mcpHasChromeDevtools = Boolean(json?.mcpServers?.chrome_devtools);
    } catch {}
  }

  const hasLegacyBackupFiles = paths.legacyMcpBackups.some((b) => fs.existsSync(b));
  checks.legacyMcpCleaned =
    !fs.existsSync(paths.legacyEdgeLauncherEsm) &&
    !hasLegacyBackupFiles &&
    !mcpHasChromeDevtools &&
    !asarHasLegacyMainHook;

  const isFullyPatched =
    checks.antigravityInstalled &&
    checks.appAsarExists &&
    checks.edgeCdpEnginePatched &&
    checks.edgeCdpIsolatedWorldPatched &&
    checks.edgeCompanionUiPatched &&
    checks.legacyMcpCleaned;

  const isCompletelyOriginal =
    !checks.edgeCdpEnginePatched &&
    !checks.edgeCdpIsolatedWorldPatched &&
    !checks.edgeCompanionUiPatched &&
    !asarHasLegacyMainHook;

  let state = 'PARTIAL';
  if (isFullyPatched) state = 'PATCHED';
  else if (isCompletelyOriginal) state = 'UNPATCHED';

  return { state, checks, paths };
}

function patchDistModules(distDir, srcDir) {
  // 1. Deploy lightweight v3 Edge modules
  console.log('      Deploying Edge launcher & v3 CDP engine modules to dist/...');
  const edgeLauncherSrc = path.join(srcDir, 'edgeLauncher.cjs.js');
  const edgeVirtualEngineSrc = path.join(srcDir, 'edgeVirtualEngine.cjs.js');
  fs.copyFileSync(edgeLauncherSrc, path.join(distDir, 'edgeLauncher.js'));
  fs.copyFileSync(edgeLauncherSrc, path.join(distDir, 'edgeLauncher.cjs.js'));
  fs.copyFileSync(edgeVirtualEngineSrc, path.join(distDir, 'edgeVirtualEngine.js'));
  fs.copyFileSync(edgeVirtualEngineSrc, path.join(distDir, 'edgeVirtualEngine.cjs.js'));

  // 2. Patch dist/utils.js (Keep Hub surface opaque so internal browser hole never punches through)
  const utilsJsPath = path.join(distDir, 'utils.js');
  console.log('      Patching utils.js (Opaque hub surface)...');
  let utilsContent = fs.readFileSync(utilsJsPath, 'utf8');
  utilsContent = applyPatch(
    'utils.setHubSurfaceTransparent',
    utilsContent,
    /function setHubSurfaceTransparent\(win, transparent\) \{\r?\n\s*if \(!win \|\| typeof win !== 'object'\) \{/,
    `function setHubSurfaceTransparent(win, transparent) {\n    transparent = false;\n    if (!win || typeof win !== 'object') {`
  );
  fs.writeFileSync(utilsJsPath, utilsContent, 'utf8');

  // 3. Patch dist/wcvBrowserRegistry.js
  const wcvRegistryPath = path.join(distDir, 'wcvBrowserRegistry.js');
  console.log('      Patching wcvBrowserRegistry.js (Suppress internal WCV & bind Edge tabs)...');
  let wcvContent = fs.readFileSync(wcvRegistryPath, 'utf8');

  wcvContent = applyPatch(
    'wcvBrowserRegistry.require',
    wcvContent,
    'const utils_1 = require("./utils");',
    'const utils_1 = require("./utils");\nconst edgeVirtualEngine = require("./edgeVirtualEngine");'
  );

  wcvContent = applyPatch(
    'wcvBrowserRegistry.setRegistryRef',
    wcvContent,
    'exports.wcvBrowserRegistry = new WcvBrowserRegistry();',
    'exports.wcvBrowserRegistry = new WcvBrowserRegistry();\nedgeVirtualEngine.setRegistryRef(exports.wcvBrowserRegistry);'
  );

  wcvContent = applyPatch(
    'wcvBrowserRegistry.getActiveTabKeyHelper',
    wcvContent,
    'dispose(tabKey, clearEvicted = true) {',
    `getActiveTabKeyForWindow(win) {
        const direct = this.activeRequestedTabByWindow.get(win);
        if (direct && this.entries.has(direct)) {
            return direct;
        }
        const vis = this.getVisibleEntryForWindow?.(win);
        if (vis) return vis.tabKey;
        for (const [k, e] of this.entries.entries()) {
            if (e.parentWindow === win) return k;
        }
        return null;
    }
    dispose(tabKey, clearEvicted = true) {`
  );

  wcvContent = applyPatch(
    'wcvBrowserRegistry.existingSetVisible',
    wcvContent,
    'existing.view.setVisible?.(true);',
    'existing.view.setVisible?.(false);'
  );

  wcvContent = applyPatch(
    'wcvBrowserRegistry.existingRegisterTab',
    wcvContent,
    'return this.toSnapshot(existing);\n        }',
    'edgeVirtualEngine.registerTab(existing.tabKey, existing.view.webContents, hubSender, existing.lastUrl, this);\n            return this.toSnapshot(existing);\n        }'
  );

  wcvContent = applyPatch(
    'wcvBrowserRegistry.acquireRegisterTab',
    wcvContent,
    'this.entries.set(request.tabKey, entry);\n        this.byWebContentsId.set(wc.id, entry);',
    'this.entries.set(request.tabKey, entry);\n        this.byWebContentsId.set(wc.id, entry);\n        edgeVirtualEngine.registerTab(entry.tabKey, wc, hubSender, lastUrl, this);'
  );

  // Replace entire pristine restore/load block cleanly without leaving dangling superseded checks
  wcvContent = applyPatch(
    'wcvBrowserRegistry.acquireNoInternalLoad',
    wcvContent,
    /else \{\s*\/\/ A restored stack is the tab's real history[\s\S]*?this\.markClipEntryRevealReady\(entry, 'load-settled'\);\s*\}\s*\}/,
    `else {
                this.bootstrappedBlankEntries.add(entry);
                await wc.loadURL('about:blank').catch(() => undefined);
                const isFreshInteractiveTab = !saved &&
                    (!request.title || request.title === 'New Tab' || request.title === 'about:blank') &&
                    lastUrl &&
                    lastUrl !== 'about:blank' &&
                    /^https:\\/\\/(?:www\\.)?google\\./i.test(lastUrl);
                if ((isFreshInteractiveTab || edgeVirtualEngine.hasAnyAttachedTab()) &&
                    lastUrl &&
                    lastUrl !== 'about:blank' &&
                    !isExternalAuth &&
                    (0, webviewBrowser_1.validateWebviewNavigationUrl)(lastUrl, 'http://127.0.0.1').allowed) {
                    void edgeVirtualEngine.acquireInteractiveUrl(entry.tabKey, lastUrl);
                }
            }`
  );

  wcvContent = applyPatch(
    'wcvBrowserRegistry.syncWindowClipAndEntryBounds',
    wcvContent,
    /if \(!win \|\| win\.isDestroyed\?\.\(\) \|\| !clipView\) \{\s*return;\s*\}/,
    `if (!win || win.isDestroyed?.() || !clipView) {\n            return;\n        }\n        try {\n            clipView.setVisible?.(false);\n            clipView.setBounds?.({ x: 0, y: 0, width: 0, height: 0 });\n            for (const e of this.getEntriesForWindow(win)) {\n                e.view?.setVisible?.(false);\n                e.view?.setBounds?.({ x: 0, y: 0, width: 0, height: 0 });\n                clipView.removeChildView?.(e.view);\n                contentViewOf(win)?.removeChildView?.(e.view);\n            }\n        } catch {}\n        return;`
  );

  // In show(): NEVER auto-launch Edge on standby historical tab restore; switch only if already attached
  wcvContent = applyPatch(
    'wcvBrowserRegistry.show',
    wcvContent,
    /entry\.view\.webContents\.setAudioMuted\?\.\(this\.userMutedTabs\.has\(tabKey\)\);\s*const clipView = \(0, utils_1\.getHubClipView\)\(entry\.parentWindow\);[\s\S]*?this\.detachVisibleSiblings\(entry\.parentWindow, entry\);\s*return this\.toSnapshot\(entry\);\s*\}/,
    `entry.view.webContents.setAudioMuted?.(this.userMutedTabs.has(tabKey));
        entry.appliedBoundsDip = { x: 0, y: 0, width: 0, height: 0 };
        this.recordNormalizedBoundsDip(entry, boundsDip, optionsDip);
        try {
            const clipView = (0, utils_1.getHubClipView)(entry.parentWindow);
            clipView?.setVisible?.(false);
            clipView?.removeChildView?.(entry.view);
            contentViewOf(entry.parentWindow)?.removeChildView?.(entry.view);
            entry.view?.setVisible?.(false);
            (0, utils_1.setHubSurfaceTransparent)(entry.parentWindow, false);
        } catch {}
        this.detachVisibleSiblings(entry.parentWindow, entry);
        void edgeVirtualEngine.activateIfAttached(tabKey);
        return this.toSnapshot(entry);
    }`
  );

  wcvContent = applyPatch(
    'wcvBrowserRegistry.setBounds',
    wcvContent,
    /if \(entry\.visible && !entry\.view\.webContents\.isDestroyed\(\)\) \{[\s\S]*?entry\.view\.setBounds\(nextBounds\);\s*\}\s*\}/,
    `try { entry.view?.setVisible?.(false); } catch {}`
  );

  wcvContent = applyPatch(
    'wcvBrowserRegistry.setRemoteStreamActive',
    wcvContent,
    /if \(next\) \{\s*entry\.view\.setVisible\?\.\(true\);\s*\}/,
    'entry.view.setVisible?.(false);'
  );

  wcvContent = applyPatch(
    'wcvBrowserRegistry.parkHiddenView',
    wcvContent,
    /contentView\?\.addChildView\?\.\(entry\.view, insertIdx\);\s*entry\.view\.setBounds\?\.\(this\.resolveHiddenBounds\(entry\)\);/,
    'contentView?.removeChildView?.(entry.view);\n        entry.view.setVisible?.(false);'
  );

  wcvContent = applyPatch(
    'wcvBrowserRegistry.dispose',
    wcvContent,
    'const existingEntry = this.entries.get(tabKey);',
    'edgeVirtualEngine.disposeTab(tabKey);\n        const existingEntry = this.entries.get(tabKey);'
  );

  wcvContent = applyPatch(
    'wcvBrowserRegistry.toSnapshot',
    wcvContent,
    /return \{\s*tabKey: entry\.tabKey,[\s\S]*?lastLoadError: entry\.lastLoadError \?\? null,\s*\};/,
    `const edgeSnap = edgeVirtualEngine.getTabSnapshotOverride(entry.tabKey);
        return {
            tabKey: entry.tabKey,
            webContentsId: entry.webContentsId,
            url: edgeSnap?.url || (!entry.lastLoadError && hasValidLiveUrl ? liveUrl : entry.lastUrl),
            title: edgeSnap?.title || (isAlive ? wc.getTitle?.() || '' : '') || entry.lastTitle,
            canGoBack: edgeSnap ? Boolean(edgeSnap.canGoBack) : Boolean(history?.canGoBack?.() ?? (isAlive && wc.canGoBack?.())),
            canGoForward: edgeSnap ? Boolean(edgeSnap.canGoForward) : Boolean(history?.canGoForward?.() ?? (isAlive && wc.canGoForward?.())),
            isLoading: edgeSnap ? Boolean(edgeSnap.isLoading) : Boolean(isAlive && wc.isLoading?.()),
            visible: Boolean(entry.visible),
            pinned: Boolean(entry.pinned),
            crashed: Boolean(entry.crashed),
            remoteStreamActive: Boolean(entry.remoteStreamActive),
            remoteControlActive: Boolean(entry.remoteControlActive),
            lastHttpResponseCode: entry.lastHttpResponseCode ?? null,
            lastLoadError: entry.lastLoadError ?? null,
        };`
  );

  fs.writeFileSync(wcvRegistryPath, wcvContent, 'utf8');

  // 4. Patch dist/wcvZOrderController.js
  const wcvZOrderPath = path.join(distDir, 'wcvZOrderController.js');
  console.log('      Patching wcvZOrderController.js (Direct Edge CDP input & navigation)...');
  let zorderContent = fs.readFileSync(wcvZOrderPath, 'utf8');

  zorderContent = applyPatch(
    'wcvZOrderController.require',
    zorderContent,
    'const utils_1 = require("./utils");',
    'const utils_1 = require("./utils");\nconst edgeVirtualEngine = require("./edgeVirtualEngine");'
  );

  zorderContent = applyPatch(
    'wcvZOrderController.fireHover',
    zorderContent,
    'fireHover(k, x, y, m, oob = false, done) {',
    'fireHover(k, x, y, m, oob = false, done) {\n        if (done) { void Promise.resolve().then(done); }\n        return;'
  );

  zorderContent = applyPatch(
    'wcvZOrderController.setAgentControlling',
    zorderContent,
    "this.reconcileWindow(entry.parentWindow, isActive ? 'agent-controlling' : 'agent-controlling-ended');",
    "this.reconcileWindow(entry.parentWindow, isActive ? 'agent-controlling' : 'agent-controlling-ended');\n        void edgeVirtualEngine.setAgentControlling(tabKey, isActive);"
  );

  zorderContent = applyPatch(
    'wcvZOrderController.dispatchMouseEvent',
    zorderContent,
    /async dispatchMouseEvent\(tabKey, params, options\) \{[\s\S]*?finally \{\s*if \(rec\.webContentsId === wcId && rec\.cdpMouseInFlight > 0\) \{\s*rec\.cdpMouseInFlight--;\s*\}\s*\}\s*\}/,
    `async dispatchMouseEvent(tabKey, params, options) {
        const entry = this.registry.getEntry(tabKey);
        if (!entry || entry.view.webContents.isDestroyed()) {
            return;
        }
        if (options?.allowOutOfBounds && !entry.isAgentStepActive) {
            return;
        }
        return edgeVirtualEngine.dispatchAgentMouse(tabKey, params);
    }`
  );

  zorderContent = applyPatch(
    'wcvZOrderController.dispatchKeyEvent',
    zorderContent,
    /async dispatchKeyEvent\(tabKey, params\) \{[\s\S]*?await this\.sendCdp\(tabKey, 'Input\.dispatchKeyEvent', cdpParams\);\s*\}/,
    `async dispatchKeyEvent(tabKey, params) {
        return edgeVirtualEngine.dispatchAgentKey(tabKey, params);
    }`
  );

  zorderContent = applyPatch(
    'wcvZOrderController.insertText',
    zorderContent,
    /async insertText\(tabKey, text\) \{\s*await this\.sendCdp\(tabKey, 'Input\.insertText', \{ text \}\);\s*\}/,
    `async insertText(tabKey, text) {
        return edgeVirtualEngine.insertEdgeText(tabKey, text);
    }`
  );

  zorderContent = applyPatch(
    'wcvZOrderController.capturePageImage',
    zorderContent,
    'async capturePageImage(tabKey) {',
    `async capturePageImage(tabKey) {
        try {
            const edgeShot = await edgeVirtualEngine.captureEdgePageNativeImage(electron_1.nativeImage, tabKey);
            if (edgeShot && !edgeShot.isEmpty?.()) {
                return edgeShot;
            }
        } catch {}
        return null;`
  );

  zorderContent = applyPatch(
    'wcvZOrderController.navigate',
    zorderContent,
    /async navigate\(tabKey, url\) \{[\s\S]*?return true;\s*\}(?=\s*emitZOrderChanged)/,
    `async navigate(tabKey, url) {
        const entry = this.registry.getEntry(tabKey);
        if (!entry || entry.view.webContents.isDestroyed()) {
            return false;
        }
        if ((0, webviewBrowser_1.isExternalOnlyAuthUrl)(url)) {
            void this.registry.openExternalUrl(url);
            return false;
        }
        if (!(0, webviewBrowser_1.validateWebviewNavigationUrl)(url, 'http://127.0.0.1').allowed) {
            return false;
        }
        this.registry.noteExternalNavigation(tabKey, url);
        return edgeVirtualEngine.navigateTab(tabKey, url);
    }`
  );

  fs.writeFileSync(wcvZOrderPath, zorderContent, 'utf8');

  // 5. Patch dist/wcvIpcHandlers.js
  const wcvIpcPath = path.join(distDir, 'wcvIpcHandlers.js');
  console.log('      Patching wcvIpcHandlers.js (Cursor bridge, controls & Companion IPCs)...');
  let wcvIpcContent = fs.readFileSync(wcvIpcPath, 'utf8');

  wcvIpcContent = applyPatch(
    'wcvIpcHandlers.require',
    wcvIpcContent,
    'const wcvBrowserRegistry_1 = require("./wcvBrowserRegistry");',
    'const wcvBrowserRegistry_1 = require("./wcvBrowserRegistry");\nconst edgeVirtualEngine = require("./edgeVirtualEngine");'
  );

  wcvIpcContent = applyPatch(
    'wcvIpcHandlers.dropCursor',
    wcvIpcContent,
    'const drop = (k) => void (cursors.delete(k) && emit(k, null));',
    'const drop = (k) => void (edgeVirtualEngine.updateCursorState(k, null), cursors.delete(k) && emit(k, null));'
  );

  wcvIpcContent = applyPatch(
    'wcvIpcHandlers.pushCursor',
    wcvIpcContent,
    'cursors.set(k, { state, webContentsId, hubSenderId: hubSender.id });',
    'cursors.set(k, { state, webContentsId, hubSenderId: hubSender.id });\n        edgeVirtualEngine.updateCursorState(k, state);'
  );

  wcvIpcContent = applyPatch(
    'wcvIpcHandlers.control',
    wcvIpcContent,
    'const history = wc.navigationHistory;',
    `if (['goBack', 'back', 'goForward', 'forward', 'reload', 'stop'].includes(action) && edgeVirtualEngine.hasTab(tabKey)) {
            return edgeVirtualEngine.controlTab(tabKey, action);
        }
        const history = wc.navigationHistory;`
  );

  wcvIpcContent = applyPatch(
    'wcvIpcHandlers.sendMouse',
    wcvIpcContent,
    'return controller.dispatchMouseEvent(tabKey, hubCssMouseToDip(event, params, coordSpace));',
    `const entry = registry.getEntry(tabKey);
            const mapped = entry?.isAgentStepActive ? params : hubCssMouseToDip(event, params, coordSpace);
            return controller.dispatchMouseEvent(tabKey, mapped);`
  );

  wcvIpcContent = applyPatch(
    'wcvIpcHandlers.setViewportSize',
    wcvIpcContent,
    'return controller.setViewportSize(tabKey, size);',
    `if (edgeVirtualEngine.hasTab(tabKey)) {\n            return null;\n        }\n        return controller.setViewportSize(tabKey, size);`
  );

  wcvIpcContent = applyPatch(
    'wcvIpcHandlers.companionIpcs',
    wcvIpcContent,
    "registerHandle('wcv:dispose', (event, tabKey) => {",
    `registerHandle('wcv:get-edge-companion-state', async (event, includeScreenshot) => {
        const { win } = assertAuthorizedWcvCaller(event, registry);
        const tabKey = registry.getActiveTabKeyForWindow?.(win) ?? null;
        return edgeVirtualEngine.getCompanionState(tabKey, Boolean(includeScreenshot));
    });
    registerHandle('wcv:focus-edge-window', async (event) => {
        const { win } = assertAuthorizedWcvCaller(event, registry);
        const tabKey = registry.getActiveTabKeyForWindow?.(win) ?? null;
        return edgeVirtualEngine.focusEdgeWindow(tabKey);
    });
    registerHandle('wcv:dispose', (event, tabKey) => {`
  );

  fs.writeFileSync(wcvIpcPath, wcvIpcContent, 'utf8');

  // 6. Patch dist/ipcHandlers.js
  const ipcHandlersPath = path.join(distDir, 'ipcHandlers.js');
  console.log('      Patching ipcHandlers.js (Edge isolated worlds, frames, network, dialogs & uploads)...');
  let ipcContent = fs.readFileSync(ipcHandlersPath, 'utf8');

  ipcContent = applyPatch(
    'ipcHandlers.require',
    ipcContent,
    'const wcvBrowserRegistry_1 = require("./wcvBrowserRegistry");',
    'const wcvBrowserRegistry_1 = require("./wcvBrowserRegistry");\nconst edgeVirtualEngine = require("./edgeVirtualEngine");'
  );

  ipcContent = applyPatch(
    'ipcHandlers.executeJsIsolatedWorld',
    ipcContent,
    'return (0, isolatedWorldExec_1.executeJavaScriptInIsolatedWorldWhenReady)(wc, worldId, [{ code }], false);',
    `if (edgeVirtualEngine.hasTabByWcId(webContentsId)) {
            return edgeVirtualEngine.executeInMainIsolatedWorld(webContentsId, worldId, code);
        }
        return (0, isolatedWorldExec_1.executeJavaScriptInIsolatedWorldWhenReady)(wc, worldId, [{ code }], false);`
  );

  ipcContent = applyPatch(
    'ipcHandlers.getNetworkRequests',
    ipcContent,
    'return guestNetworkController_1.guestNetworkController.getRequests(wc.id);',
    `if (edgeVirtualEngine.hasTabByWcId(wc.id)) {
            return edgeVirtualEngine.getNetworkRequests(wc.id);
        }
        return guestNetworkController_1.guestNetworkController.getRequests(wc.id);`
  );

  ipcContent = applyPatch(
    'ipcHandlers.clearNetworkRequests',
    ipcContent,
    'return guestNetworkController_1.guestNetworkController.clearRequests(wc.id);',
    `if (edgeVirtualEngine.hasTabByWcId(wc.id)) {
            return edgeVirtualEngine.clearNetworkRequests(wc.id);
        }
        return guestNetworkController_1.guestNetworkController.clearRequests(wc.id);`
  );

  ipcContent = applyPatch(
    'ipcHandlers.setDialogPolicy',
    ipcContent,
    'return guestDialogController_1.guestDialogController.setPolicy(wc, sender, safePolicy);',
    `if (edgeVirtualEngine.hasTabByWcId(wc.id)) {
            return edgeVirtualEngine.setDialogPolicy(wc.id, safePolicy);
        }
        return guestDialogController_1.guestDialogController.setPolicy(wc, sender, safePolicy);`
  );

  ipcContent = applyPatch(
    'ipcHandlers.handleDialog',
    ipcContent,
    'return guestDialogController_1.guestDialogController.handleDialog(wc, {',
    `if (edgeVirtualEngine.hasTabByWcId(wc.id)) {
            return edgeVirtualEngine.handleJavaScriptDialog(wc.id, {
                ...(typeof decision?.dialogId === 'string' ? { dialogId: decision.dialogId } : {}),
                accept: Boolean(decision?.accept),
                ...(typeof decision?.promptText === 'string' ? { promptText: decision.promptText } : {}),
            });
        }
        return guestDialogController_1.guestDialogController.handleDialog(wc, {`
  );

  ipcContent = applyPatch(
    'ipcHandlers.setFileChooserPolicy',
    ipcContent,
    'return guestFileChooserController_1.guestFileChooserController.setPolicy(wc, sender, {',
    `if (edgeVirtualEngine.hasTabByWcId(wc.id)) {
            return edgeVirtualEngine.setFileChooserPolicy(wc.id, {
                enabled: Boolean(policy?.enabled),
                ...(typeof policy?.tabKey === 'string' ? { tabKey: policy.tabKey } : {}),
            });
        }
        return guestFileChooserController_1.guestFileChooserController.setPolicy(wc, sender, {`
  );

  ipcContent = applyPatch(
    'ipcHandlers.handleFileChooser',
    ipcContent,
    'return guestFileChooserController_1.guestFileChooserController.handleFileChooser(wc, pinned);',
    `if (edgeVirtualEngine.hasTabByWcId(wc.id)) {
            return edgeVirtualEngine.handleFileChooser(wc.id, pinned);
        }
        return guestFileChooserController_1.guestFileChooserController.handleFileChooser(wc, pinned);`
  );

  ipcContent = applyPatch(
    'ipcHandlers.setInputFiles',
    ipcContent,
    'return guestFileChooserController_1.guestFileChooserController.setInputFiles(wc, {',
    `if (edgeVirtualEngine.hasTabByWcId(wc.id)) {
            return edgeVirtualEngine.setInputFiles(wc.id, {
                ...request,
                allowedUploadsDir: pinUploadsRoot(request?.expectedConversationId),
            });
        }
        return guestFileChooserController_1.guestFileChooserController.setInputFiles(wc, {`
  );

  ipcContent = applyPatch(
    'ipcHandlers.listFrames',
    ipcContent,
    "localOnly('webview:list-frames', async (event, wcId, options) => guestFrameBridge_1.guestFrameBridge.listFrames(assertMainFrameGuestCaller(event, wcId, 'webview:list-frames'), options));",
    `localOnly('webview:list-frames', async (event, wcId, options) => {
        const wc = assertMainFrameGuestCaller(event, wcId, 'webview:list-frames');
        if (edgeVirtualEngine.hasTabByWcId(wcId)) {
            return edgeVirtualEngine.listFrames(wcId, options);
        }
        return guestFrameBridge_1.guestFrameBridge.listFrames(wc, options);
    });`
  );

  ipcContent = applyPatch(
    'ipcHandlers.executeFrameIsolatedWorld',
    ipcContent,
    'return guestFrameBridge_1.guestFrameBridge.executeInFrameIsolatedWorld(wc, frameId, code, expectedOrigin, options);',
    `if (edgeVirtualEngine.hasTabByWcId(wcId)) {
            return edgeVirtualEngine.executeInFrameIsolatedWorld(wcId, frameId, code, expectedOrigin, options);
        }
        return guestFrameBridge_1.guestFrameBridge.executeInFrameIsolatedWorld(wc, frameId, code, expectedOrigin, options);`
  );

  fs.writeFileSync(ipcHandlersPath, ipcContent, 'utf8');

  // 7. Patch dist/preload.js (Expose companion APIs & render textured Edge Companion Card inside [data-browser-hole])
  const preloadPath = path.join(distDir, 'preload.js');
  console.log('      Patching preload.js (Branded Edge Companion Card + Live Preview)...');
  let preloadContent = fs.readFileSync(preloadPath, 'utf8');

  preloadContent = applyPatch(
    'preload.exposeCompanionApi',
    preloadContent,
    'ackRemoteControlCommand: (a) => electron_1.ipcRenderer.invoke(\'wcv:remote-control-command-ack\', a),',
    `ackRemoteControlCommand: (a) => electron_1.ipcRenderer.invoke('wcv:remote-control-command-ack', a),
    getEdgeCompanionState: (includeScreenshot) => electron_1.ipcRenderer.invoke('wcv:get-edge-companion-state', Boolean(includeScreenshot)),
    focusEdgeWindow: () => electron_1.ipcRenderer.invoke('wcv:focus-edge-window'),`
  );

  preloadContent = applyPatch(
    'preload.installCompanionSurface',
    preloadContent,
    'installWcvThreeLayerHoleReporter();',
    'installEdgeCompanionSurface();'
  );

  const companionSurfaceFn = `function installEdgeCompanionSurface() {
    const script = \`(() => {
      try {
        if (window.__agyEdgeCompanionInstalled) return;
        window.__agyEdgeCompanionInstalled = true;
        const HOST_ATTR = 'data-agy-edge-companion';
        let activeState = null;
        let pollTimer = null;
        let pendingFetch = false;

        function getActiveHole() {
          return document.querySelector('[data-browser-hole]:not([data-browser-hole="false"])') ||
            document.querySelector('[data-browser-hole]');
        }

        function ensureHost(hole) {
          let host = hole.querySelector('[' + HOST_ATTR + ']');
          if (!host) {
            if (!hole.style.position) hole.style.position = 'relative';
            host = document.createElement('div');
            host.setAttribute(HOST_ATTR, '1');
            host.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;overflow:hidden;';
            const shadow = host.attachShadow({ mode: 'closed' });

            const el = (tag, cls, txt) => {
              const node = document.createElement(tag);
              if (cls) node.className = cls;
              if (txt !== undefined) node.textContent = txt;
              return node;
            };

            const style = el('style', '',
              '.wrap{box-sizing:border-box;width:100%;height:100%;padding:16px 20px 68px;display:flex;flex-direction:column;gap:12px;background-color:#0c0e13;background-image:radial-gradient(rgba(148,163,184,0.12) 1px,transparent 1px),radial-gradient(ellipse at 50% 0%,rgba(56,189,248,0.08),transparent 65%);background-size:20px 20px,100% 100%;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}' +
              '.hdr{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 14px;border-radius:10px;background:rgba(17,22,31,0.9);border:1px solid rgba(148,163,184,0.15);backdrop-filter:blur(8px);flex-shrink:0;}' +
              '.hdr-left{display:flex;align-items:center;gap:10px;min-width:0;}' +
              '.dot{width:8px;height:8px;border-radius:9999px;flex-shrink:0;background:#f59e0b;box-shadow:0 0 8px rgba(245,158,11,0.55);}' +
              '.dot.on{background:#22c55e;box-shadow:0 0 10px rgba(34,197,94,0.65);}' +
              '.meta{display:flex;flex-direction:column;min-width:0;}' +
              '.title{font-size:12px;font-weight:600;color:#f8fafc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
              '.url{font-size:11px;color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
              '.actions{display:flex;align-items:center;gap:8px;flex-shrink:0;pointer-events:auto;}' +
              '.btn{appearance:none;border:1px solid rgba(56,189,248,0.42);background:rgba(14,165,233,0.16);color:#e0f2fe;font:600 11px/1 inherit;padding:7px 12px;border-radius:8px;cursor:pointer;transition:background .15s,border-color .15s;}' +
              '.btn:hover{background:rgba(14,165,233,0.3);border-color:rgba(56,189,248,0.75);}' +
              '.stage{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;position:relative;border-radius:12px;border:1px solid rgba(148,163,184,0.12);background:rgba(9,11,16,0.72);overflow:hidden;padding:10px;box-sizing:border-box;}' +
              '.shot-box{display:none;align-items:center;justify-content:center;width:100%;height:100%;min-height:0;}' +
              '.shot-box.show{display:flex;}' +
              '.shot-inner{position:relative;display:inline-flex;max-width:100%;max-height:100%;border-radius:8px;overflow:hidden;border:1px solid rgba(255,255,255,0.11);box-shadow:0 16px 40px rgba(0,0,0,0.55);}' +
              '.shot{display:block;max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;}' +
              '.reticle{position:absolute;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:9999px;border:2px solid #38bdf8;background:rgba(56,189,248,0.32);box-shadow:0 0 10px rgba(56,189,248,0.85);display:none;transition:left 120ms ease,top 120ms ease;}' +
              '.reticle.show{display:block;}' +
              '.standby{display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px;padding:24px;max-width:360px;}' +
              '.standby-badge{font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#38bdf8;background:rgba(56,189,248,0.1);border:1px solid rgba(56,189,248,0.25);padding:4px 10px;border-radius:9999px;}' +
              '.standby-h{font-size:14px;font-weight:600;color:#f1f5f9;}' +
              '.standby-p{font-size:12px;line-height:1.45;color:#94a3b8;}'
            );

            const wrap = el('div', 'wrap');
            const hdr = el('div', 'hdr');
            const hdrLeft = el('div', 'hdr-left');
            const dot = el('div', 'dot');
            const meta = el('div', 'meta');
            const title = el('div', 'title', 'Microsoft Edge Companion');
            const url = el('div', 'url', 'Browser-Agent Profile');
            meta.append(title, url);
            hdrLeft.append(dot, meta);

            const actions = el('div', 'actions');
            const btn = el('button', 'btn', 'Bring Edge to Front');
            btn.type = 'button';
            btn.addEventListener('click', (ev) => {
              ev.stopPropagation();
              try { void window.electronNativeAPI?.wcvBrowser?.focusEdgeWindow?.(); } catch {}
            });
            actions.append(btn);
            hdr.append(hdrLeft, actions);

            const stage = el('div', 'stage');
            const shotBox = el('div', 'shot-box');
            const shotInner = el('div', 'shot-inner');
            const shot = el('img', 'shot');
            shot.alt = 'Microsoft Edge Live Preview';
            const reticle = el('div', 'reticle');
            shotInner.append(shot, reticle);
            shotBox.append(shotInner);

            const standby = el('div', 'standby');
            const standbyBadge = el('div', 'standby-badge', 'Browser-Agent Profile');
            const standbyH = el('div', 'standby-h', 'Synced with Microsoft Edge');
            const standbyP = el('div', 'standby-p', 'Edge launches automatically when navigating or running an agent task, or click Bring Edge to Front.');
            standby.append(standbyBadge, standbyH, standbyP);

            stage.append(shotBox, standby);
            wrap.append(hdr, stage);
            shadow.append(style, wrap);

            host.__agyRefs = { dot, title, url, btn, shotBox, shot, reticle, standby, standbyH, standbyP };
            hole.appendChild(host);
          }
          return host;
        }

        function renderState(state) {
          const hole = getActiveHole();
          if (!hole) return;
          const host = ensureHost(hole);
          const refs = host.__agyRefs;
          if (!refs || !state) return;

          const attached = Boolean(state.attached);
          refs.dot.classList.toggle('on', attached);
          const displayTitle = (state.title || '').trim() || (attached ? 'Active in Microsoft Edge' : 'Standby in Microsoft Edge');
          const displayUrl = (state.url || '').trim() || 'about:blank';
          refs.title.textContent = (attached ? 'Edge Active · ' : 'Edge Standby · ') + displayTitle;
          refs.url.textContent = displayUrl;
          refs.btn.textContent = attached ? 'Bring Edge to Front' : 'Open in Edge';

          if (attached && state.screenshotDataUrl) {
            if (refs.shot.src !== state.screenshotDataUrl) {
              refs.shot.src = state.screenshotDataUrl;
            }
            refs.shotBox.classList.add('show');
            refs.standby.style.display = 'none';
            if (state.cursor && state.cursor.active && state.cursor.xRatio >= 0 && state.cursor.yRatio >= 0) {
              refs.reticle.style.left = (Math.max(0, Math.min(1, state.cursor.xRatio)) * 100).toFixed(2) + '%';
              refs.reticle.style.top = (Math.max(0, Math.min(1, state.cursor.yRatio)) * 100).toFixed(2) + '%';
              refs.reticle.classList.add('show');
            } else {
              refs.reticle.classList.remove('show');
            }
          } else {
            refs.shotBox.classList.remove('show');
            refs.reticle.classList.remove('show');
            refs.standby.style.display = 'flex';
            refs.standbyH.textContent = attached ? 'Loading Microsoft Edge...' : 'Edge on Standby for Historical Tab';
            refs.standbyP.textContent = attached
              ? ('Syncing live preview for ' + displayUrl)
              : 'Historical tabs stay closed until you click Open in Edge, navigate, or run an agent task.';
          }
        }

        async function refreshCompanion(includeScreenshot) {
          const hole = getActiveHole();
          if (!hole || pendingFetch) return;
          const api = window.electronNativeAPI?.wcvBrowser;
          if (!api?.getEdgeCompanionState) return;
          pendingFetch = true;
          try {
            const st = await api.getEdgeCompanionState(Boolean(includeScreenshot));
            activeState = st;
            renderState(st);
          } catch {}
          finally {
            pendingFetch = false;
          }
        }

        function syncLoopState() {
          const hole = getActiveHole();
          if (hole) {
            ensureHost(hole);
            if (!pollTimer) {
              void refreshCompanion(true);
              pollTimer = setInterval(() => {
                if (document.visibilityState === 'visible') {
                  void refreshCompanion(true);
                }
              }, 1100);
            }
          } else if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
        }

        try {
          window.electronNativeAPI?.wcvBrowser?.onGuestEvent?.(() => {
            if (getActiveHole()) void refreshCompanion(true);
          });
        } catch {}

        let rafPending = false;
        const scheduleSync = () => {
          if (!rafPending) {
            rafPending = true;
            requestAnimationFrame(() => {
              rafPending = false;
              syncLoopState();
              if (activeState) renderState(activeState);
            });
          }
        };

        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', scheduleSync, { once: true });
        } else {
          scheduleSync();
        }
        new MutationObserver(scheduleSync).observe(document.documentElement || document, { childList: true, subtree: true });
      } catch {}
    })();\`;
    const inject = () => { void electron_1.webFrame?.executeJavaScript?.(script).catch(() => undefined); };
    if (document?.documentElement) inject();
    else window?.addEventListener?.('DOMContentLoaded', inject, { once: true });
}
if (!isRemoteWindow) {`;

  preloadContent = applyPatch(
    'preload.defineCompanionSurface',
    preloadContent,
    'if (!isRemoteWindow) {',
    companionSurfaceFn
  );

  fs.writeFileSync(preloadPath, preloadContent, 'utf8');
}

function validatePatchedSyntax(distDir) {
  const files = [
    'main.js',
    'utils.js',
    'preload.js',
    'wcvBrowserRegistry.js',
    'wcvZOrderController.js',
    'wcvIpcHandlers.js',
    'ipcHandlers.js',
    'edgeLauncher.js',
    'edgeVirtualEngine.js',
  ];
  for (const relFile of files) {
    const targetJs = path.join(distDir, relFile);
    if (fs.existsSync(targetJs)) {
      new vm.Script(fs.readFileSync(targetJs, 'utf8'), { filename: relFile });
    }
  }
}

function ensureEdgeProfilePermissions(edgeProfile) {
  fs.mkdirSync(edgeProfile, { recursive: true });
  try {
    const agentLocalState = path.join(edgeProfile, 'Local State');
    if (fs.existsSync(agentLocalState)) {
      const ls = JSON.parse(fs.readFileSync(agentLocalState, 'utf8'));
      if (ls.profile?.info_cache?.Default) {
        ls.profile.info_cache.Default.name = 'Browser-Agent';
        ls.profile.info_cache.Default.is_using_default_name = false;
        fs.writeFileSync(agentLocalState, JSON.stringify(ls, null, 2), 'utf8');
      }
    }
    const agentPref = path.join(edgeProfile, 'Default', 'Preferences');
    if (fs.existsSync(agentPref)) {
      const pref = JSON.parse(fs.readFileSync(agentPref, 'utf8'));
      if (!pref.profile) pref.profile = {};
      pref.profile.name = 'Browser-Agent';
      pref.profile.using_default_name = false;
      fs.writeFileSync(agentPref, JSON.stringify(pref, null, 2), 'utf8');
    }
  } catch {}

  try {
    const currentUser = os.userInfo().username;
    child_process.execSync(`icacls "${edgeProfile}" /grant "Everyone:(OI)(CI)F" "${currentUser}:(OI)(CI)F" /T /C`, { stdio: 'ignore' });
  } catch {}
}

function install(options = {}) {
  const paths = getAntigravityPaths();
  const srcDir = path.resolve(__dirname, '..', 'src');

  console.log('=====================================================');
  console.log('  Antigravity Microsoft Edge Installer (v3 Clean)');
  console.log('=====================================================\n');

  if (!fs.existsSync(paths.baseDir)) {
    throw new Error(`Antigravity was not found at: ${paths.baseDir}`);
  }

  if (isAntigravityRunning() && !options.force) {
    throw new Error('Antigravity is currently running. Please close Antigravity before applying the patch (or pass --force).');
  }

  // [1/4] Protect pristine app.asar.backup
  const asarLatin1 = fs.readFileSync(paths.appAsar).toString('latin1');
  const alreadyHasAnyPatch = asarLatin1.includes('edgeVirtualEngine') || asarLatin1.includes('setupEdgeAutoLauncher');
  if (!fs.existsSync(paths.appAsarBackup)) {
    if (alreadyHasAnyPatch) {
      throw new Error('app.asar is already patched and app.asar.backup is missing; cannot recover pristine base.');
    }
    console.log('[1/4] Backing up pristine app.asar -> app.asar.backup...');
    fs.copyFileSync(paths.appAsar, paths.appAsarBackup);
  } else {
    console.log('[1/4] Preserving pristine app.asar.backup.');
  }

  // [2/4] Strip legacy v1 chrome-devtools-mcp files & config entries
  console.log('[2/4] Cleaning legacy chrome-devtools-mcp artifacts & mcp_config...');
  const cleaned = cleanupLegacyMcpArtifacts(paths);
  console.log(cleaned ? '      Removed unused legacy MCP hooks & chrome_devtools config.' : '      Already clean.');

  // [3/4] Extract pristine app.asar, deploy v3 Edge engine, validate syntax & repack
  console.log('[3/4] Patching Electron dist modules for Edge-Only + Companion UI...');
  const isV3Patched =
    asarLatin1.includes('acquireInteractiveUrl') &&
    asarLatin1.includes('installEdgeCompanionSurface') &&
    !asarLatin1.includes('setupEdgeAutoLauncher');

  if (!isV3Patched || options.force) {
    const tempExtractDir = path.join(os.tmpdir(), 'antigravity_asar_v3_' + Date.now());
    try {
      extractAsarSafe(paths.appAsarBackup, tempExtractDir, paths.unpackedDir);
      const distDir = path.join(tempExtractDir, 'dist');
      patchDistModules(distDir, srcDir);
      validatePatchedSyntax(distDir);
      console.log('      Repacking patched app.asar...');
      child_process.execSync(
        `npx asar pack "${tempExtractDir}" "${paths.appAsar}" --unpack-dir "node_modules/chrome-devtools-mcp"`,
        { stdio: 'inherit' }
      );
    } finally {
      try { fs.rmSync(tempExtractDir, { recursive: true, force: true }); } catch {}
    }
  } else {
    console.log('      app.asar already has v3 patch.');
  }

  // [4/4] Ensure dedicated Browser-Agent Edge profile exists
  console.log('[4/4] Ensuring dedicated Browser-Agent Edge profile...');
  ensureEdgeProfilePermissions(paths.edgeProfile);

  console.log('\n=====================================================');
  console.log('  SUCCESS: Edge-Only v3 integration applied!');
  console.log('  Restart Antigravity if running to load app.asar.');
  console.log('=====================================================\n');
}

function uninstall(options = {}) {
  const paths = getAntigravityPaths();

  console.log('=====================================================');
  console.log('  Antigravity Microsoft Edge Uninstaller');
  console.log('=====================================================\n');

  if (!fs.existsSync(paths.baseDir)) {
    throw new Error(`Antigravity was not found at: ${paths.baseDir}`);
  }

  if (isAntigravityRunning() && !options.force) {
    throw new Error('Antigravity is currently running. Please close Antigravity before uninstalling the patch (or pass --force).');
  }

  if (fs.existsSync(paths.appAsarBackup)) {
    console.log('[1/2] Restoring pristine app.asar from app.asar.backup...');
    fs.copyFileSync(paths.appAsarBackup, paths.appAsar);
  } else {
    console.log('[1/2] Warning: app.asar.backup not found; cannot restore app.asar.');
  }

  console.log('[2/2] Cleaning legacy MCP artifacts...');
  cleanupLegacyMcpArtifacts(paths);

  console.log('\n=====================================================');
  console.log('  UNINSTALLED: Antigravity restored to factory state.');
  console.log('=====================================================\n');
}

module.exports = {
  getAntigravityPaths,
  checkStatus,
  install,
  uninstall,
};
