"use strict";

const http = require("http");

let launcher;
try {
  launcher = require("./edgeLauncher");
} catch {
  launcher = require("./edgeLauncher.cjs.js");
}

const DEFAULT_PORT = launcher.DEFAULT_PORT || 9222;

let _persistentWs = null;
let _persistentWsUrl = null;
let _cdpNextId = 1;
const _cdpPending = new Map();
let _cursorInjectedTargets = new Set();

function closePersistentCdp() {
  if (_persistentWs) {
    try {
      _persistentWs.close();
    } catch {}
    _persistentWs = null;
    _persistentWsUrl = null;
  }
  for (const [, item] of _cdpPending.entries()) {
    clearTimeout(item.timer);
    item.reject(new Error("CDP connection closed"));
  }
  _cdpPending.clear();
}

async function getOrCreatePersistentCdp(targetWsUrl) {
  if (_persistentWs && _persistentWsUrl === targetWsUrl && _persistentWs.readyState === 1) {
    return _persistentWs;
  }
  closePersistentCdp();

  const ws = new globalThis.WebSocket(targetWsUrl);
  _persistentWs = ws;
  _persistentWsUrl = targetWsUrl;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error("Timeout connecting to Edge CDP WebSocket"));
    }, 4000);

    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = (err) => {
      clearTimeout(timer);
      reject(err);
    };
  });

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.id && _cdpPending.has(msg.id)) {
        const item = _cdpPending.get(msg.id);
        _cdpPending.delete(msg.id);
        clearTimeout(item.timer);
        if (msg.error) item.reject(new Error(msg.error.message));
        else item.resolve(msg.result);
      }
    } catch {}
  };

  ws.onclose = () => {
    if (_persistentWs === ws) {
      _persistentWs = null;
      _persistentWsUrl = null;
    }
  };

  return ws;
}

/**
 * Connects to Edge's CDP browser or page WebSocket and executes a CDP method.
 */
async function sendCdpToTarget(targetWsUrl, method, params = {}, timeoutMs = 8000) {
  try {
    const ws = await getOrCreatePersistentCdp(targetWsUrl);
    const id = ++_cdpNextId;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        _cdpPending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      _cdpPending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  } catch (err) {
    closePersistentCdp();
    throw err;
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
 * Requests Edge to create a new tab via PUT /json/new.
 */
async function createEdgeTab(url = "about:blank", port = DEFAULT_PORT) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: `/json/new?${encodeURIComponent(url)}`,
        method: "PUT",
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

/**
 * Activates an Edge tab by ID via PUT /json/activate/{id}.
 */
async function activateEdgeTab(tabId, port = DEFAULT_PORT) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: `/json/activate/${tabId}`,
        method: "PUT",
      },
      () => resolve(true)
    );
    req.on("error", () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

let _primaryEdgeTabId = null;

/**
 * Gets or creates the primary active page target in Edge.
 */
async function getPrimaryEdgePage(port = DEFAULT_PORT, autoLaunch = false) {
  if (autoLaunch) {
    await launcher.ensureEdgeRunning(port);
  } else {
    const running = await launcher.isEdgeRunning(port);
    if (!running) return null;
  }

  let tabs = await listEdgeTabs(port);
  if (tabs.length === 0 && autoLaunch) {
    const newTab = await createEdgeTab("about:blank", port);
    if (newTab) {
      _primaryEdgeTabId = newTab.id;
      return newTab;
    }
    tabs = await listEdgeTabs(port);
  }
  if (_primaryEdgeTabId) {
    const found = tabs.find((t) => t.id === _primaryEdgeTabId);
    if (found) return found;
  }
  const active = tabs[0] || null;
  if (active) _primaryEdgeTabId = active.id;
  return active;
}

/**
 * Injects the visual AI Mouse Pointer into Microsoft Edge pages.
 */
const AI_CURSOR_SNIPPET = `(() => {
  if (window.__agyCursorInjected) return;
  window.__agyCursorInjected = true;

  const cursor = document.createElement('div');
  cursor.id = 'antigravity-ai-cursor';
  cursor.innerHTML = \`
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter: drop-shadow(0 2px 5px rgba(0,0,0,0.45));">
      <path d="M5.5 3.21V20.8c0 .45.54.67.85.35l4.86-4.86a.5.5 0 0 1 .35-.15h6.87c.45 0 .67-.54.35-.85L5.5 3.21z" fill="#FFFFFF" stroke="#000000" stroke-width="1.5" stroke-linejoin="round"/>
    </svg>
    <div id="antigravity-ai-ripple" style="position: absolute; top: 0; left: 0; width: 22px; height: 22px; border-radius: 50%; border: 2.5px solid #2563eb; transform: translate(-50%, -50%) scale(0); opacity: 0; pointer-events: none;"></div>
  \`;
  Object.assign(cursor.style, {
    position: 'fixed',
    top: '0px',
    left: '0px',
    zIndex: '2147483647',
    pointerEvents: 'none',
    transform: 'translate(-2px, -2px)',
    transition: 'left 0.05s linear, top 0.05s linear',
    willChange: 'left, top'
  });

  const attach = () => {
    if (!document.getElementById('antigravity-ai-cursor')) {
      const root = document.body || document.documentElement;
      if (root) root.appendChild(cursor);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach);
  } else {
    attach();
  }

  window.__agySetCursorPos = (x, y) => {
    attach();
    cursor.style.left = x + 'px';
    cursor.style.top = y + 'px';
  };

  window.__agyPlayClickRipple = () => {
    const ripple = document.getElementById('antigravity-ai-ripple');
    if (!ripple) return;
    ripple.style.transition = 'none';
    ripple.style.transform = 'translate(-50%, -50%) scale(0)';
    ripple.style.opacity = '0.9';
    requestAnimationFrame(() => {
      ripple.style.transition = 'transform 0.35s ease-out, opacity 0.35s ease-out';
      ripple.style.transform = 'translate(-50%, -50%) scale(2.5)';
      ripple.style.opacity = '0';
    });
  };

  window.addEventListener('mousemove', (e) => {
    window.__agySetCursorPos(e.clientX, e.clientY);
  }, true);

  window.addEventListener('mousedown', (e) => {
    window.__agySetCursorPos(e.clientX, e.clientY);
    window.__agyPlayClickRipple();
  }, true);
})();`;

/**
 * Ensures the visual AI Mouse Pointer is injected into Edge.
 */
async function ensureAiCursorInjected(targetWsUrl) {
  if (_cursorInjectedTargets.has(targetWsUrl)) return;
  try {
    // 1. Evaluate immediately on active page
    await sendCdpToTarget(targetWsUrl, "Runtime.evaluate", {
      expression: AI_CURSOR_SNIPPET,
      returnByValue: false,
    }, 2000).catch(() => undefined);

    // 2. Register for all future page navigations
    await sendCdpToTarget(targetWsUrl, "Page.addScriptToEvaluateOnNewDocument", {
      source: AI_CURSOR_SNIPPET,
    }, 2000).catch(() => undefined);

    _cursorInjectedTargets.add(targetWsUrl);
  } catch (err) {
    console.error("[EdgeVirtualEngine] Failed to inject AI cursor script:", err.message);
  }
}

/**
 * Opens or navigates a persistent tab in Microsoft Edge to match the agent's target URL.
 */
async function openOrNavigateEdgeTab(url, port = DEFAULT_PORT) {
  if (!url || url === "about:blank" || url.startsWith("chrome-extension://") || url.startsWith("devtools://")) {
    return null;
  }
  try {
    await launcher.ensureEdgeRunning(port);
    const tabs = await listEdgeTabs(port);

    let targetTab = null;
    if (_primaryEdgeTabId) {
      targetTab = tabs.find((t) => t.id === _primaryEdgeTabId);
    }

    // If no existing tracked tab, reuse an empty newtab/about:blank if available
    if (!targetTab) {
      targetTab = tabs.find(
        (t) => t.url === "about:blank" || t.url.includes("edge://newtab") || t.url.includes("chrome://newtab")
      );
    }

    if (targetTab && targetTab.webSocketDebuggerUrl) {
      _primaryEdgeTabId = targetTab.id;
      await sendCdpToTarget(targetTab.webSocketDebuggerUrl, "Page.navigate", { url });
      await activateEdgeTab(targetTab.id, port);
      await ensureAiCursorInjected(targetTab.webSocketDebuggerUrl);
      return targetTab;
    }

    // Otherwise create a fresh persistent tab in Edge
    targetTab = await createEdgeTab(url, port);
    if (targetTab && targetTab.id) {
      _primaryEdgeTabId = targetTab.id;
      await activateEdgeTab(targetTab.id, port);
      if (targetTab.webSocketDebuggerUrl) {
        await ensureAiCursorInjected(targetTab.webSocketDebuggerUrl);
      }
    }
    return targetTab;
  } catch (err) {
    console.error("[EdgeVirtualEngine] openOrNavigateEdgeTab error:", err.message);
    return null;
  }
}

/**
 * Retrieves all cookies from Edge's Browser-Agent profile via CDP.
 */
async function getEdgeCookies(port = DEFAULT_PORT) {
  const page = await getPrimaryEdgePage(port, false);
  if (!page || !page.webSocketDebuggerUrl) {
    return [];
  }
  try {
    // Try modern Storage.getCookies first
    const res = await sendCdpToTarget(page.webSocketDebuggerUrl, "Storage.getCookies", {}, 4000);
    if (res && Array.isArray(res.cookies)) {
      return res.cookies;
    }
  } catch {}

  try {
    // Fallback to Network.getAllCookies
    const res2 = await sendCdpToTarget(page.webSocketDebuggerUrl, "Network.getAllCookies", {}, 4000);
    if (res2 && Array.isArray(res2.cookies)) {
      return res2.cookies;
    }
  } catch (err) {
    console.error("[EdgeVirtualEngine] Error fetching Edge cookies:", err.message);
  }
  return [];
}

/**
 * Syncs all cookies from Microsoft Edge into an Electron session partition concurrently.
 */
async function syncEdgeCookiesToSession(targetSession, port = DEFAULT_PORT) {
  if (!targetSession || !targetSession.cookies) {
    return 0;
  }
  const cookies = await getEdgeCookies(port);
  if (!cookies || cookies.length === 0) return 0;

  const setPromises = cookies.map((c) => {
    try {
      const domainClean = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
      const protocol = c.secure ? "https://" : "http://";
      const url = `${protocol}${domainClean}${c.path || "/"}`;

      let sameSite = "no_restriction";
      if (c.sameSite === "Strict") sameSite = "strict";
      else if (c.sameSite === "Lax") sameSite = "lax";

      return targetSession.cookies
        .set({
          url,
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || "/",
          secure: Boolean(c.secure),
          httpOnly: Boolean(c.httpOnly),
          expirationDate: typeof c.expires === "number" && c.expires > 0 ? c.expires : undefined,
          sameSite,
        })
        .catch(() => undefined);
    } catch {
      return Promise.resolve();
    }
  });

  await Promise.all(setPromises);
  return cookies.length;
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
        const page = await getPrimaryEdgePage(port, false);
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
          sameSite: cookie.sameSite === "strict" ? "Strict" : cookie.sameSite === "lax" ? "Lax" : "None",
        });
      } catch {}
    }
  });
}

/**
 * Navigates Edge's active page target to a URL on demand.
 */
async function navigateEdge(url, port = DEFAULT_PORT) {
  return openOrNavigateEdgeTab(url, port);
}

/**
 * Dispatches CDP mouse/keyboard/text input to Edge and updates the visual AI cursor.
 */
async function dispatchEdgeInput(method, params, port = DEFAULT_PORT) {
  const page = await getPrimaryEdgePage(port, false);
  if (!page || !page.webSocketDebuggerUrl) {
    return false;
  }
  try {
    await ensureAiCursorInjected(page.webSocketDebuggerUrl);

    // If mouse movement or press, update AI cursor position in Edge
    if (method === "Input.dispatchMouseEvent") {
      const x = typeof params.x === "number" ? Math.round(params.x) : 0;
      const y = typeof params.y === "number" ? Math.round(params.y) : 0;

      // Update cursor position
      await sendCdpToTarget(page.webSocketDebuggerUrl, "Runtime.evaluate", {
        expression: `if (window.__agySetCursorPos) window.__agySetCursorPos(${x}, ${y});${params.type === 'mousePressed' ? 'if (window.__agyPlayClickRipple) window.__agyPlayClickRipple();' : ''}`,
        returnByValue: false,
      }, 1000).catch(() => undefined);
    }

    await sendCdpToTarget(page.webSocketDebuggerUrl, method, params, 3000);
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
  const page = await getPrimaryEdgePage(port, false);
  if (!page || !page.webSocketDebuggerUrl) {
    return null;
  }
  try {
    const res = await sendCdpToTarget(
      page.webSocketDebuggerUrl,
      "Page.captureScreenshot",
      {
        format,
        quality: format === "jpeg" ? quality : undefined,
      },
      8000
    );
    if (res && res.data) {
      return Buffer.from(res.data, "base64");
    }
    return null;
  } catch (err) {
    console.error("[EdgeVirtualEngine] Error capturing Edge screenshot:", err.message);
    return null;
  }
}

/**
 * Captures a screenshot from Edge and wraps it in an Electron nativeImage.
 */
async function captureEdgePageNativeImage(nativeImageMod, format = "jpeg", quality = 80, port = DEFAULT_PORT) {
  try {
    const buf = await captureEdgeScreenshot(format, quality, port);
    if (buf && buf.length > 0) {
      if (nativeImageMod && typeof nativeImageMod.createFromBuffer === "function") {
        const img = nativeImageMod.createFromBuffer(buf);
        if (img && !img.isEmpty?.()) {
          return img;
        }
      }
    }
  } catch (err) {
    console.error("[EdgeVirtualEngine] Error creating nativeImage from Edge screenshot:", err.message);
  }
  return null;
}

/**
 * Executes an arbitrary CDP command directly against Microsoft Edge.
 */
async function sendCdpToEdge(method, params = {}, port = DEFAULT_PORT) {
  const page = await getPrimaryEdgePage(port, false);
  if (!page || !page.webSocketDebuggerUrl) {
    return undefined;
  }
  return sendCdpToTarget(page.webSocketDebuggerUrl, method, params, 8000);
}

module.exports = {
  ensureEdgeRunning: launcher.ensureEdgeRunning,
  isEdgeRunning: launcher.isEdgeRunning,
  listEdgeTabs,
  getPrimaryEdgePage,
  createEdgeTab,
  activateEdgeTab,
  openOrNavigateEdgeTab,
  getEdgeCookies,
  syncEdgeCookiesToSession,
  setupCookieSyncWatcher,
  navigateEdge,
  dispatchEdgeInput,
  captureEdgeScreenshot,
  captureEdgePageNativeImage,
  sendCdpToEdge,
  closePersistentCdp,
};
