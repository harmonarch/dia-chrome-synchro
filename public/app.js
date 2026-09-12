'use strict';
/* Bifröst 前端：轮询 /api/state，渲染控制台；所有写操作都有乐观 UI + 失败回滚。 */

const $ = (s) => document.querySelector(s);
const state = {
  data: null,
  syncing: false,
  openGroups: new Set(),      // 展开的差异分组 key
  openDisclosures: new Set(), // 插件面板展开的 disclosure key
};

const SCHEDULE_LABEL = { manual: '手动', hourly: '每小时', daily: '每天', weekly: '每周' };
const WEEKDAYS = [['mon', '一'], ['tue', '二'], ['wed', '三'], ['thu', '四'], ['fri', '五'], ['sat', '六'], ['sun', '日']];

/* ---------------- 工具 ---------------- */
async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = 'toast';
  if (kind === 'error') el.style.background = 'linear-gradient(160deg, oklch(0.42 0.13 25 / 0.94), oklch(0.35 0.11 25 / 0.94))';
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.classList.add('gone'), 3600);
  setTimeout(() => el.remove(), 4200);
}

function timeAgo(iso) {
  if (!iso) return '尚未同步';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtNext(iso) {
  if (!iso) return '—';
  const t = new Date(iso);
  const diffMin = Math.round((t.getTime() - Date.now()) / 60000);
  const hhmm = t.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (diffMin <= 0) return '即将进行';
  if (diffMin < 60) return `今天 ${hhmm}（${diffMin} 分钟后）`;
  if (diffMin < 60 * 24) return `今天 ${hhmm}`;
  return `${t.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })} ${hhmm}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const TILE_COLORS = ['oklch(0.62 0.14 30)', 'oklch(0.55 0.1 195)', 'oklch(0.6 0.12 70)', 'oklch(0.52 0.09 250)', 'oklch(0.58 0.12 150)', 'oklch(0.55 0.11 320)'];
function tileColor(id) { return TILE_COLORS[parseInt(id.slice(0, 2), 16) % TILE_COLORS.length] || TILE_COLORS[0]; }

/* ---------------- 渲染 ---------------- */
function render() {
  const d = state.data;
  if (!d) return;
  const primary = d.primaryKey;
  const secondary = d.secondaryKey;
  const pB = d.browsers[primary], sB = d.browsers[secondary];

  // 顶栏状态
  $('#statusText').textContent = state.syncing
    ? '正在同步…'
    : `${d.lastSync ? `上次同步 ${timeAgo(d.lastSync)}` : '尚未同步'} · ${SCHEDULE_LABEL[d.config.schedule]}`;
  $('#syncDot').className = 'pulse-dot' + (state.syncing ? ' busy' : '');

  // 浏览器 chips
  const statLine = (b) => {
    if (!b.bookmarksReadable) return '书签不可读';
    const c = b.bookmarkCounts || {};
    const urls = (c.bookmark_bar?.urls || 0) + (c.other?.urls || 0) + (c.synced?.urls || 0);
    return `${b.running ? '● 运行中' : '○ 未运行'} · ${urls} 书签 · ${b.extensions.filter((e) => !e.builtin).length} 插件`;
  };
  $('#diaStat').textContent = statLine(d.browsers.dia);
  $('#chromeStat').textContent = statLine(d.browsers.chrome);
  for (const chip of document.querySelectorAll('.browser-chip')) {
    chip.classList.toggle('active', chip.dataset.browser === primary);
    chip.setAttribute('aria-pressed', chip.dataset.browser === primary);
  }
  // 芯片固定顺序：Dia 在左、Chrome 在右；箭头只表达流向
  $('#flowDir').textContent = primary === 'dia' ? '→' : '←';
  $('.flow').classList.toggle('reverse', primary === 'chrome');
  $('#directionHint').textContent =
    `以 ${d.browsers[primary].label} 为基准：书签将镜像写入 ${d.browsers[secondary].label}；插件缺失的引导安装、多余的引导移除。`;

  // 频率分段
  renderSchedule(d.config);

  // 书签面板
  renderBookmarks(d, sB);
  // 插件面板
  renderExtensions(d, primary, secondary);
  // 历史
  renderHistory(d);
  updateRunningBanner();
}

function renderSchedule(cfg) {
  const seg = $('#scheduleSeg');
  const idx = ['manual', 'hourly', 'daily', 'weekly'].indexOf(cfg.schedule);
  seg.querySelectorAll('button').forEach((b, i) => {
    b.classList.toggle('on', i === idx);
    b.setAttribute('aria-selected', i === idx);
  });
  seg.querySelector('.seg-thumb').style.transform = `translateX(${idx * 100}%)`;

  const detail = $('#scheduleDetail');
  const showDetail = cfg.schedule === 'daily' || cfg.schedule === 'weekly';
  detail.hidden = !showDetail;
  if (showDetail) {
    $('#timeRow').style.display = cfg.schedule === 'hourly' ? 'none' : 'flex';
    $('#dayRow').hidden = cfg.schedule !== 'weekly';
    const timeSel = $('#timeSelect');
    if (timeSel.value !== cfg.scheduleTime) timeSel.value = cfg.scheduleTime;
    dayRow.querySelectorAll('button[data-day]').forEach((b) => {
      b.classList.toggle('on', b.dataset.day === cfg.scheduleDay);
    });
  }
  $('#nextRun').innerHTML = cfg.schedule === 'manual'
    ? '手动模式：仅在你点击「立即同步」时执行'
    : `下次同步：<b>${esc(fmtNext(state.data.nextRun))}</b>`;
}

/* 书签统计 + 分组差异 */
function renderBookmarks(d, secondaryBrowser) {
  const diff = d.bookmarkDiff;
  const counts = diff ? diff.counts : null;
  const total = counts ? counts.added + counts.removed + counts.changed + counts.moved : 0;

  $('#bookmarkSummary').textContent = diff
    ? (total === 0
        ? `与 ${d.browsers[d.secondaryKey].label} 完全一致`
        : `向 ${d.browsers[d.secondaryKey].label} 同步时的预期变更`)
    : '无法读取书签文件';

  const stats = $('#bookmarkStats');
  if (!diff) { stats.innerHTML = ''; }
  else if (total === 0) {
    stats.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <svg viewBox="0 0 34 34" fill="none"><circle cx="17" cy="17" r="15" stroke="currentColor" stroke-width="1.8"/><path d="M11 17.5l4 4 8-9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <p>两边的书签已经一致</p>
        <small>在任一浏览器增删书签后，这里会出现差异预览，点击「立即同步」即可镜像写入。</small>
      </div>`;
  } else {
    const defs = [
      ['add', 'added', '新增', counts.added],
      ['remove', 'removed', '移除', counts.removed],
      ['change', 'changed', '变更', counts.changed],
      ['move', 'moved', '移动/重命名', counts.moved],
    ];
    stats.innerHTML = defs.map(([key, k, label, n]) => `
      <button class="stat stat-${k} ${n === 0 ? 'zero' : ''}" data-group="${key}" type="button" ${n === 0 ? 'disabled' : ''}>
        <b>${n > 0 ? (k === 'remove' ? '−' : k === 'add' ? '+' : '') : ''}${n}</b><span>${label}</span>
      </button>`).join('');
    stats.querySelectorAll('.stat[data-group]').forEach((b) => {
      b.onclick = () => toggleGroup(b.dataset.group);
    });
  }
  renderBookmarkLists(diff, counts, total);

  const running = secondaryBrowser.running;
  $('#bookmarkFootText').textContent = total === 0
    ? `以 ${d.browsers[d.primaryKey].label} 为基准，差异会在下次同步时写入 ${d.browsers[d.secondaryKey].label}。`
    : running
      ? `写入需要退出 ${d.browsers[d.secondaryKey].label}（运行中会被浏览器覆盖）。每次写入前自动备份。`
      : `${d.browsers[d.secondaryKey].label} 当前未运行，点击「立即同步」即可安全写入。每次写入前自动备份到 data/backups/。`;
}

function toggleGroup(key) {
  if (state.openGroups.has(key)) state.openGroups.delete(key);
  else state.openGroups.add(key);
  render();
}

function renderBookmarkLists(diff, counts, total) {
  const wrap = $('#bookmarkLists');
  if (!diff || total === 0) { wrap.innerHTML = ''; return; }
  const groups = [
    ['add', 'added', '新增', diff.samples.added, (e) => `
      <span class="name">${esc(e.name)}</span>
      <span class="path">${esc((e.path || []).join(' / '))}</span>
      <span class="url">${esc(e.url)}</span>`],
    ['remove', 'removed', '移除', diff.samples.removed, (e) => `
      <span class="name">${esc(e.name)}</span>
      <span class="path">${esc((e.path || []).join(' / '))}</span>`],
    ['change', 'changed', '变更', diff.samples.changed, (e) => `
      <span class="name">${esc(e.name)}</span>
      <span class="fromto">${esc(e.oldName !== e.name ? `「${e.oldName}」→「${e.name}」` : esc(e.oldUrl || '') + ' → ' + esc(e.url))}</span>`],
    ['move', 'moved', '移动/重命名', diff.samples.moved, (e) => `
      <span class="name">${esc(e.name)}</span>
      <span class="fromto">${esc(e.from)} → ${esc(e.to)}</span>`],
  ];
  wrap.innerHTML = groups.filter(([key, , , items]) => items && items.length).map(([key, k, label, items, render]) => {
    const open = state.openGroups.has(key);
    return `
      <div class="diff-group glass" data-open="${open}" style="background:rgb(255 255 255 / 0.3)">
        <button class="ext-group-head" style="width:100%;border:0;background:transparent;cursor:pointer;font:inherit;padding:8px 12px 6px" data-toggle="${key}" type="button">
          <b>${label}</b><span>${counts[k]} 条${open ? ' · 收起' : ' · 展开'}</span>
        </button>
        <div class="diff-items">
          ${items.map((e, i) => `<div class="diff-item" style="animation-delay:${i * 40}ms">${render(e)}</div>`).join('')}
        </div>
      </div>`;
  }).join('');
  wrap.querySelectorAll('[data-toggle]').forEach((b) => {
    b.onclick = () => toggleGroup(b.dataset.toggle);
  });
}

/* 插件面板 */
function renderExtensions(d, primary, secondary) {
  const diff = d.extensionDiff;
  const targetLabel = d.browsers[secondary].label;
  const wrap = $('#extSections');

  if (!diff || diff.error) {
    $('#extensionSummary').textContent = '无法读取插件信息';
    wrap.innerHTML = '';
    return;
  }
  const c = diff.counts;
  const pendingInstall = Object.keys(d.pendingExtensions.install || {}).length;
  const pendingRemove = Object.keys(d.pendingExtensions.remove || {}).length;
  $('#extensionSummary').textContent =
    `${c.inSync} 个一致 · 待装 ${c.toInstall} · 待删 ${c.toRemove}${pendingInstall + pendingRemove ? ` · 待办 ${pendingInstall + pendingRemove} 项` : ''}`;

  if (c.toInstall + c.toRemove + c.toUpdate === 0) {
    wrap.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 34 34" fill="none"><circle cx="17" cy="17" r="15" stroke="currentColor" stroke-width="1.8"/><path d="M11 17.5l4 4 8-9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <p>两边的插件已对齐</p>
        <small>以下 ${c.inSync} 个插件两边一致：${diff.inSync.slice(0, 4).map((e) => esc(e.name)).join('、')}${c.inSync > 4 ? ' 等' : ''}</small>
      </div>
      ${renderIgnored(diff, c)}`;
    bindIgnored();
    return;
  }

  const rows = [];
  if (c.toInstall) {
    rows.push(`
      <section>
        <div class="ext-group-head"><b>${c.toInstall}</b><span>个插件在 ${esc(d.browsers[primary].label)} 有、${esc(targetLabel)} 没有 —— 点击后在新标签页完成一键添加</span></div>
        ${diff.toInstall.map((e, i) => extRow(e, i, `
          <button class="mini-btn primary" data-open-store="${e.id}" data-store-name="${esc(e.name)}" type="button">装到 ${esc(targetLabel)} ↗</button>
          <button class="mini-btn" data-ignore="${e.id}" type="button" title="不参与插件同步">忽略</button>`)).join('')}
      </section>`);
  }
  if (c.toRemove) {
    rows.push(`
      <section>
        <div class="ext-group-head"><b>${c.toRemove}</b><span>个插件在 ${esc(d.browsers[primary].label)} 已卸载、${esc(targetLabel)} 还有 —— 打开扩展管理页后手动移除</span></div>
        ${diff.toRemove.map((e, i) => extRow(e, i, `
          <button class="mini-btn danger" data-open-extpage="${secondary}" type="button">去 ${esc(targetLabel)} 移除 ↗</button>
          <button class="mini-btn" data-ignore="${e.id}" type="button">忽略</button>`)).join('')}
      </section>`);
  }
  if (c.toUpdate) {
    rows.push(`
      <section>
        <div class="ext-group-head"><b>${c.toUpdate}</b><span>个插件两边版本不一致</span></div>
        ${diff.toUpdate.map((e, i) => extRow(e, i, `<span class="mono" style="font-size:10.5px;color:var(--muted)">${esc(d.browsers[primary].label)} v${esc(e.version)} · ${esc(targetLabel)} v${esc(e.otherVersion)}</span>`)).join('')}
      </section>`);
  }
  rows.push(renderIgnored(diff, c));
  wrap.innerHTML = rows.join('');

  wrap.querySelectorAll('[data-open-store]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api('/api/open-store', { browser: secondary, ids: [b.dataset.openStore] });
        toast(`已在 ${targetLabel} 打开「${b.dataset.storeName}」的商店页，点击“添加扩展”即可`);
      } catch (e) { toast(`打开商店页失败：${e.message}`, 'error'); }
    };
  });
  wrap.querySelectorAll('[data-open-extpage]').forEach((b) => {
    b.onclick = async () => {
      try {
        const r = await api('/api/open-extensions-page', { browser: b.dataset.openExtpage });
        toast(r.ok ? `已尝试打开 ${targetLabel} 的扩展管理页` : `无法自动打开，请在 ${targetLabel} 地址栏输入 chrome://extensions`);
      } catch (e) { toast(e.message, 'error'); }
    };
  });
  wrap.querySelectorAll('[data-ignore]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api('/api/config', { ignoreAdd: [b.dataset.ignore] });
        toast('已忽略该插件，不再参与同步');
        refresh();
      } catch (e) { toast(e.message, 'error'); }
    };
  });
  bindIgnored();
}

function extRow(e, i, actions) {
  const disabled = e.enabled === false;
  return `
    <div class="ext-row" style="animation-delay:${i * 40}ms">
      <span class="ext-tile ${disabled ? 'disabled' : ''}" style="background:${tileColor(e.id)}">${esc((e.name || '?').trim().charAt(0).toUpperCase())}</span>
      <span class="ext-meta">
        <strong>${esc(e.name)}${disabled ? ' · 已停用' : ''}</strong>
        <em>v${esc(e.version)} · ${esc(e.id.slice(0, 10))}…</em>
      </span>
      ${actions}
    </div>`;
}

function renderIgnored(diff, c) {
  if (!c.ignored) return '';
  return `
    <div class="disclosure" data-open="${state.openDisclosures.has('ignored')}">
      <button data-toggle-disc="ignored" type="button">
        <svg viewBox="0 0 12 12" fill="none"><path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        已忽略 ${c.ignored} 个（含浏览器内置组件）· 管理
      </button>
      <div class="disclosure-body">
        ${diff.ignored.map((e) => `
          <div class="ext-row" style="background:rgb(255 255 255 / 0.2)">
            <span class="ext-tile" style="background:${tileColor(e.id)};opacity:.5">${esc((e.name || '?').trim().charAt(0).toUpperCase())}</span>
            <span class="ext-meta"><strong>${esc(e.name)}</strong><em>${esc(e.id.slice(0, 12))}…</em></span>
            <button class="mini-btn" data-unignore="${e.id}" type="button">恢复同步</button>
          </div>`).join('')}
      </div>
    </div>`;
}

function bindIgnored() {
  const wrap = $('#extSections');
  wrap.querySelectorAll('[data-toggle-disc]').forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.toggleDisc;
      if (state.openDisclosures.has(k)) state.openDisclosures.delete(k);
      else state.openDisclosures.add(k);
      render();
    };
  });
  wrap.querySelectorAll('[data-unignore]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api('/api/config', { ignoreRemove: [b.dataset.unignore] });
        toast('已恢复同步');
        refresh();
      } catch (e) { toast(e.message, 'error'); }
    };
  });
}

function renderHistory(d) {
  const list = $('#historyList');
  $('#historyCount').textContent = `${(d.history || []).length} 条`;
  if (!d.history || !d.history.length) {
    list.innerHTML = '<li class="history-empty">还没有同步记录 —— 点击上方「立即同步」开始。</li>';
    return;
  }
  list.innerHTML = d.history.slice(0, 10).map((h) => `
    <li>
      <time>${esc(new Date(h.t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</time>
      <span class="h-kind ${esc(h.trigger)}">${h.trigger === 'scheduled' ? '自动' : '手动'}</span>
      <span class="h-detail">${esc(h.direction || '')} · ${esc(h.bookmarks || '')} · ${esc(h.extensions || '')}</span>
    </li>`).join('');
}

/* ---------------- 交互 ---------------- */
async function refresh() {
  try {
    state.data = await api('/api/state');
    render();
  } catch (e) {
    $('#statusText').textContent = '无法连接本地服务';
    $('#syncDot').className = 'pulse-dot err';
    console.error(e);
  }
}

async function setPrimary(browser) {
  if (!state.data || state.data.primaryKey === browser) return;
  const prev = state.data.primaryKey;
  state.data.primaryKey = browser; // 乐观更新
  state.openGroups.clear();
  render();
  try {
    await api('/api/config', { primary: browser });
    toast(`已切换：以 ${state.data.browsers[browser].label} 为主`);
  } catch (e) {
    state.data.primaryKey = prev;
    render();
    toast(e.message, 'error');
  }
  refresh();
}

async function setSchedule(v) {
  const prev = state.data.config.schedule;
  state.data.config.schedule = v;
  render();
  try {
    await api('/api/config', { schedule: v });
  } catch (e) {
    state.data.config.schedule = prev;
    render();
    toast(e.message, 'error');
  }
  refresh();
}

async function doSync(applyBookmarks = true) {
  if (state.syncing) return null;
  state.syncing = true;
  let lastSyncResult = null;
  $('#syncBtn').classList.add('busy');
  $('#syncBtn').disabled = true;
  $('#syncBtnText').textContent = '同步中…';
  render();
  try {
    const r = await api('/api/sync', { applyBookmarks });
    lastSyncResult = r;
    const bm = r.bookmarks || {};
    if (bm.error) toast(`书签：${bm.error}`, 'error');
    else if (bm.applied) toast(`书签已镜像写入（+${bm.appliedChanges.added} −${bm.appliedChanges.removed}，自动备份完成）`);
    else if (bm.skipped) toast(`书签：${bm.skipped}`, 'error');
    else if (bm.counts && (bm.counts.added + bm.counts.removed + bm.counts.changed + bm.counts.moved) === 0) toast('书签两边已一致，无需写入');
    const c = r.extensions && r.extensions.counts;
    if (c) toast(`插件：待装 ${c.toInstall} · 待删 ${c.toRemove} · 一致 ${c.inSync}`);
  } catch (e) {
    toast(`同步失败：${e.message}`, 'error');
  }
  state.syncing = false;
  $('#syncBtn').classList.remove('busy');
  $('#syncBtn').disabled = false;
  $('#syncBtnText').textContent = '立即同步';
  refresh();
  return lastSyncResult;
}

function bindEvents() {
  document.querySelectorAll('.browser-chip').forEach((chip) => {
    chip.addEventListener('click', () => setPrimary(chip.dataset.browser));
  });
  $('#scheduleSeg').querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => setSchedule(b.dataset.v));
  });

  // 时间选择 00:00–23:30
  const timeSel = $('#timeSelect');
  for (let h = 0; h < 24; h++) for (const m of ['00', '30']) {
    const v = `${String(h).padStart(2, '0')}:${m}`;
    const opt = document.createElement('option');
    opt.value = v; opt.textContent = v;
    timeSel.appendChild(opt);
  }
  timeSel.addEventListener('change', async () => {
    try { await api('/api/config', { scheduleTime: timeSel.value }); refresh(); }
    catch (e) { toast(e.message, 'error'); }
  });
  const dayRow = $('#weekdayRow');
  for (const [v, label] of WEEKDAYS) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.dataset.day = v;
    b.onclick = async () => {
      try { await api('/api/config', { scheduleDay: v }); refresh(); }
      catch (e) { toast(e.message, 'error'); }
    };
    dayRow.appendChild(b);
  }

  $('#syncBtn').addEventListener('click', () => doSync(true));
  $('#quitAndSyncBtn').addEventListener('click', async () => {
    if (!state.data) return;
    const target = state.data.secondaryKey;
    const label = state.data.browsers[target].label;
    $('#quitAndSyncBtn').disabled = true;
    $('#quitAndSyncBtn').textContent = `正在退出 ${label}…`;
    try {
      const q = await api('/api/quit-browser', { browser: target });
      if (q.running) { toast(`${label} 未能退出，请手动关闭后重试`, 'error'); return; }
      const r = await doSync(true);
      if (r && r.bookmarks && r.bookmarks.applied) {
        await api('/api/launch-browser', { browser: target });
        toast(`${label} 已同步完成并重新打开`);
      } else {
        toast(`${label} 已退出；书签未写入（${r && r.bookmarks && r.bookmarks.skipped ? r.bookmarks.skipped : '无差异或已写入'}）`);
      }
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      $('#quitAndSyncBtn').disabled = false;
      $('#quitAndSyncBtn').textContent = '退出并同步';
    }
  });

  // 运行中提示横幅在 render() 末尾统一刷新
}

function updateRunningBanner() {
  const d = state.data;
  if (!d) return;
  const sB = d.browsers[d.secondaryKey];
  const diff = d.bookmarkDiff;
  const needQuit = sB.running && diff && (diff.counts.added + diff.counts.removed + diff.counts.changed + diff.counts.moved) > 0;
  const banner = $('#runningBanner');
  if (needQuit && !state.syncing) {
    banner.hidden = false;
    $('#runningText').textContent = `${sB.label} 正在运行，书签写入需要先退出它`;
  } else {
    banner.hidden = true;
  }
}

/* ---------------- 启动 ---------------- */
bindEvents();
refresh();
setInterval(refresh, 30000);
setInterval(() => { if (state.data) renderSchedule(state.data.config); }, 60000);
