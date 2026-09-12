'use strict';
// Chromium 书签文件（Bookmarks JSON）读取、对比与镜像写入。
// 三个永久根：bookmark_bar / other / synced。写入时只替换根的 children，
// 保留根节点自身的 id/guid/name，并删除顶层 checksum 让浏览器自行重算。
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { dataDir, ensureDataDir } = require('./config');

const ROOT_KEYS = ['bookmark_bar', 'other', 'synced'];

function readBookmarks(profileDir) {
  const file = path.join(profileDir, 'Bookmarks');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function countNodes(node) {
  if (!node || !Array.isArray(node.children)) return { folders: 0, urls: 0 };
  let folders = 0, urls = 0;
  for (const child of node.children) {
    if (child.type === 'folder') { folders += 1 + countNodes(child).folders; }
    else if (child.type === 'url') { urls += 1; }
    const sub = countNodes(child);
    folders += sub.folders; urls += sub.urls;
  }
  return { folders, urls };
}

function flatten(node, parentPath, out) {
  out = out || [];
  if (!node || !Array.isArray(node.children)) return out;
  for (const child of node.children) {
    const p = [...parentPath, child.name || ''];
    out.push({ path: p, type: child.type, name: child.name || '', url: child.url || '' });
    if (child.type === 'folder') flatten(child, p, out);
  }
  return out;
}

const pathKey = (p) => p.join('\u0001');

/** 对比两棵书签树（结构镜像预览）：返回 added/removed/changed/moved 四类差异 */
function diffTrees(sourceRoots, targetRoots) {
  const result = { added: [], removed: [], changed: [], moved: [], counts: { added: 0, removed: 0, changed: 0, moved: 0 } };
  for (const key of ROOT_KEYS) {
    const src = sourceRoots[key] || { children: [] };
    const tgt = targetRoots[key] || { children: [] };
    const srcFlat = flatten(src, [rootLabel(key)], []);
    const tgtFlat = flatten(tgt, [rootLabel(key)], []);
    const tgtByPath = new Map(tgtFlat.map((e) => [pathKey(e.path), e]));
    const srcByPath = new Map(srcFlat.map((e) => [pathKey(e.path), e]));
    const tgtByUrl = new Map(tgtFlat.filter((e) => e.type === 'url').map((e) => [e.url, e]));

    for (const e of srcFlat) {
      const t = tgtByPath.get(pathKey(e.path));
      if (!t) {
        const movedFrom = e.type === 'url' ? tgtByUrl.get(e.url) : undefined;
        if (movedFrom && !srcByPath.has(pathKey(movedFrom.path))) {
          result.moved.push({ name: e.name, url: e.url, from: movedFrom.path.join(' / '), to: e.path.join(' / ') });
        } else {
          result.added.push(e);
        }
      } else if (t.type !== e.type || t.url !== e.url || t.name !== e.name) {
        result.changed.push({ name: e.name, url: e.url, oldName: t.name, oldUrl: t.url });
      }
    }
    for (const e of tgtFlat) {
      if (!srcByPath.has(pathKey(e.path))) {
        const stillInSrcByUrl = e.type === 'url' && srcFlat.some((s) => s.type === 'url' && s.url === e.url);
        if (!stillInSrcByUrl) result.removed.push(e);
      }
    }
  }
  result.counts = {
    added: result.added.length,
    removed: result.removed.length,
    changed: result.changed.length,
    moved: result.moved.length,
  };
  return result;
}

function rootLabel(key) {
  return { bookmark_bar: '书签栏', other: '其他书签', synced: '移动设备书签' }[key] || key;
}

function makeIdCounter(start) {
  let n = start;
  return { next: () => String(++n) };
}

/** 重新生成子树的 id/guid（结构、名称、URL、日期保持与来源一致） */
function regenChildren(children, ids) {
  return (children || []).map((node) => {
    const copy = { ...node };
    delete copy.id;
    delete copy.guid;
    copy.id = ids.next();
    copy.guid = crypto.randomUUID();
    if (Array.isArray(node.children)) copy.children = regenChildren(node.children, ids);
    return copy;
  });
}

function maxNodeId(parsed) {
  let max = 100;
  const walk = (node) => {
    const n = parseInt(node && node.id, 10);
    if (!Number.isNaN(n) && n > max) max = n;
    if (node && Array.isArray(node.children)) node.children.forEach(walk);
  };
  Object.values(parsed.roots || {}).forEach((r) => typeof r === 'object' && walk(r));
  return max;
}

function backupBookmarks(profileDir, browserLabel) {
  const file = path.join(profileDir, 'Bookmarks');
  ensureDataDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dataDir(), 'backups', `${stamp}-${browserLabel}-Bookmarks.json`);
  fs.copyFileSync(file, dest);
  return dest;
}

/**
 * 把 source 书签树镜像写入 target 所在 profile。
 * 要求：目标浏览器已退出（否则 Chromium 退出时会覆盖我们的写入）。
 * 返回 { written, backup, counts }
 */
function applyMirror(targetProfileDir, sourceParsed, targetLabel, sourceLabel) {
  const file = path.join(targetProfileDir, 'Bookmarks');
  const target = readBookmarks(targetProfileDir);
  if (!target || !target.roots) throw new Error(`无法读取目标书签文件: ${file}`);

  const backup = backupBookmarks(targetProfileDir, targetLabel);
  const ids = makeIdCounter(maxNodeId(target));

  for (const key of ROOT_KEYS) {
    const srcRoot = sourceParsed.roots && sourceParsed.roots[key];
    const tgtRoot = target.roots[key];
    if (!tgtRoot) continue;
    if (srcRoot && typeof srcRoot === 'object') {
      tgtRoot.children = regenChildren(srcRoot.children, ids);
    } else {
      tgtRoot.children = [];
    }
  }

  delete target.checksum; // 让浏览器启动时重算

  const tmp = `${file}.synchro-tmp`;
  const mode = fs.existsSync(file) ? fs.statSync(file).mode : 0o600;
  fs.writeFileSync(tmp, JSON.stringify(target, null, 2));
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);

  return { written: true, backup, targetLabel, sourceLabel };
}

module.exports = { ROOT_KEYS, readBookmarks, countNodes, flatten, diffTrees, applyMirror, rootLabel, backupBookmarks, maxNodeId, regenChildren };
