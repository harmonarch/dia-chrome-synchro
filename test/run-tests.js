'use strict';
// 端到端引擎测试：全部跑在 /tmp fixture 上，绝不读写真实浏览器数据。
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = '/tmp/bifrost-test';
const DATA = path.join(ROOT, 'data');
const DIA = path.join(ROOT, 'dia-profile');
const CHROME = path.join(ROOT, 'chrome-profile');

process.env.SYNCHRO_DATA_DIR = DATA;
process.env.SYNCHRO_DIA_PROFILE_DIR = DIA;
process.env.SYNCHRO_CHROME_PROFILE_DIR = CHROME;

// ---- fixture 构建 ----
fs.rmSync(ROOT, { recursive: true, force: true });
for (const p of [DIA, CHROME]) fs.mkdirSync(p, { recursive: true });

const ts = '133700000000000000';
const mkUrl = (name, url) => ({ type: 'url', name, url, date_added: ts, guid: `src-${name}-${Math.random().toString(36).slice(2, 8)}`, id: String(100 + Math.floor(Math.random() * 1000)) });
const mkFolder = (name, children) => ({ type: 'folder', name, children, date_added: ts, guid: `src-folder-${name}-${Math.random().toString(36).slice(2, 8)}`, id: String(200 + Math.floor(Math.random() * 1000)) });

const diaTree = {
  roots: {
    bookmark_bar: { type: 'folder', name: '书签栏', id: '1', guid: 'root-bar', children: [
      mkFolder('工作', [mkUrl('阮一峰', 'https://ruanyifeng.com'), mkFolder('子', [mkUrl('内页B', 'https://example.org/b')])]),
      mkUrl('GitHub', 'https://github.com'),
    ] },
    other: { type: 'folder', name: '其他书签', id: '2', guid: 'root-other', children: [mkUrl('随笔D', 'https://example.org/d')] },
    synced: { type: 'folder', name: '移动设备书签', id: '3', guid: 'root-synced', children: [] },
  },
  version: 1,
};

const chromeTree = {
  roots: {
    bookmark_bar: { type: 'folder', name: '书签栏', id: '1', guid: 'chrome-root-bar', children: [
      mkFolder('工作', [mkUrl('阮一峰', 'https://ruanyifeng.com')]),
      mkUrl('Github', 'https://github.com'),
      mkUrl('要被删除', 'https://example.org/extra'),
      mkFolder('归档', []),
    ] },
    other: { type: 'folder', name: '其他书签', id: '2', guid: 'chrome-root-other', children: [mkFolder('归档', [mkUrl('随笔D', 'https://example.org/d')])] },
    synced: { type: 'folder', name: '移动设备书签', id: '3', guid: 'chrome-root-synced', children: [] },
  },
  version: 1,
  checksum: 'deadbeef',
};

fs.writeFileSync(path.join(DIA, 'Bookmarks'), JSON.stringify(diaTree));
fs.writeFileSync(path.join(CHROME, 'Bookmarks'), JSON.stringify(chromeTree));

// 扩展 fixture
function mkExt(profile, id, version, manifest, prefsEntry) {
  const dir = path.join(profile, 'Extensions', id, version);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}
function mkLocales(dir, locale, messages) {
  const loc = path.join(dir, '_locales', locale);
  fs.mkdirSync(loc, { recursive: true });
  fs.writeFileSync(path.join(loc, 'messages.json'), JSON.stringify(messages));
}

const EXT = { A: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', B: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', C: 'cccccccccccccccccccccccccccccccc', D: 'dddddddddddddddddddddddddddddddd', E: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' };

const aDir = mkExt(DIA, EXT.A, '1.0.0', { name: '__MSG_appName__', version: '1.0.0', update_url: 'https://clients2.google.com/service/update2/crx' }, {});
mkLocales(aDir, 'en', { appName: { message: 'Rainbow Notes' } });
mkExt(DIA, EXT.B, '1.0.0', { name: 'Plain Ext', version: '1.0.0', update_url: 'https://clients2.google.com/service/update2/crx' }, {});
mkExt(DIA, EXT.C, '1.0', { name: 'Component Thing', version: '1.0' }, {}); // 无 update_url → builtin

mkExt(CHROME, EXT.B, '0.9.0', { name: 'Plain Ext', version: '0.9.0', update_url: 'https://clients2.google.com/service/update2/crx' }, {});
mkExt(CHROME, EXT.C, '1.0', { name: 'Component Thing', version: '1.0' }, {});
mkExt(CHROME, EXT.D, '2.0', { name: 'Only In Chrome', version: '2.0', update_url: 'https://clients2.google.com/service/update2/crx' }, {});
mkExt(CHROME, EXT.E, '3.0', { name: 'Ignored One', version: '3.0', update_url: 'https://clients2.google.com/service/update2/crx' }, {});

fs.writeFileSync(path.join(DIA, 'Preferences'), JSON.stringify({ extensions: { settings: {
  [EXT.A]: { location: 1, disable_reasons: [] },
  [EXT.B]: { location: 1, disable_reasons: [] },
  [EXT.C]: { location: 5 },
} } }));
fs.writeFileSync(path.join(CHROME, 'Preferences'), JSON.stringify({ extensions: { settings: {
  [EXT.B]: { location: 1, disable_reasons: [] },
  [EXT.C]: { location: 5 },
  [EXT.D]: { location: 1, disable_reasons: [1] },
  [EXT.E]: { location: 1, state: 1 },
} } }));

// ---- 被测模块（env 已就位后再 require）----
const bookmarks = require('../lib/bookmarks');
const extensions = require('../lib/extensions');
const paths = require('../lib/paths');
const { computeNextRun } = require('../lib/schedule');
const { runSync } = require('../lib/sync');
const { loadState } = require('../lib/config');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

// 打桩：所有浏览器视为未运行，让 apply 路径可测
paths.isRunning = () => false;

console.log('— 书签引擎 —');
const srcParsed = bookmarks.readBookmarks(DIA);
const tgtParsed = bookmarks.readBookmarks(CHROME);

test('读取书签文件', () => {
  assert(srcParsed && srcParsed.roots.bookmark_bar.children.length === 2);
});

test('diff 统计（+2 / -3 / ~0 / →2，重命名以「移动/重命名」呈现）', () => {
  const d = bookmarks.diffTrees(srcParsed.roots, tgtParsed.roots);
  assert.deepStrictEqual(d.counts, { added: 2, removed: 3, changed: 0, moved: 2 });
});

test('完全相同的树 diff 为零', () => {
  const d = bookmarks.diffTrees(srcParsed.roots, srcParsed.roots);
  assert.deepStrictEqual(d.counts, { added: 0, removed: 0, changed: 0, moved: 0 });
});

test('applyMirror 后目标树与来源一致、根 guid 保留、id 唯一、checksum 移除', () => {
  const applied = bookmarks.applyMirror(CHROME, srcParsed, 'Chrome', 'Dia');
  assert(applied.written && fs.existsSync(applied.backup));
  const after = bookmarks.readBookmarks(CHROME);
  assert.strictEqual(after.checksum, undefined);
  assert.strictEqual(after.roots.bookmark_bar.guid, 'chrome-root-bar'); // 永久根 guid 不变
  const flatSrc = bookmarks.flatten(srcParsed.roots.bookmark_bar, [], []);
  const flatTgt = bookmarks.flatten(after.roots.bookmark_bar, [], []);
  assert.strictEqual(JSON.stringify(flatSrc.map(({ path, type, name, url }) => ({ path, type, name, url }))),
                     JSON.stringify(flatTgt.map(({ path, type, name, url }) => ({ path, type, name, url }))));
  const ids = new Set();
  const walk = (n) => { if (n.id) ids.add(n.id); (n.children || []).forEach(walk); };
  Object.values(after.roots).forEach((r) => walk(r));
  assert.strictEqual(ids.size, 9); // 3 根 + 工作/GitHub + 阮一峰/子/内页B + 随笔D
  const guids = new Set();
  const walkG = (n) => { if (n.guid) guids.add(n.guid); (n.children || []).forEach(walkG); };
  Object.values(after.roots).forEach((r) => walkG(r));
  assert.strictEqual(guids.size, 9);
  // 子节点 guid 必须是新 v4 格式
  assert.match(after.roots.bookmark_bar.children[0].guid, /^[0-9a-f-]{36}$/);
});

console.log('— 扩展引擎 —');
test('扩展扫描：名称/版本/启用/内置识别', () => {
  const dia = extensions.scanProfile(DIA);
  const a = dia.find((e) => e.id === EXT.A);
  assert.strictEqual(a.name, 'Rainbow Notes'); // __MSG_ 本地化名已解析
  const d = extensions.scanProfile(CHROME).find((e) => e.id === EXT.D);
  assert.strictEqual(d.enabled, false); // disable_reasons=[1]
  const c = dia.find((e) => e.id === EXT.C);
  assert.strictEqual(c.builtin, true); // location 5 = COMPONENT → 内置
});

test('扩展 diff：待装1 / 待删1 / 版本差1 / 内置忽略 / ignore 名单', () => {
  const dia = extensions.scanProfile(DIA);
  const chrome = extensions.scanProfile(CHROME);
  const diff = extensions.diffExtensions(dia, chrome, new Set([EXT.E]));
  assert.deepStrictEqual(diff.counts, { toInstall: 1, toRemove: 1, toUpdate: 1, inSync: 0, ignored: 1 });
  assert.strictEqual(diff.toInstall[0].id, EXT.A);
  assert.strictEqual(diff.toRemove[0].id, EXT.D);
  assert.strictEqual(diff.toUpdate[0].id, EXT.B);
  assert.strictEqual(diff.toUpdate[0].otherVersion, '0.9.0');
  assert.match(diff.toInstall[0].storeUrl, /chromewebstore\.google\.com\/detail\/a{32}/);
});

console.log('— 计划 —');
test('manual → null', () => {
  assert.strictEqual(computeNextRun({ schedule: 'manual' }), null);
});
test('hourly = 上次 + 1 小时', () => {
  const next = computeNextRun({ schedule: 'hourly' }, '2026-01-01T00:00:00.000Z', new Date('2026-01-01T00:30:00.000Z'));
  assert.strictEqual(new Date(next).toISOString(), '2026-01-01T01:30:00.000Z');
});
test('daily 过点则排明天', () => {
  const next = computeNextRun({ schedule: 'daily', scheduleTime: '09:00' }, null, new Date(2026, 0, 1, 10, 0));
  assert.strictEqual(next, new Date(2026, 0, 2, 9, 0).toISOString());
});
test('weekly 排到下周一 09:00', () => {
  // 2026-01-02 是周五
  const next = computeNextRun({ schedule: 'weekly', scheduleTime: '09:00', scheduleDay: 'mon' }, null, new Date(2026, 0, 2, 12, 0));
  assert.strictEqual(next, new Date(2026, 0, 5, 9, 0).toISOString());
});

console.log('— runSync 编排 —');
const restoreChromeFixture = () => fs.writeFileSync(path.join(CHROME, 'Bookmarks'), JSON.stringify(chromeTree));
const restoreDiaFixture = () => fs.writeFileSync(path.join(DIA, 'Bookmarks'), JSON.stringify(diaTree));
const { saveConfig } = require('../lib/config');

test('完整同步（浏览器未运行 → 书签写入 + 插件待办）', () => {
  restoreChromeFixture();
  restoreDiaFixture(); // 主=chrome，从=dia：先恢复两侧，保证有差异
  saveConfig({ extensions: { ignore: [EXT.E] } }); // E 不参与插件 diff
  const r = runSync({ trigger: 'manual' });
  assert.strictEqual(r.primary, 'chrome');
  assert.strictEqual(r.bookmarks.applied, true);
  assert.strictEqual(r.extensions.counts.toInstall, 1); // 仅 D
  assert.strictEqual(r.extensions.counts.toRemove, 1);  // 仅 A
  const state = loadState();
  assert(state.lastSync);
  assert(state.history.length >= 1);
});

test('目标浏览器运行中 → 书签跳过写入', () => {
  restoreChromeFixture();
  restoreDiaFixture();
  paths.isRunning = (k) => k === 'dia'; // secondary=dia 视为运行中
  const r = runSync({ trigger: 'scheduled' });
  assert.strictEqual(r.bookmarks.applied, false);
  assert(r.bookmarks.skipped.includes('Dia'));
});

console.log(`\n通过 ${passed} 项`);
if (process.exitCode) process.exit(process.exitCode);
