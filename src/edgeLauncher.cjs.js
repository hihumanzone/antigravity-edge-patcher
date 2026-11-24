// edgeLauncher.cjs.js - Lightweight on-demand Microsoft Edge launcher (Browser-Agent profile)
'use strict';

const child_process = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const DEFAULT_PORT = 9222;
const PROFILE_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'edge_profile');

const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];

/** Locates installed Microsoft Edge executable on Windows. */
function findEdgeExecutable() {
  for (const p of EDGE_PATHS) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

/** Queries Edge DevTools `/json/version`; resolves metadata object or `null`. */
function isEdgeRunning(port = DEFAULT_PORT) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(res.statusCode === 200 ? JSON.parse(data) : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(500, () => {
      req.destroy();
      resolve(null);
    });
  });
}

/** Lists active `page` CDP targets on Edge port. */
function getEdgePageTargets(port = DEFAULT_PORT) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            const list = JSON.parse(data);
            resolve(Array.isArray(list) ? list.filter((t) => t && t.type === 'page') : []);
          } else {
            resolve([]);
          }
        } catch {
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.setTimeout(500, () => {
      req.destroy();
      resolve([]);
    });
  });
}

let _edgeProcess = null;
let _launchPromise = null;

/**
 * Ensures dedicated Microsoft Edge (`Browser-Agent` profile) is running on `port`.
 * Coalesces concurrent calls atomically so only one Edge window launches.
 */
async function ensureEdgeRunning(port = DEFAULT_PORT) {
  const existing = await isEdgeRunning(port);
  if (existing && existing.webSocketDebuggerUrl) {
    return true;
  }

  if (_launchPromise) {
    return _launchPromise;
  }

  _launchPromise = (async () => {
    try {
      const checkAgain = await isEdgeRunning(port);
      if (checkAgain && checkAgain.webSocketDebuggerUrl) {
        return true;
      }

      const edgeExe = findEdgeExecutable();
      if (!edgeExe) {
        throw new Error('Microsoft Edge executable was not found on this system');
      }

      try {
        if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });
      } catch {}

      const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${PROFILE_DIR}`,
        '--profile-directory=Default',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=msEdgeSidebarV2,msHubApps,msEdgeShoppingAssistant,msEdgeDiscoverButton,msSearchEngineChoiceScreen,msSmartScreenProtection',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-default-apps',
        '--disable-translate',
        '--disable-client-side-phishing-detection',
        '--disable-component-update',
        '--disable-domain-reliability',
        '--metrics-recording-only',
        '--no-report-upload',
      ];

      _edgeProcess = child_process.spawn(edgeExe, args, {
        detached: true,
        stdio: 'ignore',
      });
      _edgeProcess.unref();
      _edgeProcess.on('exit', () => {
        _edgeProcess = null;
      });

      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 80));
        const version = await isEdgeRunning(port);
        if (version && version.webSocketDebuggerUrl) {
          const targetDeadline = Date.now() + 1200;
          while (Date.now() < targetDeadline) {
            const pages = await getEdgePageTargets(port);
            if (pages.length > 0 && pages[0].webSocketDebuggerUrl) {
              break;
            }
            await new Promise((r) => setTimeout(r, 30));
          }
          return true;
        }
      }

      throw new Error(`Timeout waiting for Microsoft Edge CDP on port ${port}`);
    } finally {
      _launchPromise = null;
    }
  })();

  return _launchPromise;
}

/** Restores and brings the Agent Edge OS window (`edge_profile`) to the foreground on Windows. */
function focusEdgeOSWindow() {
  if (process.platform !== 'win32') return;
  const psScript = `
    $ErrorActionPreference = 'SilentlyContinue'
    $sig = '[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);'
    $win32 = Add-Type -MemberDefinition $sig -Name 'EdgeFocusWin32' -Namespace 'AgyEdge' -PassThru
    $procs = Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" | Where-Object { $_.CommandLine -like '*edge_profile*' }
    foreach ($cp in $procs) {
      $p = Get-Process -Id $cp.ProcessId -ErrorAction SilentlyContinue
      if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) {
        if ($win32::IsIconic($p.MainWindowHandle)) { [void]$win32::ShowWindowAsync($p.MainWindowHandle, 9) }
        [void]$win32::SetForegroundWindow($p.MainWindowHandle)
        break
      }
    }
  `;
  try {
    const child = child_process.spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', psScript], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch {}
}

module.exports = {
  DEFAULT_PORT,
  PROFILE_DIR,
  findEdgeExecutable,
  isEdgeRunning,
  getEdgePageTargets,
  ensureEdgeRunning,
  focusEdgeOSWindow,
};
