'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  primary: 'chrome',            // 'dia' | 'chrome' —— 以谁为主（数据基准）
  schedule: 'manual',           // 'manual' | 'hourly' | 'daily' | 'weekly'
  scheduleTime: '09:00',        // daily/weekly 的触发时刻（本地时间）
  scheduleDay: 'mon',           // weekly 的触发日（mon..sun）
  autoQuitForBookmarks: false,  // 计划同步时目标浏览器在运行：true=自动退出并写回（慎用），false=跳过
  profiles: { dia: 'Default', chrome: 'Default' },
  extensions: {
    ignore: [],                 // 手动忽略的扩展 id
  },
};

function dataDir() {
  if (process.env.SYNCHRO_DATA_DIR) return process.env.SYNCHRO_DATA_DIR;
  return path.join(__dirname, '..', 'data');
}

function ensureDataDir() {
  const dir = dataDir();
  fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  return dir;
}

function configPath() { return path.join(dataDir(), 'config.json'); }
function statePath() { return path.join(dataDir(), 'state.json'); }

function loadConfig() {
  ensureDataDir();
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    cfg = {};
  }
  const merged = { ...DEFAULT_CONFIG, ...cfg };
  merged.profiles = { ...DEFAULT_CONFIG.profiles, ...(cfg.profiles || {}) };
  merged.extensions = { ...DEFAULT_CONFIG.extensions, ...(cfg.extensions || {}) };
  return merged;
}

function saveConfig(patch) {
  const cfg = { ...loadConfig(), ...patch };
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  return cfg;
}

function loadState() {
  ensureDataDir();
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return { history: [], lastSync: null, lastResult: null, nextRun: null, pendingExtensions: { install: {}, remove: {} } };
  }
}

function saveState(state) {
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
  return state;
}

function appendHistory(state, entry) {
  state.history = [{ t: new Date().toISOString(), ...entry }, ...(state.history || [])].slice(0, 80);
  return state;
}

module.exports = { DEFAULT_CONFIG, dataDir, ensureDataDir, configPath, statePath, loadConfig, saveConfig, loadState, saveState, appendHistory };
