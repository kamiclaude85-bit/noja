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
    car('a', 500, 100000), car('b', 505, 95000), car('c', 495, 105000), car('d', 510, 90000),
    car('deal', 430, 100000),
    car('other-year', 400, 100000, { year: 1394 }),
  ];
  const d = computeDeals(posts);
  assert.equal(d.get('deal').deal, true);
  assert.equal(d.get('deal').level, 'hot');
  assert.ok(d.get('deal').reasons[0].includes('ارزان‌تر از قیمت معمول'));
  assert.equal(d.get('a').deal, false);
  assert.equal(d.has('other-year'), false, 'not compared with other years');
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
