# Antigravity Microsoft Edge Integration Patcher

A modular, automated patcher and source repository that seamlessly integrates **Microsoft Edge** with the built-in `/browser` slash command and browser subagent in **Google Antigravity 2.0**.

---

## Features

* **No Pop-Up Dialogs**: Silences the *"Remote Debugging Required"* modal by intercepting the UI's port-check RPC before the dialog can trigger.
* **Lazy Automatic Launch**: Microsoft Edge launches automatically when `/browser` or browser action tools are invoked. Edge **never** launches on Antigravity application startup.
* **Dedicated Profile**: Automates an isolated profile at `~/.gemini/antigravity/edge_profile` so your personal browsing history, cookies, and extensions are untouched.
* **100% Programmatic Remote Debugging**: Automatically enables Chrome DevTools Protocol (CDP) on port `9222` with no manual user toggles in `edge://inspect/#remote-debugging`.
* **Autonomous Sub-agent Execution**: The browser subagent executes all browsing tasks directly and end-to-end with zero main agent bypass.
* **One-Click Install & Clean Uninstall**: Safely backs up original files and allows instant switching between Edge automation and factory Chrome behavior.

---

## Directory Structure

```text
antigravity-edge-patcher/
├── README.md                   # Complete documentation and usage guide
├── LICENSE                     # MIT License
├── package.json                # Project metadata & npm execution scripts
├── update.bat                  # One-click updater for when Antigravity updates
├── src/                        # Original source code for the Edge integration
│   ├── edgeLauncher.esm.js     # Edge supervisor for chrome-devtools-mcp (ESM)
│   ├── edgeLauncher.cjs.js     # Edge supervisor & auto-launcher for Electron main process (CommonJS)
│   ├── browser.js              # Patched browser connector with lazy Edge launch & port 9222 fallback
│   ├── main-patch.snippet.js   # Interceptor code snippet injected into Electron dist/main.js
│   └── mcp_config.json         # Documentation template for the generated global MCP config
└── scripts/                    # Automation scripts
    ├── patcher.js              # Core patching engine (backups, asar unpack/pack, patching)
    ├── install.js              # Node.js installer entry point
    ├── uninstall.js            # Node.js uninstaller entry point
    ├── status.js               # Diagnostic script reporting patch status
    ├── install.ps1             # Windows PowerShell one-click installer
    ├── uninstall.ps1           # Windows PowerShell one-click uninstaller
    └── status.ps1              # Windows PowerShell status checker
```

---

## Requirements

* **Windows** (10/11) — the patcher relies on `%LOCALAPPDATA%`, `tasklist`, and `icacls`.
* **Antigravity 2.0** installed at `%LOCALAPPDATA%\Programs\antigravity`.
* **Node.js 18+** on `PATH`.
* **[`asar`](https://www.npmjs.com/package/asar)** — invoked via `npx asar` to unpack/repack `app.asar`. It is fetched on demand, so the first install needs network access.

> **Note:** Patching writes to Antigravity's install directory and repacks `app.asar`. An Antigravity update overwrites `app.asar` with factory binaries, so re-run the installer (see step 3 below) to re-apply the patch.

---

## Quick Start

### 1. Check Current Status

Check whether Antigravity is currently running in original mode or patched mode:

**PowerShell:**
```powershell
.\scripts\status.ps1
```

**Node.js / npm:**
```bash
npm run status
# or
node scripts/status.js
```

---

### 2. Install (Apply Edge Integration)

Before installing, close Antigravity (or pass `--force` / `-Force` to bypass the process check):

**PowerShell:**
```powershell
.\scripts\install.ps1
# Or force if Antigravity is running:
.\scripts\install.ps1 -Force
```

**Node.js / npm:**
```bash
npm run install-patch
# Or:
node scripts/install.js --force
```

**What the installer does automatically:**
1. Backs up original `app.asar` to `app.asar.backup`.
2. Backs up original `browser.js` to `browser.js.backup`.
3. Deploys `edgeLauncher.js` and patched `browser.js` into `app.asar.unpacked`.
4. Extracts `app.asar`, injects `dist/edgeLauncher.js`, updates `dist/main.js` with the slash command interceptor, and repacks `app.asar`.
5. Configures `~/.gemini/config/mcp_config.json` with a clean UTF-8 (No BOM) entry for `chrome_devtools`.
6. Creates the dedicated profile directory `~/.gemini/antigravity/edge_profile`.

---

---

### 3. Re-applying After an Antigravity Update (Manual One-Click Update)

Whenever Antigravity updates itself, its installer replaces `resources/app.asar` with factory binaries. To re-apply the patch in ~5 seconds without keeping any processes running in the background:

**Option A: One-Click Batch File (Easiest)**
* Simply double-click `update.bat` in the project root directory.

**Option B: PowerShell**
```powershell
.\scripts\install.ps1 -Force
```

**Option C: npm**
```bash
npm run update
```

---

### 4. Uninstall (Restore Factory Chrome Default)

To revert Antigravity back to its pristine factory configuration:

**PowerShell:**
```powershell
.\scripts\uninstall.ps1
```

**Node.js / npm:**
```bash
npm run uninstall-patch
# or
node scripts/uninstall.js
```

**What the uninstaller does automatically:**
1. Restores the factory `app.asar` from `app.asar.backup`.
2. Restores the factory `browser.js` from `browser.js.backup`.
3. Removes `edgeLauncher.js` from `app.asar.unpacked`.
4. Cleans up the `chrome_devtools` entry in `mcp_config.json`.

---

## Technical Architecture

### 1. How the Pop-Up is Silenced
When you invoke `/browser` in the chat UI, Antigravity sends an internal RPC query:
```text
POST /exa.language_server_pb.LanguageServerService/CheckDevToolsActivePort
```
In the unpatched app, this check fails if Google Chrome is not running, causing the UI to display the *"Remote Debugging Required"* modal.
The patch injects an `onBeforeRequest` webRequest interceptor in `app.asar` (`dist/main.js`). When this RPC is detected, it asynchronously ensures Edge is active and synchronizes `DevToolsActivePort` before letting the request proceed. The language server immediately answers `{"exists": true}`, and the warning dialog never appears.

### 2. Lazy Process Launch
Tool discovery (`tools/list`) executes whenever Antigravity boots up. If the browser launch was placed in the CLI entry point, Edge would open on app startup. 
The patch ensures Edge launch is strictly **lazy**:
- Only when `CheckDevToolsActivePort` is called (the `/browser` command was typed), OR
- When a browser automation tool (`navigate_page`, `take_snapshot`, etc.) is called by the agent.

### 3. Dedicated Profile & ActivePort Synchronization
Edge launches with:
```bash
msedge.exe --remote-debugging-port=9222 --user-data-dir="<HOME>\.gemini\antigravity\edge_profile" --no-first-run --no-default-browser-check
```
The patch captures the active WebSocket debugging URL from `http://127.0.0.1:9222/json/version` and writes `DevToolsActivePort` to:
* `%LOCALAPPDATA%\Google\Chrome\User Data\DevToolsActivePort`
* `<HOME>\.gemini\antigravity\edge_profile\DevToolsActivePort`
* `%APPDATA%\Antigravity\DevToolsActivePort`

### 4. Main Agent vs. Sub-agent Settings
* `~/.gemini/config/mcp_config.json` is Antigravity's authoritative registry of MCP definitions.
* Toggling "Chrome DevTools" to **Disabled** in **Settings -> Installed MCP** disables the tools in the *main chat*, but leaves the schema intact for the **`/browser` subagent**, keeping your main chat clean while the subagent remains fully functional.

---

## Disclaimer

This project modifies the internals of Google Antigravity, a third-party application. It is not affiliated with, endorsed by, or supported by Google or Microsoft. Use it at your own risk, and run `npm run uninstall-patch` if you need to restore factory behaviour. The `app.asar.backup` file created by the installer is your recovery path — keep it.

---

## License

Released under the [MIT License](LICENSE).
