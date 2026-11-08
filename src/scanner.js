/*
 * The bot: drives a real Chrome tab through Divar like a person would.
 *   1. makes sure you are logged in to Divar (you log in yourself, once),
 *   2. opens the search, scrolls to the end and collects every ad link,
 *   3. opens the ads one by one, reads the page, and goes back for the next.
 * No Divar API is called: everything is read from the pages Chrome renders.
 */
'use strict';

const P = require('./parser');
const S = require('./page-scripts');

const SPEEDS = {
  slow: [5000, 10000],
  normal: [2500, 6000],
  fast: [1200, 3000],
  test: [60, 150], // used by automated tests only
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

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
  }

  get busy() {
    return !!(this.current && !['done', 'stopped', 'error'].includes(this.current.status));
  }

  /** Create a run and start it in the background. */
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
      sourceUrl: '',
      items: [],
      posts: {},
      errors: {},
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

  setStatus(run, status, message) {
    run.status = status;
    run.message = message;
    this.store.saveRun(run);
  }

  /** Wait until the user presses «ادامه» in the UI, or `autoCheck()` becomes true. */
  async waitForUser(run, status, message, autoCheck) {
    const prev = { status: run.status, message: run.message };
    this.setStatus(run, status, message);
    this.store.saveRun(run, true);
    let done = false;
    const pressed = new Promise((resolve) => { this.control.resume = () => { done = true; resolve(); }; });
    while (!done && !this.control.stop) {
      if (autoCheck && (await autoCheck().catch(() => false))) break;
      await Promise.race([pressed, sleep(2000)]);
    }
    this.control.resume = null;
    this.setStatus(run, prev.status, prev.message);
  }

  async pauseGate(run) {
    if (!this.control.paused) return;
    const prev = { status: run.status, message: run.message };
    this.setStatus(run, 'paused', 'متوقف شده است. برای ادامه دکمهٔ «ادامه» را بزنید.');
    while (this.control.paused && !this.control.stop) await sleep(500);
    this.setStatus(run, prev.status, prev.message);
  }

  async checkBlocked(run, page, response) {
    const status = response ? response.status() : 200;
    const blocked = status === 429 || status === 403 || (await page.evaluate(S.detectBlock).catch(() => false));
    if (!blocked) return false;
    await page.bringToFront().catch(() => {});
    await this.waitForUser(run, 'blocked',
      'دیوار درخواست تأیید داده (کپچا یا «تعداد درخواست زیاد»). در پنجرهٔ دیوار مشکل را حل کنید و بعد «ادامه» را بزنید. اگر کاری نکنید، ربات ۳ دقیقه صبر می‌کند و دوباره امتحان می‌کند.',
      (() => { const until = Date.now() + 3 * 60 * 1000; return async () => Date.now() > until; })());
    return true;
  }

  async run(run) {
    const c = run.criteria;
    const [dMin, dMax] = SPEEDS[c.speed] || SPEEDS.normal;
    const page = await this.context.newPage();
    this.page = page;

    try {
      // ---- 1. Login ----
      if (c.requireLogin !== false && !(await isLoggedIn(this.context))) {
        await page.goto('https://divar.ir/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await page.bringToFront().catch(() => {});
        await this.waitForUser(run, 'waiting-login',
          'وارد حساب دیوار نشده‌اید. در پنجرهٔ دیوار روی «دیوار من» ← «ورود به حساب کاربری» بزنید، شماره و کد پیامکی را وارد کنید. ربات خودش متوجه می‌شود؛ اگر نشد «ادامه» را بزنید.',
          () => isLoggedIn(this.context));
        if (this.control.stop) return this.finish(run, 'stopped');
      }

      // ---- 2. Search & collect ----
      const searchUrl = c.searchUrl || P.buildSearchUrl(c);
      run.sourceUrl = searchUrl;
      this.setStatus(run, 'collecting', 'در حال باز کردن صفحهٔ جستجو…');
      let resp = await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      while (await this.checkBlocked(run, page, resp)) {
        if (this.control.stop) return this.finish(run, 'stopped');
        resp = await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      }
      await page.waitForSelector('a[href*="/v/"]', { timeout: 20000 }).catch(() => {});
      await sleep(rand(1200, 2000));

      const maxAds = Math.max(1, Number(c.maxAds) || 150);
      const found = new Map();
      let idle = 0;
      while (!this.control.stop && found.size < maxAds && idle < 6) {
        await this.pauseGate(run);
        const before = found.size;
        for (const it of await page.evaluate(S.collectListItems)) if (!found.has(it.token)) found.set(it.token, it);
        run.items = Array.from(found.values()).slice(0, maxAds);
        this.setStatus(run, 'collecting', `در حال اسکرول لیست آگهی‌ها: ${run.items.length.toLocaleString('fa-IR')} آگهی پیدا شد`);
        for (let k = 0; k < 4; k++) {
          await page.mouse.wheel(0, rand(500, 900));
          await sleep(rand(250, 500));
        }
        await sleep(rand(800, 1400));
        if (await page.evaluate(S.clickLoadMore).catch(() => false)) await sleep(rand(1500, 2500));
        for (const it of await page.evaluate(S.collectListItems)) if (!found.has(it.token)) found.set(it.token, it);
        idle = found.size === before ? idle + 1 : 0;
      }
      run.items = Array.from(found.values()).slice(0, maxAds).map((it, i) => ({ ...it, order: i }));
      this.control.stop = false; // «stop» during collection = «enough ads, go read them»
      this.store.saveRun(run, true);
      if (!run.items.length) {
        return this.finish(run, 'done', 'هیچ آگهی‌ای در صفحهٔ جستجو پیدا نشد. عبارت جستجو یا لینک را بررسی کنید.');
      }

      // ---- 3. Visit each ad ----
      let n = 0;
      for (const item of run.items) {
        if (this.control.stop) break;
        await this.pauseGate(run);
        n++;
        const label = `در حال خواندن آگهی ${n.toLocaleString('fa-IR')} از ${run.items.length.toLocaleString('fa-IR')}`;
        this.setStatus(run, 'reading', label);

        const cached = this.store.cachedPost(item.token);
        if (cached) {
          run.posts[item.token] = { ...cached, order: item.order };
          continue;
        }
        try {
          const post = await this.readAd(run, page, item);
          if (post) {
            run.posts[item.token] = post;
            delete run.errors[item.token];
            this.store.cachePost(post);
          }
        } catch (err) {
          run.errors[item.token] = String(err && err.message ? err.message : err).slice(0, 200);
        }
        this.store.saveRun(run);
        await sleep(rand(dMin, dMax));
      }
      return this.finish(run, this.control.stop ? 'stopped' : 'done');
    } finally {
      this.store.flushCache();
    }
  }

  async readAd(run, page, item) {
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (this.control.stop) return null;
      try {
        const resp = await page.goto(item.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
        if (await this.checkBlocked(run, page, resp)) { attempt--; continue; }
        if (resp && resp.status() >= 400) throw new Error(`صفحهٔ آگهی خطای ${resp.status()} داد (شاید حذف شده)`);
        await page.waitForSelector('h1', { timeout: 15000 }).catch(() => {});
        await sleep(rand(400, 900));
        await page.mouse.wheel(0, rand(300, 700)); // look at the ad a little, like a person
        await sleep(rand(300, 700));
        const raw = await page.evaluate(S.extractAdPage);
        const post = P.extractPost(raw, item.token, item);
        post.order = item.order;
        post.url = item.href || post.url;
        if (!post.title && !Object.keys(post.fields).length) throw new Error('مشخصات آگهی در صفحه پیدا نشد');
        return post;
      } catch (err) {
        lastErr = err;
        await sleep(1500 * attempt);
      }
    }
    throw lastErr;
  }

  finish(run, status, message) {
    run.status = status;
    run.finishedAt = Date.now();
    const read = Object.keys(run.posts).length;
    const errs = Object.keys(run.errors).length;
    run.message = message || (status === 'stopped'
      ? `به درخواست شما متوقف شد. ${read.toLocaleString('fa-IR')} آگهی خوانده شد.`
      : `تمام شد: ${read.toLocaleString('fa-IR')} آگهی خوانده شد${errs ? ` و ${errs.toLocaleString('fa-IR')} آگهی خطا داشت` : ''}.`);
    this.store.saveRun(run, true);
    if (this.page) this.page.close().catch(() => {});
    this.page = null;
    return run;
  }
}

module.exports = { Scanner, SPEEDS, isLoggedIn };
