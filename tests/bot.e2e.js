/*
 * End-to-end test of Noja against a mocked Divar website.
 *
 *  - Chromium is driven exactly as in real use (the bot browses pages; no API).
 *  - divar.ir is replaced by mock pages (search list with infinite scroll, ad pages
 *    in two layouts, a captcha page, a deleted ad).
 *  Day 1: login wait, captcha + «ادامه», every extracted field, seller type, human-like
 *         behaviour, list UI, compare, CSV.
 *  Follow-up: phone, «جواب نداد» (auto next call), visit, note, removal with reason + restore,
 *         dashboard counters, backups.
 *  Day 2: only the 8 new ads, one price change and the followed-up ads are opened; a followed-up
 *         ad that disappeared from Divar is marked as sold; scrolling stops at known ads.
 *
 *   node tests/bot.e2e.js [screenshotDir]
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startApp } = require('../src/app');
const P = require('../src/parser');
const { buildDataset, searchPageHtml, adPageHtml, captchaPageHtml } = require('./fixtures/mock-divar.js');

const http = require('node:http');

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

const shot = async (page, name) => { if (SHOTS) { await page.waitForTimeout(350); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); } };

(async () => {
  // 48 ads exist; on "day 1" only the 40 older ones are on Divar, on "day 2" 8 new ones appear on top.
  const { specs, list: allAds } = buildDataset(COUNT + 8);
  let list = allAds.slice(8);
  const captchaToken = list[3].token;
  const goneToken = list[7].token;
  const goneOnDay2 = new Set();
  let captchaShown = 0;
  const adHits = [];
  const adReferers = [];
  const listUrls = [];
  let newTabs = 0;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'noja-bot-'));
  const context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    headless: true,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: SHOTS ? 2 : 1,
    locale: 'fa-IR',
  });
  // Nothing may reach Divar's API.
  await context.route('https://api.divar.ir/**', (route) => { throw new Error(`API was called: ${route.request().url()}`); });
  await context.route('https://divar.ir/**', (route) => {
    const url = new URL(route.request().url());
    const html = (body, status = 200) => route.fulfill({ status, contentType: 'text/html; charset=utf-8', body });
    if (url.pathname.startsWith('/s/')) { listUrls.push(url.href); return html(searchPageHtml(list)); }
    if (url.pathname.startsWith('/v/')) {
      const token = decodeURIComponent(url.pathname.split('/').pop());
      adHits.push(token);
      adReferers.push(route.request().headers().referer || '');
      if (token === captchaToken && captchaShown++ === 0) return html(captchaPageHtml(), 429);
      if (token === goneToken || goneOnDay2.has(token)) return html('<html><body><h1>این آگهی حذف شده است</h1></body></html>', 404);
      return specs[token] ? html(adPageHtml(specs[token])) : html('not found', 404);
    }
    return html('<!doctype html><html lang="fa"><body><h1>دیوار</h1><a href="/my-divar">دیوار من</a></body></html>');
  });
  await context.route('https://s100.divarcdn.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: carSvg(route.request().url()) }));

  // Fake Bale bot API: records messages, returns one «سلام» update.
  const baleSent = [];
  const bale = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('/getUpdates')) return res.end(JSON.stringify({ ok: true, result: [{ update_id: 1, message: { chat: { id: 4242, first_name: 'کامران' }, text: 'سلام' } }] }));
      if (req.url.endsWith('/sendMessage')) { baleSent.push(JSON.parse(body)); return res.end(JSON.stringify({ ok: true, result: {} })); }
      res.statusCode = 404; return res.end('{}');
    });
  });
  await new Promise((r) => bale.listen(0, '127.0.0.1', r));
  const baleBase = `http://127.0.0.1:${bale.address().port}`;

  context.on('page', (pg) => { pg.waitForURL(/\/v\//, { timeout: 60000 }).then(() => { newTabs++; }).catch(() => {}); });
  const app = await startApp({ context, dataDir: path.join(tmp, 'data'), port: 4799, log: () => {}, notifyApiBases: { bale: baleBase } });
  const ui = context.pages().find((p) => p.url().startsWith(app.panelUrl));
  assert.ok(ui, 'Noja opened in Chrome');
  const getJson = async (p) => (await fetch(`${app.panelUrl}${p}`)).json();
  const postJson = (p, body) => fetch(`${app.panelUrl}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: app.panelUrl.replace(/\/$/, '') }, body: JSON.stringify(body),
  }).then((r) => r.json());
  const adOf = async (token) => (await getJson('api/ads')).ads.find((x) => x.token === token);

  // ---- Empty dashboard → new search ----
  await ui.waitForSelector('.empty.big');
  await waitFor(async () => /ورود/.test(await ui.textContent('#account')), 'account chip');
  await ui.click('.empty.big a[href="#/search"]');
  await ui.waitForSelector('input[name=query]');
  await ui.fill('input[name=query]', 'پژو ۲۰۶');
  await ui.fill('input[name=yearMin]', '97');
  await ui.fill('input[name=yearMax]', '۹۷');
  await ui.click('details.adv summary');
  await ui.fill('input[name=keyword]', '206');
  await ui.fill('input[name=maxAds]', '100');
  await ui.evaluate(() => document.activeElement && document.activeElement.blur());
  await shot(ui, 'search');
  await ui.evaluate(() => { const s = document.querySelector('select[name=speed]'); s.add(new Option('test', 'test')); s.value = 'test'; });
  await ui.click('form button[type=submit]');
  await ui.waitForURL(/#\/run\//);
  const runId = ui.url().split('#/run/')[1];
  const getRun = (id = runId) => getJson(`api/runs/${id}`);

  // ---- Login wait ----
  await waitFor(async () => (await getRun()).status === 'waiting-login', 'login prompt');
  await ui.bringToFront();
  await ui.waitForSelector('#status.attn');
  assert.match(await ui.textContent('#status'), /وارد حساب دیوار شوید/);
  await context.addCookies([{ name: 'token', value: 'x'.repeat(48), domain: '.divar.ir', path: '/' }]);

  // ---- Captcha wait, user presses «ادامه» ----
  await waitFor(async () => (await getRun()).status === 'blocked', 'captcha prompt');
  await ui.bringToFront();
  await ui.waitForSelector('#status.attn');
  assert.match(await ui.textContent('#status'), /تأیید/);
  await shot(ui, 'captcha');
  await ui.click('#status .btn.primary');

  // ---- Day 1 finished ----
  const run = await waitFor(async () => { const r = await getRun(); return r.status === 'done' ? r : null; }, 'run to finish', 180000);
  assert.equal(run.items.length, COUNT, 'all ads collected by scrolling');
  assert.deepEqual(Object.keys(run.errors), [goneToken], 'only the deleted ad failed');
  assert.equal(run.posts.length, COUNT - 1);
  assert.ok(!new URL(listUrls[0]).searchParams.has('q'), 'started from the city page');
  assert.ok(listUrls.some((u) => new URL(u).searchParams.get('q') === 'پژو ۲۰۶'), 'typed the car name into the search box');
  const fromList = adReferers.filter((r) => /\/s\//.test(r)).length;
  assert.ok(fromList / adReferers.length >= 0.7, `most ads opened from the list (${fromList}/${adReferers.length})`);
  assert.ok(newTabs > 0, 'some ads opened in a new tab');

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
    assert.match(post.chassis, /شاسی جلو: سالم و پلمپ/, `chassis ${where}`);
    assert.equal(post.subtitle, s.subtitle, `subtitle ${where}`);
    assert.equal(post.images.length, s.images, `images ${where}`);
    assert.equal(post.seller, s.kind >= 3 ? 'dealer' : 'personal', `seller ${where}: ${post.sellerReasons.join(' | ')}`);
  }

  // ---- Run results UI ----
  await ui.reload();
  await ui.waitForSelector('#results .row');
  const expected = run.posts.filter((p) => P.matchesCriteria(p, run.criteria));
  assert.equal(await ui.locator('#results .row').count(), expected.length, 'matching rows rendered');
  await ui.click('#sellerSeg button[data-v=dealer]');
  assert.equal(await ui.locator('#results .row').count(), expected.filter((p) => p.seller === 'dealer').length, 'dealer filter');
  await ui.click('#sellerSeg button[data-v=all]');
  const [download] = await Promise.all([ui.waitForEvent('download'), ui.click('button[aria-label="خروجی اکسل"]')]);
  assert.equal(fs.readFileSync(await download.path(), 'utf8').trim().split(/\r\n/).length, expected.length + 1, 'CSV rows');
  await ui.locator('#results .row .cmp-toggle').nth(0).click();
  await ui.locator('#results .row .cmp-toggle').nth(2).click();
  await ui.click('.tray .btn.primary');
  await ui.waitForSelector('.modal table.compare');
  await ui.keyboard.press('Escape');
  await ui.click('.tray .btn.ghost');

  // ---- Follow-up (CRM) on the ads page ----
  await ui.goto(`${app.panelUrl}#/ads`);
  await ui.waitForSelector('#results .row');
  const tokens = await ui.$$eval('#results .row', (els) => els.map((e) => e.dataset.token));
  const [tCall, tVisit, tReject, tStar] = tokens;

  // shortlist with the star
  await ui.click(`#results .row[data-token="${tStar}"] .star`);
  await waitFor(async () => (await adOf(tStar)).crm?.stage === 'shortlist', 'shortlist');

  // phone + note + «جواب نداد»
  await ui.click(`#results .row[data-token="${tCall}"]`);
  await ui.waitForSelector('.drawer .crm');
  await ui.fill('.drawer input[type=tel]', '0912 345 6789');
  await ui.press('.drawer input[type=tel]', 'Tab');
  await waitFor(async () => (await adOf(tCall)).crm?.phone, 'phone saved');
  await ui.fill('.drawer .crm textarea', 'گفت عصر زنگ بزنم');
  await ui.click('.drawer button:has-text("جواب نداد")');
  let crm = await waitFor(async () => { const a = await adOf(tCall); return a.crm && a.crm.missed === 1 ? a.crm : null; }, 'no-answer');
  assert.equal(crm.stage, 'calling');
  assert.equal(crm.phone, '0912 345 6789');
  assert.ok(Math.abs(crm.nextCallAt - (Date.now() + 3600e3)) < 120e3, 'next call scheduled ~1 hour later');
  assert.ok(crm.calls[0].note.includes('عصر'), 'note saved with the call');
  await ui.waitForSelector('.drawer .timeline li');
  await shot(ui, 'drawer-crm');
  await ui.keyboard.press('Escape');

  // visit tomorrow at 17:00
  await ui.click(`#results .row[data-token="${tVisit}"]`);
  await ui.waitForSelector('.drawer .crm');
  await ui.click('.drawer .crm-block:has-text("بازدید") .chips button:has-text("فردا")');
  await ui.click('.drawer button:has-text("ثبت قرار بازدید")');
  crm = await waitFor(async () => { const a = await adOf(tVisit); return a.crm && a.crm.stage === 'visit' ? a.crm : null; }, 'visit');
  assert.equal(new Date(crm.visitAt).getHours(), 17);
  await ui.keyboard.press('Escape');

  // remove with a reason, then restore
  await ui.click(`#results .row[data-token="${tReject}"]`);
  await ui.waitForSelector('.drawer .crm');
  await ui.click('.drawer button:has-text("حذف با دلیل")');
  await ui.click('.dialog button:has-text("گران است")');
  await ui.click('.dialog button.danger');
  await waitFor(async () => (await adOf(tReject)).crm?.stage === 'rejected', 'reject');
  await ui.keyboard.press('Escape');
  await ui.goto(`${app.panelUrl}#/ads?stage=rejected`);
  await ui.waitForSelector('#results .row');
  assert.equal(await ui.locator('#results .row').count(), 1, 'removed ad is in «حذف‌شده‌ها»');
  await ui.click('#results .row');
  await ui.click('.drawer button:has-text("برگرداندن")');
  await waitFor(async () => (await adOf(tReject)).crm?.stage === 'new', 'restore');
  await ui.keyboard.press('Escape');
  await postJson(`api/ads/${tReject}/crm`, { action: 'reject', reason: 'تصادفی / رنگ دارد' });

  // ---- Dashboard ----
  await ui.goto(`${app.panelUrl}#/`);
  await ui.waitForSelector('.kpis');
  const kpiValue = async (label) => P.toEnDigits((await ui.locator(`.kpi:has-text("${label}") .kpi-v`).textContent()).trim());
  await waitFor(async () => (await kpiValue('در حال پیگیری')) === '3', 'dashboard counters');
  assert.equal(await kpiValue('قرار بازدید'), '1');
  await shot(ui, 'dashboard');

  // ---- Backups ----
  await ui.goto(`${app.panelUrl}#/backup`);
  await ui.waitForSelector('.items .item');
  const before = await ui.locator('.items .item').count();
  await ui.click('button:has-text("پشتیبان همین حالا")');
  await waitFor(async () => (await ui.locator('.items .item').count()) === before + 1, 'new backup listed');
  await shot(ui, 'backup');
  const backups = (await getJson('api/backups')).backups;
  const gz = await (await fetch(`${app.panelUrl}api/backups/${backups[0].name}`)).arrayBuffer();
  const restored = JSON.parse(zlib.gunzipSync(Buffer.from(gz)));
  assert.equal(restored.db.ads[tCall].crm.phone, '0912 345 6789', 'backup contains follow-up data');

  // ---- Phone reminders via Bale ----
  await ui.goto(`${app.panelUrl}#/settings`);
  await ui.waitForSelector('.seg.chan');
  await ui.click('.seg.chan button:has-text("بله")');
  await ui.waitForSelector('.setup-steps');
  await ui.fill('.setup-steps input', '123456789:AAbbCCddEEffGGhhIIjj');
  await ui.click('.setup-steps button:has-text("ذخیره")');
  await ui.waitForSelector('.setup-step.done');
  await ui.click('.setup-steps button:has-text("اتصال")');
  await ui.waitForSelector('text=وصل است به');
  await ui.click('.setup-steps button:has-text("پیام آزمایشی")');
  await waitFor(() => baleSent.length === 1, 'test message');
  assert.equal(baleSent[0].chat_id, '4242');
  await ui.click('label:has-text("شب‌ها پیام نفرست") input');
  await waitFor(async () => (await getJson('api/settings/notify')).quiet.enabled === false, 'quiet off');
  await shot(ui, 'settings');
  // a due call is sent to the phone
  await postJson(`api/ads/${tCall}/crm`, { action: 'schedule', at: Date.now() - 1000 });
  await app.notifier.tick();
  assert.ok(baleSent.some((m) => /وقت تماس/.test(m.text) && m.text.includes('0912 345 6789')), 'call reminder sent with the phone number');

  // ---- Day 2: 8 new ads, one price drop, the visit ad was sold (deleted on Divar) ----
  list = allAds.slice();
  const cheaper = list.find((it, i) => i >= 8 && specs[it.token].price != null && ![captchaToken, goneToken, tCall, tVisit, tReject, tStar].includes(it.token));
  specs[cheaper.token].price -= 25000000;
  cheaper.price = specs[cheaper.token].price;
  goneOnDay2.add(tVisit);
  const hitsBefore = adHits.length;
  const r2 = await postJson('api/scan', { query: 'پژو ۲۰۶', yearMin: '97', yearMax: '97', keyword: '206', speed: 'test', maxAds: 100, trackRecheckHours: 0 });
  await ui.goto(`${app.panelUrl}#/run/${r2.id}`);
  const run2 = await waitFor(async () => { const r = await getRun(r2.id); return r.status === 'done' ? r : null; }, 'second run');
  const opened2 = new Set(adHits.slice(hitsBefore));
  const newTokens = allAds.slice(0, 8).map((it) => it.token);
  const followed = [tCall, tVisit, tStar]; // active stages are re-checked daily
  assert.deepEqual(opened2, new Set([...newTokens, cheaper.token, ...followed]), `opened: new + price change + followed-up (got ${opened2.size})`);
  assert.equal(run2.stats.newAds, 8);
  assert.equal(run2.stats.priceChanged, 1);
  assert.equal(run2.stats.sold, 1, 'the followed-up ad that disappeared is detected');
  assert.equal(run2.collectStop, 'known', 'stopped scrolling at already-seen ads');
  assert.ok((await adOf(tVisit)).removed, 'sold ad is marked as removed');
  const summary = await waitFor(() => baleSent.find((m) => /بررسی «پژو ۲۰۶» تمام شد/.test(m.text)), 'run summary on the phone');
  assert.match(summary.text, /۸ آگهی جدید، ۱ تغییر قیمت، ۱ آگهی پیگیری‌شده فروخته شد/);
  assert.match(summary.text, /https:\/\/divar\.ir\/v\//);
  await ui.waitForSelector('#results .row');
  await shot(ui, 'next-day');

  // ---- Price-range search (no model name) ----
  const r3 = await postJson('api/scan', { priceMin: 450e6, priceMax: 500e6, speed: 'test', maxAds: 50 });
  const run3 = await waitFor(async () => { const r = await getRun(r3.id); return r.status === 'done' ? r : null; }, 'price-range run');
  assert.equal(new URL(listUrls[listUrls.length - 1]).searchParams.get('price'), '450000000-500000000', 'price filter applied on Divar');
  await ui.goto(`${app.panelUrl}#/run/${r3.id}`);
  await ui.waitForSelector('#results .row');
  const inRange = run3.posts.filter((p) => P.matchesCriteria(p, run3.criteria));
  assert.ok(inRange.length > 0 && inRange.length < run3.posts.length, 'price range filters the ads');
  assert.equal(await ui.locator('#results .row').count(), inRange.length, 'only ads in the price range are shown');

  // ---- Special offers ----
  const D = require('../src/deals');
  const mem = (await getJson('api/ads')).ads;
  const dealMap = D.computeDeals(mem.map((a) => ({ ...a.post, removed: a.removed })));
  const expectedDeals = mem.filter((a) => dealMap.get(a.token) && dealMap.get(a.token).deal && !a.removed && a.crm?.stage !== 'rejected');
  assert.ok(expectedDeals.length > 0, 'the mock market has some special offers');
  await ui.goto(`${app.panelUrl}#/deals`);
  await ui.waitForSelector('#results .row');
  assert.equal(await ui.locator('#results .row').count(), expectedDeals.length, 'special offers listed');
  assert.ok(await ui.locator('#results .row .deal-badge').count() >= expectedDeals.length);
  await shot(ui, 'deals');
  await ui.locator('#results .row').first().click();
  await ui.waitForSelector('.drawer .deal-box');
  assert.match(await ui.textContent('.drawer .deal-box'), /ارزان‌تر از قیمت معمول/);
  await shot(ui, 'deal-drawer');
  await ui.keyboard.press('Escape');

  // Sold mark + alerts
  await ui.goto(`${app.panelUrl}#/ads?view=sold`);
  await ui.waitForSelector('#results .row.sold');
  await ui.goto(`${app.panelUrl}#/`);
  await ui.waitForSelector('.kpis');
  await ui.click('#bellBtn');
  await ui.waitForSelector('#bellPop .alert-item');
  assert.match(await ui.textContent('#bellPop'), /از دیوار حذف شد/);
  await shot(ui, 'dashboard-alerts');
  await ui.click('#bellBtn');

  await ui.goto(`${app.panelUrl}#/ads`);
  await ui.waitForSelector('#results .row');
  await shot(ui, 'ads');
  if (SHOTS) {
    await ui.setViewportSize({ width: 390, height: 844 });
    await ui.goto(`${app.panelUrl}#/`);
    await ui.waitForSelector('.kpis');
    await shot(ui, 'mobile-dashboard');
    await ui.goto(`${app.panelUrl}#/ads`);
    await ui.waitForSelector('#results .row');
    await shot(ui, 'mobile-ads');
    await ui.setViewportSize({ width: 1440, height: 900 });
  }

  // Cross-site requests to the local API are refused.
  const evil = await fetch(`${app.panelUrl}api/scan`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' });
  assert.equal(evil.status, 403);

  await app.close();
  bale.close();
  await context.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`e2e OK — day 1: ${run.posts.length} ads read; day 2: ${opened2.size} pages opened `
    + `(8 new, 1 price change, ${followed.length} followed-up, 1 sold); follow-up, dashboard, backups and phone reminders work`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
