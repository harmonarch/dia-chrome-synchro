'use strict';
const { execFileSync } = require('child_process');

function esc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function notify(title, body) {
  try {
    execFileSync('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`], { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

module.exports = { notify };
