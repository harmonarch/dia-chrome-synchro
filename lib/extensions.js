'use strict';
// 扩展扫描与对比：从 Extensions/ 目录读 manifest，从 Preferences 读启用状态与 location。
const fs = require('fs');
const path = require('path');

const STORE_URL = (id) => `https://chromewebstore.google.com/detail/${id}`;

function resolveMsgName(extDir, manifest) {
  let name = manifest.name || '';
  if (name.startsWith('__MSG_') && name.endsWith('__')) {
    const key = name.slice(6, -2).toLowerCase();
    const locales = [manifest.default_locale, 'en', 'en_US', 'en_GB', 'zh_CN'].filter(Boolean);
    for (const loc of locales) {
      const f = path.join(extDir, '_locales', loc, 'messages.json');
      try {
        const msgs = JSON.parse(fs.readFileSync(f, 'utf8'));
        // message key 大小写不敏感匹配
        const lowerMap = new Map(Object.keys(msgs).map((k) => [k.toLowerCase(), msgs[k]]));
        const hit = lowerMap.get(key) || lowerMap.get(key.replace(/_/g, ''));
        if (hit && hit.message) { name = hit.message; break; }
      } catch { /* 试下一个 locale */ }
    }
  }
  return name;
}

function readExtensionSettings(profileDir) {
  // Chrome 152+ / Dia 把扩展设置放在 Secure Preferences；旧版在 Preferences。两处合并，后者优先。
  const merged = {};
  for (const name of ['Preferences', 'Secure Preferences']) {
    try {
      const prefs = JSON.parse(fs.readFileSync(path.join(profileDir, name), 'utf8'));
      Object.assign(merged, (prefs.extensions && prefs.extensions.settings) || {});
    } catch { /* 文件缺失或不可读则跳过 */ }
  }
  return merged;
}

function scanProfile(profileDir) {
  const extRoot = path.join(profileDir, 'Extensions');
  const settings = readExtensionSettings(profileDir);

  const out = [];
  if (!fs.existsSync(extRoot)) return out;
  for (const entry of fs.readdirSync(extRoot)) {
    const extDir = path.join(extRoot, entry);
    if (!fs.statSync(extDir).isDirectory()) continue;
    let versionDirs = [];
    try { versionDirs = fs.readdirSync(extDir).filter((v) => fs.statSync(path.join(extDir, v)).isDirectory()); } catch { continue; }
    if (!versionDirs.length) continue;
    versionDirs.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    const latest = path.join(extDir, versionDirs[0]);
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(path.join(latest, 'manifest.json'), 'utf8')); } catch { continue; }

    const id = entry;
    const st = settings[id] || {};
    const reasons = st.disable_reasons;
    let enabled;
    if (Array.isArray(reasons)) enabled = reasons.length === 0;
    else if (typeof reasons === 'number') enabled = reasons === 0;
    else if (typeof st.state === 'number') enabled = st.state !== 0;
    else enabled = true; // 无任何禁用痕迹

    const location = typeof st.location === 'number' ? st.location : null;
    const updateUrl = manifest.update_url || (st.update_url || null);
    out.push({
      id,
      name: resolveMsgName(latest, manifest) || '(未命名扩展)',
      version: manifest.version || versionDirs[0],
      updateUrl,
      location,
      enabled,
      // location 5=COMPONENT / 10=EXTERNAL_COMPONENT（如 Chrome Web Store Payments）→ 浏览器内置
      builtin: location === 5 || location === 10,
    });
  }
  return out;
}

/**
 * 对比主从两侧扩展集合（忽略 builtin 与手动 ignore 列表）。
 * toInstall: 主侧有、从侧没有；toRemove: 从侧有、主侧没有（= 主侧已卸载）。
 */
function diffExtensions(primaryList, secondaryList, ignoreSet = new Set()) {
  const pMap = new Map(primaryList.filter((e) => !e.builtin).map((e) => [e.id, e]));
  const sMap = new Map(secondaryList.filter((e) => !e.builtin).map((e) => [e.id, e]));
  const result = { toInstall: [], toRemove: [], toUpdate: [], inSync: [], ignored: [] };

  for (const [id, ext] of pMap) {
    if (ignoreSet.has(id)) { result.ignored.push({ ...ext, side: 'primary' }); continue; }
    const other = sMap.get(id);
    if (!other) result.toInstall.push({ ...ext, storeUrl: STORE_URL(id), action: 'install' });
    else if (other.version !== ext.version) result.toUpdate.push({ ...ext, otherVersion: other.version, storeUrl: STORE_URL(id), action: 'update' });
    else result.inSync.push(ext);
  }
  for (const [id, ext] of sMap) {
    if (ignoreSet.has(id)) { result.ignored.push({ ...ext, side: 'secondary' }); continue; }
    if (!pMap.has(id)) result.toRemove.push({ ...ext, storeUrl: STORE_URL(id), action: 'remove' });
  }
  result.counts = {
    toInstall: result.toInstall.length,
    toRemove: result.toRemove.length,
    toUpdate: result.toUpdate.length,
    inSync: result.inSync.length,
    ignored: result.ignored.length,
  };
  return result;
}

module.exports = { scanProfile, diffExtensions, STORE_URL };
