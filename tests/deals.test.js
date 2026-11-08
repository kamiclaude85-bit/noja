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
