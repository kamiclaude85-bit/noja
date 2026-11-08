/*
 * End-to-end test: loads the unpacked extension in Chromium, serves a mocked
 * Divar (search page + post API), and runs the whole flow:
 * popup -> Divar search tab -> auto-scroll collection -> results page.
 *
 *   node tests/e2e.js [screenshotDir]
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { buildDataset, searchPageHtml } = require('./fixtures/mock-divar.js');

const EXT = path.resolve(__dirname, '..', 'extension');
const SHOTS = process.argv[2] ? path.resolve(process.argv[2]) : null;
const COUNT = 40;

async function waitForPage(context, test, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const page = context.pages().find((pg) => test(pg.url()));
    if (page) return page;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('page did not open');
}

function carSvg(seed) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${h},35%,82%)"/><stop offset="1" stop-color="hsl(${h},30%,62%)"/></linearGradient></defs>
<rect width="640" height="400" fill="url(#g)"/><rect y="300" width="640" height="100" fill="hsl(${h},15%,45%)"/>
<path d="M150 280 L190 210 Q205 185 240 185 L400 185 Q430 185 450 210 L500 250 L530 258 Q550 262 550 282 L550 300 L130 300 L130 290 Q130 280 150 280Z" fill="hsl(${(h + 180) % 360},10%,96%)" stroke="#334" stroke-width="4"/>
<path d="M215 215 L245 200 L310 200 L310 245 L200 245Z M325 200 L395 200 Q415 200 430 215 L455 245 L325 245Z" fill="#9db4c8"/>
<circle cx="215" cy="302" r="34" fill="#222"/><circle cx="215" cy="302" r="14" fill="#bbb"/>
<circle cx="465" cy="302" r="34" fill="#222"/><circle cx="465" cy="302" r="14" fill="#bbb"/></svg>`;
}

(async () => {
  const { posts, list } = buildDataset(COUNT);
  const failToken = list[5].token;         // API + page both fail -> shown as error
  const rateToken = list[2].token;         // first API call is rate-limited
  let rateHits = 0;
  const apiCalls = [];

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noja-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1360, height: 900 },
    deviceScaleFactor: SHOTS ? 2 : 1,
    locale: 'fa-IR',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });

  await context.route('https://divar.ir/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/s/')) {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: searchPageHtml(list) });
    }
    return route.fulfill({ status: 404, body: 'not found' });
  });
  await context.route('https://api.divar.ir/**', (route) => {
    const token = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop());
    apiCalls.push(token);
    if (token === failToken) return route.fulfill({ status: 500, body: 'boom' });
    if (token === rateToken && rateHits++ === 0) return route.fulfill({ status: 429, body: 'slow down' });
    const json = posts[token];
    if (!json) return route.fulfill({ status: 404, body: '{}' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json), headers: { 'access-control-allow-origin': '*' } });
  });
  await context.route('https://s100.divarcdn.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: carSvg(route.request().url()) }));

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;

  // 1. Popup: fill the form and submit.
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 380, height: 640 });
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  await popup.fill('input[name=query]', 'پژو ۲۰۶');
  await popup.fill('input[name=keyword]', '206');
  await popup.fill('input[name=yearMin]', '97');
  await popup.fill('input[name=yearMax]', '۹۷');
  await popup.fill('input[name=maxAds]', '100');
  if (SHOTS) await popup.screenshot({ path: path.join(SHOTS, 'popup.png') });

  await popup.click('button[type=submit]');
  const searchTab = await waitForPage(context, (u) => u.startsWith('https://divar.ir/s/'));
  const searchUrl = new URL(searchTab.url());
  assert.equal(searchUrl.pathname, '/s/tehran/car');
  assert.equal(searchUrl.searchParams.get('q'), 'پژو ۲۰۶');
  assert.equal(searchUrl.searchParams.get('production-year'), '1397-1397');
  await searchTab.waitForSelector('#noja-overlay', { timeout: 15000 });
  if (SHOTS) {
    await searchTab.waitForTimeout(2500);
    await searchTab.screenshot({ path: path.join(SHOTS, 'collecting.png') });
  }

  // 2. Results page.
  const results = await waitForPage(context, (u) => u.includes('/results/results.html'), 120000);
  await results.waitForFunction(() => /تمام شد/.test(document.querySelector('#progressText').textContent), null, { timeout: 120000 });
  await results.waitForTimeout(400);

  const job = await results.evaluate(async () => {
    const { lastJobId } = await chrome.storage.local.get('lastJobId');
    return (await chrome.storage.local.get(`job:${lastJobId}`))[`job:${lastJobId}`];
  });
  assert.equal(job.items.length, COUNT, 'all ads collected from the infinite list');

  // Expected: year 1397, keyword 206 (excludes the 207 titles).
  const P = require('../extension/src/parser.js');
  const expected = list.filter((it) => it.token !== failToken)
    .map((it) => P.extractPost(posts[it.token], it.token))
    .filter((p) => P.matchesCriteria(p, { yearMin: 1397, yearMax: 1397, keyword: '206' }));
  const cards = await results.locator('#list article.card:not(:has(.err))').count();
  assert.equal(cards, expected.length, 'matching cards rendered');
  const errCards = await results.locator('#list .err').count();
  assert.equal(errCards, 1, 'one error card for the failing ad');
  assert.ok(rateHits >= 2, 'rate-limited ad was retried');

  await results.click('#tabs button[data-tab=personal]');
  const personalCount = await results.locator('#list article.card').count();
  assert.equal(personalCount, expected.filter((p) => p.seller === 'personal').length);
  await results.click('#tabs button[data-tab=dealer]');
  const dealerCount = await results.locator('#list article.card').count();
  assert.equal(dealerCount, expected.filter((p) => p.seller === 'dealer').length);
  await results.click('#tabs button[data-tab=all]');

  await results.selectOption('#sort', 'price-asc');
  const prices = await results.$$eval('#list article.card .price', (els) => els.map((e) => e.getAttribute('title')).filter(Boolean));
  const nums = prices.map((t) => P.parseNumber(t));
  assert.deepEqual(nums, [...nums].sort((a, b) => a - b), 'sorted by price');

  // Favorites persist.
  await results.locator('#list article.card .fav').first().click();
  await results.waitForTimeout(400);
  await results.click('#tabs button[data-tab=fav]');
  assert.equal(await results.locator('#list article.card').count(), 1);
  await results.click('#tabs button[data-tab=all]');
  await results.selectOption('#sort', 'default');

  // CSV export.
  const [download] = await Promise.all([results.waitForEvent('download'), results.click('#exportBtn')]);
  const csv = fs.readFileSync(await download.path(), 'utf8');
  assert.ok(csv.startsWith('﻿عنوان,نوع فروشنده'));
  assert.equal(csv.trim().split(/\r\n/).length, expected.length + 1);

  if (SHOTS) {
    await results.evaluate(() => window.scrollTo(0, 0));
    await results.screenshot({ path: path.join(SHOTS, 'results-cards.png') });
    await results.click('.seg button[data-view=table]');
    await results.waitForTimeout(300);
    await results.screenshot({ path: path.join(SHOTS, 'results-table.png') });
    await results.click('.seg button[data-view=cards]');
  }

  // Re-opening uses the cache (no new API calls).
  const callsBefore = apiCalls.length;
  await results.reload();
  await results.waitForFunction(() => /تمام شد/.test(document.querySelector('#progressText').textContent), null, { timeout: 60000 });
  const extra = apiCalls.slice(callsBefore);
  assert.ok(extra.every((t) => t === failToken), `only the failed ad is fetched again on reload (got ${extra.join(',')})`);

  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  console.log(`e2e OK — ${expected.length} matching ads, ${dealerCount} dealer, ${personalCount} personal`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
