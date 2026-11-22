'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeDeals, modelName } = require('../src/deals');

const base = { brand: 'پژو 206 تیپ ۲', year: 1397, body: 'سالم و بی‌خط و خش', engine: 'سالم', seller: 'personal', description: '' };
const car = (token, price, mileage, extra = {}) => ({ ...base, token, price: price * 1e6, mileage, ...extra });

test('model names group the same trim', () => {
  assert.equal(modelName({ brand: 'پژو 206 تیپ ۲' }), modelName({ brand: 'پژو ۲۰۶ تیپ 2' }));
  assert.equal(modelName({ title: 'پژو ۲۰۶ تیپ ۲، مدل ۱۳۹۷' }), modelName({ brand: 'پژو 206 تیپ ۲' }));
});

test('finds the ad clearly under the usual price for the same model and year', () => {
  const posts = [
    car('a', 500, 100000), car('b', 505, 95000), car('c', 495, 105000), car('d', 510, 90000), car('e', 502, 100000), car('f', 498, 100000),
    car('deal', 430, 100000),
    car('other-year', 400, 100000, { year: 1394 }),
  ];
  const d = computeDeals(posts);
  assert.equal(d.get('deal').deal, true);
  assert.equal(d.get('deal').level, 'hot');
  assert.ok(d.get('deal').reasons[0].includes('زیر قیمت معمول'));
  assert.equal(d.get('a').deal, false);
  // three model years away: only an approximate judgement (same trim, prices moved to its year), never an offer
  assert.equal(d.get('other-year').approx, 'years');
  assert.equal(d.get('other-year').deal, false);
  assert.equal(d.get('other-year').level, null);
});

test('mileage is taken into account', () => {
  const posts = [car('a', 500, 100000), car('b', 500, 100000), car('c', 500, 100000), car('d', 500, 100000),
    car('lowkm', 520, 30000), car('highkm', 470, 220000)];
  const d = computeDeals(posts);
  assert.ok(d.get('highkm').expected < 500e6, 'high mileage lowers the usual price');
  assert.equal(d.get('highkm').deal, false, 'cheap only because of mileage');
  assert.ok(d.get('lowkm').expected > 500e6);
});

test('problems and suspicious prices are not recommended', () => {
  const posts = [car('a', 500, 100000), car('b', 505, 100000), car('c', 495, 100000), car('d', 510, 100000),
    car('painted', 465, 100000, { body: 'دو لکه رنگ‌شدگی', engine: 'نیاز به تعمیر' }),
    car('scam', 300, 100000),
    car('loan', 420, 100000, { description: 'فروش اقساطی با ۲۰۰ میلیون پیش پرداخت' })];
  const d = computeDeals(posts);
  assert.equal(d.get('painted').deal, false);
  assert.ok(d.get('painted').warnings.some((w) => w.includes('رنگ‌شدگی')));
  assert.equal(d.get('scam').deal, false);
  assert.equal(d.get('scam').level, 'caution');
  assert.equal(d.get('loan').level, 'caution');
  assert.ok(d.get('loan').warnings[0].includes('پیش‌پرداخت'));
});

test('paint counts in the usual price, from the specs or the description', () => {
  const clean = [car('a', 500, 100000), car('b', 505, 100000), car('c', 495, 100000), car('d', 510, 100000)];
  const posts = [...clean,
    // specs say clean, the text says two pieces painted: priced like a painted car
    car('says-clean', 465, 100000, { description: 'ماشین تمیز، دو تیکه رنگ داره' }),
    car('two-tone', 400, 100000, { body: 'دوررنگ' }),
    car('no-paint', 470, 100000, { description: 'بدون رنگ و تعویضی، برگه کارشناسی گذاشتم' })];
  const d = computeDeals(posts);
  const sc = d.get('says-clean');
  assert.equal(sc.body.level, 'paint');
  assert.equal(sc.body.conflict, true);
  assert.ok(sc.expected < 480e6, 'usual price of a painted car');
  assert.equal(sc.deal, false, 'cheap only because of the paint');
  assert.match(sc.warnings[0], /در توضیحات نوشته/);
  assert.equal(d.get('two-tone').body.level, 'twoTone');
  assert.ok(d.get('two-tone').discount < 0.15, 'judged against a two-tone price, not a clean one');
  const np = d.get('no-paint');
  assert.equal(np.body.level, 'clean');
  assert.equal(np.deal, true);
  assert.ok(np.warnings.some((w) => w.includes('برگهٔ کارشناسی')));
});

test('dealers and «حواله» are listed apart, never as special offers', () => {
  const posts = [car('a', 500, 100000), car('b', 505, 100000), car('c', 495, 100000), car('d', 510, 100000), car('e', 500, 100000),
    car('dealer', 440, 100000, { seller: 'dealer' }),
    car('havaleh', 440, 100000, { title: 'حواله پژو ۲۰۶', description: 'تحویل نزدیک' })];
  const d = computeDeals(posts);
  assert.equal(d.get('dealer').level, 'dealer');
  assert.equal(d.get('dealer').deal, false);
  assert.equal(d.get('havaleh').level, 'dealer');
  assert.ok(d.get('havaleh').warnings.some((w) => w.includes('حواله')));
  assert.ok(d.get('a').expected > 499e6, 'a «حواله» price is not part of the market');
});

test('body condition words: negations and dealer boilerplate', () => {
  const P = require('../src/parser');
  const lv = (description, body = 'سالم و بی‌خط و خش') => P.bodyCondition({ body, description }).level;
  assert.equal(lv('بدون رنگ و تعویضی'), 'clean');
  assert.equal(lv('رنگ نداره، شاسی ها پلمپ'), 'clean');
  assert.equal(lv('تنوع رنگ و رنگ بندی کامل موجود'), 'clean');
  assert.equal(lv('یه لکه رنگ داره'), 'paint');
  assert.equal(lv('سه تیکه رنگ'), 'paintMany');
  assert.equal(lv('کاپوت تعویض شده'), 'replaced');
  assert.equal(lv('سینی جلو ضربه ترافیکی'), 'accident');
  assert.equal(lv('حتی ترافیکی هم نداره'), 'clean');
  assert.equal(lv('', 'رنگ‌شدگی در ۲ ناحیه'), 'paint');
  assert.equal(lv('', 'تمام‌رنگ'), 'full');
});

test('too few of the same year: approximate from nearby years, never a special offer', () => {
  const posts = [car('a', 500, 100000), car('b', 505, 100000), car('c', 495, 100000), car('d', 510, 100000), car('e', 500, 100000), car('f', 502, 100000),
    car('older', 420, 100000, { year: 1396 })];
  const d = computeDeals(posts);
  const o = d.get('older');
  assert.equal(o.approx, 'years');
  assert.ok(Math.abs(o.expected - 501e6 / 1.02) < 6e6, 'moved one year back, about 2%');
  assert.equal(o.deal, false);
  assert.equal(o.sure, false);
  assert.match(o.reasons[0], /تقریبی/);
  assert.equal(d.get('a').approx, null, 'the same year is still compared exactly');
});

test('needs enough similar ads', () => {
  const d = computeDeals([car('a', 500, 1), car('b', 400, 1), car('c', 500, 1)]);
  assert.equal(d.size, 0);
});

test('price guide: buy / market / sell per model, trim and year; installments left out', () => {
  const D = require('../src/deals.js');
  const mk = (i, price, extra = {}) => ({ token: `t${i}`, brand: 'شاهین G', year: 1401, price, mileage: 60000 + i * 5000, title: 'شاهین', description: '', ...extra });
  const posts = [2350, 2370, 2400, 2410, 2420, 2450, 2470, 2570].map((m, i) => mk(i, m * 1e6));
  posts.push(mk(20, 1200e6, { description: 'اقساط بدون ضامن، پیش پرداخت' })); // down payment: left out
  posts.push(mk(21, 4000e6)); // far off: left out
  posts.push({ ...mk(30, 2600e6), year: 1402 }, { ...mk(31, 2620e6), year: 1402 }); // too few
  const g = D.priceGuide(posts);
  const y1401 = g.find((x) => x.year === 1401);
  assert.equal(y1401.n, 8);
  assert.equal(y1401.enough, true);
  assert.equal(y1401.sure, true);
  assert.equal(y1401.market, 2415e6);
  assert.ok(y1401.buyGood < y1401.market && y1401.market < y1401.sellList);
  assert.ok(y1401.sellFast >= y1401.buyGood && y1401.sellFast < y1401.market);
  assert.equal(y1401.buyGood % 5e6, 0, 'rounded to 5 million');
  const y1402 = g.find((x) => x.year === 1402);
  assert.equal(y1402.enough, false, 'two ads are not enough');
  assert.equal(g[0].year, 1401, 'cards with enough ads come first');
  // My car: more km or paint lowers the price; low km raises it.
  const base = D.myCarPrice(y1401, { body: 'clean' });
  assert.ok(D.myCarPrice(y1401, { mileage: 150000, body: 'clean' }).sellList < base.sellList);
  assert.ok(D.myCarPrice(y1401, { body: 'paint' }).sellList < base.sellList);
  assert.ok(D.myCarPrice(y1401, { mileage: 20000, body: 'clean' }).sellList > base.sellList);
});

test('budget: best buys judged against their own model + year; gaps listed for follow-up searches', () => {
  const D = require('../src/deals.js');
  const { followUpSearches } = require('../src/budget.js');
  const mk = (i, brand, year, price, extra = {}) => ({ token: `b${i}`, brand, year, price, mileage: 100000, title: brand, description: '', seller: 'personal', body: 'سالم و بی‌خط و خش', ...extra });
  const posts = [
    ...[960, 990, 1000, 1010, 1020, 1040].map((m, i) => mk(i, 'پژو 206 تیپ ۵', 1397, m * 1e6)),
    mk(10, 'پژو 206 تیپ ۵', 1397, 900e6, { description: 'لاستیک نو، تسمه تایم تازه' }), // cheapest + extras
    mk(11, 'پژو 206 تیپ ۵', 1397, 930e6, { body: 'رنگ‌شدگی در ۳ ناحیه' }),
    mk(12, 'پراید 131 SE', 1399, 950e6), // no comparables
    mk(13, 'پژو 206 تیپ ۵', 1397, 500e6, { description: 'اقساط بدون ضامن' }), // out of range
  ];
  const guide = D.priceGuide(posts);
  const r = D.budgetPicks(posts, guide, { min: 850e6, max: 1000e6 });
  assert.equal(r.picks[0].token, 'b10', 'cheapest healthy one with extras ranks first');
  assert.match(r.picks[0].reasons.join(' '), /زیر قیمت/);
  assert.match(r.picks[0].reasons.join(' '), /لاستیک نو/);
  assert.ok(r.picks.find((x) => x.token === 'b11').score < r.picks[0].score, 'paint lowers the score');
  assert.ok(!r.picks.some((x) => x.post.price > 1000e6), 'over budget left out');
  assert.equal(r.missing.length, 1);
  assert.equal(r.missing[0].label, 'پراید 131'); // the model from Divar's catalog
  // After the price-range search, the bot lines up a search for the model without comparables.
  const store = { db: { ads: Object.fromEntries(posts.map((p) => [p.token, { post: p }])) } };
  const run = { criteria: { city: 'tehran', maxAgeDays: 30, speed: 'slow', batch: 'abc123', budget: { min: 850e6, max: 1000e6 } } };
  const more = followUpSearches(store, run);
  assert.deepEqual(more.map((c) => [c.query, c.yearMin, c.yearMax, c.batch]), [['پراید 131', 1399, 1399, 'abc123']]);
});

test('search queue: waits for the bot, keeps order, holds at the daily cap, drops a stopped batch', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const { Cloud } = require('../src/cloud.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radyab-queue-'));
  let today = 0;
  const started = [];
  const scanner = { busy: false, free: () => !scanner.busy, start: (c) => { started.push(c.query); return { id: 'x' }; } };
  const cloud = new Cloud({ store: { dailyCount: () => today, capFor: () => 300 }, scanner, dataDir: dir });
  cloud.enqueue([{ query: 'a', batch: 'b1' }, { query: 'b', batch: 'b1' }, { query: 'c', batch: 'b2' }]);
  scanner.busy = true; cloud.startPending(); assert.deepEqual(started, [], 'waits while busy');
  scanner.busy = false; cloud.startPending(); assert.deepEqual(started, ['a']);
  today = 300; cloud.startPending(); assert.deepEqual(started, ['a'], 'holds at the daily cap');
  today = 0; cloud.dropBatch('b1'); cloud.startPending(); assert.deepEqual(started, ['a', 'c'], 'the stopped batch is dropped');
  // kept on disk
  assert.deepEqual(new Cloud({ store: { dailyCount: () => 0, capFor: () => 300 }, scanner, dataDir: dir }).pending.length, 0);
});

test('search queue: a Bama search starts while a Divar one runs; each site keeps its order', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const { Cloud } = require('../src/cloud.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radyab-queue2-'));
  const busy = { divar: true, bama: false };
  const started = [];
  const site = (c) => (c.source === 'bama' ? 'bama' : 'divar');
  const scanner = { free: (c) => !busy[site(c)], start: (c) => { started.push(c.query); busy[site(c)] = true; return { id: c.query }; } };
  const cloud = new Cloud({ store: { dailyCount: () => 0, capFor: () => 300 }, scanner, dataDir: dir });
  cloud.enqueue([{ query: 'd1' }, { query: 'b1', source: 'bama' }, { query: 'd2' }, { query: 'b2', source: 'bama' }]);
  cloud.startPending();
  assert.deepEqual(started, ['b1'], 'Divar busy: the first Bama search starts');
  busy.divar = false; busy.bama = false; cloud.startPending();
  assert.deepEqual(started, ['b1', 'd1', 'b2'], 'one of each, in their order');
  assert.deepEqual(cloud.pending.map((c) => c.query), ['d2']);
});

test('daily cap: each site has its own, set in the settings; a full site does not hold the others', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const { Store } = require('../src/store.js');
  const { Cloud } = require('../src/cloud.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radyab-caps-'));
  const store = new Store(dir);
  assert.deepEqual(store.caps(), { divar: 300, bama: 300, hamrah: 300, k45: 300 });
  assert.deepEqual(store.setCaps({ divar: 2, bama: '5', hamrah: 0, k45: 99999 }), { divar: 2, bama: 5, hamrah: 300, k45: 2000 });
  store.countView('divar'); store.countView('divar'); store.countView('bama');
  assert.equal(store.dailyCount('divar'), 2);
  assert.equal(store.dailyCount('bama'), 1);
  assert.equal(store.dailyCount(), 3);
  assert.deepEqual(store.dailyCounts(), { divar: 2, bama: 1 });
  const started = [];
  const scanner = { free: () => true, start: (c) => { started.push(c.query); return { id: c.query }; } };
  const cloud = new Cloud({ store, scanner, dataDir: dir });
  cloud.enqueue([{ query: 'd1' }, { query: 'b1', source: 'bama' }]);
  cloud.startPending();
  assert.deepEqual(started, ['b1'], 'the first site is at its cap of 2; Bama (1 of 5) goes on');
  // the caps travel to the online panel as a hidden saved search
  assert.ok(store.db.searches.__caps.criteria.hidden);
});

test('scanner pool: one bot per site', () => {
  const { ScannerPool } = require('../src/pool');
  const pool = new ScannerPool({ context: null, store: {} });
  const fake = (id) => ({ id, criteria: {} });
  pool.scanners.divar.current = fake('r1'); pool.scanners.divar.current.status = 'reading';
  assert.equal(pool.free({ source: 'bama' }), true);
  assert.equal(pool.free({}), false);
  assert.equal(pool.runById('r1').id, 'r1');
  assert.equal(pool.byRun('nope'), null);
  assert.deepEqual(pool.runs.map((r) => r.id), ['r1']);
});

test('one trim whatever the word order; manuals never priced against automatics or turbos', () => {
  const D = require('../src/deals');
  assert.equal(D.trimKey('پلاس 5 دنده ساده EF7'), D.trimKey('پلاس EF7 5 دنده ساده'));
  const dena = (token, price, year, brand, gearbox) => ({ ...base, token, price: price * 1e6, mileage: 60000, year, brand, gearbox });
  const posts = [
    // the same manual trim, written both ways, a few years around
    dena('m1', 2500, 1399, 'دنا پلاس EF7 5 دنده ساده', 'دنده‌ای'), dena('m2', 2750, 1401, 'دنا پلاس EF7 5 دنده ساده', 'دنده‌ای'),
    dena('m3', 2400, 1402, 'دنا پلاس 5 دنده ساده EF7', 'دنده‌ای'), dena('m4', 2700, 1403, 'دنا پلاس EF7 5 دنده ساده', 'دنده‌ای'),
    dena('ad', 2650, 1401, 'دنا پلاس 5 دنده ساده EF7', 'دنده‌ای'),
    // many automatic turbos of the same year (much dearer)
    ...[3050, 3100, 3080, 3120, 3200, 2950, 3020].map((p, i) => dena(`at${i}`, p, 1401, 'دنا پلاس EF7 اتوماتیک توربو آپشنال', 'اتوماتیک')),
  ];
  const d = computeDeals(posts).get('ad');
  assert.ok(d.expected > 2.55e9 && d.expected < 2.8e9, `usual price from manuals only (${d.expected})`);
  assert.equal(d.level, null, 'not a special offer');
  assert.equal(D.kindOf(posts[0]).gear, 'manual');
  assert.deepEqual(D.kindOf(posts[5]), { gear: 'auto', turbo: true });
});

test('a used car is never priced above today\'s new car of its kind (less ~4% a year)', () => {
  const newPrices = [
    { make: 'دنا', model: 'پلاس EF7P', trim: '6 دنده', year: 1405, kind: 'بازار', price: 3330000000 },
    { make: 'دنا', model: 'پلاس EF7P', trim: '6 دنده', year: 1405, kind: 'بازار', price: 3250000000 },
    { make: 'دنا', model: 'پلاس EF7', trim: 'اتوماتیک توربو آپشنال', year: 1405, kind: 'بازار', price: 4400000000 },
    { make: 'دنا', model: 'پلاس EF7P', trim: '6 دنده', year: 1405, kind: 'کارخانه', price: 2083000000 },
  ];
  // only inflated asking prices of a manual 1401: the usual price is held at the new price less 4 years
  const posts = [3300, 3350, 3400, 3380, 3420, 3360].map((p, i) => ({ ...base, token: `x${i}`, price: p * 1e6, mileage: 60000, year: 1401, brand: 'دنا پلاس 5 دنده ساده EF7', gearbox: 'دنده‌ای' }));
  const d = computeDeals(posts, { newPrices }).get('x0');
  assert.deepEqual(d.newCar, { min: 3250000000, max: 3330000000, year: 1405 }); // manual rows, market prices only
  assert.equal(d.capped, true);
  assert.equal(d.expected, Math.round(3330000000 * 0.96 ** 4));
  // without the list: as before
  assert.equal(computeDeals(posts).get('x0').capped, false);
});

test('a new-car list read only partly keeps the other makes and is read again', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const { Store } = require('../src/store.js');
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'radyab-np-')));
  const row = (make, i) => ({ make, model: `m${i}`, trim: '', year: 1405, kind: 'بازار', price: 1e9 + i });
  store.setBamaPrices([...Array.from({ length: 300 }, (_, i) => row('آ', i)), ...Array.from({ length: 200 }, (_, i) => row('دنا', i))]);
  assert.ok(store.bamaPricesAt() > 0, 'full list: done for today');
  store.setBamaPrices(Array.from({ length: 100 }, (_, i) => row('آ', i))); // cut short after the first make
  const items = store.db.searches.__bama_prices.criteria.bamaPrices.items;
  assert.equal(items.filter((r) => r.make === 'دنا').length, 200, 'the makes not reached are kept');
  assert.equal(store.bamaPricesAt(), 0, 'read again at the next Bama search');
});

test('models from Divar\'s catalog: real models apart, trim-level entries folded into their car', () => {
  const P = require('../src/parser');
  const key = (b) => P.modelOf({ brand: b }).key;
  assert.equal(key('سمند سورن پلاس XU7P بنزینی'), 'سمند سورن');
  assert.equal(key('سمند LX ساده'), 'سمند');
  assert.equal(key('شاهین G'), key('شاهین GL دنده ای'));
  assert.equal(key('پراید 131 SE'), 'پراید 131');
  assert.notEqual(key('پراید 131 SE'), key('پراید وانت 151 GX'));
  assert.notEqual(key('تیبا 2 (هاچبک) EX'), key('تیبا صندوق‌دار'));
  assert.equal(key('دنا پلاس EF7 اتوماتیک توربو'), 'دنا');
  assert.equal(P.modelOf({ brand: 'جک S5 2.0 لیتر اتوماتیک' }).label, 'جک S5'); // shown as written
  assert.equal(key('سمند سورن پلاس XU7P بنزینیآگهی‌های بیشتر برای سمند سورن'), 'سمند سورن');
});
