// Details of a Web Feature - Service Worker (Manifest V3)
// Comprehensive DevTools inspector & scraper for Network, Elements, Sources, Memory, Functions & Console.

const STATE_KEY = 'dowf_state_v3';

const state = {
  capturing: false,
  autoCapture: true,        // Automatically attaches to active tab
  autoClearOnReload: true,  // Automatically clears previous logs on page reload to save storage
  autoSwitchTabs: true,     // Dynamically switches to currently focused tab
  paused: false,
  startTime: null,
  endTime: null,
  tabId: null,
  tabUrl: null,
  tabTitle: null,
  count: 0,
  bytes: 0,
  requests: new Map(),     // requestId -> entry
  scripts: new Map(),      // scriptId -> { id, url, source, length }
  consoleLogs: [],         // array of { level, text, timestamp, url, line }
  domSnapshot: null,       // HTML & element metadata
  storageSnapshot: null,   // localStorage, sessionStorage, cookies, custom globals, memory
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

function getStats() {
  const categories = {
    'Fetch/XHR': 0, 'Document': 0, 'CSS': 0, 'JavaScript': 0,
    'Image': 0, 'Media': 0, 'Font': 0, 'WebSocket': 0,
    'Wasm': 0, 'Manifest': 0, 'Other': 0
  };
  for (const req of state.requests.values()) {
    const cat = req.category || 'Other';
    if (categories[cat] !== undefined) categories[cat]++;
    else categories['Other']++;
  }
  return {
    requestsCount: state.requests.size,
    scriptsCount: state.scripts.size,
    consoleLogsCount: state.consoleLogs.length,
    bytes: state.bytes,
    categories
  };
}

// ---------- State Persistence ----------
async function saveMetaState() {
  try {
    await chrome.storage.local.set({
      [STATE_KEY]: {
        autoCapture: state.autoCapture,
        autoClearOnReload: state.autoClearOnReload,
        autoSwitchTabs: state.autoSwitchTabs
      }
    });
  } catch (e) {}
}

async function loadMetaState() {
  try {
    const data = await chrome.storage.local.get(STATE_KEY);
    if (data[STATE_KEY]) {
      Object.assign(state, data[STATE_KEY]);
    }
    if (state.autoCapture) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id && !tab.url?.startsWith('chrome://') && !tab.url?.startsWith('brave://')) {
        startCapture(tab.id).catch(() => {});
      }
    }
  } catch (e) {}
  setBadge();
}
loadMetaState();

// ---------- URL & Header Helpers ----------
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
      search: x.search,
      queryParams: params
    };
  } catch { return {}; }
}

function lowerKeys(obj) {
  if (!obj) return {};
  const out = {};
  for (const k of Object.keys(obj)) out[k.toLowerCase()] = obj[k];
  return out;
}

// ---------- Debugger Event Listener (Multi-Domain) ----------
chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (!state.capturing || state.paused) return;
  if (state.tabId && source.tabId !== state.tabId) return;

  // 1. Network Events
  if (method.startsWith('Network.')) {
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
        e.resourceType = params.type;
        e.requestTime = params.timestamp;
        e.category = normalizeCategory(params.type, req.url);
        Object.assign(e, parseUrl(req.url));
        if (req.postData) {
          try {
            const ct = (lowerKeys(req.headers)['content-type'] || '').toLowerCase();
            if (ct.includes('application/json')) e.postDataJson = JSON.parse(req.postData);
          } catch {}
        }
        break;
      }
      case 'Network.responseReceived': {
        const r = params.response || {};
        e.responseStatus = r.status;
        e.responseStatusText = r.statusText;
        e.responseHeaders = r.headers || {};
        e.responseMimeType = r.mimeType;
        e.category = normalizeCategory(e.resourceType, e.url, r.mimeType);
        break;
      }
      case 'Network.loadingFinished': {
        e.encodedDataLength = params.encodedDataLength;
        e.duration = e.requestTime ? (params.timestamp - e.requestTime) * 1000 : null;
        state.bytes += params.encodedDataLength || 0;

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
          }
        } catch (err) {
          e.responseBodyError = err?.message || String(err);
        } finally {
          state.pendingBodies.delete(reqId);
        }
        setBadge();
        break;
      }
      case 'Network.loadingFailed': {
        e.failed = true;
        e.errorText = params.errorText;
        setBadge();
        break;
      }
      case 'Network.webSocketCreated': {
        e.kind = 'websocket';
        e.category = 'WebSocket';
        e.url = params.url;
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
          payload: params.response?.payloadData
        });
        break;
      }
    }
  }

  // 2. Sources / Debugger Events (All JS files)
  else if (method === 'Debugger.scriptParsed') {
    const { scriptId, url } = params;
    if (scriptId && (!url || !url.startsWith('chrome-extension://'))) {
      chrome.debugger.sendCommand({ tabId: state.tabId }, 'Debugger.getScriptSource', { scriptId })
        .then(res => {
          if (res && res.scriptSource) {
            state.scripts.set(scriptId, {
              id: scriptId,
              url: url || `inline_script_${scriptId}.js`,
              source: res.scriptSource,
              length: res.scriptSource.length
            });
          }
        }).catch(() => {});
    }
  }

  // 3. Console Events
  else if (method === 'Console.messageAdded') {
    const m = params.message;
    state.consoleLogs.push({
      level: m.level || 'log',
      text: m.text,
      url: m.url,
      line: m.line,
      timestamp: Date.now()
    });
  } else if (method === 'Runtime.consoleAPICalled') {
    const text = params.args?.map(a => a.value !== undefined ? String(a.value) : (a.description || '')).join(' ') || '';
    state.consoleLogs.push({
      level: params.type || 'log',
      text,
      timestamp: Date.now()
    });
  } else if (method === 'Runtime.exceptionThrown') {
    const text = params.exceptionDetails?.text || params.exceptionDetails?.exception?.description || 'Uncaught Error';
    state.consoleLogs.push({
      level: 'error',
      text,
      url: params.exceptionDetails?.url,
      line: params.exceptionDetails?.lineNumber,
      timestamp: Date.now()
    });
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (state.tabId === source.tabId) {
    if (state.capturing) {
      state.capturing = false;
      state.endTime = Date.now();
      setBadge();
    }
  }
});

// ---------- Dynamic Tab Switching & Storage Protection ----------
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (!state.autoCapture || !state.autoSwitchTabs) return;
  const tab = await chrome.tabs.get(activeInfo.tabId).catch(() => null);
  if (!tab || tab.url?.startsWith('chrome://') || tab.url?.startsWith('brave://')) return;

  if (state.tabId !== activeInfo.tabId) {
    console.log(`[DetailsOfAWeb] Tab switched to ${activeInfo.tabId} (${tab.url})`);
    if (state.capturing) {
      try { await chrome.debugger.detach({ tabId: state.tabId }); } catch {}
    }
    // Auto-clear on tab switch to protect disk / RAM
    if (state.autoClearOnReload) {
      await clearCapture();
    }
    startCapture(activeInfo.tabId).catch(() => {});
  }
});

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId === 0) { // Main page reload
    if (state.autoClearOnReload && (state.tabId === details.tabId || !state.tabId)) {
      console.log(`[DetailsOfAWeb] Page reload detected. Auto-clearing memory to protect storage.`);
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

// ---------- Capture Control Methods ----------
async function startCapture(tabId) {
  if (!tabId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab && tab.id;
  }
  if (!tabId) throw new Error('No active tab');
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.url?.startsWith('chrome://') || tab.url?.startsWith('brave://')) return;

  if (state.capturing && state.tabId === tabId) return;
  if (state.capturing && state.tabId !== tabId) {
    try { await chrome.debugger.detach({ tabId: state.tabId }); } catch {}
  }

  state.tabId = tabId;
  state.tabUrl = tab.url;
  state.tabTitle = tab.title || tab.url;

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (err) {
    if (!err.message?.includes('already attached')) throw err;
  }

  // Enable all DevTools inspection domains
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {
    maxResourceBufferSize: 100 * 1024 * 1024,
    maxTotalBufferSize: 400 * 1024 * 1024
  });
  await chrome.debugger.sendCommand({ tabId }, 'Debugger.enable', {}).catch(() => {});
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {}).catch(() => {});
  await chrome.debugger.sendCommand({ tabId }, 'Console.enable', {}).catch(() => {});
  await chrome.debugger.sendCommand({ tabId }, 'Performance.enable', {}).catch(() => {});

  state.capturing = true;
  state.paused = false;
  if (!state.startTime) state.startTime = Date.now();
  state.endTime = null;
  setBadge();
}

async function stopCapture() {
  if (!state.capturing) return;
  try { await chrome.debugger.detach({ tabId: state.tabId }); } catch {}
  state.capturing = false;
  state.endTime = Date.now();
  setBadge();
}

async function clearCapture() {
  state.requests = new Map();
  state.scripts = new Map();
  state.consoleLogs = [];
  state.domSnapshot = null;
  state.storageSnapshot = null;
  state.bytes = 0;
  state.count = 0;
  state.startTime = Date.now();
  state.endTime = null;
  setBadge();
}

function setBadge() {
  try {
    if (state.capturing && !state.paused) {
      const count = state.requests.size;
      chrome.action.setBadgeText({ text: count ? String(count) : 'ON' });
      chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
    } else if (state.paused) {
      chrome.action.setBadgeText({ text: '||' });
      chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  } catch {}
}

// ---------- Live Snapshot Collectors ----------
async function collectDomAndState() {
  if (!state.tabId) return;

  // 1. Elements (DOM)
  try {
    const domRes = await chrome.debugger.sendCommand({ tabId: state.tabId }, 'Runtime.evaluate', {
      expression: `(() => {
        return {
          title: document.title,
          url: window.location.href,
          outerHTML: document.documentElement.outerHTML,
          metaTags: Array.from(document.querySelectorAll('meta')).map(m => m.outerHTML),
          scriptsCount: document.querySelectorAll('script').length,
          linksCount: document.querySelectorAll('link').length
        };
      })()`,
      returnByValue: true
    });
    if (domRes?.result?.value) state.domSnapshot = domRes.result.value;
  } catch (e) {}

  // 2. Memory, Storage & Window Globals
  try {
    const storRes = await chrome.debugger.sendCommand({ tabId: state.tabId }, 'Runtime.evaluate', {
      expression: `(() => {
        const ls = {};
        try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = localStorage.getItem(k); } } catch(e){}
        const ss = {};
        try { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); ss[k] = sessionStorage.getItem(k); } } catch(e){}
        const globals = {};
        try {
          const std = new Set(Object.getOwnPropertyNames(window.constructor.prototype).concat(Object.getOwnPropertyNames(Object.prototype)));
          for (const prop of Object.getOwnPropertyNames(window)) {
            if (!std.has(prop)) {
              try {
                const val = window[prop];
                const t = typeof val;
                if (t === 'function') globals[prop] = 'function ' + (val.name || prop) + '()';
                else if (prop === '__NEXT_DATA__') globals[prop] = val;
                else if (t === 'object') globals[prop] = Array.isArray(val) ? 'Array(' + val.length + ')' : 'Object';
                else globals[prop] = val;
              } catch(e){}
            }
          }
        } catch(e){}
        return {
          localStorage: ls,
          sessionStorage: ss,
          cookies: document.cookie,
          nextData: window.__NEXT_DATA__ || null,
          customGlobals: globals,
          memory: window.performance?.memory ? {
            jsHeapSizeLimit: window.performance.memory.jsHeapSizeLimit,
            totalJSHeapSize: window.performance.memory.totalJSHeapSize,
            usedJSHeapSize: window.performance.memory.usedJSHeapSize
          } : null
        };
      })()`,
      returnByValue: true
    });
    if (storRes?.result?.value) state.storageSnapshot = storRes.result.value;
  } catch (e) {}
}

// ---------- Offscreen Worker for Downloads ----------
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
    justification: 'Compile DevTools archive and trigger Save As download.'
  });
  offscreenReady = true;
}

async function triggerDownload(scope = 'all', format = 'zip') {
  await collectDomAndState();
  await ensureOffscreen();

  const entries = Array.from(state.requests.values());
  const scripts = Array.from(state.scripts.values());
  const ts = new Date().toISOString().replace(/[:.]/g, '-');

  const reply = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'BUILD_AND_DOWNLOAD',
    scope, // 'all', 'network', 'elements', 'sources', 'memory', 'console'
    format,
    ts,
    entries,
    scripts,
    consoleLogs: state.consoleLogs,
    domSnapshot: state.domSnapshot,
    storageSnapshot: state.storageSnapshot,
    meta: {
      startTime: state.startTime,
      endTime: state.endTime || Date.now(),
      tabUrl: state.tabUrl,
      tabTitle: state.tabTitle,
      count: entries.length,
      bytes: state.bytes,
      stats: getStats()
    }
  });

  if (!reply || !reply.ok) throw new Error(reply?.error || 'Download compilation failed');

  const id = await chrome.downloads.download({
    url: reply.url,
    filename: reply.filename,
    saveAs: true
  });

  setTimeout(() => {
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'REVOKE_URL', url: reply.url }).catch(() => {});
  }, 90_000);

  return { ok: true, filename: reply.filename, downloadId: id };
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
            autoSwitchTabs: state.autoSwitchTabs,
            paused: state.paused,
            startTime: state.startTime,
            endTime: state.endTime,
            tabId: state.tabId,
            tabUrl: state.tabUrl,
            tabTitle: state.tabTitle,
            stats: getStats(),
            swVersion: chrome.runtime.getManifest().version
          });
          break;
        }

        case 'SET_TOGGLE': {
          if (msg.key in state) state[msg.key] = !!msg.value;
          await saveMetaState();
          sendResponse({ ok: true });
          break;
        }

        case 'GET_REQUESTS': {
          sendResponse({ requests: Array.from(state.requests.values()) });
          break;
        }

        case 'CLEAR': {
          await clearCapture();
          sendResponse({ ok: true });
          break;
        }

        case 'DOWNLOAD': {
          const res = await triggerDownload(msg.scope || 'all', msg.format || 'zip');
          sendResponse(res);
          break;
        }

        default:
          sendResponse({ ok: false, error: 'Unknown message type: ' + msg.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true;
});
