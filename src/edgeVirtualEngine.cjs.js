// edgeVirtualEngine.cjs.js (v2) - Full Edge CDP Execution & Cursor Engine for Antigravity
'use strict';

const http = require('http');
const net = require('net');
const crypto = require('crypto');
function safeRequire(modPath) {
  try {
    return require(modPath);
  } catch {
    return null;
  }
}

const edgeLauncher = safeRequire('./edgeLauncher') || require('./edgeLauncher.cjs.js');

const guestFramePolicy = safeRequire('./guestFramePolicy');
const guestNetworkSanitizer = safeRequire('./guestNetworkSanitizer');
const webviewUploadValidation = safeRequire('./webviewUploadValidation');
const webviewBrowser = safeRequire('./webviewBrowser');

const PAGE_AGENT_WORLD_NAME = guestFramePolicy?.PAGE_AGENT_ISOLATED_WORLD_NAME || 'agy_page_agent';
const CURSOR_WORLD_NAME = 'agy_ai_cursor_overlay';
const WCV_GUEST_EVENT_CHANNEL = 'wcv:guest-event';
const WEBVIEW_DIALOG_OPENING_CHANNEL = 'webview:javascript-dialog-opening';
const WEBVIEW_FILE_CHOOSER_OPENED_CHANNEL = 'webview:file-chooser-opened';
const WEBVIEW_NETWORK_REQUEST_CHANNEL = 'webview:network-request-updated';

const AUTO_ATTACH_PARAMS = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
};

const MAX_NETWORK_ENTRIES = 50;
const MAX_IN_FLIGHT_REQUESTS = 128;
const FRAME_EVAL_TIMEOUT_MS = 30000;
const NAV_WAIT_TIMEOUT_MS = 15000;
const CDP_CMD_TIMEOUT_MS = 20000;
const CURSOR_IDLE_FADE_MS = 2200;

const COMPUTE_OWNER_PATH_AND_RECT_FN = guestFramePolicy?.COMPUTE_OWNER_PATH_AND_RECT_FN || `function() {
  const el = this;
  if (!el || el.nodeType !== 1 || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  return {
    domPath: [],
    rect: { x: r.left, y: r.top, width: r.width, height: r.height, visible: r.width >= 1 && r.height >= 1 }
  };
}`;

const PROTECTED_IDP_HOSTS = [
  'accounts.google.com', 'myaccount.google.com', 'accounts.youtube.com',
  'login.microsoftonline.com', 'login.live.com', 'appleid.apple.com',
];

function isProtectedUrlFallback(rawUrl) {
  try {
    const host = new URL(String(rawUrl || '')).hostname.toLowerCase().replace(/^www\./, '');
    return PROTECTED_IDP_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  } catch {
    return false;
  }
}

function isProtectedIdp(rawUrl) {
  if (typeof guestFramePolicy?.isProtectedIdpFrameUrl === 'function') {
    if (guestFramePolicy.isProtectedIdpFrameUrl(rawUrl)) return true;
  }
  if (typeof webviewUploadValidation?.isProtectedIdentityProviderOriginUrl === 'function') {
    if (webviewUploadValidation.isProtectedIdentityProviderOriginUrl(rawUrl)) return true;
  }
  return isProtectedUrlFallback(rawUrl);
}

function extractOrigin(securityOrigin, rawUrl) {
  if (typeof guestFramePolicy?.extractFrameOrigin === 'function') {
    return guestFramePolicy.extractFrameOrigin(securityOrigin, rawUrl);
  }
  const candidate = (securityOrigin && securityOrigin !== 'null') ? securityOrigin : rawUrl;
  try {
    const parsed = new URL(String(candidate || ''));
    return parsed.origin && parsed.origin !== 'null' ? parsed.origin.toLowerCase() : '';
  } catch {
    return '';
  }
}

function isOpaqueOrigin(raw) {
  if (typeof guestFramePolicy?.isOpaqueOrigin === 'function') {
    return guestFramePolicy.isOpaqueOrigin(raw);
  }
  const s = String(raw || '').trim().toLowerCase();
  return s === 'null' || s === '://';
}

function isStaleCtxErr(err) {
  if (err && err.isEvalErr) return false;
  const msg = err instanceof Error ? err.message : String(err || '');
  return /cannot find context|execution context was destroyed|inspected target navigated|frame with the given id was not found/i.test(msg);
}

function withTimeout(promise, ms, msg) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(msg)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function clampCoord(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
}

function httpRequestJson(method, urlStr) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method,
      timeout: 3000,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (!body) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(body);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`HTTP timeout on ${method} ${urlStr}`));
    });
    req.end();
  });
}

/**
 * Dependency-free RFC6455 WebSocket client supporting fragmented & >64KiB CDP frames.
 */
class CdpWebSocket {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.readyState = 0; // 0: CONNECTING, 1: OPEN, 3: CLOSED
    this.onMessage = null;
    this.onClose = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const parsed = new URL(this.wsUrl);
      const key = crypto.randomBytes(16).toString('base64');
      const socket = net.createConnection({
        host: parsed.hostname || '127.0.0.1',
        port: Number(parsed.port) || 9222,
      });
      this.socket = socket;
      let handshakeDone = false;
      let headerBuf = Buffer.alloc(0);

      const fail = (err) => {
        if (!handshakeDone) {
          handshakeDone = true;
          reject(err);
        }
        this.close();
      };

      socket.once('error', fail);
      socket.once('connect', () => {
        const reqLines = [
          `GET ${parsed.pathname}${parsed.search} HTTP/1.1`,
          `Host: ${parsed.host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '\r\n',
        ];
        socket.write(reqLines.join('\r\n'));
      });

      const onData = (chunk) => {
        if (!handshakeDone) {
          headerBuf = Buffer.concat([headerBuf, chunk]);
          const sepIdx = headerBuf.indexOf('\r\n\r\n');
          if (sepIdx === -1) return;

          const head = headerBuf.subarray(0, sepIdx).toString('latin1');
          const rest = headerBuf.subarray(sepIdx + 4);
          if (!/^HTTP\/1\.[01]\s+101\b/i.test(head)) {
            fail(new Error(`WebSocket upgrade failed: ${head.split('\r\n')[0]}`));
            return;
          }
          handshakeDone = true;
          this.readyState = 1;
          if (rest.length > 0) {
            this.buffer = Buffer.concat([this.buffer, rest]);
          }
          resolve(this);
          this._drainFrames();
          return;
        }
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this._drainFrames();
      };

      socket.on('data', onData);
      socket.once('close', () => {
        if (this.readyState !== 3) {
          this.readyState = 3;
          try { this.onClose?.(); } catch {}
        }
        if (!handshakeDone) {
          handshakeDone = true;
          reject(new Error('WebSocket closed before handshake completed'));
        }
      });
    });
  }

  _drainFrames() {
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        const hi = this.buffer.readUInt32BE(2);
        const lo = this.buffer.readUInt32BE(6);
        payloadLen = hi * 4294967296 + lo;
        offset = 10;
      }

      if (masked) {
        if (this.buffer.length < offset + 4) return;
        offset += 4;
      }

      if (this.buffer.length < offset + payloadLen) return;

      let payload = this.buffer.subarray(offset, offset + payloadLen);
      if (masked) {
        const maskKey = this.buffer.subarray(offset - 4, offset);
        const unmasked = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i++) {
          unmasked[i] = payload[i] ^ maskKey[i & 3];
        }
        payload = unmasked;
      }

      this.buffer = this.buffer.subarray(offset + payloadLen);

      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this._sendFrame(0x0a, payload);
        continue;
      }
      if (opcode === 0x0a) {
        continue;
      }

      if (opcode !== 0x00) {
        if (fin) {
          this._emitPayload(opcode, payload);
        } else {
          this.fragmentOpcode = opcode;
          this.fragments = [payload];
        }
      } else {
        this.fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(this.fragments);
          const op = this.fragmentOpcode;
          this.fragments = [];
          this.fragmentOpcode = 0;
          this._emitPayload(op, full);
        }
      }
    }
  }

  _emitPayload(opcode, payload) {
    if (opcode === 0x01 || opcode === 0x02) {
      try {
        this.onMessage?.(payload.toString('utf8'));
      } catch {}
    }
  }

  _sendFrame(opcode, payloadBuf) {
    if (!this.socket || this.readyState !== 1) return false;
    const len = payloadBuf.length;
    const maskKey = crypto.randomBytes(4);
    let headerLen = 2 + 4;
    if (len >= 126 && len < 65536) headerLen = 4 + 4;
    else if (len >= 65536) headerLen = 10 + 4;

    const frame = Buffer.allocUnsafe(headerLen + len);
    frame[0] = 0x80 | (opcode & 0x0f);

    let offset = 2;
    if (len < 126) {
      frame[1] = 0x80 | len;
    } else if (len < 65536) {
      frame[1] = 0x80 | 126;
      frame.writeUInt16BE(len, 2);
      offset = 4;
    } else {
      frame[1] = 0x80 | 127;
      frame.writeUInt32BE(Math.floor(len / 4294967296), 2);
      frame.writeUInt32BE(len >>> 0, 6);
      offset = 10;
    }

    maskKey.copy(frame, offset);
    offset += 4;
    for (let i = 0; i < len; i++) {
      frame[offset + i] = payloadBuf[i] ^ maskKey[i & 3];
    }

    this.socket.write(frame);
    return true;
  }

  send(text) {
    return this._sendFrame(0x01, Buffer.from(String(text), 'utf8'));
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    try { this.socket?.end(); } catch {}
    try { this.socket?.destroy(); } catch {}
    this.socket = null;
    try { this.onClose?.(); } catch {}
  }
}

/**
 * Independent AI Agent Cursor overlay mounted inside a closed Shadow DOM.
 * Driven strictly by CDP commands & AUIT cursor state; NEVER listens to OS mousemove events.
 */
const AI_CURSOR_BOOTSTRAP_FN = `(function() {
  try {
    const ROOT_ATTR = 'data-antigravity-cursor-host';
    if (!document || !document.documentElement) return;
    if (!globalThis.__agyCursorState) {
      globalThis.__agyCursorState = {
        x: -100, y: -100, visible: false, phase: 'idle', hideTimer: null,
        host: null, cursorEl: null, rippleEl: null, arrowEl: null
      };
    }
    const st = globalThis.__agyCursorState;
    function ensureDom() {
      if (st.host && st.host.isConnected && st.cursorEl) return true;
      let host = document.querySelector('[' + ROOT_ATTR + ']');
      if (!host) {
        host = document.createElement('div');
        host.setAttribute(ROOT_ATTR, '1');
        host.setAttribute('aria-hidden', 'true');
        host.style.cssText = 'all:initial !important;position:fixed !important;inset:0 !important;width:0 !important;height:0 !important;pointer-events:none !important;z-index:2147483647 !important;overflow:visible !important;';
        const shadow = host.attachShadow({ mode: 'closed' });
        shadow.innerHTML = '<style>' +
          '.agy-c{position:fixed;top:0;left:0;width:28px;height:28px;pointer-events:none;user-select:none;opacity:0;transform:translate3d(-100px,-100px,0);transition:transform 65ms cubic-bezier(.22,1,.36,1),opacity 140ms ease;will-change:transform,opacity;filter:drop-shadow(0 2px 6px rgba(0,0,0,0.42));}' +
          '.agy-c.vis{opacity:1;}' +
          '.agy-arrow{transform-origin:2px 2px;transition:transform 90ms ease;}' +
          '.agy-c.down .agy-arrow{transform:scale(0.84);}' +
          '.agy-ring{position:absolute;top:-10px;left:-10px;width:24px;height:24px;border-radius:9999px;border:2px solid rgba(56,189,248,0.92);background:rgba(56,189,248,0.22);opacity:0;transform:scale(0.3);pointer-events:none;}' +
          '.agy-ring.pop{animation:agy-pop 340ms cubic-bezier(.16,1,.3,1) forwards;}' +
          '@keyframes agy-pop{0%{opacity:0.95;transform:scale(0.3);}100%{opacity:0;transform:scale(1.65);}}' +
        '</style>' +
        '<div class="agy-c">' +
          '<div class="agy-ring"></div>' +
          '<svg class="agy-arrow" width="24" height="24" viewBox="0 0 24 24" fill="none">' +
            '<path d="M3.5 2.5L10.5 20.5L13.5 13L21 10L3.5 2.5Z" fill="#ffffff" stroke="#0f172a" stroke-width="1.8" stroke-linejoin="round"/>' +
          '</svg>' +
        '</div>';
        (document.documentElement || document.body).appendChild(host);
        st.host = host;
        st.cursorEl = shadow.querySelector('.agy-c');
        st.rippleEl = shadow.querySelector('.agy-ring');
      }
      return Boolean(st.cursorEl);
    }
    globalThis.__agyApplyCursor = function(x, y, phase, visible, autoFadeMs) {
      if (!ensureDom()) return false;
      if (st.hideTimer) { clearTimeout(st.hideTimer); st.hideTimer = null; }
      if (typeof x === 'number' && Number.isFinite(x)) st.x = Math.round(x);
      if (typeof y === 'number' && Number.isFinite(y)) st.y = Math.round(y);
      st.phase = phase || 'move';
      st.visible = Boolean(visible);
      const el = st.cursorEl;
      if (!el) return false;
      el.style.transform = 'translate3d(' + st.x + 'px,' + st.y + 'px,0)';
      el.classList.toggle('vis', st.visible);
      el.classList.toggle('down', st.phase === 'down');
      if (st.phase === 'down' && st.rippleEl) {
        st.rippleEl.classList.remove('pop');
        void st.rippleEl.offsetWidth;
        st.rippleEl.classList.add('pop');
      }
      if (st.visible && autoFadeMs > 0) {
        st.hideTimer = setTimeout(function() {
          if (st.phase !== 'down') {
            el.classList.remove('vis');
          }
        }, autoFadeMs);
      }
      return true;
    };
    ensureDom();
  } catch {}
})();`;

/**
 * Dedicated per-tab Edge CDP session tracking isolated worlds, OOPIFs,
 * navigation events, ordered input, network capture, dialogs, file choosers, and AI cursor.
 */
class EdgeTabSession {
  constructor(engine, tabKey, wc, hubSender, initialUrl) {
    this.engine = engine;
    this.tabKey = tabKey;
    this.wc = wc;
    this.wcId = wc?.id;
    this.hubSender = hubSender;

    this.targetId = null;
    this.ws = null;
    this.attachPromise = null;
    this.closing = false;

    this.nextMsgId = 1;
    this.pendingCmds = new Map();

    // Navigation & frame metadata
    this.mainFrameId = '';
    this.url = (initialUrl && initialUrl !== 'about:blank') ? initialUrl : '';
    this.title = '';
    this.isLoading = false;
    this.canGoBack = false;
    this.canGoForward = false;
    this.httpStatusCode = null;
    this.loadError = null;
    this.navWaiters = [];

    // Isolated worlds and OOPIF child sessions
    this.childTargets = new Map(); // sessionId -> { sessionId, targetId, parentSessionId, ready }
    this.worlds = new Map();       // `${sid}::${frameId}::${worldName}` -> executionContextId
    this.pendingWorlds = new Map();
    this.cursorScriptId = null;

    // Agent control, focus emulation & ordered input queue
    this.agentControlling = false;
    this.focusEmulated = false;
    this.inputQueue = Promise.resolve();
    this.layoutCache = { width: 1280, height: 800, updatedAt: 0 };

    // Cursor state
    this.cursor = { active: false, x: -100, y: -100, phase: 'idle', lastClickSeq: 0 };

    // Network capture
    this.networkEntries = [];
    this.inFlightRequests = new Map();
    this.networkTombstones = new Set();
    this.networkSeq = 1;

    // Dialog & file chooser state
    this.dialogPolicy = { enabled: false, action: 'dismiss' };
    this.pendingDialog = null;
    this.dialogSeq = 1;

    this.fileChooserPolicy = { enabled: false };
    this.interceptChooserEnabled = false;
    this.pendingChooser = null;
    this.chooserSeq = 1;
  }

  _updateRegistryMetadata() {
    const entry = this.engine.registryRef?.getEntry?.(this.tabKey);
    if (entry) {
      if (this.url) entry.lastUrl = this.url;
      if (this.title) entry.lastTitle = this.title;
      entry.lastHttpResponseCode = this.httpStatusCode;
      entry.lastLoadError = this.loadError;
    }
  }

  _emitGuestEvent(type, extra = {}) {
    if (!this.hubSender || this.hubSender.isDestroyed?.()) return;
    const registry = this.engine.registryRef;
    const entry = registry?.getEntry?.(this.tabKey);
    const snapshot = entry && typeof registry?.toSnapshot === 'function'
      ? registry.toSnapshot(entry)
      : {
          tabKey: this.tabKey,
          webContentsId: this.wcId,
          url: this.url || 'about:blank',
          title: this.title || '',
          canGoBack: this.canGoBack,
          canGoForward: this.canGoForward,
          isLoading: this.isLoading,
          visible: true,
          pinned: Boolean(entry?.pinned),
          crashed: false,
          remoteStreamActive: Boolean(entry?.remoteStreamActive),
          remoteControlActive: Boolean(entry?.remoteControlActive),
          lastHttpResponseCode: this.httpStatusCode,
          lastLoadError: this.loadError,
        };
    try {
      this.hubSender.send(WCV_GUEST_EVENT_CHANNEL, {
        type,
        ...snapshot,
        ...extra,
      });
    } catch {}
  }

  _sendHubChannel(channel, payload) {
    if (!this.hubSender || this.hubSender.isDestroyed?.()) return;
    try {
      this.hubSender.send(channel, payload);
    } catch {}
  }

  _settleNavWaiters(err = null) {
    if (this.navWaiters.length === 0) return;
    const list = this.navWaiters.splice(0, this.navWaiters.length);
    for (const w of list) {
      clearTimeout(w.timer);
      if (err) w.reject(err);
      else w.resolve();
    }
  }

  async ensureAttached() {
    if (this.closing) throw new Error(`Tab ${this.tabKey} is closing`);
    if (this.ws && this.ws.readyState === 1 && this.targetId) {
      return this;
    }
    if (this.attachPromise) {
      return this.attachPromise;
    }

    this.attachPromise = (async () => {
      const port = edgeLauncher.DEFAULT_PORT || 9222;
      await edgeLauncher.ensureEdgeRunning(port);

      const claimed = this.engine.getClaimedTargetIds();
      let target = null;

      // Reuse Edge's initial idle tab for the first Antigravity tab instead of leaving an extra empty tab
      const pages = await edgeLauncher.getEdgePageTargets(port);
      if (this.targetId) {
        target = pages.find((p) => p.id === this.targetId) || null;
      }
      if (!target) {
        target = pages.find((p) => {
          if (!p?.id || !p.webSocketDebuggerUrl || claimed.has(p.id)) return false;
          if (/^(edge|chrome|devtools):\/\//i.test(p.url || '')) return false;
          // Only claim unclaimed blank / new-tab / initial Edge page when no target assigned yet
          return claimed.size === 0 || p.url === 'about:blank' || p.url === '' || /^edge:\/\/newtab/i.test(p.url || '');
        }) || null;
      }

      if (!target) {
        try {
          target = await httpRequestJson('PUT', `http://127.0.0.1:${port}/json/new?about:blank`);
        } catch {
          target = await httpRequestJson('GET', `http://127.0.0.1:${port}/json/new?about:blank`);
        }
      }

      if (!target?.id || !target?.webSocketDebuggerUrl) {
        throw new Error(`Failed to acquire Edge CDP page target for ${this.tabKey}`);
      }

      this.targetId = target.id;
      const ws = new CdpWebSocket(target.webSocketDebuggerUrl);
      ws.onMessage = (raw) => this._handleWsMessage(raw);
      ws.onClose = () => this._handleWsClose();
      await ws.connect();
      this.ws = ws;

      // Enable required domains on Edge page target
      await Promise.all([
        this.sendCdp('Page.enable'),
        this.sendCdp('Runtime.enable'),
        this.sendCdp('DOM.enable'),
        this.sendCdp('Network.enable'),
        this.sendCdp('Target.setAutoAttach', AUTO_ATTACH_PARAMS),
      ]);

      // Fetch initial frame id & install persistent AI cursor bootstrap on future documents
      const frameTreeRes = await this.sendCdp('Page.getFrameTree').catch(() => null);
      if (frameTreeRes?.frameTree?.frame) {
        const f = frameTreeRes.frameTree.frame;
        this.mainFrameId = f.id || '';
        if (f.url && f.url !== 'about:blank') {
          this.url = f.url;
        }
      }

      this.cursorScriptId = await this.sendCdp('Page.addScriptToEvaluateOnNewDocument', {
        source: AI_CURSOR_BOOTSTRAP_FN,
        worldName: CURSOR_WORLD_NAME,
      }).then((r) => r?.identifier || null).catch(() => null);

      await this._ensureCursorBootstrapped().catch(() => undefined);
      await this._refreshHistoryAndTitle().catch(() => undefined);

      if (this.agentControlling) {
        await this.sendCdp('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);
        this.focusEmulated = true;
      }

      return this;
    })().finally(() => {
      this.attachPromise = null;
    });

    return this.attachPromise;
  }

  _handleWsClose() {
    this.ws = null;
    this.mainFrameId = '';
    this.worlds.clear();
    this.pendingWorlds.clear();
    this.childTargets.clear();
    this.inFlightRequests.clear();
    this.focusEmulated = false;
    for (const [, p] of this.pendingCmds) {
      clearTimeout(p.timer);
      p.reject(new Error(`Edge CDP WebSocket closed for ${this.tabKey}`));
    }
    this.pendingCmds.clear();
    this._settleNavWaiters();
  }

  sendCdp(method, params = {}, sessionId = '', timeoutMs = CDP_CMD_TIMEOUT_MS) {
    if (!this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new Error(`Edge CDP WebSocket is not connected for ${this.tabKey}`));
    }
    const id = this.nextMsgId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCmds.delete(id);
        reject(new Error(`Edge CDP timeout (${timeoutMs}ms): ${method}`));
      }, timeoutMs);
      this.pendingCmds.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timer);
        this.pendingCmds.delete(id);
        reject(err);
      }
    });
  }

  _handleWsMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (typeof msg.id === 'number') {
      const pending = this.pendingCmds.get(msg.id);
      if (pending) {
        this.pendingCmds.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.error) {
          pending.reject(new Error(msg.error.message || `CDP error ${msg.error.code}`));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    const method = msg.method;
    const params = msg.params || {};
    const incomingSid = msg.sessionId || '';
    if (!method) return;

    this._handleCdpEvent(incomingSid, method, params);
  }

  _purgeWorldsForSession(sid) {
    for (const map of [this.worlds, this.pendingWorlds]) {
      for (const k of map.keys()) {
        if (k.startsWith(`${sid}::`)) map.delete(k);
      }
    }
  }

  _handleCdpEvent(incomingSid, method, params) {
    // OOPIF Auto-attach tracking
    if (method === 'Target.attachedToTarget') {
      const sid = typeof params.sessionId === 'string' ? params.sessionId : '';
      const info = params.targetInfo;
      if (sid && info?.type === 'iframe') {
        const ready = this.sendCdp('Target.setAutoAttach', AUTO_ATTACH_PARAMS, sid)
          .then(() => undefined)
          .catch(() => undefined);
        this.childTargets.set(sid, {
          sessionId: sid,
          targetId: String(info.targetId || ''),
          parentSessionId: incomingSid,
          ready,
        });
      }
      if (sid && params.waitingForDebugger === true) {
        void this.sendCdp('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => undefined);
      }
      return;
    }

    if (method === 'Target.detachedFromTarget') {
      const sid = typeof params.sessionId === 'string' ? params.sessionId : '';
      if (sid) {
        const q = [sid];
        while (q.length > 0) {
          const s = q.pop();
          this.childTargets.delete(s);
          this._purgeWorldsForSession(s);
          for (const [k, t] of this.childTargets.entries()) {
            if (t.parentSessionId === s) q.push(k);
          }
        }
      }
      return;
    }

    // Execution context cleanup
    if (method === 'Runtime.executionContextDestroyed') {
      const ctxId = params.executionContextId;
      for (const [k, v] of this.worlds.entries()) {
        if (v === ctxId) this.worlds.delete(k);
      }
      return;
    }
    if (method === 'Runtime.executionContextsCleared') {
      this._purgeWorldsForSession(incomingSid);
      return;
    }

    // Sub-session network/dialog only handled on root session unless needed
    if (incomingSid) {
      if (method === 'Page.frameNavigated' && params.frame?.id) {
        for (const map of [this.worlds, this.pendingWorlds]) {
          for (const k of map.keys()) {
            if (k.startsWith(`${incomingSid}::${params.frame.id}::`)) map.delete(k);
          }
        }
      }
      return;
    }

    if (method === 'Page.frameStartedLoading') {
      if (params.frameId === this.mainFrameId || !this.mainFrameId) {
        this.isLoading = true;
        this._emitGuestEvent('did-start-loading');
      }
      return;
    }

    if (method === 'Page.frameNavigated') {
      const frame = params.frame;
      if (frame?.id) {
        for (const map of [this.worlds, this.pendingWorlds]) {
          for (const k of map.keys()) {
            if (k.startsWith(`::${frame.id}::`)) map.delete(k);
          }
        }
        if (!frame.parentId) {
          this.mainFrameId = frame.id;
          this.layoutCache.updatedAt = 0;
          if (frame.url) {
            this.url = frame.url;
          }
          this.loadError = null;
          this._updateRegistryMetadata();
          this._emitGuestEvent('did-navigate', { url: this.url });
          void this._refreshHistoryAndTitle().catch(() => undefined);
          void this._ensureCursorBootstrapped().catch(() => undefined);
        }
      }
      return;
    }

    if (method === 'Page.navigatedWithinDocument') {
      if (!params.frameId || params.frameId === this.mainFrameId) {
        if (params.url) this.url = params.url;
        this._updateRegistryMetadata();
        this._emitGuestEvent('did-navigate-in-page', { url: this.url });
        void this._refreshHistoryAndTitle().catch(() => undefined);
      }
      return;
    }

    if (method === 'Page.domContentEventFired') {
      void this._ensureCursorBootstrapped().catch(() => undefined);
      this._emitGuestEvent('dom-ready');
      return;
    }

    if (method === 'Page.loadEventFired' || method === 'Page.frameStoppedLoading') {
      if (method === 'Page.frameStoppedLoading' && params.frameId && this.mainFrameId && params.frameId !== this.mainFrameId) {
        return;
      }
      this.isLoading = false;
      this.layoutCache.updatedAt = 0;
      void this._refreshHistoryAndTitle().then(() => {
        this._updateRegistryMetadata();
        this._emitGuestEvent('did-stop-loading');
        if (this.title) {
          this._emitGuestEvent('page-title-updated', { title: this.title });
        }
        this._settleNavWaiters();
      }).catch(() => {
        this._emitGuestEvent('did-stop-loading');
        this._settleNavWaiters();
      });
      return;
    }

    if (method === 'Page.javascriptDialogOpening') {
      this._onDialogOpening(params);
      return;
    }

    if (method === 'Page.fileChooserOpened') {
      this._onFileChooserOpened(params);
      return;
    }

    if (method && method.startsWith('Network.')) {
      this._handleNetworkEvent(method, params);
    }
  }

  async _refreshHistoryAndTitle() {
    const [hist, titleEval] = await Promise.all([
      this.sendCdp('Page.getNavigationHistory').catch(() => null),
      this.sendCdp('Runtime.evaluate', { expression: 'document.title', returnByValue: true }).catch(() => null),
    ]);
    if (hist && Array.isArray(hist.entries) && typeof hist.currentIndex === 'number') {
      const idx = hist.currentIndex;
      const cur = hist.entries[idx];
      this.canGoBack = idx > 0;
      this.canGoForward = idx >= 0 && idx < hist.entries.length - 1;
      if (cur?.url && cur.url !== 'about:blank') this.url = cur.url;
      if (cur?.title) this.title = cur.title;
    }
    if (typeof titleEval?.result?.value === 'string' && titleEval.result.value) {
      this.title = titleEval.result.value;
    }
    this._updateRegistryMetadata();
  }

  async _waitForFrameTree(sid = '') {
    const res = await this.sendCdp('Page.getFrameTree', {}, sid).catch(() => null);
    if (res?.frameTree?.frame?.id && !sid) {
      this.mainFrameId = res.frameTree.frame.id;
    }
    return res?.frameTree || null;
  }

  async _withWorld(resolveSid, frameId, worldName, grantUniversalAccess, fn) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const sid = await resolveSid();
      const key = `${sid}::${frameId}::${worldName}`;
      if (attempt > 0) {
        this.worlds.delete(key);
        this.pendingWorlds.delete(key);
      }

      let ctxId = this.worlds.get(key);
      if (!ctxId) {
        let pending = this.pendingWorlds.get(key);
        if (!pending) {
          const created = this.sendCdp('Page.createIsolatedWorld', {
            frameId,
            worldName,
            grantUniversalAccess: Boolean(grantUniversalAccess),
          }, sid).then((res) => {
            const id = res?.executionContextId;
            if (typeof id !== 'number' || id <= 0) return undefined;
            if (this.pendingWorlds.get(key) === created) {
              this.worlds.set(key, id);
            }
            return id;
          }).finally(() => {
            if (this.pendingWorlds.get(key) === created) {
              this.pendingWorlds.delete(key);
            }
          });
          this.pendingWorlds.set(key, created);
          pending = created;
        }
        ctxId = await pending;
      }

      if (!ctxId) {
        throw new Error(`ISOLATED_WORLD_UNAVAILABLE: Frame ${frameId}`);
      }

      try {
        return await fn(sid, ctxId);
      } catch (err) {
        if (attempt === 0 && isStaleCtxErr(err)) {
          continue;
        }
        throw err;
      }
    }
    throw new Error(`ISOLATED_WORLD_UNAVAILABLE: Frame ${frameId}`);
  }

  async _ensureCursorBootstrapped() {
    if (!this.mainFrameId) {
      await this._waitForFrameTree();
    }
    if (!this.mainFrameId) return;
    await this._withWorld(async () => '', this.mainFrameId, CURSOR_WORLD_NAME, true, async (sid, ctxId) => {
      await this.sendCdp('Runtime.evaluate', {
        expression: AI_CURSOR_BOOTSTRAP_FN,
        contextId: ctxId,
        returnByValue: true,
        userGesture: false,
      }, sid);
      if (this.cursor.active || this.agentControlling) {
        const fade = this.agentControlling ? 0 : CURSOR_IDLE_FADE_MS;
        await this.sendCdp('Runtime.evaluate', {
          expression: `globalThis.__agyApplyCursor && globalThis.__agyApplyCursor(${this.cursor.x}, ${this.cursor.y}, ${JSON.stringify(this.cursor.phase)}, ${Boolean(this.cursor.active || this.agentControlling)}, ${fade})`,
          contextId: ctxId,
          returnByValue: true,
          userGesture: false,
        }, sid);
      }
    });
  }

  async _renderCursorOverlay(x, y, phase, visible) {
    try {
      if (!this.ws || this.ws.readyState !== 1) return;
      if (!this.mainFrameId) await this._waitForFrameTree();
      if (!this.mainFrameId) return;
      const fade = (visible && !this.agentControlling) ? CURSOR_IDLE_FADE_MS : 0;
      await this._withWorld(async () => '', this.mainFrameId, CURSOR_WORLD_NAME, true, async (sid, ctxId) => {
        const expr = `if (typeof globalThis.__agyApplyCursor !== 'function') { ${AI_CURSOR_BOOTSTRAP_FN} } globalThis.__agyApplyCursor && globalThis.__agyApplyCursor(${clampCoord(x)}, ${clampCoord(y)}, ${JSON.stringify(phase)}, ${Boolean(visible)}, ${fade});`;
        await this.sendCdp('Runtime.evaluate', {
          expression: expr,
          contextId: ctxId,
          returnByValue: true,
          userGesture: false,
        }, sid);
      });
    } catch {}
  }

  updateCursorState(state) {
    if (!state || !state.active) {
      this.cursor.active = false;
      this.cursor.phase = 'idle';
      void this._renderCursorOverlay(this.cursor.x, this.cursor.y, 'idle', false);
      return;
    }
    this.cursor.active = true;
    this.cursor.x = clampCoord(state.x);
    this.cursor.y = clampCoord(state.y);
    const seq = typeof state.clickSeq === 'number' ? state.clickSeq : 0;
    const isClick = seq > this.cursor.lastClickSeq || state.phase === 'click' || state.phase === 'down';
    this.cursor.lastClickSeq = Math.max(this.cursor.lastClickSeq, seq);
    this.cursor.phase = isClick ? 'down' : 'move';
    void this._renderCursorOverlay(this.cursor.x, this.cursor.y, this.cursor.phase, true);
  }

  async setAgentControlling(active) {
    this.agentControlling = Boolean(active);
    if (this.agentControlling) {
      await this.ensureAttached();
      await this.sendCdp('Target.activateTarget', { targetId: this.targetId }).catch(() => undefined);
      await this.sendCdp('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);
      this.focusEmulated = true;
      this.cursor.active = true;
      void this._renderCursorOverlay(this.cursor.x, this.cursor.y, 'move', true);
    } else if (this.ws && this.ws.readyState === 1) {
      await this.sendCdp('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => undefined);
      this.focusEmulated = false;
      this.cursor.active = false;
      void this._renderCursorOverlay(this.cursor.x, this.cursor.y, 'idle', false);
    }
  }

  async activateInEdge() {
    await this.ensureAttached();
    if (this.targetId) {
      await this.sendCdp('Target.activateTarget', { targetId: this.targetId }).catch(() => undefined);
    }
  }

  async navigate(url) {
    if (typeof webviewBrowser?.validateWebviewNavigationUrl === 'function') {
      const check = webviewBrowser.validateWebviewNavigationUrl(url, 'http://127.0.0.1');
      if (!check.allowed) return false;
    } else if (!/^https?:|^file:|^about:blank/i.test(String(url || '').trim())) {
      return false;
    }

    await this.ensureAttached();
    await this.activateInEdge();

    this.loadError = null;
    this.isLoading = true;
    this._emitGuestEvent('did-start-loading');

    const settlePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.navWaiters.indexOf(entry);
        if (idx >= 0) this.navWaiters.splice(idx, 1);
        resolve();
      }, NAV_WAIT_TIMEOUT_MS);
      const entry = { resolve, reject, timer };
      this.navWaiters.push(entry);
    });

    const navRes = await this.sendCdp('Page.navigate', { url });
    if (navRes?.errorText && navRes.errorText !== 'net::ERR_ABORTED') {
      this.loadError = {
        errorCode: -1,
        errorDescription: navRes.errorText,
        validatedURL: url,
      };
      this.isLoading = false;
      this._settleNavWaiters();
      this._updateRegistryMetadata();
      return false;
    }

    await settlePromise;
    await this._refreshHistoryAndTitle().catch(() => undefined);
    await this._ensureCursorBootstrapped().catch(() => undefined);
    return true;
  }

  async control(action) {
    if (!this.ws || this.ws.readyState !== 1) {
      if (action === 'reload' && this.url) {
        return this.navigate(this.url);
      }
      return;
    }
    switch (action) {
      case 'goBack':
      case 'back': {
        const hist = await this.sendCdp('Page.getNavigationHistory').catch(() => null);
        if (hist && hist.currentIndex > 0) {
          const targetEntry = hist.entries[hist.currentIndex - 1];
          if (targetEntry) {
            await this.sendCdp('Page.navigateToHistoryEntry', { entryId: targetEntry.id });
          }
        }
        break;
      }
      case 'goForward':
      case 'forward': {
        const hist = await this.sendCdp('Page.getNavigationHistory').catch(() => null);
        if (hist && hist.currentIndex < hist.entries.length - 1) {
          const targetEntry = hist.entries[hist.currentIndex + 1];
          if (targetEntry) {
            await this.sendCdp('Page.navigateToHistoryEntry', { entryId: targetEntry.id });
          }
        }
        break;
      }
      case 'reload':
        await this.sendCdp('Page.reload');
        break;
      case 'stop':
        await this.sendCdp('Page.stopLoading');
        this.isLoading = false;
        this._settleNavWaiters();
        break;
    }
    await this._refreshHistoryAndTitle().catch(() => undefined);
  }

  async executeInMainIsolatedWorld(worldId, code) {
    await this.ensureAttached();
    if (this.isLoading && this.navWaiters.length > 0) {
      await Promise.race([
        new Promise((resolve) => {
          const t = setTimeout(resolve, 6000);
          const check = () => {
            if (!this.isLoading) {
              clearTimeout(t);
              resolve();
            } else {
              setTimeout(check, 50);
            }
          };
          check();
        }),
      ]);
    }
    if (!this.mainFrameId) {
      await this._waitForFrameTree();
    }
    if (!this.mainFrameId) {
      throw new Error('ISOLATED_WORLD_UNAVAILABLE: Main frame id missing');
    }

    const worldName = `agy_world_${worldId}`;
    return this._withWorld(async () => '', this.mainFrameId, worldName, true, async (sid, ctxId) => {
      const res = await withTimeout(
        this.sendCdp('Runtime.evaluate', {
          expression: code,
          contextId: ctxId,
          returnByValue: true,
          awaitPromise: true,
          userGesture: false,
        }, sid, FRAME_EVAL_TIMEOUT_MS + 2000),
        FRAME_EVAL_TIMEOUT_MS,
        `ISOLATED_WORLD_TIMEOUT: Execution exceeded ${FRAME_EVAL_TIMEOUT_MS}ms`
      );
      if (res?.exceptionDetails) {
        const exc = res.exceptionDetails.exception;
        const msg = exc?.description ||
          (exc?.value !== undefined ? String(exc.value) : '') ||
          res.exceptionDetails.text ||
          'Isolated world evaluation failed';
        throw Object.assign(new Error(msg), { isEvalErr: true });
      }
      return res?.result?.value;
    });
  }

  async _collectFrameTree() {
    // Wait briefly for in-flight child Target.setAutoAttach setups
    const seen = new Set();
    for (;;) {
      const pending = [];
      for (const t of this.childTargets.values()) {
        if (t.ready && !seen.has(t.ready)) {
          seen.add(t.ready);
          pending.push(t.ready);
        }
      }
      if (pending.length === 0) break;
      await Promise.all(pending);
    }

    const rootTree = await this._waitForFrameTree('');
    if (!rootTree?.frame?.id) return null;

    const oopifs = new Map();
    await Promise.all(Array.from(this.childTargets.values()).map(async (t) => {
      const tree = await this._waitForFrameTree(t.sessionId);
      const fid = tree?.frame?.id || t.targetId;
      if (tree?.frame && fid) {
        oopifs.set(fid, { sid: t.sessionId, parentSid: t.parentSessionId, tree });
      }
    }));

    const visited = new Set();
    const build = (n, sid, parentId, ownerSid) => {
      const f = n.frame;
      const id = f?.id || '';
      if (!id || visited.has(id)) return null;

      const oopif = oopifs.get(id);
      if (oopif && oopif.sid !== sid) {
        return build(oopif.tree, oopif.sid, f?.parentId || parentId, sid);
      }

      visited.add(id);
      const node = {
        id,
        parentId: f?.parentId || parentId,
        url: String(f?.url || ''),
        securityOrigin: String(f?.securityOrigin || ''),
        name: String(f?.name || ''),
        mimeType: String(f?.mimeType || ''),
        execSid: sid,
        ownerSid,
        children: [],
      };
      for (const ch of n.childFrames || []) {
        const sub = build(ch, sid, id, sid);
        if (sub) node.children.push(sub);
      }
      for (const [oid, entry] of oopifs.entries()) {
        const dp = entry.tree.frame?.parentId || '';
        const isRoot = parentId === '' || ownerSid !== sid;
        const match = dp ? dp === id : (entry.parentSid === sid && isRoot);
        if (!visited.has(oid) && match) {
          const sub = build(entry.tree, entry.sid, id, sid);
          if (sub) node.children.push(sub);
        }
      }
      return node;
    };

    return build(rootTree, '', '', '');
  }

  async _resolveOwnerGeometry(ownerSid, parentFid, childFid) {
    const owner = await this.sendCdp('DOM.getFrameOwner', { frameId: childFid }, ownerSid).catch(() => null);
    const bId = owner?.backendNodeId;
    if (typeof bId !== 'number' || bId <= 0) return undefined;

    return this._withWorld(async () => ownerSid, parentFid, PAGE_AGENT_WORLD_NAME, false, async (sid, ctxId) => {
      const resolved = await this.sendCdp('DOM.resolveNode', { backendNodeId: bId, executionContextId: ctxId }, sid);
      const objectId = resolved?.object?.objectId;
      if (!objectId) return undefined;
      try {
        const res = await this.sendCdp('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: COMPUTE_OWNER_PATH_AND_RECT_FN,
          returnByValue: true,
        }, sid);
        const val = res?.exceptionDetails ? null : res?.result?.value;
        if (!val || !val.rect) return undefined;
        const r = val.rect;
        const rx = Number(r.x);
        const ry = Number(r.y);
        const rw = Number(r.width);
        const rh = Number(r.height);
        if (![rx, ry, rw, rh].every(Number.isFinite)) return undefined;
        return {
          domPath: val.domPath,
          rect: { x: rx, y: ry, width: Math.max(0, rw), height: Math.max(0, rh), visible: !!r.visible },
        };
      } finally {
        void this.sendCdp('Runtime.releaseObject', { objectId }, sid).catch(() => undefined);
      }
    }).catch(() => undefined);
  }

  async listFrames(options) {
    await this.ensureAttached();
    const opts = guestFramePolicy?.parseFrameBridgeOptions?.(options) || {};
    const pdfUnmask = Boolean(opts.pdfViewerUnmask);
    const isExt = (raw) => /^(?:blob:|filesystem:)?chrome-extension:/i.test(String(raw || '').trim());

    const root = await this._collectFrameTree();
    if (!root || isProtectedIdp(root.url) || isProtectedIdp(root.securityOrigin) ||
        (pdfUnmask && (isExt(root.url) || isExt(root.securityOrigin)))) {
      return guestFramePolicy?.EMPTY_FRAME_TREE || { mainFrameId: '', mainUrl: '', mainOrigin: '', frames: [] };
    }

    const redact = (u) => guestFramePolicy?.redactFrameUrl ? guestFramePolicy.redactFrameUrl(u) : u;
    const compose = (s, c) => guestFramePolicy?.composeFrameViewportRect ? guestFramePolicy.composeFrameViewportRect(s, c) : c;
    const mainOrigin = extractOrigin(root.securityOrigin, root.url);
    const frames = [];

    const m = await this.sendCdp('Page.getLayoutMetrics').catch(() => null);
    const vp = m?.cssLayoutViewport || m?.layoutViewport;
    const rootRect = (vp && Number.isFinite(Number(vp.clientWidth)) && Number.isFinite(Number(vp.clientHeight)))
      ? { x: 0, y: 0, width: Number(vp.clientWidth), height: Number(vp.clientHeight), visible: true }
      : { x: 0, y: 0, width: 1e9, height: 1e9, visible: true };

    const walk = async (parent, scopeFid, scopeOrigin, scopeRect) => {
      for (const ch of parent.children) {
        if (pdfUnmask && parent.mimeType.trim().toLowerCase() === 'application/pdf' &&
            /^chrome-extension:\/\/mhjfbmdgcfjbbpaeojofohoefgiehjai(?:\/|$)/i.test(ch.url.trim())) {
          continue;
        }
        const chOrigin = extractOrigin(ch.securityOrigin, ch.url);
        const opaque = isOpaqueOrigin(ch.securityOrigin);
        const idp = isProtectedIdp(ch.url) || isProtectedIdp(ch.securityOrigin);
        const same = !idp && !opaque && ch.execSid === parent.execSid && Boolean(chOrigin) && chOrigin === scopeOrigin;
        if (same) {
          await walk(ch, scopeFid, scopeOrigin, scopeRect);
          continue;
        }
        const geom = await this._resolveOwnerGeometry(ch.ownerSid, parent.id, ch.id);
        const rect = geom ? compose(scopeRect, geom.rect) : undefined;
        frames.push({
          frameId: ch.id,
          parentFrameId: ch.parentId,
          url: idp ? (chOrigin || extractOrigin(undefined, ch.url)) : redact(ch.url),
          origin: chOrigin || (opaque ? 'null' : ''),
          name: ch.name,
          isCrossOrigin: true,
          isProtectedIdp: idp,
          ownerContextFrameId: scopeFid,
          ...(geom ? { ownerDomPath: geom.domPath } : {}),
          ...(rect ? { viewportRect: rect } : {}),
        });
        if (!idp && !(pdfUnmask && (isExt(ch.url) || isExt(ch.securityOrigin)))) {
          const hide = { ...scopeRect, width: 0, height: 0, visible: false };
          await walk(ch, ch.id, chOrigin, rect || hide);
        }
      }
    };

    await walk(root, '', mainOrigin, rootRect);
    return {
      mainFrameId: root.id,
      mainUrl: redact(root.url),
      mainOrigin,
      frames,
    };
  }

  async executeInFrameIsolatedWorld(frameId, code, expectedOrigin, options) {
    if (typeof frameId !== 'string' || !frameId.trim()) {
      throw new Error('frameId must be a non-empty string');
    }
    if (typeof code !== 'string') {
      throw new Error('code must be a string');
    }
    await this.ensureAttached();
    const expected = guestFramePolicy?.normalizeExpectedOrigin ? guestFramePolicy.normalizeExpectedOrigin(expectedOrigin) : expectedOrigin;
    const pdfUnmask = Boolean(guestFramePolicy?.parseFrameBridgeOptions?.(options)?.pdfViewerUnmask);
    const isExt = (raw) => /^(?:blob:|filesystem:)?chrome-extension:/i.test(String(raw || '').trim());

    const findChain = (n, target) => {
      if (n.id === target) return [n];
      for (const ch of n.children) {
        const sub = findChain(ch, target);
        if (sub) return [n, ...sub];
      }
      return null;
    };

    const resolveTarget = async () => {
      const root = await this._collectFrameTree();
      if (!root) throw new Error('ISOLATED_WORLD_UNAVAILABLE: Edge debugger unavailable');
      if (isProtectedIdp(root.url) || isProtectedIdp(root.securityOrigin)) {
        throw new Error('IDP_BLOCKED: Guest unavailable or on protected IdP');
      }
      if (pdfUnmask && (isExt(root.url) || isExt(root.securityOrigin))) {
        throw new Error('ERR_DISALLOWED_URL: Cannot execute in chrome-extension: frame');
      }
      const chain = findChain(root, frameId);
      if (!chain || chain.length === 0) {
        throw new Error(`FRAME_NOT_FOUND: Subframe ${frameId} is detached`);
      }
      if (chain.some((f) => isProtectedIdp(f.url) || isProtectedIdp(f.securityOrigin))) {
        throw new Error('IDP_BLOCKED: Protected Identity Provider frame');
      }
      if (pdfUnmask && chain.some((f) => isExt(f.url) || isExt(f.securityOrigin))) {
        throw new Error('ERR_DISALLOWED_URL: Cannot execute in chrome-extension: frame');
      }
      const t = chain[chain.length - 1];
      if (expected !== undefined) {
        const current = extractOrigin(t.securityOrigin, t.url) || (isOpaqueOrigin(t.securityOrigin) ? 'null' : '');
        if (current !== expected) {
          throw new Error('FRAME_ORIGIN_CHANGED: Frame origin no longer matches the expected origin');
        }
      }
      return t.execSid;
    };

    const prelude = guestFramePolicy?.buildFrameGuardPrelude ? guestFramePolicy.buildFrameGuardPrelude(expected) : '';
    const expression = `${prelude}${code}`;

    return this._withWorld(resolveTarget, frameId, PAGE_AGENT_WORLD_NAME, false, async (sid, ctxId) => {
      const res = await withTimeout(
        this.sendCdp('Runtime.evaluate', {
          expression,
          contextId: ctxId,
          returnByValue: true,
          awaitPromise: true,
          userGesture: false,
        }, sid, FRAME_EVAL_TIMEOUT_MS + 2000),
        FRAME_EVAL_TIMEOUT_MS,
        `FRAME_EVAL_TIMEOUT: Frame ${frameId} did not finish within ${FRAME_EVAL_TIMEOUT_MS}ms`
      );
      if (res?.exceptionDetails) {
        const exc = res.exceptionDetails.exception;
        const msg = exc?.description ||
          (exc?.value !== undefined ? String(exc.value) : '') ||
          res.exceptionDetails.text ||
          'Frame isolated world evaluation failed';
        throw Object.assign(new Error(msg), { isEvalErr: true });
      }
      return res?.result?.value;
    });
  }

  _enqueueInput(fn) {
    const next = this.inputQueue.then(fn, fn);
    this.inputQueue = next.catch(() => undefined);
    return next;
  }

  async _getViewportBounds() {
    const now = Date.now();
    if (now - this.layoutCache.updatedAt < 500) {
      return this.layoutCache;
    }
    const m = await this.sendCdp('Page.getLayoutMetrics').catch(() => null);
    const vp = m?.cssLayoutViewport || m?.layoutViewport;
    const width = Number(vp?.clientWidth);
    const height = Number(vp?.clientHeight);
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      this.layoutCache = { width: Math.round(width), height: Math.round(height), updatedAt: now };
    }
    return this.layoutCache;
  }

  async dispatchAgentMouse(params) {
    return this._enqueueInput(async () => {
      await this.ensureAttached();
      if (!this.focusEmulated && this.agentControlling) {
        await this.sendCdp('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);
        this.focusEmulated = true;
      }

      const vp = await this._getViewportBounds();
      const rawX = clampCoord(params?.x);
      const rawY = clampCoord(params?.y);
      const x = Math.max(0, Math.min(rawX, Math.max(0, vp.width - 1)));
      const y = Math.max(0, Math.min(rawY, Math.max(0, vp.height - 1)));

      const type = params?.type || 'mouseMoved';
      this.cursor.x = x;
      this.cursor.y = y;
      this.cursor.active = true;
      this.cursor.phase = type === 'mousePressed' ? 'down' : type === 'mouseReleased' ? 'up' : 'move';

      await this._renderCursorOverlay(x, y, this.cursor.phase, true);
      await this.sendCdp('Input.dispatchMouseEvent', {
        button: 'none',
        clickCount: 0,
        ...params,
        x,
        y,
      });
    });
  }

  async dispatchAgentKey(params) {
    return this._enqueueInput(async () => {
      await this.ensureAttached();
      if (!this.focusEmulated && this.agentControlling) {
        await this.sendCdp('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);
        this.focusEmulated = true;
      }
      const { nativeVirtualKeyCode: _ignored, ...sanitized } = params || {};
      await this.sendCdp('Input.dispatchKeyEvent', sanitized);
    });
  }

  async insertText(text) {
    return this._enqueueInput(async () => {
      await this.ensureAttached();
      await this.sendCdp('Input.insertText', { text: String(text ?? '') });
    });
  }

  async captureScreenshotNativeImage(nativeImage) {
    await this.ensureAttached();
    const res = await this.sendCdp('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
    });
    if (!res?.data) return null;
    const buf = Buffer.from(res.data, 'base64');
    const img = nativeImage.createFromBuffer(buf);
    return img && !img.isEmpty?.() ? img : null;
  }

  // --- Network tracking ---
  _handleNetworkEvent(method, params) {
    const requestId = params.requestId;
    if (!requestId) return;

    if (method === 'Network.requestWillBeSent') {
      const req = params.request;
      const rawUrl = typeof req?.url === 'string' ? req.url.trim() : '';
      const docUrl = params.documentURL || this.url || '';
      const docOrigin = guestNetworkSanitizer?.extractHttpOrigin ? guestNetworkSanitizer.extractHttpOrigin(docUrl) : '';
      if (guestNetworkSanitizer?.isProtectedNetworkUrl?.(rawUrl) ||
          guestNetworkSanitizer?.isCrossOriginSensitiveGoogleUrl?.(rawUrl, docOrigin)) {
        this.inFlightRequests.delete(requestId);
        return;
      }
      const cleanUrl = guestNetworkSanitizer?.sanitizeNetworkUrl ? guestNetworkSanitizer.sanitizeNetworkUrl(rawUrl) : rawUrl;
      if (!cleanUrl) return;
      const httpMethod = String(req?.method || 'GET').toUpperCase().slice(0, 24);
      const resourceType = guestNetworkSanitizer?.normalizeResourceType
        ? guestNetworkSanitizer.normalizeResourceType(params.type, httpMethod)
        : (params.type || 'other').toLowerCase();
      const entry = {
        seq: this.networkSeq++,
        url: cleanUrl,
        method: httpMethod,
        resourceType,
        status: 0,
        statusText: '',
        ok: false,
        requestHeaders: {},
        responseHeaders: {},
        ...(docOrigin ? { documentOrigin: docOrigin } : {}),
        finished: false,
      };
      this.inFlightRequests.set(requestId, { entry, rawUrl });
      if (this.inFlightRequests.size > MAX_IN_FLIGHT_REQUESTS) {
        const oldest = this.inFlightRequests.keys().next().value;
        if (oldest !== undefined) this.inFlightRequests.delete(oldest);
      }
      this.networkEntries.push(entry);
      if (this.networkEntries.length > MAX_NETWORK_ENTRIES) {
        this.networkEntries.shift();
      }
      return;
    }

    const rec = this.inFlightRequests.get(requestId);
    if (!rec) return;

    if (method === 'Network.responseReceived') {
      const resp = params.response || {};
      const status = typeof resp.status === 'number' ? Math.trunc(resp.status) : 0;
      rec.entry.status = status;
      rec.entry.statusText = String(resp.statusText || '').slice(0, 128);
      rec.entry.ok = status >= 200 && status < 300;
      return;
    }

    if (method === 'Network.loadingFailed') {
      this.inFlightRequests.delete(requestId);
      rec.entry.errorText = String(params.errorText || 'net::ERR_FAILED').slice(0, 256);
      rec.entry.ok = false;
      rec.entry.finished = true;
      rec.entry.seq = this.networkSeq++;
      this._sendHubChannel(WEBVIEW_NETWORK_REQUEST_CHANNEL, {
        webContentsId: this.wcId,
        tabKey: this.tabKey,
        entry: { ...rec.entry },
      });
      return;
    }

    if (method === 'Network.loadingFinished') {
      this.inFlightRequests.delete(requestId);
      rec.entry.finished = true;
      rec.entry.seq = this.networkSeq++;
      this._sendHubChannel(WEBVIEW_NETWORK_REQUEST_CHANNEL, {
        webContentsId: this.wcId,
        tabKey: this.tabKey,
        entry: { ...rec.entry },
      });
    }
  }

  getNetworkRequests() {
    return this.networkEntries.map((e) => ({ ...e }));
  }

  clearNetworkRequests() {
    this.networkEntries = [];
    this.inFlightRequests.clear();
    return true;
  }

  // --- Dialog handling ---
  async setDialogPolicy(policy) {
    this.dialogPolicy = { ...policy };
    await this.ensureAttached().catch(() => undefined);
    return true;
  }

  _onDialogOpening(params) {
    const dialogId = `dlg_${this.dialogSeq++}`;
    const dialogType = params.type || 'alert';
    const message = String(params.message || '');
    const defaultPrompt = String(params.defaultPrompt || '');
    const p = this.dialogPolicy || {};

    if (p.enabled && (p.action === 'accept' || p.action === 'dismiss')) {
      void this.sendCdp('Page.handleJavaScriptDialog', {
        accept: p.action === 'accept',
        ...(p.action === 'accept' && dialogType === 'prompt' ? { promptText: p.promptText || defaultPrompt } : {}),
      }).catch(() => undefined);
      return;
    }

    const timer = setTimeout(() => {
      if (this.pendingDialog?.dialogId === dialogId) {
        this.pendingDialog = null;
        const acceptFallback = p.fallbackAction === 'accept';
        void this.sendCdp('Page.handleJavaScriptDialog', {
          accept: acceptFallback,
          ...(acceptFallback && p.fallbackPromptText ? { promptText: p.fallbackPromptText } : {}),
        }).catch(() => undefined);
      }
    }, 10000);

    this.pendingDialog = { dialogId, timer };
    this._sendHubChannel(WEBVIEW_DIALOG_OPENING_CHANNEL, {
      webContentsId: this.wcId,
      tabKey: this.tabKey,
      dialogId,
      dialogType,
      message,
      defaultPrompt,
      url: params.url || this.url,
    });
  }

  async handleJavaScriptDialog(decision) {
    if (this.pendingDialog) {
      clearTimeout(this.pendingDialog.timer);
      this.pendingDialog = null;
    }
    await this.sendCdp('Page.handleJavaScriptDialog', {
      accept: Boolean(decision?.accept),
      ...(typeof decision?.promptText === 'string' ? { promptText: decision.promptText } : {}),
    });
    return true;
  }

  // --- File chooser handling ---
  async setFileChooserPolicy(policy) {
    this.fileChooserPolicy = { enabled: Boolean(policy?.enabled), tabKey: policy?.tabKey };
    if (this.ws && this.ws.readyState === 1) {
      const enabled = this.fileChooserPolicy.enabled && !isProtectedIdp(this.url);
      await this.sendCdp('Page.setInterceptFileChooserDialog', { enabled }).catch(() => undefined);
      this.interceptChooserEnabled = enabled;
      return true;
    }
    return true;
  }

  _onFileChooserOpened(params) {
    const backendNodeId = typeof params.backendNodeId === 'number' && params.backendNodeId > 0
      ? params.backendNodeId
      : undefined;
    if (!this.fileChooserPolicy?.enabled || isProtectedIdp(this.url)) {
      if (backendNodeId !== undefined) {
        void this.sendCdp('DOM.setFileInputFiles', { files: [], backendNodeId }).catch(() => undefined);
      }
      return;
    }
    if (this.pendingChooser) {
      clearTimeout(this.pendingChooser.timer);
    }
    const chooserId = `fc_${this.chooserSeq++}`;
    const timer = setTimeout(() => {
      if (this.pendingChooser?.chooserId === chooserId) {
        this.pendingChooser = null;
        if (backendNodeId !== undefined) {
          void this.sendCdp('DOM.setFileInputFiles', { files: [], backendNodeId }).catch(() => undefined);
        }
      }
    }, 10000);

    this.pendingChooser = { chooserId, backendNodeId, frameId: params.frameId, timer };
    this._sendHubChannel(WEBVIEW_FILE_CHOOSER_OPENED_CHANNEL, {
      webContentsId: this.wcId,
      tabKey: this.tabKey,
      chooserId,
      mode: params.mode || 'selectSingle',
      multiple: params.mode === 'selectMultiple',
      url: this.url,
    });
  }

  async handleFileChooser(decision) {
    if (isProtectedIdp(this.url)) {
      return { ok: false, errorCode: 'NAVIGATION_NEEDS_PERMISSION', error: 'File upload blocked on protected IdP' };
    }
    const pending = this.pendingChooser;
    if (!pending || pending.chooserId !== decision?.chooserId) {
      return { ok: false, errorCode: 'ACTION_FAILED', error: 'No matching open file chooser' };
    }
    clearTimeout(pending.timer);
    this.pendingChooser = null;

    if (!decision.accept || !Array.isArray(decision.files) || decision.files.length === 0) {
      if (pending.backendNodeId) {
        await this.sendCdp('DOM.setFileInputFiles', { files: [], backendNodeId: pending.backendNodeId }).catch(() => undefined);
      }
      return { ok: true };
    }

    if (!webviewUploadValidation?.resolveValidatedStagedUploadFiles) {
      return { ok: false, errorCode: 'ACTION_FAILED', error: 'Upload validator unavailable' };
    }
    const validated = webviewUploadValidation.resolveValidatedStagedUploadFiles(decision.allowedUploadsDir, decision.files);
    if (!validated.ok) return validated;

    await this.sendCdp('DOM.setFileInputFiles', {
      files: validated.files,
      backendNodeId: pending.backendNodeId,
    });
    return { ok: true, files: validated.files };
  }

  async setInputFiles(request) {
    if (isProtectedIdp(this.url)) {
      return { ok: false, errorCode: 'NAVIGATION_NEEDS_PERMISSION', error: 'File upload blocked on protected IdP' };
    }
    await this.ensureAttached();
    const files = Array.isArray(request?.files) ? request.files : [];
    let resolvedFiles = [];
    if (files.length > 0) {
      if (!webviewUploadValidation?.resolveValidatedStagedUploadFiles) {
        return { ok: false, errorCode: 'ACTION_FAILED', error: 'Upload validator unavailable' };
      }
      const validated = webviewUploadValidation.resolveValidatedStagedUploadFiles(request.allowedUploadsDir, files);
      if (!validated.ok) return validated;
      resolvedFiles = validated.files;
    }

    const selector = request?.selector;
    const domPath = request?.domPath;
    if (!this.mainFrameId) await this._waitForFrameTree();

    const docRes = await this.sendCdp('DOM.getDocument', { depth: -1 });
    if (!docRes?.root?.nodeId) {
      return { ok: false, errorCode: 'ACTION_FAILED', error: 'DOM root unavailable' };
    }

    if (typeof selector === 'string' && selector) {
      const q = await this.sendCdp('DOM.querySelector', { nodeId: docRes.root.nodeId, selector });
      if (!q?.nodeId) return { ok: false, errorCode: 'ACTION_FAILED', error: `Selector not found: ${selector}` };
      await this.sendCdp('DOM.setFileInputFiles', { files: resolvedFiles, nodeId: q.nodeId });
      return { ok: true, files: resolvedFiles };
    }

    if (Array.isArray(domPath) && domPath.length > 0) {
      const evalPath = `(function(steps) {
        let cur = document;
        for (const s of steps) {
          if (!cur) return null;
          if (s.kind === 'shadow') cur = cur.shadowRoot;
          else if (s.kind === 'child') cur = cur.childNodes && cur.childNodes[s.index];
        }
        return cur && cur.tagName === 'INPUT' && cur.type === 'file' ? cur : null;
      })(${JSON.stringify(domPath)})`;
      const r = await this.sendCdp('Runtime.evaluate', { expression: evalPath, returnByValue: false });
      const objectId = r?.result?.objectId;
      if (!objectId) return { ok: false, errorCode: 'ACTION_FAILED', error: 'DOM path did not resolve to <input type="file">' };
      try {
        await this.sendCdp('DOM.setFileInputFiles', { files: resolvedFiles, objectId });
        return { ok: true, files: resolvedFiles };
      } finally {
        void this.sendCdp('Runtime.releaseObject', { objectId }).catch(() => undefined);
      }
    }

    return { ok: false, errorCode: 'ACTION_FAILED', error: 'selector or domPath required for setInputFiles' };
  }

  async dispose() {
    this.closing = true;
    if (this.pendingDialog) {
      clearTimeout(this.pendingDialog.timer);
      this.pendingDialog = null;
    }
    if (this.pendingChooser) {
      clearTimeout(this.pendingChooser.timer);
      this.pendingChooser = null;
    }
    this._settleNavWaiters();

    const targetId = this.targetId;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    if (targetId) {
      const port = edgeLauncher.DEFAULT_PORT || 9222;
      try {
        const pages = await edgeLauncher.getEdgePageTargets(port);
        if (pages.length > 1) {
          await httpRequestJson('GET', `http://127.0.0.1:${port}/json/close/${targetId}`).catch(() => undefined);
        }
      } catch {}
      this.targetId = null;
    }
  }
}

class EdgeVirtualEngine {
  constructor() {
    this.sessionsByTabKey = new Map();
    this.sessionsByWcId = new Map();
    this.registryRef = null;
  }

  setRegistryRef(registry) {
    this.registryRef = registry;
  }

  getClaimedTargetIds() {
    const claimed = new Set();
    for (const s of this.sessionsByTabKey.values()) {
      if (s.targetId) claimed.add(s.targetId);
    }
    return claimed;
  }

  /** Registers metadata ONLY; strictly never launches Edge until an operation runs. */
  registerTab(tabKey, wc, hubSender, initialUrl, registryRef) {
    if (registryRef) this.registryRef = registryRef;
    const prev = this.sessionsByTabKey.get(tabKey);
    if (prev) {
      if (prev.wcId !== undefined) this.sessionsByWcId.delete(prev.wcId);
      prev.wc = wc;
      prev.wcId = wc?.id;
      prev.hubSender = hubSender;
      if (initialUrl && initialUrl !== 'about:blank' && !prev.url) {
        prev.url = initialUrl;
      }
      if (prev.wcId !== undefined) this.sessionsByWcId.set(prev.wcId, prev);
      return prev;
    }
    const session = new EdgeTabSession(this, tabKey, wc, hubSender, initialUrl);
    this.sessionsByTabKey.set(tabKey, session);
    if (session.wcId !== undefined) {
      this.sessionsByWcId.set(session.wcId, session);
    }
    return session;
  }

  disposeTab(tabKey) {
    const session = this.sessionsByTabKey.get(tabKey);
    if (!session) return;
    this.sessionsByTabKey.delete(tabKey);
    if (session.wcId !== undefined) {
      this.sessionsByWcId.delete(session.wcId);
    }
    void session.dispose();
  }

  hasTab(tabKey) {
    return this.sessionsByTabKey.has(tabKey);
  }

  hasTabByWcId(wcId) {
    return this.sessionsByWcId.has(wcId);
  }

  getSession(tabKey) {
    return this.sessionsByTabKey.get(tabKey) || null;
  }

  getSessionByWcId(wcId) {
    return this.sessionsByWcId.get(wcId) || null;
  }

  getTabSnapshotOverride(tabKey) {
    const s = this.sessionsByTabKey.get(tabKey);
    if (!s) return null;
    if (!s.ws && !s.url) return null;
    return {
      url: s.url || 'about:blank',
      title: s.title || '',
      canGoBack: s.canGoBack,
      canGoForward: s.canGoForward,
      isLoading: s.isLoading,
    };
  }

  async setAgentControlling(tabKey, active) {
    const s = this.sessionsByTabKey.get(tabKey);
    if (!s) return;
    await s.setAgentControlling(active);
  }

  async activateTab(tabKey) {
    const s = this.sessionsByTabKey.get(tabKey);
    if (!s) return;
    if (s.ws || (s.url && s.url !== 'about:blank')) {
      await s.activateInEdge().catch(() => undefined);
    }
  }

  async navigateTab(tabKey, url) {
    const s = this.sessionsByTabKey.get(tabKey);
    if (!s) return false;
    return s.navigate(url);
  }

  async controlTab(tabKey, action) {
    const s = this.sessionsByTabKey.get(tabKey);
    if (!s) return false;
    await s.control(action);
    return true;
  }

  async executeInMainIsolatedWorld(wcId, worldId, code) {
    const s = this.sessionsByWcId.get(wcId);
    if (!s) throw new Error(`Edge tab not registered for webContentsId ${wcId}`);
    return s.executeInMainIsolatedWorld(worldId, code);
  }

  async listFrames(wcId, options) {
    const s = this.sessionsByWcId.get(wcId);
    if (!s) return guestFramePolicy?.EMPTY_FRAME_TREE || { mainFrameId: '', mainUrl: '', mainOrigin: '', frames: [] };
    return s.listFrames(options);
  }

  async executeInFrameIsolatedWorld(wcId, frameId, code, expectedOrigin, options) {
    const s = this.sessionsByWcId.get(wcId);
    if (!s) throw new Error(`Edge tab not registered for webContentsId ${wcId}`);
    return s.executeInFrameIsolatedWorld(frameId, code, expectedOrigin, options);
  }

  async dispatchAgentMouse(tabKey, params) {
    const s = this.sessionsByTabKey.get(tabKey);
    if (!s) return;
    return s.dispatchAgentMouse(params);
  }

  async dispatchAgentKey(tabKey, params) {
    const s = this.sessionsByTabKey.get(tabKey);
    if (!s) return;
    return s.dispatchAgentKey(params);
  }

  async insertEdgeText(tabKey, text) {
    const s = this.sessionsByTabKey.get(tabKey);
    if (!s) return;
    return s.insertText(text);
  }

  updateCursorState(tabKey, state) {
    const s = this.sessionsByTabKey.get(tabKey);
    if (s) s.updateCursorState(state);
  }

  async captureEdgePageNativeImage(nativeImage, tabKey) {
    const s = tabKey
      ? this.sessionsByTabKey.get(tabKey)
      : Array.from(this.sessionsByTabKey.values())[0];
    if (!s || !nativeImage) return null;
    return s.captureScreenshotNativeImage(nativeImage);
  }

  getNetworkRequests(wcId) {
    return this.sessionsByWcId.get(wcId)?.getNetworkRequests() || [];
  }

  clearNetworkRequests(wcId) {
    return this.sessionsByWcId.get(wcId)?.clearNetworkRequests() ?? true;
  }

  async setDialogPolicy(wcId, policy) {
    const s = this.sessionsByWcId.get(wcId);
    if (!s) return false;
    return s.setDialogPolicy(policy);
  }

  async handleJavaScriptDialog(wcId, decision) {
    const s = this.sessionsByWcId.get(wcId);
    if (!s) return false;
    return s.handleJavaScriptDialog(decision);
  }

  async setFileChooserPolicy(wcId, policy) {
    const s = this.sessionsByWcId.get(wcId);
    if (!s) return false;
    return s.setFileChooserPolicy(policy);
  }

  async handleFileChooser(wcId, decision) {
    const s = this.sessionsByWcId.get(wcId);
    if (!s) return { ok: false, errorCode: 'ACTION_FAILED', error: 'No Edge session' };
    return s.handleFileChooser(decision);
  }

  async setInputFiles(wcId, request) {
    const s = this.sessionsByWcId.get(wcId);
    if (!s) return { ok: false, errorCode: 'ACTION_FAILED', error: 'No Edge session' };
    return s.setInputFiles(request);
  }
}

const edgeVirtualEngine = new EdgeVirtualEngine();

module.exports = edgeVirtualEngine;
module.exports.EdgeVirtualEngine = EdgeVirtualEngine;
module.exports.EdgeTabSession = EdgeTabSession;
module.exports.CdpWebSocket = CdpWebSocket;
module.exports.AI_CURSOR_BOOTSTRAP_FN = AI_CURSOR_BOOTSTRAP_FN;
