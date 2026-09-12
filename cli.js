#!/usr/bin/env node
'use strict';
// Bifröst CLI：node cli.js <status|sync|primary|schedule|open>
const { runSync } = require('./lib/sync');
const { loadConfig, saveConfig, loadState } = require('./lib/config');
const { computeNextRun } = require('./lib/schedule');
const { execFileSync } = require('child_process');

const [, , cmd, ...args] = process.argv;

function fmtState() {
  const cfg = loadConfig();
  const state = loadState();
  const dir = cfg.primary === 'dia' ? 'Dia' : 'Chrome';
  const next = state.nextRun ? new Date(state.nextRun).toLocaleString('zh-CN') : '—';
  console.log(`主浏览器:   ${dir}`);
  console.log(`同步计划:   ${cfg.schedule}${cfg.schedule !== 'manual' ? ` (${cfg.scheduleTime}${cfg.schedule === 'weekly' ? ' ' + cfg.scheduleDay : ''})` : ''}`);
  console.log(`上次同步:   ${state.lastSync ? new Date(state.lastSync).toLocaleString('zh-CN') : '尚未同步'}`);
  console.log(`下次同步:   ${next}`);
  if (state.lastResult) {
    const r = state.lastResult;
    console.log(`上次结果:   ${r.ok ? '成功' : '异常'} · 方向 ${r.direction || ''}`);
  }
}

switch (cmd) {
  case 'status':
    fmtState();
    break;
  case 'sync': {
    const apply = !args.includes('--no-apply');
    const r = runSync({ trigger: 'manual', applyBookmarks: apply });
    if (r.bookmarks && r.bookmarks.error) console.error('书签: ' + r.bookmarks.error);
    if (r.bookmarks && r.bookmarks.applied) console.log('书签: 已镜像写入（见 data/backups/ 备份）');
    if (r.bookmarks && r.bookmarks.skipped) console.log('书签: ' + r.bookmarks.skipped);
    if (r.extensions && r.extensions.counts) {
      const c = r.extensions.counts;
      console.log(`插件: 待安装 ${c.toInstall} · 待移除 ${c.toRemove} · 版本差异 ${c.toUpdate} · 已一致 ${c.inSync}`);
    }
    break;
  }
  case 'primary': {
    if (args[0] !== 'dia' && args[0] !== 'chrome') { console.error('用法: node cli.js primary <dia|chrome>'); process.exit(1); }
    saveConfig({ primary: args[0] });
    console.log(`已设置主浏览器为 ${args[0] === 'dia' ? 'Dia' : 'Chrome'}`);
    break;
  }
  case 'schedule': {
    const mode = args[0];
    if (!['manual', 'hourly', 'daily', 'weekly'].includes(mode)) { console.error('用法: node cli.js schedule <manual|hourly|daily|weekly> [HH:MM] [mon..sun]'); process.exit(1); }
    const patch = { schedule: mode };
    if (mode === 'daily' || mode === 'weekly') {
      if (args[1] && /^\d{2}:\d{2}$/.test(args[1])) patch.scheduleTime = args[1];
      if (mode === 'weekly' && args[2]) patch.scheduleDay = args[2];
    }
    const cfg = saveConfig(patch);
    const state = loadState();
    state.nextRun = computeNextRun(cfg, state.lastSync);
    require('./lib/config').saveState(state);
    console.log(`同步计划已设为 ${mode}，下次运行: ${state.nextRun || '—'}`);
    break;
  }
  case 'open': {
    execFileSync('open', ['http://127.0.0.1:8770']);
    console.log('已在默认浏览器打开控制台');
    break;
  }
  default:
    console.log('用法: node cli.js <status|sync|primary|schedule|open>');
    process.exit(cmd ? 1 : 0);
}
