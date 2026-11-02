import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';

export const DEFAULT_PORT = 9222;

const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
];

export function findEdgeExecutable() {
  for (const p of EDGE_PATHS) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

export const PROFILE_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'edge_profile');
export const CHROME_USER_DATA_DIR = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
export const ANTIGRAVITY_USER_DATA_DIR = path.join(process.env.APPDATA || '', 'Antigravity');

export function isEdgeRunning(port = DEFAULT_PORT) {
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

export function syncDevToolsActivePort(port, wsUrl) {
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

export async function ensureEdgeRunning(port = DEFAULT_PORT) {
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
      console.error(`[EdgeLauncher] Microsoft Edge launched with remote debugging on port ${port}`);
      return true;
    }
  }

  throw new Error(`Timeout waiting for Microsoft Edge on port ${port}`);
}
