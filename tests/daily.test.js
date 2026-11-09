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
