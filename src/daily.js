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
const DAY = 24 * 60 * 60 * 1000;

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
    if (!a || !a.on || !s.criteria || s.criteria.hidden) continue;
    if (hourNow < (Number.isInteger(a.hour) ? a.hour : DEFAULT_HOUR)) continue;
    if (s.lastAutoDay === today || busyKeys.has(key)) continue;
    // Already checked by hand today after the chosen hour: nothing more to do today.
    if (s.lastRunAt && localDay(s.lastRunAt) === today && new Date(s.lastRunAt).getHours() >= a.hour && !a.full) continue;
    out.push({ key, criteria: { ...s.criteria, recheckAll: !!a.full, auto: true } });
  }
  return out;
}

/*
 * Daily price check («بررسی قیمت روزانه»): one switch for all saved searches.
 * Once a day, from the chosen hour (or the first time the bot is on after it), the saved searches
 * are gone through again, slowly and one after another. The list pages show each ad's price, so
 * only new ads and ads whose price moved are opened; the work grows with the number of searches,
 * not of ads. To keep it small as searches pile up:
 *   - each group of ads is checked once: a search whose ads are (almost) all in a search already
 *     chosen is left out (Divar and Bama, or the same model with other filters);
 *   - searches with ads being followed up come first, then the ones used most recently;
 *   - a search not used by hand for IDLE_DAYS and with nothing followed up rests.
 * Ads followed up in a left-out search are re-checked by a chosen search of the same site.
 * The switch and the last check live in a hidden saved search (DAILY_KEY), so they reach the
 * online panel with the searches and can be changed there like any search's daily check.
 */
const DAILY_KEY = '__daily_check';
const IDLE_DAYS = 14;

function siteOfSearch(key, c) { return (c && c.source === 'bama') || String(key).startsWith('bama|') ? 'bama' : 'divar'; }

/**
 * Which saved searches to run for today's price check.
 * Returns { items: [{ key, criteria }], idle, merged } (idle: resting searches, merged: left out
 * because their ads are covered by another).
 */
function planPriceCheck(searches, ads, activeStages, now = Date.now(), busyKeys = new Set()) {
  const cands = [];
  let idle = 0;
  for (const [key, s] of Object.entries(searches || {})) {
    const c = s && s.criteria;
    if (!c || c.hidden || busyKeys.has(key)) continue;
    const live = (s.tokens || []).filter((t) => { const a = ads[t]; return a && a.post && !a.removed; });
    if (!live.length) continue;
    const tracked = live.filter((t) => { const cr = ads[t].crm; return cr && activeStages.includes(cr.stage); });
    const used = s.lastHandAt || s.lastRunAt || s.createdAt || 0;
    if (!tracked.length && now - used > IDLE_DAYS * DAY) { idle++; continue; }
    cands.push({ key, s, live, tracked, used, site: siteOfSearch(key, c), trackKeys: [] });
  }
  cands.sort((a, b) => b.tracked.length - a.tracked.length || b.used - a.used);
  const covered = new Set();
  const chosen = [];
  const left = [];
  for (const x of cands) {
    const fresh = x.live.filter((t) => !covered.has(t)).length;
    if (fresh >= Math.max(5, Math.ceil(x.live.length * 0.25)) || (fresh && fresh === x.live.length)) {
      chosen.push(x);
      for (const t of x.live) covered.add(t);
    } else left.push(x);
  }
  // followed-up ads of a left-out search: re-checked by the chosen search sharing most of its ads
  let merged = 0;
  for (const x of left) {
    if (x.tracked.length) {
      let best = null; let bestN = -1;
      for (const y of chosen) {
        if (y.site !== x.site) continue;
        const set = new Set(y.live);
        const n = x.live.filter((t) => set.has(t)).length;
        if (n > bestN) { best = y; bestN = n; }
      }
      if (!best) { chosen.push(x); continue; }
      best.trackKeys.push(x.key);
    }
    merged++;
  }
  return {
    items: chosen.map((x) => ({ key: x.key, criteria: { ...x.s.criteria, recheckAll: false, auto: true, daily: true, trackKeys: x.trackKeys } })),
    idle,
    merged,
  };
}

/** Is today's price check due? dc: the hidden search ({ auto, criteria.dailyCheck }). */
function dailyCheckDue(dc, now = Date.now()) {
  if (!dc || !dc.auto || !dc.auto.on) return false;
  const last = (dc.criteria && dc.criteria.dailyCheck) || {};
  if (last.day === localDay(now)) return false;
  return new Date(now).getHours() >= (Number.isInteger(dc.auto.hour) ? dc.auto.hour : DEFAULT_HOUR);
}

module.exports = { dueSearches, cleanAuto, localDay, DEFAULT_HOUR, DAILY_KEY, IDLE_DAYS, planPriceCheck, dailyCheckDue, siteOfSearch };
