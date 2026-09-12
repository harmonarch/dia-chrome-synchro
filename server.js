'use strict';
// Bifröst 本地控制台服务：REST API + 静态前端 + 内置调度器。
// 建议通过 LaunchAgent 常驻运行（scripts/install-agent.sh），默认端口 8770。
const http = require('http');
const fs = require('fs');
const path = require('path');

const { loadConfig, saveConfig, loadState, saveState, dataDir } = require('./lib/config');
const { BROWSERS, otherOf, isRunning, quitBrowser, launchBrowser, openInBrowser, openInternalPage, browserProfileStatus } = require('./lib/paths');
const bookmarks = require('./lib/bookmarks');
const extensions = require('./lib/extensions');
const { runSync } = require('./lib/sync');
const { computeNextRun } = require('./lib/schedule');

const PORT = parseInt(process.env.PORT || '8770', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/** 组装完整状态（每次实时读盘，量小且文件读取廉价） */
function buildState() {
  const cfg = loadConfig();
  const state = loadState();
  const primaryKey = cfg.primary === 'dia' ? 'dia' : 'chrome';
  const secondaryKey = otherOf(primaryKey);
  const primary = BROWSERS[primaryKey];
  const secondary = BROWSERS[secondaryKey];

  const browsers = {};
  for (const key of ['dia', 'chrome']) {
    const status = browserProfileStatus(cfg, key);
    const parsed = bookmarks.readBookmarks(status.profileDir);
    let counts = null;
    if (parsed && parsed.roots) {
      counts = {};
      for (const rk of bookmarks.ROOT_KEYS) {
        if (parsed.roots[rk]) counts[rk] = bookmarks.countNodes(parsed.roots[rk]);
      }
    }
    let exts = [];
    try { exts = extensions.scanProfile(status.profileDir); } catch { exts = []; }
    browsers[key] = { ...status, bookmarkCounts: counts, extensions: exts };
  }

  let bookmarkDiff = null;
  try {
    const src = bookmarks.readBookmarks(primary.profileDir(cfg));
    const tgt = bookmarks.readBookmarks(secondary.profileDir(cfg));
    if (src && tgt && src.roots && tgt.roots) {
      const d = bookmarks.diffTrees(src.roots, tgt.roots);
      bookmarkDiff = {
        counts: d.counts,
        samples: {
          added: d.added.slice(0, 8),
          removed: d.removed.slice(0, 8),
          changed: d.changed.slice(0, 8),
          moved: d.moved.slice(0, 8),
        },
      };
    }
  } catch { bookmarkDiff = null; }

  let extensionDiff = null;
  try {
    const ignoreSet = new Set((cfg.extensions && cfg.extensions.ignore) || []);
    extensionDiff = extensions.diffExtensions(browsers[primaryKey].extensions, browsers[secondaryKey].extensions, ignoreSet);
  } catch { extensionDiff = null; }

  return {
    config: cfg,
    primaryKey,
    secondaryKey,
    browsers,
    bookmarkDiff,
    extensionDiff,
    pendingExtensions: state.pendingExtensions || { install: {}, remove: {} },
    lastSync: state.lastSync,
    lastResult: state.lastResult,
    nextRun: state.nextRun,
    history: (state.history || []).slice(0, 24),
    dataDir: dataDir(),
    serverPort: PORT,
  };
}

const routes = {
  'GET /api/state': (req, res) => send(res, 200, buildState()),

  'POST /api/config': async (req, res) => {
    const body = await readBody(req);
    const patch = {};
    if (body.primary === 'dia' || body.primary === 'chrome') patch.primary = body.primary;
    if (['manual', 'hourly', 'daily', 'weekly'].includes(body.schedule)) patch.schedule = body.schedule;
    if (typeof body.scheduleTime === 'string' && /^\d{2}:\d{2}$/.test(body.scheduleTime)) patch.scheduleTime = body.scheduleTime;
    if (typeof body.scheduleDay === 'string' && /^(sun|mon|tue|wed|thu|fri|sat)$/.test(body.scheduleDay)) patch.scheduleDay = body.scheduleDay;
    if (typeof body.autoQuitForBookmarks === 'boolean') patch.autoQuitForBookmarks = body.autoQuitForBookmarks;
    if (Array.isArray(body.ignoreAdd) || Array.isArray(body.ignoreRemove)) {
      const cfg = loadConfig();
      const set = new Set(cfg.extensions.ignore || []);
      (body.ignoreAdd || []).forEach((i) => set.add(i));
      (body.ignoreRemove || []).forEach((i) => set.delete(i));
      patch.extensions = { ...cfg.extensions, ignore: [...set] };
    }
    const cfg = saveConfig(patch);
    const state = loadState();
    state.nextRun = computeNextRun(cfg, state.lastSync);
    saveState(state);
    send(res, 200, { ok: true, config: cfg, nextRun: state.nextRun });
  },

  'POST /api/sync': async (req, res) => {
    const body = await readBody(req);
    const result = runSync({ trigger: 'manual', applyBookmarks: body.applyBookmarks !== false });
    send(res, 200, result);
  },

  'POST /api/quit-browser': async (req, res) => {
    const body = await readBody(req);
    if (!BROWSERS[body.browser]) return send(res, 400, { ok: false, error: '未知浏览器' });
    const ok = quitBrowser(body.browser);
    send(res, 200, { ok, running: isRunning(body.browser) });
  },

  'POST /api/launch-browser': async (req, res) => {
    const body = await readBody(req);
    if (!BROWSERS[body.browser]) return send(res, 400, { ok: false, error: '未知浏览器' });
    send(res, 200, { ok: launchBrowser(body.browser) });
  },

  'POST /api/open-store': async (req, res) => {
    const body = await readBody(req);
    if (!BROWSERS[body.browser] || !Array.isArray(body.ids)) return send(res, 400, { ok: false, error: '参数错误' });
    const results = body.ids.map((id) => ({ id, ok: openInBrowser(body.browser, extensions.STORE_URL(id)) }));
    send(res, 200, { ok: results.every((r) => r.ok), results });
  },

  'POST /api/open-extensions-page': async (req, res) => {
    const body = await readBody(req);
    if (!BROWSERS[body.browser]) return send(res, 400, { ok: false, error: '未知浏览器' });
    const viaAppleScript = openInternalPage(body.browser, 'chrome://extensions/');
    if (viaAppleScript) return send(res, 200, { ok: true, method: 'applescript' });
    const viaOpen = openInBrowser(body.browser, 'chrome://extensions/');
    send(res, 200, { ok: viaOpen, method: viaOpen ? 'open' : 'failed' });
  },
};

const server = http.createServer(async (req, res) => {
  const route = `${req.method} ${req.url.split('?')[0]}`;
  try {
    if (routes[route]) return await routes[route](req, res);

    // 静态文件
    if (req.method === 'GET') {
      const rel = req.url === '/' ? '/index.html' : req.url.split('?')[0];
      const file = path.normalize(path.join(PUBLIC_DIR, rel));
      if (file.startsWith(PUBLIC_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const type = MIME[path.extname(file)] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        return fs.createReadStream(file).pipe(res);
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
});

// ---- 调度器：每 30s 检查一次是否到达 nextRun ----
function tick() {
  try {
    const cfg = loadConfig();
    if (cfg.schedule === 'manual') return;
    const state = loadState();
    const next = state.nextRun || computeNextRun(cfg, state.lastSync);
    if (!next) return;
    if (new Date(next).getTime() <= Date.now()) {
      runSync({ trigger: 'scheduled' });
    }
  } catch (e) {
    console.error('[scheduler]', e.message);
  }
}
setInterval(tick, 30 * 1000);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Bifröst 控制台: http://127.0.0.1:${PORT}`);
  console.log(`数据目录: ${dataDir()}`);
});
