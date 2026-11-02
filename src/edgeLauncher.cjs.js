"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureEdgeRunning = ensureEdgeRunning;
exports.isEdgeRunning = isEdgeRunning;
exports.getEdgePageTargets = getEdgePageTargets;
exports.findEdgeExecutable = findEdgeExecutable;
exports.syncDevToolsActivePort = syncDevToolsActivePort;
exports.setupEdgeAutoLauncher = setupEdgeAutoLauncher;
exports.PROFILE_DIR = exports.CHROME_USER_DATA_DIR = exports.DEFAULT_PORT = void 0;

const child_process = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");

const DEFAULT_PORT = 9222;
exports.DEFAULT_PORT = DEFAULT_PORT;

const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
];

function findEdgeExecutable() {
  for (const p of EDGE_PATHS) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

const PROFILE_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'edge_profile');
exports.PROFILE_DIR = PROFILE_DIR;

const CHROME_USER_DATA_DIR = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
exports.CHROME_USER_DATA_DIR = CHROME_USER_DATA_DIR;

const ANTIGRAVITY_USER_DATA_DIR = path.join(process.env.APPDATA || '', 'Antigravity');
exports.ANTIGRAVITY_USER_DATA_DIR = ANTIGRAVITY_USER_DATA_DIR;

function isEdgeRunning(port = DEFAULT_PORT) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            resolve(JSON.parse(data));
          } else {
            resolve(null);
          }
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

function getEdgePageTargets(port = DEFAULT_PORT) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            const list = JSON.parse(data);
            const pages = Array.isArray(list) ? list.filter(t => t.type === 'page') : [];
            resolve(pages);
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

function syncDevToolsActivePort(port, wsUrl) {
  try {
    const pathname = new URL(wsUrl).pathname;
    const content = `${port}\n${pathname}\n`;

    fs.mkdirSync(CHROME_USER_DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(CHROME_USER_DATA_DIR, 'DevToolsActivePort'), content, 'utf8');

    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    fs.writeFileSync(path.join(PROFILE_DIR, 'DevToolsActivePort'), content, 'utf8');

    fs.mkdirSync(ANTIGRAVITY_USER_DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(ANTIGRAVITY_USER_DATA_DIR, 'DevToolsActivePort'), content, 'utf8');
    return true;
  } catch (err) {
    console.error('[EdgeLauncher] Error syncing DevToolsActivePort:', err);
    return false;
  }
}

let _edgeProcess = null;

async function ensureEdgeRunning(port = DEFAULT_PORT) {
  const existingVersion = await isEdgeRunning(port);
  if (existingVersion && existingVersion.webSocketDebuggerUrl) {
    syncDevToolsActivePort(port, existingVersion.webSocketDebuggerUrl);
    return true;
  }

  const edgeExe = findEdgeExecutable();
  if (!edgeExe) {
    throw new Error('Microsoft Edge executable was not found on this system');
  }

  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.mkdirSync(CHROME_USER_DATA_DIR, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=msEdgeSidebarV2,msHubApps,msEdgeShoppingAssistant,msEdgeDiscoverButton,msSearchEngineChoiceScreen,msSmartScreenProtection',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-translate',
    '--disable-client-side-phishing-detection',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--metrics-recording-only',
    '--no-report-upload'
  ];

  _edgeProcess = child_process.spawn(edgeExe, args, {
    detached: true,
    stdio: 'ignore'
  });
  _edgeProcess.unref();

  _edgeProcess.on('exit', () => {
    _edgeProcess = null;
  });

  const startTime = Date.now();
  while (Date.now() - startTime < 8000) {
    await new Promise(r => setTimeout(r, 100));
    const version = await isEdgeRunning(port);
    if (version && version.webSocketDebuggerUrl) {
      syncDevToolsActivePort(port, version.webSocketDebuggerUrl);

      // Page Readiness Barrier: wait a moment for Edge's initial tab to transition beyond empty/about:blank
      const pageDeadline = Date.now() + 1000;
      while (Date.now() < pageDeadline) {
        const pages = await getEdgePageTargets(port);
        if (pages.length > 0 && pages.some(p => p.url && p.url !== 'about:blank')) {
          break;
        }
        await new Promise(r => setTimeout(r, 25));
      }

      console.error(`[EdgeLauncher] Microsoft Edge launched with remote debugging on port ${port}`);
      return true;
    }
  }

  throw new Error(`Timeout waiting for Microsoft Edge on port ${port}`);
}

function setupEdgeAutoLauncher(session) {
  if (!session || !session.defaultSession) return;
  session.defaultSession.webRequest.onBeforeRequest(
    {
      urls: ['<all_urls>']
    },
    (details, callback) => {
      if (details.url && details.url.includes('CheckDevToolsActivePort')) {
        ensureEdgeRunning()
          .catch((err) => {
            console.error('[EdgeLauncher] Error ensuring Edge running:', err);
          })
          .finally(() => {
            callback({});
          });
        return;
      }
      callback({});
    }
  );
  console.error('[EdgeLauncher] Edge auto-launcher registered for /browser command');
}
