/*
 * Daily automatic recheck of saved searches.
 *
 * Each saved search can be set to run by itself once a day, from a chosen hour (PC clock):
 *   auto = { on: true, hour: 9, full: false }
 *   - full = false: only new ads, plus the ads being followed up (the usual «بررسی جدیدها»);
 *   - full = true:  every ad within the search's period is opened again (catches price
 *                   changes and sold ads too; slower and uses more of the daily cap).
 * Due searches join the bot's waiting line, so they run one after another and respect
 * the daily cap like any other search.
 */
'use strict';

const DEFAULT_HOUR = 9;

function localDay(t) { return new Date(t).toLocaleDateString('en-CA'); }

/** Keep only valid settings: { on, hour 0–23, full }. */
function cleanAuto(a) {
  const raw = a && a.hour;
  const hour = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  return {
    on: !!(a && a.on),
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_HOUR,
    full: !!(a && a.full),
  };
}

/**
 * Searches whose daily time has come and that have not run today.
 * `busyKeys`: searches already running or waiting in line (not added twice).
 * Returns [{ key, criteria }]; the caller queues them and calls markAutoRan.
 */
function dueSearches(searches, now = Date.now(), busyKeys = new Set()) {
  const today = localDay(now);
  const hourNow = new Date(now).getHours();
  const out = [];
  for (const [key, s] of Object.entries(searches || {})) {
    const a = s.auto;
    if (!a || !a.on || !s.criteria) continue;
    if (hourNow < (Number.isInteger(a.hour) ? a.hour : DEFAULT_HOUR)) continue;
    if (s.lastAutoDay === today || busyKeys.has(key)) continue;
    // Already checked by hand today after the chosen hour: nothing more to do today.
    if (s.lastRunAt && localDay(s.lastRunAt) === today && new Date(s.lastRunAt).getHours() >= a.hour && !a.full) continue;
    out.push({ key, criteria: { ...s.criteria, recheckAll: !!a.full, auto: true } });
  }
  return out;
}

module.exports = { dueSearches, cleanAuto, localDay, DEFAULT_HOUR };
