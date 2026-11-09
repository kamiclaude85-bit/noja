/*
 * Page scripts against pages saved from the REAL divar.ir (Aban 1405), not the mock.
 * Saved without scripts, styles, the map snapshot or any contact data.
 *
 *   tests/fixtures/divar-ad-personal.html   a personal ad (Peugeot 206, 1397)
 *   tests/fixtures/divar-ad-dealer.html     a dealer's ad (seller assessment with a hit chassis)
 *   tests/fixtures/divar-search.html        a search result page (24 cards)
 *
 * The pages are loaded into headless Chrome (or Playwright's Chromium) under their real
 * divar.ir address; every other request is blocked, so the test runs offline.
 * Skipped when no browser can be started.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../src/page-scripts');
const P = require('../src/parser');

const FIX = path.join(__dirname, 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');

let browser = null;
let skipReason = '';

test.before(async () => {
  const { chromium } = require('playwright-core');
  for (const opts of [{ channel: 'chrome' }, { channel: 'msedge' }, {}]) {
    try {
      browser = await chromium.launch({ ...opts, headless: true });
      return;
    } catch (err) {
      skipReason = `no browser for page tests (${String(err.message || err).split('\n')[0]})`;
    }
  }
});

test.after(async () => { if (browser) await browser.close(); });

/** Open a saved page as if it were served by divar.ir, and run `fn` inside it. */
async function inPage(file, url, fn) {
  const page = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1366, height: 900 } });
  try {
    await page.route('**/*', (route) => (route.request().url() === url
      ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture(file) })
      : route.abort()));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    return await page.evaluate(fn);
  } finally {
    await page.close();
  }
}

const AD_URL = 'https://divar.ir/v/%DB%B2%DB%B0%DB%B6/gawz8kz7';
const DEALER_URL = 'https://divar.ir/v/%D9%BE%DA%98%D9%88%DB%B2%DB%B0%DB%B6/gaYDmVII';
const SEARCH_URL = 'https://divar.ir/s/tehran/car?q=%D9%BE%DA%98%D9%88+%DB%B2%DB%B0%DB%B6&production-year=1397-1397';

test('real personal ad: every spec, the seller assessment, photos and description', async (t) => {
  if (!browser) return t.skip(skipReason);
  const raw = await inPage('divar-ad-personal.html', AD_URL, S.extractAdPage);
  const p = P.extractPost(raw, 'gawz8kz7');

  assert.equal(p.title, '۲۰۶شاسی سالم بی رنگ..');
  assert.equal(p.subtitle, '۲ ساعت پیش در تهران، شهرری');
  // «انتشار آگهی: ۱۷ آبان ۱۴۰۵، ۲۲:۵۶» (Tehran) from the folded time/place row
  assert.equal(new Date(p.publishedAt).toISOString(), '2026-11-08T19:26:00.000Z');
  assert.equal(p.publishedApprox, undefined, 'exact, not estimated');
  // breadcrumbs: پژو › 206 › تیپ ۲
  assert.deepEqual([p.make, p.model, p.trim], ['پژو', '206', 'تیپ ۲']);
  assert.deepEqual(P.modelOf(p), { key: 'پژو 206', label: 'پژو 206', trim: 'تیپ ۲' });
  assert.equal(p.price, 1655000000);
  assert.equal(p.mileage, 170000);
  assert.equal(p.year, 1397);
  assert.equal(p.color, 'سفید');
  assert.equal(p.brand, 'پژو 206 تیپ ۲');
  assert.equal(p.gearbox, 'دنده‌ای'); // the type, not the assessment «سالم و پلمپ»
  assert.equal(p.fuel, 'بنزین');
  // «ارزیابی فروشنده» rows (kt-score-row): these used to pick up the mileage of the row above.
  assert.equal(p.engine, 'سالم');
  assert.equal(p.chassis, 'سالم و پلمپ');
  assert.equal(p.body, 'سالم و بی‌خط و خش');
  assert.equal(p.fields['وضعیت گیربکس'], 'سالم و پلمپ');
  assert.ok(!Object.values(p.fields).includes(''), 'no empty values');
  assert.ok(!('زنگ خطرهای قبل از معامله' in p.fields), 'link rows are not specs');

  assert.match(p.description, /^ماشین بدونه هیچ خرجی/);
  assert.match(p.description, /بازدید قرچک ورامین$/);
  assert.match(p.description, /\n/, 'line breaks are kept');
  assert.doesNotMatch(p.description, /انتشار آگهی/, 'not the hidden publish date');

  // 6 photos: 3 large ones already loaded + 3 thumbnails for the lazy ones; no duplicates, no map.
  assert.equal(p.images.length, 6);
  const files = p.images.map((u) => u.split('/').pop());
  assert.equal(new Set(files).size, 6);
  assert.ok(p.images.slice(0, 3).every((u) => /webp_post/.test(u)));
  assert.ok(p.images.every((u) => !/mapimage/.test(u)));

  assert.equal(p.seller, 'personal');
});

test('real dealer ad: front/rear chassis, paint, insurance; dealer from keywords and list card', async (t) => {
  if (!browser) return t.skip(skipReason);
  const raw = await inPage('divar-ad-dealer.html', DEALER_URL, S.extractAdPage);
  const p = P.extractPost(raw, 'gaYDmVII');

  assert.equal(p.price, 1450000000);
  // published ۲۹ مهر ۱۴۰۵، ۱۰:۱۹ and bumped («نردبان») ۱۷ آبان ۱۴۰۵، ۱۰:۵۷
  assert.equal(new Date(p.publishedAt).toISOString(), '2026-10-21T06:49:00.000Z');
  assert.equal(new Date(p.bumpedAt).toISOString(), '2026-11-08T07:27:00.000Z');
  assert.equal(p.mileage, 150000);
  assert.equal(p.year, 1397);
  assert.equal(p.color, 'مشکی');
  assert.equal(p.insurance, '۶ ماه');
  assert.equal(p.engine, 'سالم');
  assert.equal(p.chassis, 'شاسی جلو: ضربه‌خورده، شاسی عقب: سالم و پلمپ');
  assert.equal(p.body, 'رنگ‌شدگی در ۳ ناحیه');
  assert.equal(p.gearbox, 'دنده‌ای');
  assert.equal(p.images.length, 5);
  assert.match(p.description, /^فروش نقد و اقساط انواع خودرو/);

  // The ad page itself has no dealer badge; selling on installments gives it away…
  assert.equal(p.seller, 'dealer');
  assert.equal(p.sellerConfidence, 'medium');
  assert.match(p.sellerReasons.join(' '), /اقساط/);
  assert.match(p.sellerReasons.join(' '), /امکان خرید قسطی: دارد/);
  // …and the search-list card says «نمایشگاه در فردوس», which makes it certain.
  const withCard = P.extractPost(raw, 'gaYDmVII', { lines: ['پژو۲۰۶تیپ۵ مدل۹۷ نقدواقساط(اتوجلیلیان)', '۱۵۰,۰۰۰ کیلومتر', '۱,۴۵۰,۰۰۰,۰۰۰ تومان', 'نردبان شده', 'نمایشگاه در فردوس'] });
  assert.equal(withCard.seller, 'dealer');
  assert.equal(withCard.sellerConfidence, 'high');
});

test('real search page: 24 cards with token, title, mileage, price and photo', async (t) => {
  if (!browser) return t.skip(skipReason);
  const items = await inPage('divar-search.html', SEARCH_URL, S.collectListItems);
  assert.equal(items.length, 24);
  assert.equal(new Set(items.map((i) => i.token)).size, 24);
  for (const it of items) {
    assert.match(it.token, /^[A-Za-z0-9_-]{8}$/);
    assert.ok(it.href.startsWith('https://divar.ir/v/'));
    assert.ok(it.title.length > 0);
    assert.ok(it.lines.some((l) => /تومان|توافقی/.test(l)), `price line for ${it.token}`);
    assert.ok(it.lines.some((l) => /کیلومتر/.test(l)), `mileage line for ${it.token}`);
  }
  assert.ok(items.filter((i) => /divarcdn/.test(i.image)).length >= 20);
});

test('next-page link: found when Divar shows «بعدی», none on the saved page', async (t) => {
  if (!browser) return t.skip(skipReason);
  assert.equal(await inPage('divar-search.html', SEARCH_URL, S.nextPageLink), null);
  const page = await browser.newPage();
  try {
    const html = fixture('divar-search.html').replace('</main>',
      `<div><a href="${SEARCH_URL}&amp;page=1">بعدی</a></div></main>`);
    await page.route('**/*', (r) => (r.request().url() === SEARCH_URL
      ? r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }) : r.abort()));
    await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded' });
    const next = await page.evaluate(S.nextPageLink);
    assert.equal(next.href, `${SEARCH_URL}&page=1`);
    assert.equal(next.visible, true);
  } finally {
    await page.close();
  }
});
