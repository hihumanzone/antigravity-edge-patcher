# Antigravity Microsoft Edge Integration (v3)

A lightweight, dependency-free patcher that replaces Google Antigravity's built-in Chromium browser execution with **Microsoft Edge** over direct Chrome DevTools Protocol (CDP), while rendering a live **Edge Companion Card** directly inside Antigravity.

---

## Features

* **Edge-Only Execution**: Routes all browser subagent execution (`webview:*` isolated worlds, cross-origin OOPIFs, navigation, ordered mouse/keyboard input, screenshots, network logs, dialogs, and file uploads) straight to Microsoft Edge.
* **No Internal `WebContentsView` Split/Overlap**: Keeps Antigravity's Hub surface opaque (`about:blank` anchor only) so no hidden Chromium guest ever loads URLs or fights for clicks.
* **Live Synced Edge Preview**: Mirrors active Microsoft Edge tabs inside Antigravity via real-time CDP screencast frames while keeping Electron's internal `WebContentsView` disabled (`about:blank` anchor only).
* **Independent AI Agent Cursor**: Renders `#antigravity-ai-cursor` inside a closed Shadow DOM in Edge with smooth glide, animated click ripple, and action status badge — driven strictly by agent actions and never hijacked by your physical mouse.
* **On-Demand Single-Tab Launch**: Claims Edge's initial tab cleanly (zero duplicate `New Tab` + `about:blank`), stays closed on Antigravity startup and when inspecting historical conversations, and launches only on active navigation (`+ > Browser` or agent steps).
* **Dedicated Persistent Profile**: Isolates logins and extensions under `~/.gemini/antigravity/edge_profile` (`Browser-Agent`) on CDP port `9222`.
* **Zero External MCP Overhead**: Connects Electron main process directly to Edge via a zero-dependency RFC6455 CDP WebSocket (`CdpWebSocket`) with no external `chrome-devtools-mcp` server or npm downloads needed.

---

## Directory Structure

```text
antigravity-edge-patcher/
├── README.md
├── LICENSE
├── package.json
├── update.bat                      # One-click re-patch after Antigravity updates
├── src/
│   ├── edgeLauncher.cjs.js         # Atomic on-demand Edge launcher & Win32 focus helper
│   └── edgeVirtualEngine.cjs.js    # Direct CDP engine, OOPIF frames, cursor & companion API
└── scripts/
    ├── patcher.js                  # Core asar extractor/patcher & legacy MCP cleaner
    ├── install.js / install.ps1    # One-click installers
    ├── uninstall.js / uninstall.ps1# Restores pristine factory app.asar
    └── status.js / status.ps1      # Diagnostic status checker
```

---

## Requirements

* **Windows 10/11** (`%LOCALAPPDATA%\Programs\antigravity` + Microsoft Edge installed)
* **Node.js 18+** on `PATH`

---

## Usage

### 1. Check Status
```bash
npm run status
# or: node scripts/status.js
```

### 2. Install / Update Patch
Run with Antigravity closed (or pass `--force`, then restart Antigravity):
```bash
npm run update
# or: node scripts/install.js --force
```
Or double-click `update.bat`.

### 3. Uninstall (Restore Factory Antigravity)
```bash
npm run uninstall-patch
# or: node scripts/uninstall.js
```

---

## License

Released under the [MIT License](LICENSE).
