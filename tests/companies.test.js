'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/companies');
const P = require('../src/parser');
const D = require('../src/deals');

test('tokens and site of an address', () => {
  assert.equal(C.tokenOf('hamrah', '/cars-for-sale/irankhodro/peugeot206/3620110/'), 'hm-3620110');
  assert.equal(C.tokenOf('k45', 'https://khodro45.com/buy-car/peugeot-206/tehran/cla-17im9a/'), 'k45-cla-17im9a');
  assert.equal(C.tokenOf('k45', '/buy-car/peugeot-206/tehran/'), null);
  assert.equal(C.siteOfUrl('https://www.hamrah-mechanic.com/cars-for-sale/'), 'hamrah');
  assert.equal(C.siteOfUrl('https://khodro45.com/buy-car/'), 'k45');
  assert.equal(C.siteOfUrl('http://khodro45.com/buy-car/'), null);
  assert.equal(C.siteOfToken('k45-cla-1'), 'k45');
});

test('list cards of both sites', () => {
  const hm = C.parseCard(['پژو 206', '1400', 'تیپ 2', '85,525 km', 'دنده ای', 'تهران، پیروزی', 'قیمت', '1,850,000,000', 'تومان']);
  assert.deepEqual(hm, { name: 'پژو 206', year: 1400, trim: 'تیپ 2', km: 85525, gearbox: 'دنده ای', place: 'تهران، پیروزی', price: 1850000000 });
  // a special offer: the current price first, the old one crossed out after it
  const offer = C.parseCard(['ام جی 360', '1397', 'اتوماتیک توربو', '115,114 km', 'اتومات', 'تهران، شعبه تهرانپارس', 'قیمت', '3,250,000,000', 'تومان', '3,400,000,000', '4٪']);
  assert.equal(offer.price, 3250000000);
  assert.equal(offer.trim, 'اتوماتیک توربو');
  const k = C.parseCard(['خرید اقساطی', 'پژو', '206', '1400', 'تیپ 2', '86,575 km', 'تهران', 'شاسی پلمپ', 'خدمات خودرو۴۵', 'قیمت', '1,818,000,000']);
  assert.equal(k.name, 'پژو 206');
  assert.equal(k.place, 'تهران');
  assert.equal(k.price, 1818000000);
  // the price box of a Khodro45 ad page (Persian digits)
  const box = C.parseCard(['پژو', '206', '۱۳۹۶', 'تیپ 5', '۱۹۲,۳۴۱ کیلومتر', 'خدمات خودرو ۴۵', 'قیمت', 'تومان']);
  assert.equal(box.year, 1396);
  assert.equal(box.km, 192341);
  assert.equal(box.trim, 'تیپ 5');
});

test('make and model from the site\'s own list', () => {
  const k45 = [
    { brand: 'پژو', model: '', path: '/buy-car/peugeot/' }, { brand: 'پژو', model: '206', path: '/buy-car/peugeot-206/' },
    { brand: 'پژو', model: '206 SD', path: '/buy-car/peugeot-206sd/' }, { brand: 'پژو', model: 'پارس', path: '/buy-car/peugeot-pars/' },
    { brand: 'شاهین', model: '', path: '/buy-car/shahin/' }, { brand: 'شاهین', model: 'G', path: '/buy-car/shahin-g/' },
  ];
  assert.equal(C.pickModel(k45, 'پژو 206').path, '/buy-car/peugeot-206/');
  assert.equal(C.pickModel(k45, 'پژو 206 صندوقدار').path, '/buy-car/peugeot-206/'); // «SD» is not a word asked for
  assert.equal(C.pickModel(k45, 'شاهین').path, '/buy-car/shahin/');
  assert.equal(C.pickModel(k45, 'پژو').path, '/buy-car/peugeot/');
  assert.equal(C.pickModel(k45, 'تیبا'), null);
  const hm = [{ brand: 'پژو', model: 'پژو 206', path: '/cars-for-sale/peugeot/peugeot206/' }, { brand: 'پژو', model: 'پژو 206 صندوقدار', path: '/cars-for-sale/peugeot/peugeot206sedan/' }];
  assert.equal(C.pickModel(hm, 'پژو 206').path, '/cars-for-sale/peugeot/peugeot206/');
  assert.deepEqual(C.hamrahMakes([['peugeot', 'پژو'], ['saipa', 'سایپا'], ['irankhodro', 'ایران خودرو']], 'شاهین').map((x) => x[0]), ['saipa']);
  assert.deepEqual(C.hamrahMakes([['peugeot', 'پژو'], ['saipa', 'سایپا'], ['irankhodro', 'ایران خودرو']], 'پژو 206').map((x) => x[0]), ['peugeot', 'irankhodro']);
  assert.equal(C.listUrl('k45', '/buy-car/peugeot-206/', { city: 'tehran' }), 'https://khodro45.com/buy-car/peugeot-206/tehran/');
  assert.equal(C.listUrl('k45', '/buy-car/peugeot-206/', { city: 'iran' }), 'https://khodro45.com/buy-car/peugeot-206/');
  assert.equal(C.listUrl('k45', '/buy-car/peugeot-206/tehran/', {}, 2), 'https://khodro45.com/buy-car/peugeot-206/tehran/?page=2');
  assert.ok(C.inCity('تهران، پیروزی', 'تهران'));
  assert.ok(!C.inCity('کرج، گلشهر', 'تهران'));
});

test('expert report → body words the price rules understand', () => {
  const r = C.bodyFromReport([
    { part: 'شاسی جلو راننده', text: 'ضربه کف اتاق' },
    { part: 'سقف', text: 'صافکاری بدون رنگ' },
    { part: 'درب موتور', text: 'تعویض و رنگ' },
    { part: 'گلگیر راننده جلو', text: 'استوک تعویضی, رنگ پریدگی و ضربه' },
    { part: 'سپر جلو', text: 'تعویض شده, شکستگی' },
    { part: 'رکاب راننده', text: 'رنگ پریدگی و ضربه' },
  ]);
  assert.deepEqual(r.painted, ['درب موتور']);
  assert.deepEqual(r.replaced, ['درب موتور', 'گلگیر راننده جلو']); // not the bumper
  assert.equal(r.chassis, 'سالم'); // a scraped floor is not a frame repair
  const lv = P.bodyCondition({ body: r.body, chassis: r.chassis });
  assert.equal(lv.level, 'replaced');
  const clean = C.bodyFromReport([{ part: 'سینی فن و جاچراغی', text: 'خوردگی جزئی' }]);
  assert.equal(clean.body, 'صافکاری بی‌رنگ');
  const crash = C.bodyFromReport([{ part: 'سینی فن و جاچراغی', text: 'کشیده و صافکاری شده' }, { part: 'کاپوت', text: 'رنگ شدگی' }, { part: 'گلگیر جلو شاگرد', text: 'رنگ شدگی' }, { part: 'درب عقب شاگرد', text: 'رنگ شدگی' }]);
  assert.equal(P.bodyCondition({ body: crash.body, chassis: crash.chassis }).level, 'accident');
  assert.match(crash.body, /رنگ‌شدگی در 3 ناحیه/);
});

test('an ad of each site becomes a post like Divar\'s, with no phone number', () => {
  const item = { token: 'hm-3620110', href: 'https://www.hamrah-mechanic.com/cars-for-sale/irankhodro/peugeot206/3620110/',
    lines: ['پژو 206', '1400', 'تیپ 2', '85,525 km', 'دنده ای', 'تهران، پیروزی', 'قیمت', '1,850,000,000', 'تومان'] };
  const raw = { url: item.href, name: 'پژو 206', trim: 'تیپ 2', year: 1400, km: 85525, place: 'تهران، پیروزی', price: 1850000000,
    rows: { 'وضعیت فنی': 'سالم', 'وضعیت بدنه': '1 قطعه تعویض', 'رنگ بدنه': 'سفید', 'مانده بیمه': '4 ماه', 'شماره مشاور': '09905361858' },
    parts: [{ part: 'کاپوت', text: 'رنگ شدگی' }, { part: 'کاپوت', text: 'تعویض شدگی' }], images: ['https://ncdn.hamrah-mechanic.com/a.jpg'] };
  const p = C.toPost('hamrah', raw, item);
  assert.equal(p.source, 'hamrah');
  assert.equal(p.brand, 'پژو 206 تیپ 2');
  assert.equal(p.price, 1850000000);
  assert.equal(p.mileage, 85525);
  assert.equal(p.seller, 'dealer');
  assert.equal(p.engine, 'سالم');
  assert.equal(p.color, 'سفید');
  assert.match(p.body, /رنگ‌شدگی در 1 ناحیه، تعویض 1 قطعه/);
  assert.ok(!/09\d{9}/.test(JSON.stringify(p)));
  assert.ok(!D.isInstallment(p)); // «خرید اقساطی» on cards is a service, not the price
  // from the card alone (opened from the list, page data not read)
  const k = C.toPost('k45', { url: 'https://khodro45.com/buy-car/peugeot-206/tehran/cla-abc12/', rows: { بیمه: 'دارد' }, parts: [], images: [] },
    { token: 'k45-cla-abc12', href: 'https://khodro45.com/buy-car/peugeot-206/tehran/cla-abc12/', lines: ['خرید اقساطی', 'پژو', '206', '1400', 'تیپ 2', '86,575 km', 'تهران', 'قیمت', '1,818,000,000'] });
  assert.equal(k.title, 'پژو 206 تیپ 2 1400');
  assert.equal(k.price, 1818000000);
  assert.equal(k.subtitle, 'در تهران');
  assert.ok(!D.isInstallment(k));
});

test('the same car on a company site and on Divar counts once in the market', () => {
  const base = { year: 1400, brand: 'پژو 206 تیپ 2', title: 'پژو 206 تیپ 2', mileage: 80000, publishedAt: Date.now() };
  const posts = [{ ...base, token: 'a', price: 1.8e9 }, { ...base, token: 'hm-1', source: 'hamrah', price: 1.81e9, mileage: 80500 }];
  const dup = D.crossDuplicates(posts);
  assert.equal(dup.get('a'), 'hm-1');
});
