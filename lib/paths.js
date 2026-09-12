'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const BROWSERS = {
  dia: {
    key: 'dia',
    label: 'Dia',
    appName: 'Dia',
    pgrepPattern: 'Dia.app/Contents/MacOS/Dia',
    defaultProfile: 'Default',
    // 测试环境可注入 SYNCHRO_DIA_PROFILE_DIR 覆盖真实路径
    profileDir(config) {
      if (process.env.SYNCHRO_DIA_PROFILE_DIR) return process.env.SYNCHRO_DIA_PROFILE_DIR;
      const userData = path.join(os.homedir(), 'Library', 'Application Support', 'Dia', 'User Data');
      return path.join(userData, (config && config.profiles && config.profiles.dia) || this.defaultProfile);
    },
  },
  chrome: {
    key: 'chrome',
    label: 'Chrome',
    appName: 'Google Chrome',
    pgrepPattern: 'Google Chrome.app/Contents/MacOS/Google Chrome',
    defaultProfile: 'Default',
    profileDir(config) {
      if (process.env.SYNCHRO_CHROME_PROFILE_DIR) return process.env.SYNCHRO_CHROME_PROFILE_DIR;
      const userData = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
      return path.join(userData, (config && config.profiles && config.profiles.chrome) || this.defaultProfile);
    },
  },
};

function otherOf(key) {
  return key === 'dia' ? 'chrome' : 'dia';
}

function isRunning(browserKey) {
  const b = BROWSERS[browserKey];
  if (!b) throw new Error(`未知浏览器: ${browserKey}`);
  try {
    const out = execFileSync('pgrep', ['-f', b.pgrepPattern], { encoding: 'utf8' });
    return out.trim().length > 0;
  } catch {
    return false; // pgrep 无匹配时退出码为 1
  }
}

function quitBrowser(browserKey, timeoutMs = 20000) {
  const b = BROWSERS[browserKey];
  if (!isRunning(browserKey)) return true;
  try {
    execFileSync('osascript', ['-e', `tell application "${b.appName}" to quit`], { timeout: 10000 });
  } catch {
    /* 某些情况下 AppleScript 会失败，仍以轮询结果为准 */
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(browserKey)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  return !isRunning(browserKey);
}

function launchBrowser(browserKey) {
  const b = BROWSERS[browserKey];
  try {
    execFileSync('open', ['-a', b.appName], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

function openInBrowser(browserKey, url) {
  const b = BROWSERS[browserKey];
  try {
    execFileSync('open', ['-a', b.appName, url], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

/** 用 AppleScript 尝试打开浏览器内部页（chrome://…），失败则返回 false */
function openInternalPage(browserKey, internalUrl) {
  const b = BROWSERS[browserKey];
  try {
    execFileSync('osascript', ['-e', `tell application "${b.appName}" to open location "${internalUrl}"`], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

function browserProfileStatus(config, browserKey) {
  const dir = BROWSERS[browserKey].profileDir(config);
  const bookmarksFile = path.join(dir, 'Bookmarks');
  return {
    key: browserKey,
    label: BROWSERS[browserKey].label,
    profileDir: dir,
    bookmarksFile,
    bookmarksReadable: fs.existsSync(bookmarksFile),
    running: isRunning(browserKey),
  };
}

module.exports = { BROWSERS, otherOf, isRunning, quitBrowser, launchBrowser, openInBrowser, openInternalPage, browserProfileStatus };
