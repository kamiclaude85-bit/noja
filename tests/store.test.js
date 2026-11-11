/* «حذف جستجو»: what goes and what stays. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { searchKey } = require('../src/scanner');

const post = (token) => ({ token, title: `آگهی ${token}`, price: 500000000, fields: { 'کارکرد': '۱۰۰٬۰۰۰' } });

test('deleting a saved search removes its own ads and runs, and keeps the rest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radyab-store-'));
  const store = new Store(dir);
  const a = { query: 'پاترول', city: 'tehran' };
  const b = { query: 'تیبا', city: 'tehran' };
  const keyA = searchKey(a);
  const keyB = searchKey(b);
  for (const t of ['plain1', 'plain2', 'followed', 'rejected', 'shared']) store.rememberAd(post(t), keyA);
  for (const t of ['shared', 'other']) store.rememberAd(post(t), keyB);
  store.touchSearch(keyA, a);
  store.touchSearch(keyB, b);
  store.applyCrm('followed', { action: 'stage', stage: 'shortlist' });
  store.applyCrm('rejected', { action: 'reject', reason: 'گران است' });
  const run = (id, criteria) => store.saveRun({ id, createdAt: Date.now(), criteria, status: 'done', items: [], posts: {}, errors: {}, stats: {} }, true);
  run('run_a1', a);
  run('run_a2', { ...a, recheckAll: true, auto: true });
  run('run_b', b);

  assert.throws(() => store.deleteSearch('nope', searchKey), /پیدا نشد/);
  const out = store.deleteSearch(keyA, searchKey);
  assert.deepStrictEqual(out, { removedAds: 3, keptAds: 1, removedRuns: 2 });
  assert.deepStrictEqual(Object.keys(store.db.ads).sort(), ['followed', 'other', 'shared']);
  assert.deepStrictEqual(Object.keys(store.db.searches), [keyB]);
  assert.deepStrictEqual(store.listRuns().map((r) => r.id), ['run_b']);
  assert.deepStrictEqual(store.gone().ads.sort(), ['plain1', 'plain2', 'rejected']);
  assert.deepStrictEqual(store.gone().runs.sort(), ['run_a1', 'run_a2']);
  assert.ok(store.listBackups().length >= 1, 'a backup was written first');

  // Still there after a restart; cleared once the online panel has heard.
  const again = new Store(dir);
  assert.deepStrictEqual(again.gone().runs.sort(), ['run_a1', 'run_a2']);
  again.clearGone({ ads: ['plain1', 'plain2', 'rejected'], runs: ['run_a1', 'run_a2'] });
  assert.deepStrictEqual(again.gone(), { ads: [], runs: [] });
  again.flush();
  fs.rmSync(dir, { recursive: true, force: true });
});
