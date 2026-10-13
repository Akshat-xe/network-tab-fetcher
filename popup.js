// Details of a Web Feature - Popup Controller
const $ = (id) => document.getElementById(id);

const ui = {
  status: $('status'),
  dot: $('dot'),
  targetTitle: $('targetTitle'),
  targetUrl: $('targetUrl'),
  heroSub: $('heroSub'),
  dlAll: $('dlAll'),
  dlNetwork: $('dlNetwork'),
  dlElements: $('dlElements'),
  dlSources: $('dlSources'),
  dlMemory: $('dlMemory'),
  dlConsole: $('dlConsole'),
  autoCaptureToggle: $('autoCaptureToggle'),
  autoSwitchToggle: $('autoSwitchToggle'),
  autoClearToggle: $('autoClearToggle'),
  netCount: $('netCount'),
  sourcesCount: $('sourcesCount'),
  consoleCount: $('consoleCount'),
  bytes: $('bytes'),
  filter: $('filter'),
  clearBtn: $('clearBtn'),
  list: $('list'),
  catPills: document.querySelectorAll('.cat-pill'),
  counts: {
    xhr: $('cXhr'),
    media: $('cMedia'),
    doc: $('cDoc'),
    js: $('cJs'),
    css: $('cCss'),
    img: $('cImg'),
    ws: $('cWs'),
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

async function send(type, data = {}) {
  try {
    return await chrome.runtime.sendMessage({ target: 'background', type, ...data });
  } catch (err) {
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

  // Active Tab Target
  if (s.tabUrl) {
    ui.targetUrl.textContent = s.tabUrl;
    ui.targetTitle.textContent = s.tabTitle || 'Active Tab';
  } else {
    ui.targetUrl.textContent = '(loading current tab...)';
    ui.targetTitle.textContent = 'Active Tab';
  }

  // Multi-domain counts
  const stats = s.stats || {};
  ui.netCount.textContent = stats.requestsCount || 0;
  ui.sourcesCount.textContent = stats.scriptsCount || 0;
  ui.consoleCount.textContent = stats.consoleLogsCount || 0;
  ui.bytes.textContent = fmtBytes(stats.bytes);

  // Status
  if (s.capturing && !s.paused) {
    ui.status.textContent = 'Inspecting (Live)';
    ui.status.className = 'status-pill active';
    ui.dot.className = 'dot live';
  } else {
    ui.status.textContent = 'Idle';
    ui.status.className = 'status-pill';
    ui.dot.className = 'dot';
  }

  // Toggles
  ui.autoCaptureToggle.checked = !!s.autoCapture;
  ui.autoSwitchToggle.checked = !!s.autoSwitchTabs;
  ui.autoClearToggle.checked = !!s.autoClearOnReload;

  // Category Pills
  const cats = stats.categories || {};
  if (ui.counts.xhr) ui.counts.xhr.textContent = cats['Fetch/XHR'] || 0;
  if (ui.counts.media) ui.counts.media.textContent = cats['Media'] || 0;
  if (ui.counts.doc) ui.counts.doc.textContent = cats['Document'] || 0;
  if (ui.counts.js) ui.counts.js.textContent = cats['JavaScript'] || 0;
  if (ui.counts.css) ui.counts.css.textContent = cats['CSS'] || 0;
  if (ui.counts.img) ui.counts.img.textContent = cats['Image'] || 0;
  if (ui.counts.ws) ui.counts.ws.textContent = cats['WebSocket'] || 0;
  if (ui.counts.other) ui.counts.other.textContent = cats['Other'] || 0;

  // Subtitle
  ui.heroSub.textContent = `Includes ${stats.requestsCount || 0} reqs, ${stats.scriptsCount || 0} scripts, ${stats.consoleLogsCount || 0} logs & DOM snapshot`;
}

async function refreshList() {
  const res = await send('GET_REQUESTS');
  cachedRequests = res?.requests || [];
  renderList();
}

function renderList() {
  const q = ui.filter.value.trim().toLowerCase();
  ui.list.innerHTML = '';

  const sorted = cachedRequests.slice().sort((a, b) =>
    (a.requestTime || a.capturedAt || 0) - (b.requestTime || b.capturedAt || 0)
  );

  let shown = 0;
  for (const e of sorted) {
    if (activeCategory) {
      const cat = (e.category || 'Other').toLowerCase();
      if (cat !== activeCategory.toLowerCase()) continue;
    }
    if (q) {
      const hay = `${e.method || ''} ${e.url || ''} ${e.category || ''} ${e.responseStatus || ''}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }

    shown++;
    const row = document.createElement('div');
    row.className = 'row';

    const status = e.failed ? 'ERR' : (e.responseStatus || '…');
    const sc = e.failed ? 'err' : (e.responseStatus >= 400 ? 'err' : (e.responseStatus >= 300 ? 'warn' : 'ok'));
    const host = e.hostname || '';
    const path = (e.pathname || '') + (e.search || '');
    const cat = e.category || 'Other';

    row.innerHTML = `
      <span class="m">${e.method || 'GET'}</span>
      <span class="s ${sc}">${status}</span>
      <span class="cat">${cat}</span>
      <span class="u" title="${(e.url || '').replace(/"/g,'&quot;')}">${host}${path}</span>
      <span class="t">${e.duration ? Math.round(e.duration) + 'ms' : (e.encodedDataLength ? fmtBytes(e.encodedDataLength) : '')}</span>
    `;

    row.addEventListener('click', () => toggleDetail(row, e));
    ui.list.appendChild(row);

    if (shown >= 200) break;
  }

  if (!shown) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = cachedRequests.length ? 'No requests match filter' : 'Capturing live page inspector...';
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
  d.innerHTML = `
    <div class="detail-title">${entry.method || 'GET'} ${entry.url}</div>
    <pre>${escapeHtml(JSON.stringify({
      status: entry.responseStatus,
      durationMs: entry.duration ? Math.round(entry.duration) : undefined,
      sizeBytes: entry.encodedDataLength,
      requestHeaders: entry.requestHeaders,
      postData: entry.postDataJson || entry.postData,
      responseHeaders: entry.responseHeaders,
      responseBody: entry.responseBody ? entry.responseBody.slice(0, 1500) : (entry.responseBodyError || undefined)
    }, null, 2))}</pre>
  `;
  row.after(d);
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function handleDownload(scope) {
  try {
    ui.status.textContent = `Compiling ${scope} dump...`;
    const res = await send('DOWNLOAD', { scope });
    if (!res || !res.ok) throw new Error(res?.error || 'Download failed');
    ui.status.textContent = `✓ Exported: ${res.filename}`;
    setTimeout(() => refreshState(), 3000);
  } catch (err) {
    alert('Export error: ' + (err.message || err));
    refreshState();
  }
}

// Download Button Listeners
ui.dlAll.addEventListener('click', () => handleDownload('all'));
ui.dlNetwork.addEventListener('click', () => handleDownload('network'));
ui.dlElements.addEventListener('click', () => handleDownload('elements'));
ui.dlSources.addEventListener('click', () => handleDownload('sources'));
ui.dlMemory.addEventListener('click', () => handleDownload('memory'));
ui.dlConsole.addEventListener('click', () => handleDownload('console'));

// Toggles
ui.autoCaptureToggle.addEventListener('change', async (e) => {
  await send('SET_TOGGLE', { key: 'autoCapture', value: e.target.checked });
  await refreshState();
});
ui.autoSwitchToggle.addEventListener('change', async (e) => {
  await send('SET_TOGGLE', { key: 'autoSwitchTabs', value: e.target.checked });
});
ui.autoClearToggle.addEventListener('change', async (e) => {
  await send('SET_TOGGLE', { key: 'autoClearOnReload', value: e.target.checked });
});

// Category pills
ui.catPills.forEach(pill => {
  pill.addEventListener('click', () => {
    ui.catPills.forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    activeCategory = pill.dataset.cat || '';
    renderList();
  });
});

// Clear & Filter
ui.clearBtn.addEventListener('click', async () => {
  await send('CLEAR');
  await refreshAll();
});
ui.filter.addEventListener('input', renderList);

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
