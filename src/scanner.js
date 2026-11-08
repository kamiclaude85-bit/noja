/*
 * The bot: browses Divar in a real Chrome window the way one person would.
 *
 *   1. makes sure you are logged in (you log in yourself, once),
 *   2. goes to Divar, types the car name into the search box, applies the year filter,
 *   3. scrolls the result list to collect the ads,
 *   4. opens the ads from the list — usually by clicking, sometimes in a new tab —
 *      reads each page for a few seconds while scrolling, goes back, takes breaks,
 *      and stops at a daily cap.
 *
 * Pace and volume stay at what a single visitor would do. Captchas are always
 * handed to you; the bot never tries to get around them. No Divar API is used.
 */
'use strict';

const P = require('./parser');
const S = require('./page-scripts');
const H = require('./human');

/** Timing profiles (milliseconds). */
const SPEEDS = {
  slow: { read: [9000, 20000], gap: [2500, 7000], breakEvery: [12, 20], breakLen: [120000, 300000] },
  normal: { read: [6000, 14000], gap: [1500, 4500], breakEvery: [18, 30], breakLen: [60000, 180000] },
  fast: { read: [3500, 8000], gap: [800, 2500], breakEvery: [25, 40], breakLen: [30000, 90000] },
  test: { read: [60, 120], gap: [20, 50], breakEvery: [8, 12], breakLen: [300, 600] }, // automated tests only
};
const DEFAULT_DAILY_LIMIT = 300;

const fa = (n) => Number(n).toLocaleString('fa-IR');

async function isLoggedIn(context) {
  const cookies = await context.cookies('https://divar.ir');
  return cookies.some((c) => /token|jwt/i.test(c.name) && String(c.value).length >= 20);
}

class Scanner {
  constructor({ context, store, log = () => {} }) {
    this.context = context;
    this.store = store;
    this.log = log;
    this.current = null;
    this.control = null;
  }

  get busy() {
    return !!(this.current && !['done', 'stopped', 'error'].includes(this.current.status));
  }

  start(criteria) {
    if (this.busy) throw new Error('یک جستجو در حال انجام است.');
    const now = new Date();
    const id = `${now.toISOString().replace(/[-:T]/g, '').slice(0, 14)}_${Math.random().toString(36).slice(2, 6)}`;
    const run = {
      id,
      createdAt: now.getTime(),
      criteria,
      status: 'starting',
      message: 'در حال باز کردن دیوار…',
      activity: '',
      waitUntil: null,
      sourceUrl: '',
      items: [],
      posts: {},
      errors: {},
      stats: { opened: 0, cached: 0, readMs: 0 },
      finishedAt: null,
    };
    this.current = run;
    this.control = { paused: false, stop: false, resume: null };
    this.store.saveRun(run, true);
    this.run(run).catch((err) => {
      run.status = 'error';
      run.message = `خطا: ${err && err.message ? err.message : err}`;
      this.log(err);
      this.store.saveRun(run, true);
    });
    return run;
  }

  // ----- controls from the UI -----
  continue() { if (this.control && this.control.resume) this.control.resume(); }
  pause() { if (this.control) this.control.paused = true; }
  resume() { if (this.control) { this.control.paused = false; this.continue(); } }
  stop() { if (this.control) { this.control.stop = true; this.continue(); } }
  focus() { if (this.page) this.page.bringToFront().catch(() => {}); }

  setStatus(run, status, message, activity) {
    run.status = status;
    run.message = message;
    if (activity !== undefined) run.activity = activity;
    this.store.saveRun(run);
  }

  /** Wait until «ادامه» is pressed, `autoCheck()` is true, or `untilMs` passes. */
  async waitForUser(run, status, message, { autoCheck, untilMs } = {}) {
    const prev = { status: run.status, message: run.message };
    run.waitUntil = untilMs || null;
    this.setStatus(run, status, message);
    this.store.saveRun(run, true);
    let pressed = false;
    const press = new Promise((resolve) => { this.control.resume = () => { pressed = true; resolve(); }; });
    while (!pressed && !this.control.stop) {
      if (untilMs && Date.now() >= untilMs) break;
      if (autoCheck && (await autoCheck().catch(() => false))) break;
      await Promise.race([press, H.sleep(untilMs ? Math.min(1000, untilMs - Date.now()) : 2000)]);
    }
    this.control.resume = null;
    run.waitUntil = null;
    this.setStatus(run, prev.status, prev.message);
  }

  async pauseGate(run) {
    if (!this.control.paused) return;
    const prev = { status: run.status, message: run.message };
    this.setStatus(run, 'paused', 'ربات مکث کرده است.');
    while (this.control.paused && !this.control.stop) await H.sleep(400);
    this.setStatus(run, prev.status, prev.message);
  }

  /** If Divar shows a captcha / rate-limit page, hand it to the user and wait. */
  async handleBlock(run, page, response) {
    const status = response ? response.status() : 200;
    const blocked = status === 429 || status === 403 || (await page.evaluate(S.detectBlock).catch(() => false));
    if (!blocked) return false;
    await page.bringToFront().catch(() => {});
    await this.waitForUser(run, 'blocked',
      'دیوار تأیید خواسته (کپچا یا «درخواست زیاد»). در پنجرهٔ دیوار حلش کنید و «ادامه» را بزنید. اگر کاری نکنید، ربات ۵ دقیقه صبر می‌کند و آرام ادامه می‌دهد.',
      { untilMs: Date.now() + 5 * 60 * 1000 });
    return true;
  }

  async run(run) {
    const c = run.criteria;
    const pace = SPEEDS[c.speed] || SPEEDS.normal;
    const dailyLimit = Math.max(1, Number(c.dailyLimit) || DEFAULT_DAILY_LIMIT);
    const page = await this.context.newPage();
    this.page = page;
    try {
      // ---- 1. Login ----
      if (c.requireLogin !== false && !(await isLoggedIn(this.context))) {
        await page.goto('https://divar.ir/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await page.bringToFront().catch(() => {});
        await this.waitForUser(run, 'waiting-login',
          'در پنجرهٔ دیوار روی «دیوار من» و بعد «ورود به حساب کاربری» بزنید و با شماره و کد پیامکی وارد شوید. ربات خودش متوجه می‌شود؛ اگر نشد «ادامه» را بزنید.',
          { autoCheck: () => isLoggedIn(this.context) });
        if (this.control.stop) return this.finish(run, 'stopped');
      }

      // ---- 2. Search ----
      this.setStatus(run, 'collecting', 'در حال رفتن به دیوار و جستجو…', '');
      const listUrl = await this.openSearch(run, page);
      run.sourceUrl = listUrl;

      // ---- 3. Collect the list ----
      await this.collect(run, page);
      if (!run.items.length) {
        return this.finish(run, 'done', 'هیچ آگهی‌ای در نتایج جستجو پیدا نشد. نام خودرو یا لینک را بررسی کنید.');
      }

      // ---- 4. Read the ads ----
      const queue = H.looseOrder(run.items);
      let sinceBreak = 0;
      let nextBreak = H.randInt(...pace.breakEvery);
      let n = 0;
      for (const item of queue) {
        if (this.control.stop) break;
        await this.pauseGate(run);
        n++;
        const cached = this.store.cachedPost(item.token);
        if (cached) {
          run.posts[item.token] = { ...cached, order: item.order, url: item.href || cached.url };
          run.stats.cached++;
          this.store.saveRun(run);
          continue;
        }
        if (this.store.dailyCount() >= dailyLimit) {
          return this.finish(run, 'done',
            `به سقف روزانهٔ ${fa(dailyLimit)} آگهی رسیدیم؛ ${fa(Object.keys(run.posts).length)} آگهی خوانده شد. بقیه را فردا ادامه دهید (یا سقف را در تنظیمات بیشتر کنید).`);
        }
        this.setStatus(run, 'reading', `در حال خواندن آگهی ${fa(n)} از ${fa(run.items.length)}`, item.title || '');
        const t0 = Date.now();
        try {
          const post = await this.readAd(run, page, item, pace, listUrl);
          if (post) {
            run.posts[item.token] = post;
            delete run.errors[item.token];
            this.store.cachePost(post);
          }
        } catch (err) {
          run.errors[item.token] = String(err && err.message ? err.message : err).slice(0, 200);
        }
        run.stats.opened++;
        run.stats.readMs += Date.now() - t0;
        this.store.countView();
        this.store.saveRun(run);

        sinceBreak++;
        if (sinceBreak >= nextBreak && n < queue.length) {
          const ms = H.natural(...pace.breakLen);
          await this.waitForUser(run, 'resting',
            `استراحت کوتاه بعد از ${fa(sinceBreak)} آگهی — مثل یک کاربر واقعی.`,
            { untilMs: Date.now() + ms });
          sinceBreak = 0;
          nextBreak = H.randInt(...pace.breakEvery);
        } else {
          await H.sleep(H.natural(...pace.gap));
        }
      }
      return this.finish(run, this.control.stop ? 'stopped' : 'done');
    } finally {
      this.store.flushCache();
    }
  }

  /** Go to Divar and search like a person: type into the search box, then apply the year filter. */
  async openSearch(run, page) {
    const c = run.criteria;
    const target = c.searchUrl || P.buildSearchUrl(c);
    if (c.searchUrl) {
      let resp = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
      while (await this.handleBlock(run, page, resp)) {
        if (this.control.stop) return target;
        resp = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
      }
      return page.url();
    }

    const cityUrl = `https://divar.ir/s/${encodeURIComponent(c.city || 'tehran')}/car`;
    let resp = await page.goto(cityUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    while (await this.handleBlock(run, page, resp)) {
      if (this.control.stop) return cityUrl;
      resp = await page.goto(cityUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    await H.sleep(H.natural(1200, 2600));

    let typed = false;
    if (c.query) {
      const box = await page.$('input[type="search"], input[placeholder*="جستجو"], input[name="q"]');
      if (box) {
        try {
          await H.clickElement(page, box);
          await H.sleep(H.rand(200, 600));
          await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
          await H.typeText(page, c.query);
          await H.sleep(H.rand(300, 900));
          await page.keyboard.press('Enter');
          await page.waitForURL((u) => /\/s\//.test(u.pathname) && u.searchParams.has('q'), { timeout: 15000 });
          typed = true;
        } catch (_) { typed = false; }
      }
    }

    // Year filter (and the query, if typing did not work), like ticking a filter.
    const want = new URL(target);
    const now = new URL(page.url());
    const needYear = want.searchParams.get('production-year') && now.searchParams.get('production-year') !== want.searchParams.get('production-year');
    if (!typed || needYear) {
      if (typed) {
        now.searchParams.set('production-year', want.searchParams.get('production-year'));
      }
      const next = typed ? now.href : target;
      await H.sleep(H.natural(800, 2000));
      let r = await page.goto(next, { waitUntil: 'domcontentloaded', timeout: 60000 });
      while (await this.handleBlock(run, page, r)) {
        if (this.control.stop) break;
        r = await page.goto(next, { waitUntil: 'domcontentloaded', timeout: 60000 });
      }
    }
    return page.url();
  }

  /** Scroll the result list (unevenly, with pauses) and collect every ad link. */
  async collect(run, page) {
    const maxAds = Math.max(1, Number(run.criteria.maxAds) || 150);
    await page.waitForSelector('a[href*="/v/"]', { timeout: 20000 }).catch(() => {});
    await H.sleep(H.natural(900, 1800));
    const found = new Map();
    const add = async () => {
      for (const it of await page.evaluate(S.collectListItems)) if (!found.has(it.token)) found.set(it.token, it);
      run.items = Array.from(found.values()).slice(0, maxAds);
    };
    let idle = 0;
    await add();
    while (!this.control.stop && found.size < maxAds && idle < 6) {
      await this.pauseGate(run);
      const before = found.size;
      this.setStatus(run, 'collecting', `در حال مرور نتایج: ${fa(run.items.length)} آگهی پیدا شد`);
      await H.scrollBy(page, H.rand(600, 1400));
      await H.sleep(H.natural(500, 1600));
      if (H.chance(0.15)) { await H.scrollBy(page, -H.rand(150, 400)); await H.sleep(H.rand(400, 1000)); }
      if (H.chance(0.12)) await H.sleep(H.natural(1500, 4000)); // looking at a card
      const more = await page.$('button:has-text("آگهی‌های بیشتر"), button:has-text("نمایش بیشتر")').catch(() => null);
      if (more && (await more.isVisible().catch(() => false))) {
        await H.clickElement(page, more).catch(() => {});
        await H.sleep(H.natural(1500, 2500));
      }
      await add();
      idle = found.size === before ? idle + 1 : 0;
    }
    run.items = Array.from(found.values()).slice(0, maxAds).map((it, i) => ({ ...it, order: i }));
    this.control.stop = false; // «enough ads» during collection means: go read them
    this.store.saveRun(run, true);
    // Back to the top of the list before opening ads, like a person starting over.
    await H.scrollBy(page, -H.rand(3000, 6000)).catch(() => {});
  }

  /** Make sure the list page is showing (go back to it if needed). */
  async ensureList(page, listUrl) {
    if (page.url() === listUrl || /\/s\//.test(new URL(page.url()).pathname)) return;
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
    if (!/\/s\//.test(new URL(page.url()).pathname)) {
      await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    await page.waitForSelector('a[href*="/v/"]', { timeout: 15000 }).catch(() => {});
    await H.sleep(H.natural(500, 1200));
  }

  /** Find the ad's card in the list, scrolling to load more if needed. */
  async findCard(page, token) {
    const sel = `a[href*="/${token}"]`;
    for (let i = 0; i < 12; i++) {
      const el = await page.$(sel);
      if (el) return el;
      await H.scrollBy(page, H.rand(700, 1200));
      await H.sleep(H.natural(400, 900));
    }
    return null;
  }

  /**
   * Open one ad the way a person would and read it.
   * Mostly: click it in the list, read, go back. Sometimes: open it in a new tab.
   * If the card is not in the list any more: open its address directly.
   */
  async readAd(run, page, item, pace, listUrl) {
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (this.control.stop) return null;
      let adPage = page;
      let viaNewTab = false;
      try {
        let response = null;
        await this.ensureList(page, listUrl).catch(() => {});
        const card = attempt === 1 ? await this.findCard(page, item.token) : null;
        if (card && H.chance(0.25)) {
          // Open in a new tab (middle click), read there, close it.
          const opened = this.context.waitForEvent('page', { timeout: 15000 });
          await H.clickElement(page, card, { button: 'middle' });
          adPage = await opened;
          viaNewTab = true;
          await H.sleep(H.rand(300, 900));
          await adPage.bringToFront().catch(() => {});
          await adPage.waitForLoadState('domcontentloaded', { timeout: 45000 });
        } else if (card) {
          await H.clickElement(page, card);
          await page.waitForURL((u) => u.pathname.includes(item.token), { timeout: 30000 });
          await page.waitForLoadState('domcontentloaded', { timeout: 45000 });
        } else {
          response = await page.goto(item.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
        }

        if (await this.handleBlock(run, adPage, response)) {
          if (viaNewTab) await adPage.close().catch(() => {});
          attempt--;
          continue;
        }
        await adPage.waitForSelector('h1', { timeout: 15000 }).catch(() => {});

        // Read: time depends on how much there is to read, plus randomness.
        const descLen = await adPage.evaluate(() => (document.body.innerText || '').length).catch(() => 1500);
        const [rMin, rMax] = pace.read;
        await H.readPage(adPage, H.natural(rMin, rMax) * Math.min(1.6, 0.7 + descLen / 6000));

        const raw = await adPage.evaluate(S.extractAdPage);
        const post = P.extractPost(raw, item.token, item);
        post.order = item.order;
        post.url = item.href || post.url;
        if (viaNewTab) {
          await H.sleep(H.rand(200, 700));
          await adPage.close().catch(() => {});
          await page.bringToFront().catch(() => {});
        }
        if (!Object.keys(post.fields).length) {
          throw new Error(/حذف شده|منقضی|یافت نشد/.test(post.title) ? 'این آگهی حذف شده است' : 'مشخصات آگهی در صفحه پیدا نشد');
        }
        return post;
      } catch (err) {
        if (viaNewTab) await adPage.close().catch(() => {});
        lastErr = err;
        if (/حذف شده/.test(err.message)) throw err;
        await H.sleep(1500 * attempt);
      }
    }
    throw lastErr;
  }

  finish(run, status, message) {
    run.status = status;
    run.finishedAt = Date.now();
    run.activity = '';
    run.waitUntil = null;
    const read = Object.keys(run.posts).length;
    const errs = Object.keys(run.errors).length;
    run.message = message || (status === 'stopped'
      ? `متوقف شد. ${fa(read)} آگهی خوانده شد.`
      : `تمام شد: ${fa(read)} آگهی خوانده شد${errs ? ` و ${fa(errs)} آگهی باز نشد` : ''}.`);
    this.store.saveRun(run, true);
    if (this.page) this.page.close().catch(() => {});
    this.page = null;
    return run;
  }
}

module.exports = { Scanner, SPEEDS, DEFAULT_DAILY_LIMIT, isLoggedIn };
