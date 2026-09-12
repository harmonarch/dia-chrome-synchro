'use strict';
// 计划任务：根据 config 计算下一次运行时间（ISO 字符串）。
function parseTime(hhmm) {
  const [h, m] = String(hhmm || '09:00').split(':').map((x) => parseInt(x, 10));
  return { h: Number.isNaN(h) ? 9 : h, m: Number.isNaN(m) ? 0 : m };
}

function atTime(base, hhmm) {
  const { h, m } = parseTime(hhmm);
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d;
}

const DAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function computeNextRun(cfg, lastSyncIso, now = new Date()) {
  if (!cfg || cfg.schedule === 'manual') return null;
  if (cfg.schedule === 'hourly') {
    const base = lastSyncIso ? new Date(lastSyncIso) : now;
    const next = new Date(Math.max(base.getTime(), now.getTime()) + 60 * 60 * 1000);
    return next.toISOString();
  }
  if (cfg.schedule === 'daily') {
    let next = atTime(now, cfg.scheduleTime);
    if (next.getTime() <= now.getTime()) next = new Date(next.getTime() + 24 * 3600 * 1000);
    return next.toISOString();
  }
  if (cfg.schedule === 'weekly') {
    const target = DAY_INDEX[cfg.scheduleDay] ?? 1;
    let next = atTime(now, cfg.scheduleTime);
    let add = (target - next.getDay() + 7) % 7;
    if (add === 0 && next.getTime() <= now.getTime()) add = 7;
    next = new Date(next.getTime() + add * 24 * 3600 * 1000);
    return next.toISOString();
  }
  return null;
}

module.exports = { computeNextRun };
