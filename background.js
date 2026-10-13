// Network Web Fetcher - Service Worker (Manifest V3)
// Captures full network request/response data, headers, bodies, media, and WebSockets via Chrome DevTools Protocol.

const STATE_KEY = 'nwf_state_v2';
const REQUESTS_KEY = 'nwf_requests_v2';

const state = {
  capturing: false,
  autoCapture: true,        // Automatically captures active tab on load/reload
  autoClearOnReload: true,  // Automatically resets/deletes previous logs when page reloads
  paused: false,
  startTime: null,
  endTime: null,
  tabId: null,
  tabUrl: null,
  count: 0,
  bytes: 0,
  requests: new Map(), // requestId -> entry
  pendingBodies: new Set()
};

// ---------- Categorization Helper ----------
function normalizeCategory(resourceType, url = '', mimeType = '') {
  const t = (resourceType || '').toLowerCase();
  const u = (url || '').toLowerCase();
  const m = (mimeType || '').toLowerCase();

  if (t === 'xhr' || t === 'fetch') return 'Fetch/XHR';
  if (t === 'document') return 'Document';
  if (t === 'stylesheet' || u.endsWith('.css') || m.includes('text/css')) return 'CSS';
  if (t === 'script' || u.endsWith('.js') || m.includes('javascript') || m.includes('ecmascript')) return 'JavaScript';
  if (t === 'image' || u.match(/\.(png|jpg|jpeg|gif|webp|svg|ico|avif)($|\?)/) || m.includes('image/')) return 'Image';
  if (t === 'media' || u.match(/\.(ts|m3u8|mp4|webm|mp3|aac|m4s|ogg)($|\?)/) || m.includes('video/') || m.includes('audio/') || m.includes('mpegurl')) return 'Media';
  if (t === 'font' || u.match(/\.(woff|woff2|ttf|otf|eot)($|\?)/) || m.includes('font/')) return 'Font';
  if (t === 'websocket' || u.startsWith('ws://') || u.startsWith('wss://')) return 'WebSocket';
  if (t === 'wasm' || u.endsWith('.wasm') || m.includes('wasm')) return 'Wasm';
  if (t === 'manifest' || u.includes('manifest')) return 'Manifest';
  return 'Other';
}

function getCategoryCounts() {
  const counts = {
    'Fetch/XHR': 0,
    'Document': 0,
    'CSS': 0,
    'JavaScript': 0,
    'Image': 0,
    'Media': 0,
    'Font': 0,
    'WebSocket': 0,
    'Wasm': 0,
    'Manifest': 0,
    'Other': 0
  };
  for (const req of state.requests.values()) {
    const cat = req.category || 'Other';
    if (counts[cat] !== undefined) counts[cat]++;
    else counts['Other']++;
  }
  return counts;
}

// ---------- Persistence ----------
async function saveState() {
  const meta = {
    capturing: state.capturing,
    autoCapture: state.autoCapture,
    autoClearOnReload: state.autoClearOnReload,
    paused: state.paused,
    startTime: state.startTime,
    endTime: state.endTime,
    tabId: state.tabId,
    tabUrl: state.tabUrl,
    count: state.requests.size,
    bytes: state.bytes
  };
  try {
    await chrome.storage.local.set({
      [STATE_KEY]: meta,
      [REQUESTS_KEY]: Array.from(state.requests.entries())
    });
  } catch (e) {
    console.warn('[NetworkWebFetcher] saveState failed', e);
  }
}

async function loadState() {
  try {
    const data = await chrome.storage.local.get([STATE_KEY, REQUESTS_KEY]);
    if (data[STATE_KEY]) {
      Object.assign(state, data[STATE_KEY]);
      state.requests = new Map();
      if (Array.isArray(data[REQUESTS_KEY])) {
        for (const [k, v] of data[REQUESTS_KEY]) state.requests.set(k, v);
      }
      if (state.capturing) {
        state.capturing = false;
        state.endTime = Date.now();
      }
    }
    // Check if auto-capture is active and attach to current tab
    if (state.autoCapture) {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab && activeTab.id && !activeTab.url?.startsWith('chrome://')) {
        startCapture(activeTab.id).catch(() => {});
      }
    }
  } catch (e) {
    console.warn('[NetworkWebFetcher] loadState error:', e);
  }
  setBadge();
}
loadState();

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveState();
  }, 1200);
}

// ---------- URL & Header Parsers ----------
function parseUrl(u) {
  try {
    const x = new URL(u);
    const params = {};
    x.searchParams.forEach((v, k) => {
      if (params[k] === undefined) params[k] = v;
      else if (Array.isArray(params[k])) params[k].push(v);
      else params[k] = [params[k], v];
    });
    return {
      hostname: x.hostname,
      pathname: x.pathname,
      protocol: x.protocol,
      port: x.port,
      hash: x.hash,
      search: x.search,
      origin: x.origin,
      queryParams: params
    };
  } catch {
    return {};
  }
}

function parseCookieHeader(value) {
  if (!value) return [];
  return String(value).split(/;\s*/).filter(Boolean).map(part => {
    const i = part.indexOf('=');
    if (i === -1) return { name: part, value: '' };
    return { name: part.slice(0, i), value: part.slice(i + 1) };
  });
}

function parseSetCookie(value) {
  if (!value) return [];
  const lines = String(value).split('\n').filter(Boolean);
  return lines.map(line => {
    const parts = line.split(/;\s*/);
    const [nv, ...attrs] = parts;
    const i = nv.indexOf('=');
    const name = i === -1 ? nv : nv.slice(0, i);
    const val = i === -1 ? '' : nv.slice(i + 1);
    const cookie = { name, value: val };
    for (const a of attrs) {
      const j = a.indexOf('=');
      const k = (j === -1 ? a : a.slice(0, j)).toLowerCase();
      const v = j === -1 ? true : a.slice(j + 1);
      if (k === 'expires') cookie.expires = v;
      else if (k === 'max-age') cookie.maxAge = v;
      else if (k === 'domain') cookie.domain = v;
      else if (k === 'path') cookie.path = v;
      else if (k === 'samesite') cookie.sameSite = v;
      else if (k === 'secure') cookie.secure = true;
      else if (k === 'httponly') cookie.httpOnly = true;
      else cookie[k] = v;
    }
    return cookie;
  });
}

function lowerKeys(obj) {
  if (!obj) return {};
  const out = {};
  for (const k of Object.keys(obj)) out[k.toLowerCase()] = obj[k];
  return out;
}

// ---------- Debugger Event Listener ----------
chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (!state.capturing || state.paused) return;
  if (state.tabId && source.tabId !== state.tabId) return;
  const reqId = params && params.requestId;
  if (!reqId) return;

  let e = state.requests.get(reqId);
  if (!e) {
    e = { id: reqId, capturedAt: Date.now() };
    state.requests.set(reqId, e);
  }

  switch (method) {
    case 'Network.requestWillBeSent': {
      const req = params.request || {};
      e.url = req.url;
      e.method = req.method;
      e.requestHeaders = req.headers || {};
      e.postData = req.postData || null;
      e.hasPostData = !!req.hasPostData;
      e.initiator = params.initiator;
      e.resourceType = params.type;
      e.frameId = params.frameId;
      e.loaderId = params.loaderId;
      e.documentURL = params.documentURL;
      e.redirectResponse = params.redirectResponse;
      e.wallTime = params.wallTime;
      e.requestTime = params.timestamp;
      e.category = normalizeCategory(params.type, req.url);
      Object.assign(e, parseUrl(req.url));

      const lh = lowerKeys(req.headers);
      if (lh.cookie) e.requestCookies = parseCookieHeader(lh.cookie);
      if (req.postData) {
        try {
          const ct = lh['content-type'] || '';
          if (ct.includes('application/json')) e.postDataJson = JSON.parse(req.postData);
          else if (ct.includes('application/x-www-form-urlencoded')) {
            const p = {};
            new URLSearchParams(req.postData).forEach((v, k) => p[k] = v);
            e.postDataForm = p;
          }
        } catch { /* raw */ }
      }
      break;
    }

    case 'Network.requestWillBeSentExtraInfo': {
      e.requestHeadersExtra = params.headers || {};
      e.associatedCookies = params.associatedCookies || [];
      e.connectTiming = params.connectTiming;
      e.requestHeadersFull = { ...(e.requestHeaders || {}), ...(e.requestHeadersExtra || {}) };
      break;
    }

    case 'Network.responseReceived': {
      const r = params.response || {};
      e.responseStatus = r.status;
      e.responseStatusText = r.statusText;
      e.responseHeaders = r.headers || {};
      e.responseMimeType = r.mimeType;
      e.responseUrl = r.url;
      e.remoteAddress = r.remoteIPAddress ? `${r.remoteIPAddress}:${r.remotePort}` : null;
      e.protocol = r.protocol;
      e.responseTiming = r.timing;
      e.securityState = r.securityState;
      e.securityDetails = r.securityDetails;
      e.fromDiskCache = r.fromDiskCache;
      e.fromServiceWorker = r.fromServiceWorker;
      e.fromPrefetchCache = r.fromPrefetchCache;
      e.category = normalizeCategory(e.resourceType, e.url, r.mimeType);

      const rh = lowerKeys(r.headers);
      if (rh['set-cookie']) e.responseCookies = parseSetCookie(rh['set-cookie']);
      break;
    }

    case 'Network.responseReceivedExtraInfo': {
      e.responseHeadersExtra = params.headers || {};
      e.blockedCookies = params.blockedCookies || [];
      e.cookiePartitionKey = params.cookiePartitionKey;
      e.headersText = params.headersText;
      e.responseHeadersFull = { ...(e.responseHeaders || {}), ...(e.responseHeadersExtra || {}) };
      const rh = lowerKeys(e.responseHeadersFull);
      if (rh['set-cookie'] && !e.responseCookies) e.responseCookies = parseSetCookie(rh['set-cookie']);
      break;
    }

    case 'Network.loadingFinished': {
      e.encodedDataLength = params.encodedDataLength;
      e.finishedAt = Date.now();
      e.duration = e.requestTime ? (params.timestamp - e.requestTime) * 1000 : null;
      state.bytes += params.encodedDataLength || 0;

      // Extract full response body for text, json, html, etc.
      state.pendingBodies.add(reqId);
      try {
        const body = await chrome.debugger.sendCommand(
          { tabId: state.tabId },
          'Network.getResponseBody',
          { requestId: reqId }
        );
        if (body) {
          e.responseBody = body.body;
          e.responseBase64Encoded = !!body.base64Encoded;
          e.responseBodySize = body.body ? body.body.length : 0;
        }
      } catch (err) {
        e.responseBodyError = err && err.message ? err.message : String(err);
      } finally {
        state.pendingBodies.delete(reqId);
      }
      scheduleSave();
      setBadge();
      break;
    }

    case 'Network.loadingFailed': {
      e.failed = true;
      e.errorText = params.errorText;
      e.canceled = params.canceled;
      e.blockedReason = params.blockedReason;
      e.corsErrorStatus = params.corsErrorStatus;
      e.finishedAt = Date.now();
      scheduleSave();
      setBadge();
      break;
    }

    case 'Network.webSocketCreated': {
      e.kind = 'websocket';
      e.category = 'WebSocket';
      e.url = params.url;
      e.initiator = params.initiator;
      break;
    }

    case 'Network.webSocketFrameSent':
    case 'Network.webSocketFrameReceived': {
      e.kind = 'websocket';
      e.category = 'WebSocket';
      e.frames = e.frames || [];
      e.frames.push({
        direction: method.endsWith('Sent') ? 'out' : 'in',
        timestamp: params.timestamp,
        opcode: params.response && params.response.opcode,
        mask: params.response && params.response.mask,
        payload: params.response && params.response.payloadData
      });
      break;
    }
  }

  if (method !== 'Network.loadingFinished' && method !== 'Network.loadingFailed') {
    scheduleSave();
    setBadge();
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (state.tabId === source.tabId) {
    if (state.capturing) {
      state.capturing = false;
      state.endTime = Date.now();
      saveState();
      setBadge();
    }
  }
});

// ---------- Auto-Capture & Auto-Clear on Page Reload / Navigation ----------
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId === 0) { // Main frame navigation or reload
    if (state.autoClearOnReload && (state.tabId === details.tabId || !state.tabId)) {
      console.log(`[NetworkWebFetcher] Main page reloading: clearing logs and resetting session.`);
      await clearCapture();
      state.tabId = details.tabId;
      state.tabUrl = details.url;
      state.startTime = Date.now();
      if (state.autoCapture) {
        startCapture(details.tabId).catch(() => {});
      }
    }
  }
});

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId === 0 && state.autoCapture) {
    if (state.tabId === details.tabId && !state.capturing) {
      startCapture(details.tabId).catch(() => {});
    }
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (state.autoCapture) {
    const tab = await chrome.tabs.get(activeInfo.tabId).catch(() => null);
    if (tab && !tab.url?.startsWith('chrome://')) {
      if (state.tabId !== activeInfo.tabId) {
        if (state.capturing) {
          try { await chrome.debugger.detach({ tabId: state.tabId }); } catch {}
        }
        startCapture(activeInfo.tabId).catch(() => {});
      }
    }
  }
});

// ---------- Capture Controls ----------
async function startCapture(tabId) {
  if (!tabId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab && tab.id;
  }
  if (!tabId) throw new Error('No active tab');
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.url?.startsWith('chrome://')) return;

  if (state.capturing && state.tabId === tabId) return;
  if (state.capturing && state.tabId !== tabId) {
    try { await chrome.debugger.detach({ tabId: state.tabId }); } catch {}
  }

  state.tabId = tabId;
  state.tabUrl = tab.url;

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (err) {
    if (!err.message?.includes('already attached')) {
      throw err;
    }
  }

  await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {
    maxResourceBufferSize: 100 * 1024 * 1024,
    maxTotalBufferSize: 400 * 1024 * 1024
  });

  try {
    await chrome.debugger.sendCommand({ tabId }, 'Network.setCacheDisabled', { cacheDisabled: false });
  } catch {}

  state.capturing = true;
  state.paused = false;
  if (!state.startTime) state.startTime = Date.now();
  state.endTime = null;
  await saveState();
  setBadge();
}

async function stopCapture() {
  if (!state.capturing) return;
  try { await chrome.debugger.detach({ tabId: state.tabId }); } catch {}
  state.capturing = false;
  state.endTime = Date.now();
  await saveState();
  setBadge();
}

async function pauseCapture(paused) {
  state.paused = !!paused;
  await saveState();
  setBadge();
}

async function clearCapture() {
  state.requests = new Map();
  state.bytes = 0;
  state.count = 0;
  state.startTime = Date.now();
  state.endTime = null;
  await saveState();
  setBadge();
}

function setBadge() {
  try {
    if (state.capturing && !state.paused) {
      const count = state.requests.size;
      chrome.action.setBadgeText({ text: count ? String(count) : 'ON' });
      chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
    } else if (state.paused) {
      chrome.action.setBadgeText({ text: 'PAUSE' });
      chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
    } else if (state.requests.size) {
      chrome.action.setBadgeText({ text: String(state.requests.size) });
      chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  } catch {}
}

// ---------- Offscreen for ZIP / HAR / JSON Building ----------
let offscreenReady = false;
async function ensureOffscreen() {
  if (offscreenReady) return;
  try {
    const has = await chrome.offscreen.hasDocument?.();
    if (has) { offscreenReady = true; return; }
  } catch {}
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Build ZIP/JSON/HAR/CSV blobs and trigger downloads.'
  });
  offscreenReady = true;
}

// Download all captured data with Save-As system prompt
async function downloadAll(format = 'zip') {
  const entries = Array.from(state.requests.values());
  if (!entries.length) throw new Error('No requests captured yet on this page.');
  await ensureOffscreen();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const reply = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'BUILD_AND_DOWNLOAD',
    format,
    ts,
    entries,
    meta: {
      startTime: state.startTime,
      endTime: state.endTime || Date.now(),
      tabUrl: state.tabUrl,
      count: entries.length,
      bytes: state.bytes,
      categories: getCategoryCounts()
    }
  });

  if (!reply || !reply.ok) throw new Error((reply && reply.error) || 'Build failed in offscreen worker');
  if (!chrome.downloads || !chrome.downloads.download) {
    throw new Error('chrome.downloads API unavailable. Reload extension in chrome://extensions');
  }

  // Opens system Save As prompt so the user chooses the exact folder
  const id = await chrome.downloads.download({
    url: reply.url,
    filename: reply.filename,
    saveAs: true
  });

  setTimeout(() => {
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'REVOKE_URL', url: reply.url }).catch(() => {});
  }, 90_000);

  return { ok: true, downloadId: id, filename: reply.filename };
}

// ---------- Site Data Clearing ----------
function originsFor(url) {
  try {
    const u = new URL(url);
    return [u.origin];
  } catch { return []; }
}

async function clearSiteData(url, opts = {}) {
  if (!url) throw new Error('No site URL specified');
  const origins = originsFor(url);
  if (!origins.length) throw new Error('Could not parse site URL: ' + url);
  const what = {
    cookies: opts.cookies !== false,
    cache: opts.cache !== false,
    cacheStorage: opts.cache !== false,
    localStorage: opts.storage !== false,
    indexedDB: opts.storage !== false,
    serviceWorkers: opts.storage !== false
  };
  await chrome.browsingData.remove({ origins }, what);
  return { ok: true, origins, cleared: what };
}

// ---------- Message Router ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || (msg.target && msg.target !== 'background')) return;
  (async () => {
    try {
      switch (msg.type) {
        case 'GET_STATE': {
          sendResponse({
            capturing: state.capturing,
            autoCapture: state.autoCapture,
            autoClearOnReload: state.autoClearOnReload,
            paused: state.paused,
            startTime: state.startTime,
            endTime: state.endTime,
            count: state.requests.size,
            bytes: state.bytes,
            tabId: state.tabId,
            tabUrl: state.tabUrl,
            categories: getCategoryCounts(),
            swVersion: chrome.runtime.getManifest().version
          });
          break;
        }

        case 'SET_AUTO_CAPTURE': {
          state.autoCapture = !!msg.enabled;
          await saveState();
          if (state.autoCapture && !state.capturing) {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab && tab.id) startCapture(tab.id).catch(() => {});
          } else if (!state.autoCapture && state.capturing) {
            await stopCapture();
          }
          sendResponse({ ok: true, autoCapture: state.autoCapture });
          break;
        }

        case 'SET_AUTO_CLEAR': {
          state.autoClearOnReload = !!msg.enabled;
          await saveState();
          sendResponse({ ok: true, autoClearOnReload: state.autoClearOnReload });
          break;
        }

        case 'GET_REQUESTS': {
          const arr = Array.from(state.requests.values());
          sendResponse({ requests: arr });
          break;
        }

        case 'START':
          await startCapture(msg.tabId);
          sendResponse({ ok: true });
          break;

        case 'STOP':
          await stopCapture();
          sendResponse({ ok: true });
          break;

        case 'PAUSE':
          await pauseCapture(true);
          sendResponse({ ok: true });
          break;

        case 'RESUME':
          await pauseCapture(false);
          sendResponse({ ok: true });
          break;

        case 'CLEAR':
          await clearCapture();
          sendResponse({ ok: true });
          break;

        case 'DOWNLOAD': {
          const r = await downloadAll(msg.format || 'zip');
          sendResponse({ ok: true, ...r });
          break;
        }

        case 'GET_TARGET_URL': {
          let url = state.tabUrl;
          if (!url) {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            url = tab && tab.url;
          }
          sendResponse({ ok: true, url });
          break;
        }

        case 'RELOAD_TARGET': {
          const tabId = state.tabId || (await activeTabId());
          if (tabId) await chrome.tabs.reload(tabId, { bypassCache: !!msg.bypassCache });
          sendResponse({ ok: true });
          break;
        }

        case 'CLEAR_SITE_DATA': {
          const url = msg.url || state.tabUrl || (await activeTabUrl());
          const r = await clearSiteData(url, msg.opts || {});
          sendResponse({ ok: true, ...r });
          break;
        }

        default:
          sendResponse({ ok: false, error: 'unknown message: ' + msg.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  })();
  return true; // async
});

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && tab.id;
}

async function activeTabUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && tab.url;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (state.tabId === tabId && state.capturing) {
    state.capturing = false;
    state.endTime = Date.now();
    saveState();
    setBadge();
  }
});
