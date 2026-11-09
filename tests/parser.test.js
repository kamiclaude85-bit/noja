'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/parser.js');
const { postJson, buildDataset } = require('./fixtures/mock-divar.js');

test('digit and number parsing', () => {
  assert.equal(P.toEnDigits('۱۳۹۷'), '1397');
  assert.equal(P.parseNumber('۶۵۰٬۰۰۰٬۰۰۰ تومان'), 650000000);
  assert.equal(P.parseNumber('120,000'), 120000);
  assert.equal(P.parseNumber('۱٫۲ میلیارد'), 1200000000);
  assert.equal(P.parseNumber('۴۸۵ میلیون'), 485000000);
  assert.equal(P.parseNumber('توافقی'), null);
  assert.equal(P.normalizeYear('97'), 1397);
  assert.equal(P.normalizeYear('۰۲'), 1402);
  assert.equal(P.normalizeYear('1397'), 1397);
});

test('token extraction from Divar links', () => {
  assert.equal(P.extractTokenFromHref('/v/پژو-206-تیپ-2/AaBb12Cd'), 'AaBb12Cd');
  assert.equal(P.extractTokenFromHref('https://divar.ir/v/%D9%BE%DA%98%D9%88/gZ9x_Kq-1'), 'gZ9x_Kq-1');
  assert.equal(P.extractTokenFromHref('/v/AaBb12Cd'), 'AaBb12Cd');
  assert.equal(P.extractTokenFromHref('/s/tehran/car'), null);
});

test('extracts car specs from post JSON', () => {
  const json = postJson({
    title: 'پژو ۲۰۶ تیپ ۲ مدل ۱۳۹۷', subtitle: '۲ ساعت پیش در تهران، پونک', km: 125000, year: 1397,
    color: 'سفید', price: 485000000, description: 'دست اول', businessType: 'personal', seed: 'abc',
  });
  const p = P.extractPost(json, 'abc');
  assert.equal(p.title, 'پژو ۲۰۶ تیپ ۲ مدل ۱۳۹۷');
  assert.equal(p.subtitle, '۲ ساعت پیش در تهران، پونک');
  assert.equal(p.mileage, 125000);
  assert.equal(p.year, 1397);
  assert.equal(p.color, 'سفید');
  assert.equal(p.price, 485000000);
  assert.equal(p.gearbox, 'دنده‌ای');
  assert.equal(p.fuel, 'بنزینی');
  assert.equal(p.engine, 'سالم');
  assert.equal(p.insurance, '۸ ماه');
  assert.match(p.chassis, /شاسی جلو: سالم و پلمپ/);
  assert.match(p.chassis, /شاسی عقب: سالم و پلمپ/);
  assert.equal(p.images.length, 3);
  assert.equal(p.url, 'https://divar.ir/v/abc');
  assert.equal(p.seller, 'personal');
  assert.equal(p.sellerConfidence, 'high');
});

test('negotiable price', () => {
  const p = P.extractPost(postJson({ title: 't', km: 1, year: 1397, color: 'x', price: null }), 't1');
  assert.equal(p.price, null);
  assert.equal(p.priceText, 'توافقی');
});

test('dealer detection: Divar business marker', () => {
  const p = P.extractPost(postJson({ title: 't', km: 1, year: 1397, color: 'x', price: 1, businessType: 'premium-panel' }), 't');
  assert.equal(p.seller, 'dealer');
  assert.equal(p.sellerConfidence, 'high');
});

test('dealer detection: dealership badge text', () => {
  const p = P.extractPost(postJson({ title: 't', subtitle: 'لحظاتی پیش در تهران · نمایشگاه اتوگالری ستاره', km: 1, year: 1397, color: 'x', price: 1 }), 't');
  assert.equal(p.seller, 'dealer');
  assert.equal(p.sellerConfidence, 'high');
});

test('dealer detection: description keywords only => likely dealer', () => {
  const p = P.extractPost(postJson({
    title: 't', km: 1, year: 1397, color: 'x', price: 1,
    description: 'نمایشگاه خودرو آرمان\nخرید و فروش انواع خودروهای صفر و کارکرده\nساعات کاری ۹ تا ۲۱',
  }), 't');
  assert.equal(p.seller, 'dealer');
  assert.equal(p.sellerConfidence, 'low');
});

test('personal ad that merely mentions a dealership stays personal', () => {
  const p = P.extractPost(postJson({
    title: 't', km: 1, year: 1397, color: 'x', price: 1,
    description: 'ماشین شخصی، از نمایشگاه خریده بودم، دو سال دستمه. کارشناسی آزاد.',
  }), 't');
  assert.equal(p.seller, 'personal');
});

test('falls back to list-card info when details are missing', () => {
  const p = P.extractPost({}, 'tok', {
    title: 'پژو ۲۰۶ مدل ۹۷', image: 'https://s100.divarcdn.com/a.jpg',
    lines: ['پژو ۲۰۶ مدل ۹۷', '۱۲۰٬۰۰۰ کیلومتر', '۴۹۰٬۰۰۰٬۰۰۰ تومان', 'لحظاتی پیش در پونک'],
  });
  assert.equal(p.title, 'پژو ۲۰۶ مدل ۹۷');
  assert.equal(p.price, 490000000);
  assert.equal(p.mileage, 120000);
  assert.equal(p.subtitle, 'لحظاتی پیش در پونک');
  assert.deepEqual(p.images, ['https://s100.divarcdn.com/a.jpg']);
});

test('criteria matching', () => {
  const base = { title: 'پژو ۲۰۶ تیپ ۲', brand: 'پژو 206 تیپ ۲', year: 1397, price: 480e6, mileage: 100000 };
  assert.equal(P.matchesCriteria(base, { yearMin: 97, yearMax: 97 }), true);
  assert.equal(P.matchesCriteria({ ...base, year: 1396 }, { yearMin: 1397, yearMax: 1397 }), false);
  assert.equal(P.matchesCriteria({ ...base, year: null }, { yearMin: 1397 }), true);
  assert.equal(P.matchesCriteria({ ...base, year: null }, { yearMin: 1397, strictYear: true }), false);
  assert.equal(P.matchesCriteria(base, { keyword: '206' }), true);
  assert.equal(P.matchesCriteria({ ...base, title: 'پژو ۲۰۷', brand: 'پژو 207' }, { keyword: '۲۰۶' }), false);
  assert.equal(P.matchesCriteria(base, { priceMax: 450e6 }), false);
  assert.equal(P.matchesCriteria(base, { mileageMax: 90000 }), false);
});

test('search URL', () => {
  const url = P.buildSearchUrl({ city: 'tehran', query: 'پژو ۲۰۶', yearMin: 97, yearMax: 97 });
  const u = new URL(url);
  assert.equal(u.pathname, '/s/tehran/car');
  assert.equal(u.searchParams.get('q'), 'پژو ۲۰۶');
  assert.equal(u.searchParams.get('production-year'), '1397-1397');
});

test('whole mock dataset classifies as expected', () => {
  const { posts } = buildDataset(40);
  const parsed = Object.entries(posts).map(([t, j]) => P.extractPost(j, t));
  const dealers = parsed.filter((p) => p.seller === 'dealer').length;
  assert.equal(dealers, 16); // kinds 3 and 4 => 2 of every 5
  assert.ok(parsed.every((p) => p.year && p.mileage));
});

test('installments, guarantor, «شرایطی» … mean a dealer; negated ones do not', () => {
  const base = { title: 'پژو ۲۰۶ مدل ۹۷', description: 'دست اول، بی رنگ', fields: {} };
  const seller = (over) => P.classifySeller({ ...base, ...over });

  assert.equal(seller({}).seller, 'personal');
  for (const title of ['شاهین g مدل ۱۴۰۲ سانروف دار بیرنگ اقساط بدون ضامن', 'دنا پلاس شرایطی', 'تیبا ۹۹ فروش قسطی']) {
    const p = seller({ title });
    assert.equal(p.seller, 'dealer', title);
    assert.equal(p.sellerConfidence, 'medium');
    assert.match(p.sellerReasons[0], /اقساطی\/شرایطی/);
  }
  assert.equal(seller({ description: 'نقد و اقساط با حداقل پیش پرداخت' }).seller, 'dealer');
  assert.equal(seller({ fields: { 'امکان خرید قسطی': 'دارد' } }).seller, 'dealer');
  assert.equal(seller({ fields: { 'امکان خرید قسطی': 'ندارد' } }).seller, 'personal');
  // A private seller saying "no installments":
  assert.equal(seller({ description: 'فقط نقد، اقساط نداریم' }).seller, 'personal');
  assert.equal(seller({ description: 'قسطی نمی‌فروشم' }).seller, 'personal');
});

test('saved ads get the new seller rule; sure dealers stay dealers', () => {
  const old = { title: 'شاهین اقساط بدون ضامن', description: '', fields: {}, seller: 'personal', sellerConfidence: 'medium', sellerReasons: [] };
  assert.equal(P.reclassifySaved(old).seller, 'dealer');
  const sure = { title: 'پژو', description: '', fields: {}, seller: 'dealer', sellerConfidence: 'high', sellerReasons: ['برچسب «نمایشگاه در فردوس»'] };
  assert.deepEqual(P.reclassifySaved({ ...sure }).sellerReasons, ['برچسب «نمایشگاه در فردوس»']);
});

test('Persian dates, «X پیش», place and car model', () => {
  assert.deepEqual(P.jalaliToGregorian(1405, 8, 18), [2026, 11, 9]);
  assert.deepEqual(P.jalaliToGregorian(1404, 1, 1), [2025, 3, 21]);
  assert.deepEqual(P.jalaliToGregorian(1403, 12, 30), [2025, 3, 20]);
  assert.equal(new Date(P.parseFaDateTime('۱ فروردین ۱۴۰۵، ۰۰:۰۰')).toISOString(), '2026-03-20T20:30:00.000Z');
  assert.equal(P.parseFaDateTime('بدون تاریخ'), null);
  const at = Date.UTC(2026, 10, 9, 12);
  assert.equal(P.parseRelativeAgo('۳ ساعت پیش در تهران', at), at - 3 * 3600000);
  assert.equal(P.parseRelativeAgo('۲ هفته پیش', at), at - 14 * 86400000);
  assert.equal(P.parseRelativeAgo('دیروز در تهران', at), at - 86400000);
  assert.equal(P.parseRelativeAgo('نمایشگاه در فردوس', at), null);
  assert.equal(P.placeOf('۲ ساعت پیش در تهران، شهرری'), 'تهران، شهرری');
  assert.equal(P.placeOf('نمایشگاه در فردوس'), 'نمایشگاه در فردوس');
  // Saved ads without the exact date get an estimate, marked as such.
  const saved = P.estimatePublished({ subtitle: '۶ ساعت پیش در تهران، نارمک' }, at);
  assert.equal(saved.publishedAt, at - 6 * 3600000);
  assert.equal(saved.publishedApprox, true);
  // Model groups: same model whether read with breadcrumbs or from «برند و مدل».
  assert.equal(P.modelOf({ brand: 'شاهین G' }).key, P.modelOf({ brand: 'شاهین G CVT', make: 'سایپا', model: 'شاهین', trim: 'G CVT' }).key);
  assert.deepEqual(P.modelOf({ brand: 'پژو 206 SD V8' }), { key: 'پژو 206', label: 'پژو 206', trim: 'SD V8' });
  assert.equal(P.modelOf({}).label, 'نامشخص');
});

test('«X پیش» in words, for the «آگهی‌های تا چه مدت پیش» period', () => {
  const at = Date.UTC(2026, 10, 9, 12);
  const days = (s) => Math.round((at - P.parseRelativeAgo(s, at)) / 86400000);
  assert.equal(days('یک ماه پیش در تهران'), 30);
  assert.equal(days('دو هفته پیش'), 14);
  assert.equal(days('هفتهٔ پیش در کرج'), 7);
  assert.ok(days('بیش از یک ماه پیش') > 30);
  assert.equal(days('۳ هفته پیش'), 21);
  assert.equal(P.parseRelativeAgo('نردبان شده', at), null, 'bumped ads have no time');
  assert.equal(P.parseRelativeAgo('دقایقی پیش', at), at - 5 * 60000);
});

test('value tags: recent repairs and extras from the ad text; negations and bad signs', () => {
  const tags = (description, extra = {}) => P.valueTags({ title: '', description, ...extra }).map((t) => t.key);
  assert.deepEqual(tags('چهار حلقه لاستیک نو، تسمه تایم تازه عوض شده، باتری نو'), ['tires', 'timing', 'battery']);
  assert.deepEqual(tags('سانروف دار، رینگ اسپرت، دوربین دنده عقب'), ['sunroof', 'rims', 'sensor']);
  assert.deepEqual(tags('لاستیک نو نیست. سانروف ندارد'), [], 'negated');
  assert.deepEqual(tags('لاستیک ها نیاز به تعویض دارد'), ['tires-bad']);
  assert.deepEqual(tags('کمی روغن سوزی دارد'), ['oil']);
  assert.deepEqual(tags('', { insurance: '۱۱ ماه' }), ['insurance']);
  const boost = P.valueBoost(P.valueTags({ description: 'لاستیک نو تسمه تایم نو دیسک و صفحه نو سانروف رینگ اسپرت باتری نو کمک فنر نو لنت نو دست اول' }));
  assert.equal(boost, 0.05, 'capped at 5%');
  assert.ok(P.valueBoost(P.valueTags({ description: 'روغن سوزی دارد، نیاز به تعمیر' })) < 0);
});
