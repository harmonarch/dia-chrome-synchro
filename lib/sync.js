'use strict';
// 同步编排：以 primary 为数据基准（书签镜像到 secondary；扩展集合向 secondary 对齐）。
const { loadConfig, loadState, saveState, appendHistory } = require('./config');
const paths = require('./paths');
const { BROWSERS, otherOf } = paths;
const bookmarks = require('./bookmarks');
const extensions = require('./extensions');
const { computeNextRun } = require('./schedule');
const { notify } = require('./notify');

/**
 * 执行一次同步。
 * opts: { trigger: 'manual'|'scheduled', applyBookmarks?: boolean }
 * 书签只有在「目标浏览器未运行」时才写入文件；否则记录为 skipped。
 * 扩展不做静默安装/卸载（Chromium 安全限制），而是生成待办动作：
 *   install → 打开 Chrome Web Store 页面一键添加；remove → 打开扩展管理页手动移除。
 */
function runSync(opts = {}) {
  const trigger = opts.trigger || 'manual';
  const cfg = loadConfig();
  const state = loadState();

  const primaryKey = cfg.primary === 'dia' ? 'dia' : 'chrome';
  const secondaryKey = otherOf(primaryKey);
  const primary = BROWSERS[primaryKey];
  const secondary = BROWSERS[secondaryKey];

  const result = {
    trigger,
    primary: primaryKey,
    secondary: secondaryKey,
    bookmarks: null,
    extensions: null,
    ok: true,
  };

  // ---- 书签 ----
  const srcParsed = bookmarks.readBookmarks(primary.profileDir(cfg));
  const tgtParsed = bookmarks.readBookmarks(secondary.profileDir(cfg));
  if (!srcParsed) {
    result.ok = false;
    result.bookmarks = { error: `无法读取 ${primary.label} 的书签文件` };
  } else if (!tgtParsed) {
    result.ok = false;
    result.bookmarks = { error: `无法读取 ${secondary.label} 的书签文件` };
  } else {
    const diff = bookmarks.diffTrees(srcParsed.roots, tgtParsed.roots);
    const totalChanges = diff.counts.added + diff.counts.removed + diff.counts.changed + diff.counts.moved;
    result.bookmarks = {
      counts: diff.counts,
      samples: {
        added: diff.added.slice(0, 10),
        removed: diff.removed.slice(0, 10),
        changed: diff.changed.slice(0, 10),
        moved: diff.moved.slice(0, 10),
      },
      secondaryRunning: paths.isRunning(secondaryKey),
    };

    if (totalChanges > 0 && (opts.applyBookmarks !== false)) {
      if (result.bookmarks.secondaryRunning) {
        result.bookmarks.applied = false;
        result.bookmarks.skipped = `${secondary.label} 正在运行，为避免被覆盖已跳过写入`;
      } else {
        const applied = bookmarks.applyMirror(
          secondary.profileDir(cfg),
          srcParsed,
          secondary.label,
          primary.label
        );
        result.bookmarks.applied = true;
        result.bookmarks.backup = applied.backup;
        // 写入后目标文件与来源一致
        result.bookmarks.counts = { added: 0, removed: 0, changed: 0, moved: 0 };
        result.bookmarks.appliedChanges = diff.counts;
      }
    }
  }

  // ---- 扩展 ----
  try {
    const primaryExts = extensions.scanProfile(primary.profileDir(cfg));
    const secondaryExts = extensions.scanProfile(secondary.profileDir(cfg));
    const ignoreSet = new Set((cfg.extensions && cfg.extensions.ignore) || []);
    const diff = extensions.diffExtensions(primaryExts, secondaryExts, ignoreSet);
    result.extensions = diff;

    // 维护待办状态：resolved（上次待装/待删的现在已经一致）自动出账
    const pending = state.pendingExtensions || { install: {}, remove: {} };
    const sMap = new Map(secondaryExts.filter((e) => !e.builtin).map((e) => [e.id, e]));
    const pMap = new Map(primaryExts.filter((e) => !e.builtin).map((e) => [e.id, e]));
    for (const id of Object.keys(pending.install)) {
      if (sMap.has(id)) { delete pending.install[id]; }
    }
    for (const id of Object.keys(pending.remove)) {
      if (!sMap.has(id)) { delete pending.remove[id]; }
    }
    for (const ext of diff.toInstall) pending.install[ext.id] = { name: ext.name, t: new Date().toISOString() };
    for (const ext of diff.toRemove) pending.remove[ext.id] = { name: ext.name, t: new Date().toISOString() };
    state.pendingExtensions = pending;
  } catch (e) {
    result.extensions = { error: String(e.message || e) };
  }

  // ---- 落账 ----
  state.lastSync = new Date().toISOString();
  state.lastResult = result;
  appendHistory(state, {
    kind: 'sync',
    trigger,
    ok: result.ok,
    direction: `${primary.label} → ${secondary.label}`,
    bookmarks: result.bookmarks && (result.bookmarks.applied
      ? `书签已写入（+${result.bookmarks.appliedChanges.added} -${result.bookmarks.appliedChanges.removed} ~${result.bookmarks.appliedChanges.changed} →${result.bookmarks.appliedChanges.moved}）`
      : result.bookmarks.skipped || `书签差异 +${result.bookmarks.counts.added} -${result.bookmarks.counts.removed}`),
    extensions: result.extensions && result.extensions.counts
      ? `插件待装 ${result.extensions.counts.toInstall} / 待删 ${result.extensions.counts.toRemove}`
      : '插件读取失败',
  });
  state.nextRun = computeNextRun(cfg, state.lastSync);
  saveState(state);

  if (trigger === 'scheduled') {
    const pend = result.extensions && result.extensions.counts
      ? result.extensions.counts.toInstall + result.extensions.counts.toRemove : 0;
    if (pend > 0) notify('Bifröst 同步器', `发现 ${pend} 个插件差异待处理，打开控制台完成安装/移除`);
  }
  return result;
}

module.exports = { runSync };
