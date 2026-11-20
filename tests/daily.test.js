'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { dueSearches, cleanAuto, localDay } = require('../src/daily');

const at = (h, day = 10) => new Date(2026, 10, day, h, 30).getTime();
const crit = { query: 'پژو 206', city: 'tehran', maxAgeDays: 30 };

test('daily check: runs once a day from the chosen hour', () => {
  const searches = {
    a: { criteria: crit, auto: { on: true, hour: 9, full: false } },
    b: { criteria: crit, auto: { on: false, hour: 9 } },
    c: { criteria: crit, auto: { on: true, hour: 20, full: true } },
    d: { criteria: null, auto: { on: true, hour: 0 } },
  };
  assert.deepEqual(dueSearches(searches, at(8)).map((x) => x.key), [], 'before the hour');
  const due = dueSearches(searches, at(10));
  assert.deepEqual(due.map((x) => x.key), ['a']);
  assert.equal(due[0].criteria.recheckAll, false);
  assert.equal(due[0].criteria.auto, true);
  // once a day
  searches.a.lastAutoDay = localDay(at(10));
  assert.deepEqual(dueSearches(searches, at(21)).map((x) => [x.key, x.criteria.recheckAll]), [['c', true]], 'full = every ad again');
  assert.deepEqual(dueSearches(searches, at(10, 11)).map((x) => x.key), ['a'], 'again the next day');
  // not twice while waiting in line or running
  assert.deepEqual(dueSearches(searches, at(10, 11), new Set(['a'])).map((x) => x.key), []);
});

test('daily check: skipped when already checked by hand today', () => {
  const searches = { a: { criteria: crit, auto: { on: true, hour: 9 }, lastRunAt: at(9) } };
  assert.deepEqual(dueSearches(searches, at(11)), []);
  searches.a.lastRunAt = at(7); // checked before the chosen hour: still runs
  assert.equal(dueSearches(searches, at(11)).length, 1);
});

test('daily check settings are cleaned', () => {
  assert.deepEqual(cleanAuto({ on: 1, hour: '7', full: 0 }), { on: true, hour: 7, full: false });
  assert.deepEqual(cleanAuto({ on: true, hour: 99 }), { on: true, hour: 9, full: false });
  assert.deepEqual(cleanAuto(null), { on: false, hour: 9, full: false });
});

// ---------- daily price check of all saved searches ----------
const { planPriceCheck, dailyCheckDue, DAILY_KEY } = require('../src/daily');
const STAGES = ['shortlist', 'contacting', 'visit'];
const adsOf = (tokens, crm) => Object.fromEntries(tokens.map((t) => [t, { post: { token: t }, crm: crm && crm[t] ? { stage: crm[t] } : null }]));

test('price check: overlapping searches are checked once, idle ones rest, hidden ones never run', () => {
  const now = at(10);
  const day = 24 * 3600 * 1000;
  const a = Array.from({ length: 40 }, (_, i) => `a${i}`);
  const b = Array.from({ length: 10 }, (_, i) => `b${i}`);
  const ads = { ...adsOf(a), ...adsOf(b), ...adsOf(['old1', 'old2']) };
  const searches = {
    'q|206 all': { criteria: { query: 'پژو 206' }, tokens: a, lastHandAt: now - day },
    'q|206 cheap': { criteria: { query: 'پژو 206', priceMax: 1e9 }, tokens: a.slice(0, 30), lastHandAt: now - 2 * day }, // inside the first
    'bama|206': { criteria: { query: 'پژو 206', source: 'bama' }, tokens: [...a.slice(0, 2), ...b], lastHandAt: now - 3 * day },
    'q|old': { criteria: { query: 'پراید' }, tokens: ['old1', 'old2'], lastHandAt: now - 30 * day },
    [DAILY_KEY]: { criteria: { hidden: true, dailyCheck: {} }, tokens: [], auto: { on: true, hour: 9 } },
  };
  const plan = planPriceCheck(searches, ads, STAGES, now);
  assert.deepEqual(plan.items.map((x) => x.key), ['q|206 all', 'bama|206']);
  assert.equal(plan.merged, 1);
  assert.equal(plan.idle, 1);
  assert.ok(plan.items.every((x) => x.criteria.daily && x.criteria.auto && !x.criteria.recheckAll));
  // the hidden switch is never taken for a search of its own
  assert.equal(dueSearches(searches, now).length, 0);
});

test('price check: followed-up ads go first, and a left-out search hands them to one of its site', () => {
  const now = at(10);
  const a = Array.from({ length: 20 }, (_, i) => `a${i}`);
  const ads = { ...adsOf(a), ...adsOf(['z'], { z: 'visit' }) };
  const searches = {
    'q|big': { criteria: { query: 'x' }, tokens: a, lastHandAt: now },
    'q|small': { criteria: { query: 'x', yearMin: 1400 }, tokens: [...a.slice(0, 6), 'z'], lastHandAt: now - 1000 },
  };
  const plan = planPriceCheck(searches, ads, STAGES, now);
  // q|small has the followed-up ad and comes first; q|big still adds 14 ads of its own
  assert.equal(plan.items[0].key, 'q|small');
  assert.equal(plan.items.length, 2);
  // an old search with a followed-up ad does not rest
  const old = planPriceCheck({ 'q|old': { criteria: { query: 'y' }, tokens: ['z'], lastHandAt: now - 60 * 864e5 } }, ads, STAGES, now);
  assert.equal(old.items.length, 1);
  // a left-out search's followed-up ads ride along with the search that covers it
  const ads2 = adsOf(a, { a1: 'visit' });
  const s2 = { 'q|big': { criteria: { query: 'x' }, tokens: a, lastHandAt: now }, 'q|dup': { criteria: { query: 'x', priceMax: 5 }, tokens: a.slice(0, 2), lastHandAt: now - 5 } };
  s2['q|big'].tokens = a; // a1 is in both; both have a followed-up ad
  const p2 = planPriceCheck(s2, ads2, STAGES, now);
  assert.deepEqual(p2.items.map((x) => x.key), ['q|big']);
  assert.deepEqual(p2.items[0].criteria.trackKeys, ['q|dup']);
});

test('price check is due once a day, from its hour, only when switched on', () => {
  const dc = (on, day) => ({ auto: { on, hour: 9 }, criteria: { hidden: true, dailyCheck: day ? { day } : {} } });
  assert.equal(dailyCheckDue(dc(true), at(8)), false);
  assert.equal(dailyCheckDue(dc(true), at(9)), true);
  assert.equal(dailyCheckDue(dc(true), at(15)), true); // PC turned on late: runs then
  assert.equal(dailyCheckDue(dc(false), at(15)), false);
  assert.equal(dailyCheckDue(dc(true, localDay(at(9))), at(15)), false);
  assert.equal(dailyCheckDue(dc(true, localDay(at(9, 9))), at(15)), true); // checked yesterday
});
