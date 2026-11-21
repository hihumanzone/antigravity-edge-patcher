"use strict";

const http = require("http");
const launcher = require("./edgeLauncher.cjs.js");

const DEFAULT_PORT = launcher.DEFAULT_PORT || 9222;

/**
 * Connects to Edge's CDP browser or page WebSocket and executes a CDP method.
 */
async function sendCdpToTarget(targetWsUrl, method, params = {}) {
  const ws = new globalThis.WebSocket(targetWsUrl);
  try {
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    return await new Promise((resolve, reject) => {
      const id = 1;
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.id === id) {
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
          }
        } catch (err) {
          reject(err);
        }
      };
      ws.send(JSON.stringify({ id, method, params }));
    });
  } finally {
    try {
      ws.close();
    } catch {}
  }
}

/**
 * Returns list of page targets from Edge.
 */
async function listEdgeTabs(port = DEFAULT_PORT) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          if (res.statusCode === 200) {
            const list = JSON.parse(data);
            resolve(Array.isArray(list) ? list.filter((t) => t.type === "page") : []);
          } else {
            resolve([]);
          }
        } catch {
          resolve([]);
        }
      });
    });
    req.on("error", () => resolve([]));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve([]);
    });
  });
}

/**
 * Gets or creates the primary active page target in Edge.
 */
async function getPrimaryEdgePage(port = DEFAULT_PORT) {
  await launcher.ensureEdgeRunning(port);
  let tabs = await listEdgeTabs(port);
  if (tabs.length === 0) {
    // Open a default blank page
    tabs = await new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/json/new?about:blank`, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve([JSON.parse(data)]);
          } catch {
            resolve([]);
          }
        });
      });
      req.on("error", () => resolve([]));
    });
  }
  return tabs[0] || null;
}

/**
 * Retrieves all cookies from Edge's Browser-Agent profile via CDP.
 */
async function getEdgeCookies(port = DEFAULT_PORT) {
  await launcher.ensureEdgeRunning(port);
  const page = await getPrimaryEdgePage(port);
  if (!page || !page.webSocketDebuggerUrl) {
    return [];
  }
  try {
    const res = await sendCdpToTarget(page.webSocketDebuggerUrl, "Network.getAllCookies");
    return Array.isArray(res.cookies) ? res.cookies : [];
  } catch (err) {
    console.error("[EdgeVirtualEngine] Error fetching Edge cookies:", err.message);
    return [];
  }
}

/**
 * Syncs all cookies from Microsoft Edge into an Electron session partition.
 */
async function syncEdgeCookiesToSession(targetSession, port = DEFAULT_PORT) {
  if (!targetSession || !targetSession.cookies) {
    return 0;
  }
  const cookies = await getEdgeCookies(port);
  let synced = 0;
  for (const c of cookies) {
    try {
      const domainClean = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
      const protocol = c.secure ? "https://" : "http://";
      const url = `${protocol}${domainClean}${c.path || "/"}`;
      
      let sameSite = "no_restriction";
      if (c.sameSite === "Strict") sameSite = "strict";
      else if (c.sameSite === "Lax") sameSite = "lax";

      await targetSession.cookies.set({
        url,
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || "/",
        secure: Boolean(c.secure),
        httpOnly: Boolean(c.httpOnly),
        expirationDate: typeof c.expires === "number" && c.expires > 0 ? c.expires : undefined,
        sameSite
      });
      synced++;
    } catch {
      // Ignore individual cookie rejection (e.g. malformed or expired)
    }
  }
  return synced;
}

/**
 * Watches an Electron session for cookie modifications and updates Edge via CDP.
 */
function setupCookieSyncWatcher(targetSession, port = DEFAULT_PORT) {
  if (!targetSession || !targetSession.cookies || targetSession._edgeWatcherAttached) {
    return;
  }
  targetSession._edgeWatcherAttached = true;

  targetSession.cookies.on("changed", async (_event, cookie, cause, removed) => {
    if (cause === "explicit" && !removed) {
      try {
        const page = await getPrimaryEdgePage(port);
        if (!page || !page.webSocketDebuggerUrl) return;

        const domainClean = cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain;
        const protocol = cookie.secure ? "https://" : "http://";
        const url = `${protocol}${domainClean}${cookie.path || "/"}`;

        await sendCdpToTarget(page.webSocketDebuggerUrl, "Network.setCookie", {
          url,
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          expires: cookie.expirationDate,
          sameSite: cookie.sameSite === "strict" ? "Strict" : (cookie.sameSite === "lax" ? "Lax" : "None")
        });
      } catch {}
    }
  });
}

/**
 * Navigates Edge's active page target to a URL.
 */
async function navigateEdge(url, port = DEFAULT_PORT) {
  const page = await getPrimaryEdgePage(port);
  if (!page || !page.webSocketDebuggerUrl) {
    return false;
  }
  try {
    await sendCdpToTarget(page.webSocketDebuggerUrl, "Page.navigate", { url });
    return true;
  } catch (err) {
    console.error("[EdgeVirtualEngine] Error navigating Edge:", err.message);
    return false;
  }
}

/**
 * Dispatches CDP mouse/keyboard/text input to Edge.
 */
async function dispatchEdgeInput(method, params, port = DEFAULT_PORT) {
  const page = await getPrimaryEdgePage(port);
  if (!page || !page.webSocketDebuggerUrl) {
    return false;
  }
  try {
    await sendCdpToTarget(page.webSocketDebuggerUrl, method, params);
    return true;
  } catch (err) {
    console.error(`[EdgeVirtualEngine] Error dispatching ${method} to Edge:`, err.message);
    return false;
  }
}

/**
 * Captures a high-resolution screenshot from Edge via CDP.
 */
async function captureEdgeScreenshot(format = "jpeg", quality = 80, port = DEFAULT_PORT) {
  const page = await getPrimaryEdgePage(port);
  if (!page || !page.webSocketDebuggerUrl) {
    return null;
  }
  try {
    const res = await sendCdpToTarget(page.webSocketDebuggerUrl, "Page.captureScreenshot", {
      format,
      quality: format === "jpeg" ? quality : undefined
    });
    if (res && res.data) {
      return Buffer.from(res.data, "base64");
    }
    return null;
  } catch (err) {
    console.error("[EdgeVirtualEngine] Error capturing Edge screenshot:", err.message);
    return null;
  }
}

module.exports = {
  ensureEdgeRunning: launcher.ensureEdgeRunning,
  listEdgeTabs,
  getPrimaryEdgePage,
  getEdgeCookies,
  syncEdgeCookiesToSession,
  setupCookieSyncWatcher,
  navigateEdge,
  dispatchEdgeInput,
  captureEdgeScreenshot
};
