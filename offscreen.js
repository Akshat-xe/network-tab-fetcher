// Offscreen Worker — Assembles DevTools dumps and builds download ZIPs

const enc = new TextEncoder();

function safe(s, n = 80) {
  return String(s ?? '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, n) || 'x';
}
function pad(i, w) { return String(i).padStart(w, '0'); }

function buildHar(entries, meta) {
  const har = {
    log: {
      version: '1.2',
      creator: { name: 'Details of a Web Feature', version: '2.5.0' },
      pages: [{
        startedDateTime: new Date(meta.startTime || Date.now()).toISOString(),
        id: 'page_1',
        title: meta.tabTitle || meta.tabUrl || '',
        pageTimings: {}
      }],
      entries: entries.map(e => ({
        startedDateTime: new Date(e.capturedAt || meta.startTime || Date.now()).toISOString(),
        time: e.duration || 0,
        request: {
          method: e.method || 'GET',
          url: e.url || '',
          httpVersion: 'HTTP/1.1',
          cookies: (e.requestCookies || []).map(c => ({ name: c.name, value: c.value })),
          headers: Object.entries(e.requestHeaders || {}).map(([n, v]) => ({ name: n, value: String(v) })),
          queryString: Object.entries(e.queryParams || {}).map(([n, v]) => ({ name: n, value: String(v) })),
          postData: e.postData ? { mimeType: 'application/json', text: e.postData } : undefined,
          headersSize: -1,
          bodySize: e.postData ? e.postData.length : 0
        },
        response: {
          status: e.responseStatus || 0,
          statusText: e.responseStatusText || '',
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: Object.entries(e.responseHeaders || {}).map(([n, v]) => ({ name: n, value: String(v) })),
          content: {
            size: e.responseBody ? e.responseBody.length : 0,
            mimeType: e.responseMimeType || '',
            text: e.responseBody || ''
          },
          redirectURL: '',
          headersSize: -1,
          bodySize: e.encodedDataLength || 0
        },
        cache: {},
        timings: { send: 0, wait: e.duration || 0, receive: 0 },
        _category: e.category,
        pageref: 'page_1'
      }))
    }
  };
  return JSON.stringify(har, null, 2);
}

function buildCsv(entries) {
  const headers = ['#','time','method','status','category','host','path','duration_ms','bytes','url'];
  const lines = [headers.join(',')];
  entries.forEach((e, i) => {
    lines.push([
      i + 1,
      new Date(e.capturedAt || 0).toISOString(),
      e.method || '',
      e.failed ? 'ERR' : (e.responseStatus || ''),
      e.category || '',
      e.hostname || '',
      e.pathname || '',
      e.duration ? Math.round(e.duration) : '',
      e.encodedDataLength || '',
      `"${(e.url || '').replace(/"/g, '""')}"`
    ].join(','));
  });
  return lines.join('\n');
}

function buildIndexHtml(meta, entries, scripts, consoleLogs) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${meta.tabTitle || 'DevTools Capture'} — Details of a Web Feature</title>
  <style>
    body { font: 13px/1.5 -apple-system, Segoe UI, Roboto, sans-serif; padding: 24px; background: #0f172a; color: #f8fafc; }
    h1 { font-size: 22px; color: #60a5fa; margin: 0 0 4px; }
    .meta { font-size: 12px; color: #94a3b8; margin-bottom: 20px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .card { background: #1e293b; padding: 12px 16px; border-radius: 8px; border: 1px solid #334155; }
    .card .val { font-size: 20px; font-weight: bold; color: #38bdf8; }
    .card .lbl { font-size: 11px; color: #94a3b8; margin-top: 2px; }
    .section-title { font-size: 15px; font-weight: 600; margin: 24px 0 10px; color: #e2e8f0; border-bottom: 1px solid #334155; padding-bottom: 6px; }
    table { border-collapse: collapse; width: 100%; background: #1e293b; border-radius: 8px; overflow: hidden; border: 1px solid #334155; margin-bottom: 20px; }
    td, th { padding: 8px 12px; text-align: left; font-size: 12px; border-bottom: 1px solid #334155; }
    th { background: #0b1120; color: #94a3b8; font-size: 11px; text-transform: uppercase; }
    tr:hover td { background: #243048; }
    .url { font-family: ui-monospace, monospace; max-width: 500px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    a { color: #38bdf8; text-decoration: none; }
  </style>
</head>
<body>
  <h1>🌐 Details of a Web Feature — Full DevTools Snapshot</h1>
  <div class="meta">Target: <b>${meta.tabUrl || '-'}</b> &bull; Captured: ${new Date(meta.startTime||0).toLocaleString()} &rarr; ${new Date(meta.endTime||Date.now()).toLocaleString()}</div>
  <div class="grid">
    <div class="card"><div class="val">${entries.length}</div><div class="lbl">Network Requests</div></div>
    <div class="card"><div class="val">${scripts.length}</div><div class="lbl">Parsed JavaScript Files</div></div>
    <div class="card"><div class="val">${consoleLogs.length}</div><div class="lbl">Console Messages</div></div>
    <div class="card"><div class="val">${meta.bytes ? (meta.bytes / (1024*1024)).toFixed(2) + ' MB' : '0 MB'}</div><div class="lbl">Total Transferred</div></div>
  </div>

  <div class="section-title">📦 Folder Contents in this Archive</div>
  <ul>
    <li><b><code>elements/</code></b>: Full rendered DOM (<code>page.html</code>) and meta tag tree</li>
    <li><b><code>sources/scripts/</code></b>: ${scripts.length} captured JavaScript files and bundles</li>
    <li><b><code>memory_and_storage/</code></b>: LocalStorage, SessionStorage, Cookies, Globals, and Next.js State</li>
    <li><b><code>console/</code></b>: Captured Console logs, warnings, and error backtraces</li>
    <li><b><code>network/</code></b>: All network requests, payloads, HAR, and CSV exports</li>
  </ul>
</body>
</html>`;
}

async function buildBlob({ scope, format, ts, entries, scripts, consoleLogs, domSnapshot, storageSnapshot, meta }) {
  const files = [];

  // Master Summary & Report
  files.push({
    name: 'summary.json',
    data: enc.encode(JSON.stringify({
      meta,
      counts: {
        networkRequests: entries.length,
        scripts: scripts.length,
        consoleLogs: consoleLogs.length
      },
      generatedAt: new Date().toISOString()
    }, null, 2))
  });

  files.push({
    name: 'report.txt',
    data: enc.encode([
      `============================================================`,
      `Details of a Web Feature — Full DevTools Capture Report`,
      `============================================================`,
      `Target URL           : ${meta.tabUrl || '-'}`,
      `Target Title         : ${meta.tabTitle || '-'}`,
      `Capture Started      : ${meta.startTime ? new Date(meta.startTime).toISOString() : '-'}`,
      `Capture Ended        : ${meta.endTime ? new Date(meta.endTime).toISOString() : '-'}`,
      `Total Network Items  : ${entries.length}`,
      `Total Script Sources : ${scripts.length}`,
      `Total Console Logs   : ${consoleLogs.length}`,
      `Transferred Data     : ${(meta.bytes ? (meta.bytes / (1024*1024)).toFixed(2) + ' MB' : '0 MB')}`,
      `============================================================`
    ].join('\n'))
  });

  files.push({
    name: 'index.html',
    data: enc.encode(buildIndexHtml(meta, entries, scripts, consoleLogs))
  });

  // 1. ELEMENTS (DOM)
  if (domSnapshot?.outerHTML) {
    files.push({ name: 'elements/page.html', data: enc.encode(domSnapshot.outerHTML) });
    files.push({ name: 'elements/dom_metadata.json', data: enc.encode(JSON.stringify(domSnapshot, null, 2)) });
  }

  // 2. SOURCES (All Parsed JavaScript files)
  const scriptsManifest = [];
  for (let i = 0; i < scripts.length; i++) {
    const s = scripts[i];
    const idx = pad(i + 1, 4);
    let sname = 'script';
    try {
      const u = new URL(s.url);
      sname = safe(u.pathname.split('/').pop() || 'script', 30);
    } catch {
      sname = safe(s.url || 'inline', 30);
    }
    if (!sname.endsWith('.js')) sname += '.js';
    const filePath = `sources/scripts/${idx}_${sname}`;
    files.push({ name: filePath, data: enc.encode(s.source || '') });
    scriptsManifest.push({ id: s.id, url: s.url, path: filePath, length: s.length });
  }
  files.push({ name: 'sources/scripts_manifest.json', data: enc.encode(JSON.stringify(scriptsManifest, null, 2)) });

  // 3. MEMORY & STORAGE (LocalStorage, SessionStorage, Cookies, Globals, Memory metrics)
  if (storageSnapshot) {
    if (storageSnapshot.localStorage) {
      files.push({ name: 'memory_and_storage/local_storage.json', data: enc.encode(JSON.stringify(storageSnapshot.localStorage, null, 2)) });
    }
    if (storageSnapshot.sessionStorage) {
      files.push({ name: 'memory_and_storage/session_storage.json', data: enc.encode(JSON.stringify(storageSnapshot.sessionStorage, null, 2)) });
    }
    if (storageSnapshot.cookies) {
      files.push({ name: 'memory_and_storage/cookies.txt', data: enc.encode(storageSnapshot.cookies) });
    }
    if (storageSnapshot.nextData) {
      files.push({ name: 'memory_and_storage/next_data.json', data: enc.encode(JSON.stringify(storageSnapshot.nextData, null, 2)) });
    }
    if (storageSnapshot.customGlobals) {
      files.push({ name: 'memory_and_storage/window_custom_globals.json', data: enc.encode(JSON.stringify(storageSnapshot.customGlobals, null, 2)) });
    }
    if (storageSnapshot.memory) {
      files.push({ name: 'memory_and_storage/js_heap_memory.json', data: enc.encode(JSON.stringify(storageSnapshot.memory, null, 2)) });
    }
  }

  // 4. CONSOLE LOGS
  if (consoleLogs.length) {
    files.push({ name: 'console/console_logs.json', data: enc.encode(JSON.stringify(consoleLogs, null, 2)) });
    const logText = consoleLogs.map(l => `[${new Date(l.timestamp).toLocaleTimeString()}] [${l.level.toUpperCase()}] ${l.text} ${l.url ? '(' + l.url + ':' + l.line + ')' : ''}`).join('\n');
    files.push({ name: 'console/console_logs.txt', data: enc.encode(logText) });
  }

  // 5. NETWORK
  files.push({ name: 'network/all_requests.json', data: enc.encode(JSON.stringify(entries, null, 2)) });
  files.push({ name: 'network/capture.har', data: enc.encode(buildHar(entries, meta)) });
  files.push({ name: 'network/capture.csv', data: enc.encode(buildCsv(entries)) });

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const idx = pad(i + 1, 5);
    const host = safe(e.hostname || 'unknown', 24);
    const method = safe(e.method || 'GET', 6);
    files.push({
      name: `network/requests/${idx}_${host}_${method}.json`,
      data: enc.encode(JSON.stringify(e, null, 2))
    });
    if (e.responseBody) {
      const ext = (e.category || '').toLowerCase().includes('json') ? 'json' : 'txt';
      files.push({
        name: `network/bodies/${idx}_${host}.${ext}`,
        data: enc.encode(e.responseBody)
      });
    }
  }

  const zipBytes = NCPZip.create(files);
  const blob = new Blob([zipBytes], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const filename = `details_of_web_${ts}.zip`;

  return { ok: true, url, filename };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;
  if (msg.type === 'REVOKE_URL') {
    try { URL.revokeObjectURL(msg.url); } catch {}
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'BUILD_AND_DOWNLOAD') {
    (async () => {
      try {
        const r = await buildBlob(msg);
        sendResponse(r);
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }
});
