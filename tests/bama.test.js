'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../src/bama');
const D = require('../src/deals');
const P = require('../src/parser');

const makes = [
  { href: 'https://bama.ir/car/peugeot', text: 'خرید و فروش پژو' },
  { href: 'https://bama.ir/car/peugeot-pars', text: 'خرید و فروش پژو پارس' },
  { href: 'https://bama.ir/car/saina', text: 'خرید و فروش ساینا' },
  { href: 'https://bama.ir/car/saipa', text: 'خرید و فروش سایپا' },
];
const models = [
  { href: 'https://bama.ir/car/peugeot-206ir', text: 'خرید و فروش پژو 206' },
  { href: 'https://bama.ir/car/peugeot-206sd', text: 'خرید و فروش پژو 206 SD' },
  { href: 'https://bama.ir/car/peugeot-207', text: 'خرید و فروش پژو 207' },
  { href: 'https://bama.ir/car/peugeot-207sd', text: 'خرید و فروش پژو 207 صندوقدار' },
  { href: 'https://bama.ir/car/peugeot-2008', text: 'خرید و فروش پژو 2008' },
];

test('bama: the make and model are picked from what was asked', () => {
  assert.equal(B.pickLink(makes, 'پژو 207i').href, 'https://bama.ir/car/peugeot');
  assert.equal(B.pickLink(makes, 'پژو پارس').href, 'https://bama.ir/car/peugeot-pars');
  assert.equal(B.pickLink(makes, 'ساینا').href, 'https://bama.ir/car/saina');
  assert.equal(B.pickLink(models, 'پژو 207i').href, 'https://bama.ir/car/peugeot-207', '«207» matches «207i», not 2008 or the sedan');
  assert.equal(B.pickLink(models, 'پژو 206 SD').href, 'https://bama.ir/car/peugeot-206sd');
  assert.equal(B.pickLink(models, 'پژو 206').href, 'https://bama.ir/car/peugeot-206ir');
  assert.equal(B.pickLink(makes, 'تویوتا'), null);
});

test('bama: tokens, years and list addresses', () => {
  assert.equal(B.tokenOf('/car/detail-uwx5rlrz-samand-soren-plus-1402'), 'bm-uwx5rlrz');
  assert.equal(B.yearOfHref('https://bama.ir/car/detail-uwx5rlrz-samand-soren-plus-1402'), 1402);
  assert.equal(B.priceOf(['تهران', '2,900,000,000', 'تومان']), 2900000000);
  assert.equal(B.listUrl('https://bama.ir/car/peugeot-207', { yearMin: 1402, yearMax: 1402 }), 'https://bama.ir/car/peugeot-207-y1402');
  assert.equal(B.listUrl('https://bama.ir/car/peugeot-207', { yearMin: 1400, yearMax: 1403, personalOnly: true }, { sort: 'cheapest' }), 'https://bama.ir/car/peugeot-207?seller=1&sort=4');
});

test('bama: the city goes in the address', () => {
  assert.equal(B.listUrl('https://bama.ir/car/peugeot-207', { city: 'karaj', yearMin: 1402, yearMax: 1402 }), 'https://bama.ir/car/peugeot-207-y1402/alborz-karaj');
  assert.equal(B.listUrl('https://bama.ir/car', { city: 'tehran' }), 'https://bama.ir/car/all/tehran-tehran');
  assert.equal(B.listUrl('https://bama.ir/car/saina', { city: 'iran' }), 'https://bama.ir/car/saina', 'all of Iran: no city');
  assert.equal(B.listUrl('https://bama.ir/car/saina/fars-shiraz', { city: 'tehran' }), 'https://bama.ir/car/saina/fars-shiraz', 'a pasted link keeps its city');
});

test('bama: an ad page becomes a post like a Divar one; body words in Divar terms', () => {
  assert.equal(B.bodyInDivarWords('بدون رنگ'), 'سالم و بی‌خط و خش');
  assert.equal(B.bodyInDivarWords('دو لکه رنگ'), 'رنگ‌شدگی در ۲ ناحیه');
  assert.equal(B.bodyInDivarWords('دور رنگ'), 'دوررنگ');
  const raw = {
    ld: { '@type': ['Product', 'Car'], name: 'سمند،  سورن', url: 'https://bama.ir/car/detail-uwx5rlrz-samand-soren-plus-1402',
      description: 'خرید خودرو سمند سورن پلاس EF7 بنزینی تولید 1402 در شهر تهران، سورن پلاس فول سفارشی', brand: { name: 'سمند' },
      vehicleModelDate: 1402, mileageFromOdometer: { value: 27000 }, color: 'سفید', vehicleTransmission: 'دنده ای', offers: { price: '2900000000' } },
    rows: { 'وضعیت بدنه': 'بدون رنگ', گیربکس: 'دنده ای' },
    trim: 'پلاس EF7 بنزینی',
    ago: 'لحظاتی پیش',
    place: 'تهران، شهرک گلها',
    dealer: '',
    images: ['https://cdn-sth1.bama.ir/uploads/BamaImages/VehicleCarImages/x/a.jpg'],
  };
  const p = B.toPost(raw, { href: raw.ld.url });
  assert.equal(p.token, 'bm-uwx5rlrz');
  assert.equal(p.source, 'bama');
  assert.equal(p.price, 2900000000);
  assert.equal(p.mileage, 27000);
  assert.equal(p.year, 1402);
  assert.equal(p.brand, 'سمند سورن پلاس EF7 بنزینی');
  assert.equal(p.body, 'سالم و بی‌خط و خش');
  assert.equal(p.description, 'سورن پلاس فول سفارشی');
  assert.equal(p.seller, 'personal');
  assert.ok(!/09\d{9}/.test(P.toEnDigits(JSON.stringify({ ...p, publishedAt: 0 }))), 'no phone number');
  const dealer = B.toPost({ ...raw, dealer: 'تجارت خودرو خسروانی' }, { href: raw.ld.url });
  assert.equal(dealer.seller, 'dealer');
});

test('the same car on Divar and Bama is found, and counted once in a market', () => {
  const car = (token, price, source, km = 60000) => ({ token, source, brand: 'پژو 207 دنده ای', year: 1402, mileage: km, price: price * 1e6, title: 'پژو', description: '' });
  const posts = [car('d1', 2500, undefined), car('bm-1', 2520, 'bama', 61000), car('d2', 2400, undefined, 90000), car('d3', 2450, undefined, 70000)];
  const dup = D.crossDuplicates(posts);
  assert.equal(dup.get('d1'), 'bm-1');
  assert.equal(dup.get('bm-1'), 'd1');
  assert.equal(dup.has('d2'), false);
  const g = D.priceGuide(posts).find((x) => x.year === 1402);
  assert.equal(g.total, 3, 'four ads, three cars');
});
