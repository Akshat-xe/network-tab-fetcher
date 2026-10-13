// Offscreen worker — receives entries from background, builds blobs, triggers downloads.

const enc = new TextEncoder();

function safe(s, n = 80) {
  return String(s ?? '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, n) || 'x';
}
function pad(i, w) { return String(i).padStart(w, '0'); }

function extFromMime(mime, ct) {
  const m = (mime || ct || '').toLowerCase();
  if (m.includes('json')) return 'json';
  if (m.includes('html')) return 'html';
  if (m.includes('xml'))  return 'xml';
  if (m.includes('javascript')) return 'js';
  if (m.includes('css'))  return 'css';
  if (m.includes('plain')) return 'txt';
  if (m.includes('png'))  return 'png';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('gif'))  return 'gif';
  if (m.includes('webp')) return 'webp';
  if (m.includes('svg'))  return 'svg';
  if (m.includes('pdf'))  return 'pdf';
  if (m.includes('font') || m.includes('woff')) return 'woff';
  if (m.includes('octet')) return 'bin';
  return 'bin';
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function csvEscape(s) {
  if (s === null || s === undefined) return '';
  const v = String(s);
  if (/[",\n\r]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}

function buildHar(entries, meta) {
  const har = {
    log: {
      version: '1.2',
      creator: { name: 'Network Tab Fetcher', version: '2.0.0' },
      pages: [{
        startedDateTime: new Date(meta.startTime || Date.now()).toISOString(),
        id: 'page_1',
        title: meta.tabUrl || '',
        pageTimings: {}
      }],
      entries: entries.map((e) => {
        const reqHeaders = Object.entries(e.requestHeadersFull || e.requestHeaders || {})
          .map(([n, v]) => ({ name: n, value: String(v) }));
        const resHeaders = Object.entries(e.responseHeadersFull || e.responseHeaders || {})
          .map(([n, v]) => ({ name: n, value: String(v) }));
        const queryString = Object.entries(e.queryParams || {}).flatMap(([n, v]) =>
          Array.isArray(v) ? v.map(vv => ({ name: n, value: String(vv) })) : [{ name: n, value: String(v) }]
        );
        const cookies = (e.requestCookies || []).map(c => ({ name: c.name, value: c.value }));
        const setCookies = (e.responseCookies || []).map(c => ({
          name: c.name, value: c.value, path: c.path, domain: c.domain,
          expires: c.expires, httpOnly: !!c.httpOnly, secure: !!c.secure
        }));
        const postData = e.postData ? {
          mimeType: (e.requestHeaders && (e.requestHeaders['content-type'] || e.requestHeaders['Content-Type'])) || 'application/octet-stream',
          text: e.postData,
          params: e.postDataForm
            ? Object.entries(e.postDataForm).map(([n, v]) => ({ name: n, value: String(v) }))
            : undefined
        } : undefined;

        return {
          startedDateTime: new Date(e.capturedAt || meta.startTime || Date.now()).toISOString(),
          time: e.duration || 0,
          request: {
            method: e.method || 'GET',
            url: e.url || '',
            httpVersion: e.protocol || 'HTTP/1.1',
            cookies,
            headers: reqHeaders,
            queryString,
            postData,
            headersSize: -1,
            bodySize: e.postData ? e.postData.length : 0
          },
          response: {
            status: e.responseStatus || 0,
            statusText: e.responseStatusText || '',
            httpVersion: e.protocol || 'HTTP/1.1',
            cookies: setCookies,
            headers: resHeaders,
            content: {
              size: e.responseBodySize || 0,
              mimeType: e.responseMimeType || '',
              text: e.responseBody || '',
              encoding: e.responseBase64Encoded ? 'base64' : undefined
            },
            redirectURL: '',
            headersSize: -1,
            bodySize: e.encodedDataLength || 0
          },
          cache: {},
          timings: e.responseTiming || { send: 0, wait: e.duration || 0, receive: 0 },
          serverIPAddress: e.remoteAddress ? e.remoteAddress.split(':')[0] : undefined,
          _category: e.category,
          _resourceType: e.resourceType,
          pageref: 'page_1'
        };
      })
    }
  };
  return JSON.stringify(har, null, 2);
}

function buildCsv(entries) {
  const headers = [
    '#','time','method','status','category','type','host','path','duration_ms','bytes',
    'mime','remote','request_cookies','response_set_cookies','url'
  ];
  const lines = [headers.join(',')];
  entries.forEach((e, i) => {
    lines.push([
      i + 1,
      new Date(e.capturedAt || 0).toISOString(),
      e.method || '',
      e.failed ? 'ERR' : (e.responseStatus || ''),
      e.category || '',
      e.resourceType || '',
      e.hostname || '',
      e.pathname || '',
      e.duration ? Math.round(e.duration) : '',
      e.encodedDataLength || '',
      e.responseMimeType || '',
      e.remoteAddress || '',
      (e.requestCookies || []).map(c => `${c.name}=${c.value}`).join('; '),
      (e.responseCookies || []).map(c => c.name).join('; '),
      e.url || ''
    ].map(csvEscape).join(','));
  });
  return lines.join('\n');
}

function buildIndexHtml(entries, meta) {
  const rows = entries.map((e, i) => {
    const status = e.failed ? `<span style="color:#ef4444;font-weight:600">ERR ${e.errorText || ''}</span>`
                            : `<span style="color:${(e.responseStatus||0) >= 400 ? '#ef4444' : '#10b981'};font-weight:600">${e.responseStatus || '…'}</span>`;
    const catClass = safe(e.category || 'Other').toLowerCase();
    return `<tr>
      <td>${i + 1}</td>
      <td><b>${e.method || 'GET'}</b></td>
      <td>${status}</td>
      <td><span class="badge ${catClass}">${e.category || e.resourceType || ''}</span></td>
      <td class="url-cell" title="${(e.url || '').replace(/"/g,'&quot;')}">${(e.hostname || '') + (e.pathname || '')}</td>
      <td>${e.duration ? Math.round(e.duration) + 'ms' : ''}</td>
      <td>${e.encodedDataLength ? (e.encodedDataLength > 1024 ? (e.encodedDataLength/1024).toFixed(1) + ' KB' : e.encodedDataLength + ' B') : ''}</td>
      <td><a href="requests/${pad(i+1,5)}_${safe((e.hostname||'x'),24)}_${safe(e.method||'GET',6)}.json">JSON</a></td>
    </tr>`;
  }).join('');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Network Tab Fetcher — ${new Date(meta.startTime||Date.now()).toLocaleString()}</title>
  <style>
    body { font: 13px/1.5 -apple-system, Segoe UI, Roboto, sans-serif; padding: 24px; background: #0f172a; color: #f8fafc; }
    h1 { font-size: 20px; margin: 0 0 4px; color: #60a5fa; }
    .meta { font-size: 12px; color: #94a3b8; margin-bottom: 20px; }
    .card-grid { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
    .card { background: #1e293b; padding: 10px 16px; border-radius: 6px; border: 1px solid #334155; }
    .card .val { font-size: 18px; font-weight: bold; color: #38bdf8; }
    .card .lbl { font-size: 11px; color: #94a3b8; }
    table { border-collapse: collapse; width: 100%; background: #1e293b; border-radius: 8px; overflow: hidden; border: 1px solid #334155; }
    td, th { padding: 8px 12px; text-align: left; font-size: 12px; border-bottom: 1px solid #334155; }
    th { background: #0f172a; color: #94a3b8; font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; }
    tr:hover td { background: #243048; }
    .url-cell { font-family: ui-monospace, Consolas, monospace; max-width: 480px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge { padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; background: #334155; color: #cbd5e1; }
    .badge.fetch_xhr { background: #0369a1; color: #e0f2fe; }
    .badge.media { background: #7c2d12; color: #ffedd5; }
    .badge.javascript { background: #854d0e; color: #fef08a; }
    .badge.css { background: #1e3a8a; color: #dbeafe; }
    .badge.image { background: #065f46; color: #d1fae5; }
    .badge.websocket { background: #581c87; color: #f3e8ff; }
    a { color: #38bdf8; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>🌐 Network Tab Fetcher Report</h1>
  <div class="meta">
    Target: <b>${meta.tabUrl || 'Active Page'}</b> &bull; Captured: ${new Date(meta.startTime||0).toLocaleString()} &rarr; ${new Date(meta.endTime||Date.now()).toLocaleString()}
  </div>
  <div class="card-grid">
    <div class="card"><div class="val">${entries.length}</div><div class="lbl">Total Requests</div></div>
    <div class="card"><div class="val">${(meta.bytes ? (meta.bytes / (1024*1024)).toFixed(2) + ' MB' : '0 MB')}</div><div class="lbl">Total Transferred</div></div>
    <div class="card"><div class="val">${meta.categories?.['Fetch/XHR'] || 0}</div><div class="lbl">Fetch / XHR APIs</div></div>
    <div class="card"><div class="val">${meta.categories?.['Media'] || 0}</div><div class="lbl">Media Streams</div></div>
    <div class="card"><div class="val">${meta.categories?.['WebSocket'] || 0}</div><div class="lbl">WebSockets</div></div>
  </div>
  <table>
    <thead>
      <tr><th>#</th><th>Method</th><th>Status</th><th>Category</th><th>URL</th><th>Time</th><th>Size</th><th>Raw</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}

async function buildBlob({ format, ts, entries, meta }) {
  let url, filename, mime;
  const total = entries.length;

  if (format === 'json') {
    const payload = JSON.stringify({ meta, requests: entries }, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    url = URL.createObjectURL(blob);
    filename = `network_capture_${ts}.json`;
    mime = 'application/json';
  } else if (format === 'har') {
    const har = buildHar(entries, meta);
    const blob = new Blob([har], { type: 'application/json' });
    url = URL.createObjectURL(blob);
    filename = `network_capture_${ts}.har`;
    mime = 'application/json';
  } else if (format === 'csv') {
    const csv = buildCsv(entries);
    const blob = new Blob([csv], { type: 'text/csv' });
    url = URL.createObjectURL(blob);
    filename = `network_capture_${ts}.csv`;
    mime = 'text/csv';
  } else {
    // ZIP — Organized with master files + categorized directories
    const files = [];

    // Master files
    files.push({ name: 'summary.json', data: enc.encode(JSON.stringify({
      meta, count: total, generatedAt: new Date().toISOString()
    }, null, 2)) });

    files.push({ name: 'all_requests.json', data: enc.encode(JSON.stringify(entries, null, 2)) });
    files.push({ name: 'capture.har', data: enc.encode(buildHar(entries, meta)) });
    files.push({ name: 'capture.csv', data: enc.encode(buildCsv(entries)) });
    files.push({ name: 'index.html', data: enc.encode(buildIndexHtml(entries, meta)) });

    files.push({ name: 'report.txt', data: enc.encode([
      `============================================================`,
      `Network Tab Fetcher — Session Capture Report`,
      `============================================================`,
      `Target URL           : ${meta.tabUrl || '-'}`,
      `Total Requests       : ${total}`,
      `Total Data           : ${(meta.bytes ? (meta.bytes / (1024*1024)).toFixed(2) + ' MB' : '0 MB')}`,
      `Capture Started      : ${meta.startTime ? new Date(meta.startTime).toISOString() : '-'}`,
      `Capture Ended        : ${meta.endTime ? new Date(meta.endTime).toISOString() : '-'}`,
      `Elapsed Seconds      : ${meta.startTime && meta.endTime ? ((meta.endTime - meta.startTime)/1000).toFixed(2) : '-'}`,
      `------------------------------------------------------------`,
      `Category Breakdown:`,
      `  • Fetch / XHR APIs : ${meta.categories?.['Fetch/XHR'] || 0}`,
      `  • Documents (HTML) : ${meta.categories?.['Document'] || 0}`,
      `  • JavaScript Files : ${meta.categories?.['JavaScript'] || 0}`,
      `  • CSS Stylesheets  : ${meta.categories?.['CSS'] || 0}`,
      `  • Images           : ${meta.categories?.['Image'] || 0}`,
      `  • Media (HLS/Video): ${meta.categories?.['Media'] || 0}`,
      `  • Fonts            : ${meta.categories?.['Font'] || 0}`,
      `  • WebSockets       : ${meta.categories?.['WebSocket'] || 0}`,
      `  • WebAssembly      : ${meta.categories?.['Wasm'] || 0}`,
      `  • Manifests        : ${meta.categories?.['Manifest'] || 0}`,
      `  • Others           : ${meta.categories?.['Other'] || 0}`,
      `============================================================`,
      ``
    ].join('\n')) });

    // Cookies
    const allReqCookies = [];
    const allResCookies = [];
    for (const e of entries) {
      for (const c of (e.requestCookies || [])) allReqCookies.push({ url: e.url, ...c });
      for (const c of (e.responseCookies || [])) allResCookies.push({ url: e.url, ...c });
    }
    files.push({ name: 'cookies/request_cookies.json', data: enc.encode(JSON.stringify(allReqCookies, null, 2)) });
    files.push({ name: 'cookies/response_cookies.json', data: enc.encode(JSON.stringify(allResCookies, null, 2)) });

    // Categorized lists
    const fetchXhrList = [];
    const mediaList = [];
    const wsFrames = [];

    // Per-request files
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const idx = pad(i + 1, 5);
      const host = safe(e.hostname || 'unknown', 24);
      const method = safe(e.method || 'GET', 6);
      const base = `requests/${idx}_${host}_${method}`;

      // Master detail file
      files.push({
        name: `${base}.json`,
        data: enc.encode(JSON.stringify(e, null, 2))
      });

      // Categorized sorting
      const cat = (e.category || 'Other').toLowerCase();
      let catFolder = 'categories/other';
      if (cat.includes('fetch') || cat.includes('xhr')) {
        catFolder = 'categories/fetch_xhr';
        fetchXhrList.push({
          index: i + 1,
          method: e.method,
          url: e.url,
          status: e.responseStatus,
          requestBody: e.postDataJson || e.postDataForm || e.postData,
          responseBody: e.responseBody
        });
      } else if (cat.includes('media')) {
        catFolder = 'categories/media';
        mediaList.push({
          index: i + 1,
          url: e.url,
          size: e.encodedDataLength,
          duration: e.duration
        });
      } else if (cat.includes('script') || cat.includes('javascript')) {
        catFolder = 'categories/scripts';
      } else if (cat.includes('css') || cat.includes('stylesheet')) {
        catFolder = 'categories/stylesheets';
      } else if (cat.includes('image')) {
        catFolder = 'categories/images';
      } else if (cat.includes('font')) {
        catFolder = 'categories/fonts';
      } else if (cat.includes('doc')) {
        catFolder = 'categories/documents';
      } else if (cat.includes('socket')) {
        catFolder = 'categories/websockets';
        if (e.frames && e.frames.length) wsFrames.push({ url: e.url, frames: e.frames });
      } else if (cat.includes('wasm')) {
        catFolder = 'categories/wasm';
      }

      // Add to category folder
      files.push({
        name: `${catFolder}/${idx}_${host}_${method}.json`,
        data: enc.encode(JSON.stringify(e, null, 2))
      });

      // Raw response body
      if (e.responseBody) {
        const ext = extFromMime(e.responseMimeType, (e.responseHeadersFull && (e.responseHeadersFull['content-type'] || e.responseHeadersFull['Content-Type'])) || '');
        const bodyName = `bodies/${idx}_${host}.${ext}`;
        if (e.responseBase64Encoded) {
          try { files.push({ name: bodyName, data: b64ToBytes(e.responseBody) }); }
          catch { files.push({ name: bodyName + '.b64', data: enc.encode(e.responseBody) }); }
        } else {
          files.push({ name: bodyName, data: enc.encode(e.responseBody) });
        }
      }

      // Raw post body
      if (e.postData) {
        files.push({ name: `post_data/${idx}_${host}.txt`, data: enc.encode(e.postData) });
      }
    }

    if (fetchXhrList.length) {
      files.push({ name: 'categories/fetch_xhr/all_apis_summary.json', data: enc.encode(JSON.stringify(fetchXhrList, null, 2)) });
    }
    if (mediaList.length) {
      files.push({ name: 'categories/media/all_media_segments.json', data: enc.encode(JSON.stringify(mediaList, null, 2)) });
    }
    if (wsFrames.length) {
      files.push({ name: 'categories/websockets/all_frames.json', data: enc.encode(JSON.stringify(wsFrames, null, 2)) });
    }

    const zipBytes = NCPZip.create(files);
    const blob = new Blob([zipBytes], { type: 'application/zip' });
    url = URL.createObjectURL(blob);
    filename = `network_capture_${ts}.zip`;
    mime = 'application/zip';
  }

  return { ok: true, url, filename, mime };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;
  if (msg.type === 'REVOKE_URL') {
    try { URL.revokeObjectURL(msg.url); } catch {}
    sendResponse({ ok: true });
    return;
  }
  if (msg.type !== 'BUILD_AND_DOWNLOAD') return;
  (async () => {
    try {
      const r = await buildBlob(msg);
      sendResponse({ ok: true, url: r.url, filename: r.filename, mime: r.mime });
    } catch (e) {
      console.error('[offscreen] build error', e);
      sendResponse({ ok: false, error: e && e.message || String(e) });
    }
  })();
  return true;
});
