// Network Web Fetcher - Popup Controller
const $ = (id) => document.getElementById(id);

const ui = {
  status: $('status'),
  dot: $('dot'),
  count: $('count'),
  timer: $('timer'),
  bytes: $('bytes'),
  dlZip: $('dlZip'),
  dlJson: $('dlJson'),
  dlHar: $('dlHar'),
  dlCsv: $('dlCsv'),
  heroSub: $('heroSub'),
  autoCaptureToggle: $('autoCaptureToggle'),
  autoClearToggle: $('autoClearToggle'),
  filter: $('filter'),
  clearBtn: $('clearBtn'),
  list: $('list'),
  targetUrl: $('targetUrl'),
  openPanel: $('openPanel'),
  catPills: document.querySelectorAll('.cat-pill'),
  counts: {
    all: $('cAll'),
    xhr: $('cXhr'),
    media: $('cMedia'),
    doc: $('cDoc'),
    js: $('cJs'),
    css: $('cCss'),
    img: $('cImg'),
    ws: $('cWs'),
    font: $('cFont'),
    wasm: $('cWasm'),
    other: $('cOther')
  }
};

let cachedRequests = [];
let lastState = null;
let activeCategory = '';
let timerHandle = null;

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B','KB','MB','GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function fmtElapsed(start, end) {
  if (!start) return '00:00';
  const ms = (end || Date.now()) - start;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}

async function send(type, data = {}) {
  try {
    return await chrome.runtime.sendMessage({ target: 'background', type, ...data });
  } catch (err) {
    console.error(`[NetworkWebFetcher] send error for ${type}:`, err);
    return null;
  }
}

async function refreshState() {
  const s = await send('GET_STATE');
  if (!s) {
    ui.status.textContent = 'Service Worker Offline';
    ui.status.className = 'status-pill';
    ui.dot.className = 'dot';
    return;
  }
  lastState = s;

  // Update counts & sizes
  ui.count.textContent = s.count || 0;
  ui.bytes.textContent = fmtBytes(s.bytes);
  ui.timer.textContent = fmtElapsed(s.startTime, s.endTime);

  // Status indicator
  if (s.capturing && !s.paused) {
    ui.status.textContent = s.autoCapture ? 'Active (Auto)' : 'Capturing';
    ui.status.className = 'status-pill active';
    ui.dot.className = 'dot live';
  } else if (s.paused) {
    ui.status.textContent = 'Paused';
    ui.status.className = 'status-pill';
    ui.dot.className = 'dot';
  } else {
    ui.status.textContent = 'Idle';
    ui.status.className = 'status-pill';
    ui.dot.className = 'dot';
  }

  // Toggles
  if (ui.autoCaptureToggle) ui.autoCaptureToggle.checked = !!s.autoCapture;
  if (ui.autoClearToggle) ui.autoClearToggle.checked = !!s.autoClearOnReload;

  // Category counts
  const cats = s.categories || {};
  if (ui.counts.all) ui.counts.all.textContent = s.count || 0;
  if (ui.counts.xhr) ui.counts.xhr.textContent = cats['Fetch/XHR'] || 0;
  if (ui.counts.media) ui.counts.media.textContent = cats['Media'] || 0;
  if (ui.counts.doc) ui.counts.doc.textContent = cats['Document'] || 0;
  if (ui.counts.js) ui.counts.js.textContent = cats['JavaScript'] || 0;
  if (ui.counts.css) ui.counts.css.textContent = cats['CSS'] || 0;
  if (ui.counts.img) ui.counts.img.textContent = cats['Image'] || 0;
  if (ui.counts.ws) ui.counts.ws.textContent = cats['WebSocket'] || 0;
  if (ui.counts.font) ui.counts.font.textContent = cats['Font'] || 0;
  if (ui.counts.wasm) ui.counts.wasm.textContent = cats['Wasm'] || 0;
  if (ui.counts.other) ui.counts.other.textContent = cats['Other'] || 0;

  // Target URL
  if (s.tabUrl) {
    ui.targetUrl.textContent = s.tabUrl;
    ui.targetUrl.title = s.tabUrl;
  } else {
    ui.targetUrl.textContent = '(loading active tab...)';
  }

  // Hero subtitle
  if (ui.heroSub) {
    ui.heroSub.textContent = s.count
      ? `Save ${s.count} requests (${fmtBytes(s.bytes)}) to folder`
      : 'Ready — exports categorized ZIP with all payloads';
  }
}

async function refreshList() {
  const res = await send('GET_REQUESTS');
  cachedRequests = (res && res.requests) || [];
  renderList();
}

function statusClass(code) {
  if (!code) return 'warn';
  if (code >= 500) return 'err';
  if (code >= 400) return 'err';
  if (code >= 300) return 'warn';
  return 'ok';
}

function renderList() {
  const q = ui.filter.value.trim().toLowerCase();
  ui.list.innerHTML = '';

  const sorted = cachedRequests.slice().sort((a, b) =>
    (a.requestTime || a.capturedAt || 0) - (b.requestTime || b.capturedAt || 0)
  );

  let shown = 0;
  for (const e of sorted) {
    // Filter by category pill
    if (activeCategory) {
      const cat = (e.category || 'Other').toLowerCase();
      if (cat !== activeCategory.toLowerCase()) continue;
    }

    // Filter by search query
    if (q) {
      const hay = `${e.method || ''} ${e.url || ''} ${e.category || ''} ${e.responseStatus || ''}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }

    shown++;
    const row = document.createElement('div');
    row.className = 'row';

    const status = e.failed ? 'ERR' : (e.responseStatus || '…');
    const sc = e.failed ? 'err' : statusClass(e.responseStatus);
    const host = e.hostname || '';
    const path = (e.pathname || '') + (e.search || '');
    const cat = e.category || 'Other';
    const catClass = cat.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();

    row.innerHTML = `
      <span class="m">${e.method || 'GET'}</span>
      <span class="s ${sc}">${status}</span>
      <span class="cat ${catClass}">${cat}</span>
      <span class="u" title="${(e.url || '').replace(/"/g,'&quot;')}">${host}${path}</span>
      <span class="t">${e.duration ? Math.round(e.duration) + 'ms' : (e.encodedDataLength ? fmtBytes(e.encodedDataLength) : '')}</span>
    `;

    row.addEventListener('click', () => toggleDetail(row, e));
    ui.list.appendChild(row);

    if (shown >= 250) break; // keep rendering fast
  }

  if (!shown) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = cachedRequests.length
      ? 'No requests match your current category/filter.'
      : 'Waiting for network traffic... (Reload or interact with the page)';
    ui.list.appendChild(empty);
  }
}

function toggleDetail(row, entry) {
  const next = row.nextElementSibling;
  if (next && next.classList.contains('detail')) {
    next.remove();
    return;
  }

  const d = document.createElement('div');
  d.className = 'detail';

  const clean = {
    url: entry.url,
    method: entry.method,
    status: entry.responseStatus,
    category: entry.category,
    durationMs: entry.duration ? Math.round(entry.duration) : undefined,
    sizeBytes: entry.encodedDataLength,
    queryParams: entry.queryParams,
    requestHeaders: entry.requestHeadersFull || entry.requestHeaders,
    postData: entry.postDataJson || entry.postDataForm || entry.postData,
    responseHeaders: entry.responseHeadersFull || entry.responseHeaders,
    responseBodyPreview: entry.responseBody
      ? (entry.responseBody.length > 2000 ? entry.responseBody.slice(0, 2000) + `... [${entry.responseBody.length} chars total]` : entry.responseBody)
      : (entry.responseBodyError || undefined),
    webSocketFrames: entry.frames?.length ? entry.frames : undefined
  };

  d.innerHTML = `
    <div class="detail-title">${entry.method || 'GET'} ${entry.url}</div>
    <pre>${escapeHtml(JSON.stringify(clean, null, 2))}</pre>
  `;
  row.after(d);
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Download action with Save As prompt
async function doDownload(format = 'zip') {
  try {
    ui.status.textContent = 'Preparing download...';
    const res = await send('DOWNLOAD', { format });
    if (!res || !res.ok) throw new Error(res && res.error || 'Failed to generate download');
    ui.status.textContent = `✓ Exported: ${res.filename}`;
    setTimeout(() => refreshState(), 3000);
  } catch (err) {
    alert('Download failed: ' + (err.message || err));
    refreshState();
  }
}

// Category pill click listeners
ui.catPills.forEach(pill => {
  pill.addEventListener('click', () => {
    ui.catPills.forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    activeCategory = pill.dataset.cat || '';
    renderList();
  });
});

// Download buttons
ui.dlZip.addEventListener('click', () => doDownload('zip'));
ui.dlJson.addEventListener('click', () => doDownload('json'));
ui.dlHar.addEventListener('click', () => doDownload('har'));
ui.dlCsv.addEventListener('click', () => doDownload('csv'));

// Toggles
ui.autoCaptureToggle.addEventListener('change', async (e) => {
  await send('SET_AUTO_CAPTURE', { enabled: e.target.checked });
  await refreshAll();
});

ui.autoClearToggle.addEventListener('change', async (e) => {
  await send('SET_AUTO_CLEAR', { enabled: e.target.checked });
});

// Clear button
ui.clearBtn.addEventListener('click', async () => {
  await send('CLEAR');
  await refreshAll();
});

// Search filter
ui.filter.addEventListener('input', renderList);

// DevTools panel link
ui.openPanel.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('panel.html') });
});

async function refreshAll() {
  await refreshState();
  await refreshList();
}

refreshAll();
timerHandle = setInterval(() => {
  if (lastState && lastState.capturing) {
    refreshAll();
  }
}, 800);

window.addEventListener('unload', () => {
  if (timerHandle) clearInterval(timerHandle);
});
