/*
 * End-to-end test of the Chrome bot against a mocked Divar website.
 *
 *  - Chromium is driven exactly as in real use (the bot browses pages; no API).
 *  - divar.ir is replaced by mock pages (search list with infinite scroll, ad pages
 *    in two different layouts, a captcha page, a deleted ad).
 *  - Checks: login wait, captcha wait + «ادامه», every extracted field, seller type,
 *    UI tabs, CSV, and that a second run is served from the cache.
 *
 *   node tests/bot.e2e.js [screenshotDir]
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startApp } = require('../src/app');
const { buildDataset, searchPageHtml, adPageHtml, captchaPageHtml } = require('./fixtures/mock-divar.js');

const SHOTS = process.argv[2] ? path.resolve(process.argv[2]) : null;
const COUNT = 40;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function carSvg(seed) {
  let hue = 0;
  for (const c of seed) hue = (hue * 31 + c.charCodeAt(0)) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">
<rect width="640" height="400" fill="hsl(${hue},35%,78%)"/><rect y="300" width="640" height="100" fill="hsl(${hue},15%,45%)"/>
<path d="M150 280 L190 210 Q205 185 240 185 L400 185 Q430 185 450 210 L500 250 L530 258 Q550 262 550 282 L550 300 L130 300 L130 290 Q130 280 150 280Z" fill="#f5f5f5" stroke="#334" stroke-width="4"/>
<path d="M215 215 L245 200 L310 200 L310 245 L200 245Z M325 200 L395 200 Q415 200 430 215 L455 245 L325 245Z" fill="#9db4c8"/>
<circle cx="215" cy="302" r="34" fill="#222"/><circle cx="465" cy="302" r="34" fill="#222"/></svg>`;
}

async function waitFor(fn, what, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${what}`);
}

(async () => {
  const { specs, list } = buildDataset(COUNT);
  const captchaToken = list[3].token;
  const goneToken = list[7].token;
  let captchaShown = 0;
  const adHits = [];

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'noja-bot-'));
  const context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    headless: true,
    viewport: { width: 1360, height: 900 },
    deviceScaleFactor: SHOTS ? 2 : 1,
    locale: 'fa-IR',
  });
  // Nothing may reach Divar's API.
  await context.route('https://api.divar.ir/**', (route) => { throw new Error(`API was called: ${route.request().url()}`); });
  await context.route('https://divar.ir/**', (route) => {
    const url = new URL(route.request().url());
    const html = (body, status = 200) => route.fulfill({ status, contentType: 'text/html; charset=utf-8', body });
    if (url.pathname.startsWith('/s/')) return html(searchPageHtml(list));
    if (url.pathname.startsWith('/v/')) {
      const token = decodeURIComponent(url.pathname.split('/').pop());
      adHits.push(token);
      if (token === captchaToken && captchaShown++ === 0) return html(captchaPageHtml(), 429);
      if (token === goneToken) return html('<html><body><h1>این آگهی حذف شده است</h1></body></html>', 404);
      return specs[token] ? html(adPageHtml(specs[token])) : html('not found', 404);
    }
    return html('<!doctype html><html lang="fa"><body><h1>دیوار</h1><a href="/my-divar">دیوار من</a></body></html>');
  });
  await context.route('https://s100.divarcdn.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: carSvg(route.request().url()) }));

  const app = await startApp({ context, dataDir: path.join(tmp, 'data'), port: 4799, log: () => {} });
  const panel = context.pages().find((p) => p.url().startsWith(app.panelUrl));
  assert.ok(panel, 'control panel opened in Chrome');
  await panel.waitForSelector('#loginState .dot');
  assert.match(await panel.textContent('#loginState'), /نشده‌اید/);

  // ---- Fill the form in the panel ----
  await panel.fill('input[name=query]', 'پژو ۲۰۶');
  await panel.fill('input[name=keyword]', '206');
  await panel.fill('input[name=yearMin]', '97');
  await panel.fill('input[name=yearMax]', '۹۷');
  await panel.fill('input[name=maxAds]', '100');
  await panel.evaluate(() => document.activeElement && document.activeElement.blur());
  if (SHOTS) await panel.screenshot({ path: path.join(SHOTS, 'panel.png') });
  await panel.evaluate(() => {
    const sel = document.querySelector('select[name=speed]');
    sel.add(new Option('test', 'test'));
    sel.value = 'test';
  });
  await panel.click('button.go');
  await panel.waitForURL(/results\.html\?run=/);
  const runId = new URL(panel.url()).searchParams.get('run');
  const getRun = async () => (await fetch(`${app.panelUrl}api/runs/${runId}`)).json();

  // ---- Login wait ----
  await waitFor(async () => (await getRun()).status === 'waiting-login', 'login prompt');
  await panel.bringToFront();
  await panel.waitForSelector('#banner.attn');
  assert.match(await panel.textContent('#banner'), /وارد حساب دیوار شوید/);
  if (SHOTS) await panel.screenshot({ path: path.join(SHOTS, 'waiting-login.png') });
  // The user logs in inside the Divar tab -> Divar sets its session cookie.
  await context.addCookies([{ name: 'token', value: 'x'.repeat(48), domain: '.divar.ir', path: '/' }]);

  // ---- Captcha wait, user presses «ادامه» ----
  await waitFor(async () => (await getRun()).status === 'blocked', 'captcha prompt');
  await panel.bringToFront();
  await panel.waitForSelector('#banner.attn');
  assert.match(await panel.textContent('#banner'), /تأیید/);
  await panel.click('#bannerBtns .btn-main');

  // ---- Finish ----
  const run = await waitFor(async () => { const r = await getRun(); return r.status === 'done' ? r : null; }, 'run to finish', 180000);
  assert.equal(run.items.length, COUNT, 'all ads collected by scrolling');
  assert.deepEqual(Object.keys(run.errors), [goneToken], 'only the deleted ad failed');
  assert.equal(run.posts.length, COUNT - 1);

  // Every field extracted from the rendered pages (both layouts) matches the source data.
  const P = require('../src/parser');
  for (const post of run.posts) {
    const s = specs[post.token];
    const where = `${post.token}${s.classless ? ' (plain layout)' : ''}`;
    assert.equal(post.title, s.title, `title ${where}`);
    assert.equal(post.year, s.year, `year ${where}`);
    assert.equal(post.mileage, s.km, `mileage ${where}`);
    assert.equal(post.price, s.price, `price ${where}`);
    assert.equal(post.color, s.color, `color ${where}`);
    assert.equal(post.body, s.body, `body ${where}`);
    assert.equal(post.engine, s.engine, `engine ${where}`);
    assert.equal(post.gearbox, s.gearbox, `gearbox ${where}`);
    assert.equal(post.brand, s.brand, `brand ${where}`);
    assert.equal(post.insurance, '۸ ماه', `insurance ${where}`);
    assert.match(post.chassis, /شاسی جلو: سالم و پلمپ/, `chassis ${where}`);
    assert.equal(post.subtitle, s.subtitle, `subtitle ${where}`);
    assert.equal(post.images.length, s.images, `images ${where}`);
    assert.ok(post.description.includes(s.description.split('\n')[0]), `description ${where}`);
    const expectedSeller = s.kind >= 3 ? 'dealer' : 'personal';
    assert.equal(post.seller, expectedSeller, `seller ${where}: ${post.sellerReasons.join(' | ')}`);
    if (s.kind === 3) assert.equal(post.sellerConfidence, 'high', `dealer link detected ${where}`);
  }

  // ---- UI ----
  await panel.bringToFront();
  await panel.reload();
  await panel.waitForSelector('#list article.card');
  const expected = run.posts.filter((p) => P.matchesCriteria(p, run.criteria));
  const cards = await panel.locator('#list article.card:not(:has(.err))').count();
  assert.equal(cards, expected.length, 'matching cards rendered');
  await panel.click('#tabs button[data-tab=dealer]');
  assert.equal(await panel.locator('#list article.card').count(), expected.filter((p) => p.seller === 'dealer').length);
  await panel.click('#tabs button[data-tab=personal]');
  assert.equal(await panel.locator('#list article.card').count(), expected.filter((p) => p.seller === 'personal').length);
  await panel.click('#tabs button[data-tab=all]');
  const [download] = await Promise.all([panel.waitForEvent('download'), panel.click('#exportBtn')]);
  const csv = fs.readFileSync(await download.path(), 'utf8');
  assert.equal(csv.trim().split(/\r\n/).length, expected.length + 1, 'CSV rows');

  if (SHOTS) {
    await panel.locator('#list article.card .fav').nth(1).click();
    await panel.evaluate(() => window.scrollTo(0, 0));
    await panel.screenshot({ path: path.join(SHOTS, 'results-cards.png') });
    await panel.click('.seg button[data-view=table]');
    await panel.screenshot({ path: path.join(SHOTS, 'results-table.png') });
    await panel.click('.seg button[data-view=cards]');
  }

  // ---- Second run: ads are served from the cache, no ad page is opened again ----
  const hitsBefore = adHits.length;
  const res = await fetch(`${app.panelUrl}api/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: app.panelUrl.replace(/\/$/, '') },
    body: JSON.stringify({ query: 'پژو ۲۰۶', yearMin: '97', yearMax: '97', speed: 'test', maxAds: 100 }),
  });
  const { id: run2 } = await res.json();
  await waitFor(async () => (await (await fetch(`${app.panelUrl}api/runs/${run2}`)).json()).status === 'done', 'second run');
  const reopened = adHits.slice(hitsBefore);
  assert.ok(reopened.every((t) => t === goneToken), `only the failed ad is visited again (got ${reopened.length})`);

  // Cross-site requests to the local API are refused.
  const evil = await fetch(`${app.panelUrl}api/scan`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' });
  assert.equal(evil.status, 403);

  await app.close();
  await context.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`bot e2e OK — ${run.posts.length} ads read from pages, ${expected.length} match, `
    + `${expected.filter((p) => p.seller === 'dealer').length} dealer / ${expected.filter((p) => p.seller === 'personal').length} personal`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
