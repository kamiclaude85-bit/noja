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
/** Divar lists newest ads first: after this many already-known ads in a row, the rest is old. */
const KNOWN_STREAK_STOP = 20;
/** After this many ads in a row older than the chosen period («آگهی‌های تا چه مدت پیش»), stop scrolling. */
const OLD_STREAK_STOP = 5;
/** At most this many result pages (24 ads each on Divar) per search. */
const MAX_LIST_PAGES = 15;

/** Identifies a saved search, so its ads can be remembered across runs. */
function searchKey(c) {
  if (c.searchUrl) return `url:${c.searchUrl}`;
  const key = ['q', c.city || 'tehran', P.normalizeText(c.query || ''), c.yearMin || '', c.yearMax || ''];
  if (c.priceMin || c.priceMax) key.push(`p${c.priceMin || ''}-${c.priceMax || ''}`);
  return key.join('|');
}

/** Price shown on the search-list card (e.g. «۴۸۵٬۰۰۰٬۰۰۰ تومان»), or null. */
function cardPrice(item) {
  const line = (item.lines || []).find((l) => /تومان/.test(l));
  return line ? P.parseNumber(line) : null;
}

const fa = (n) => Number(n).toLocaleString('fa-IR');

async function isLoggedIn(context) {
  const cookies = await context.cookies('https://divar.ir');
  return cookies.some((c) => /token|jwt/i.test(c.name) && String(c.value).length >= 20);
}

class Scanner {
  constructor({ context, store, log = () => {}, onEvent = () => {} }) {
    this.context = context;
    this.store = store;
    this.log = log;
    this.onEvent = onEvent; // (run, kind) for phone reminders
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
      stats: { opened: 0, newAds: 0, known: 0, priceChanged: 0, readMs: 0 },
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
  /** «پایان» during list-collecting: end the search without reading the ads found so far. */
  cancel() { if (this.control) { this.control.cancel = true; this.control.stop = true; this.continue(); } }

  /** Wait, but return at once when «پایان» is pressed. */
  async idle(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until && !(this.control && this.control.stop)) await H.sleep(Math.min(250, until - Date.now()));
  }
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
    Promise.resolve(this.onEvent(run, status)).catch(() => {});
    let pressed = false;
    let how = 'user';
    const press = new Promise((resolve) => { this.control.resume = () => { pressed = true; resolve(); }; });
    while (!pressed && !this.control.stop) {
      if (untilMs && Date.now() >= untilMs) { how = 'timeout'; break; }
      if (autoCheck && (await autoCheck().catch(() => false))) { how = 'auto'; break; }
      await Promise.race([press, H.sleep(untilMs ? Math.min(1000, untilMs - Date.now()) : 2000)]);
    }
    if (!pressed && this.control.stop) how = 'stop';
    this.control.resume = null;
    run.waitUntil = null;
    this.setStatus(run, prev.status, prev.message);
    return how;
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
    // Keep what led to it, to learn Divar's limits over time (see «کپچا و محدودیت‌ها» in «جستجوها»).
    const url = page.url();
    const ev = {
      t: Date.now(),
      kind: status === 429 ? 'too-many' : status === 403 ? 'forbidden' : 'captcha',
      http: status,
      where: url.includes('/v/') ? 'ad' : url.includes('/s/') ? 'list' : 'other',
      runId: run.id,
      query: run.criteria.query || '',
      speed: run.criteria.speed || 'normal',
      runMinutes: Math.round((Date.now() - run.createdAt) / 60000),
      runOpened: (run.stats && run.stats.opened) || 0,
      views15m: this.store.viewsSince(15 * 60000),
      views1h: this.store.viewsSince(3600000),
      views24h: this.store.viewsSince(24 * 3600000),
      today: this.store.dailyCount(),
      sinceLastBlockMin: null,
    };
    const last = this.store.listBlocks().slice(-1)[0];
    if (last) ev.sinceLastBlockMin = Math.round((ev.t - last.t) / 60000);
    await page.bringToFront().catch(() => {});
    const how = await this.waitForUser(run, 'blocked',
      'دیوار تأیید خواسته (کپچا یا «درخواست زیاد»). در پنجرهٔ دیوار حلش کنید و «ادامه» را بزنید. اگر کاری نکنید، ربات ۵ دقیقه صبر می‌کند و آرام ادامه می‌دهد.',
      { untilMs: Date.now() + 5 * 60 * 1000 });
    ev.resolved = how; // 'user' (you pressed «ادامه»), 'timeout' (waited 5 min), 'stop'
    ev.waitedSec = Math.round((Date.now() - ev.t) / 1000);
    try { this.store.logBlock(ev); } catch (e) { this.log(e); }
    run.stats.blocks = (run.stats.blocks || 0) + 1;
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

      // ---- 3. Collect the list (stops early at ads already seen) ----
      const key = searchKey(c);
      this.store.touchSearch(key, c);
      await this.collect(run, page);
      if (this.control.cancel) return this.finish(run, 'stopped', `متوقف شد. ${fa(run.items.length)} آگهی در فهرست پیدا شد و باز نشد.`);

      // ---- 4. Decide what to open: only new ads, and old ads whose price changed ----
      const toVisit = [];
      for (const item of run.items) {
        const rec = c.recheckAll ? null : this.store.knownAd(item.token);
        if (rec && rec.removed) continue;
        if (rec && rec.post) {
          const now = cardPrice(item);
          const before = rec.post.price;
          const changed = now != null && before != null && Math.abs(now - before) / before > 0.005;
          if (!changed) {
            run.posts[item.token] = { ...rec.post, order: item.order, isNew: false, firstSeenAt: rec.firstSeenAt };
            this.store.addToSearch(key, item.token);
            run.stats.known++;
            continue;
          }
          item.priceFrom = before;
        }
        toVisit.push(item);
      }
      // Ads this search found on earlier days that are further down the list (not scrolled to today).
      const inList = new Set(run.items.map((it) => it.token));
      for (const token of this.store.searchTokens(key)) {
        if (inList.has(token)) continue;
        const rec = this.store.knownAd(token);
        if (!rec || !rec.post || rec.removed) continue;
        const order = run.items.length;
        run.items.push({ token, href: rec.post.url, title: rec.post.title, order, fromMemory: true });
        run.posts[token] = { ...rec.post, order, isNew: false, firstSeenAt: rec.firstSeenAt };
        run.stats.known++;
      }
      // Ads you are following up: re-check once a day (still on Divar? price changed?).
      const recheckMs = (c.trackRecheckHours != null ? Number(c.trackRecheckHours) : 20) * 60 * 60 * 1000;
      const queued = new Set(toVisit.map((it) => it.token));
      for (const token of this.store.trackedTokens(key)) {
        const rec = this.store.knownAd(token);
        if (queued.has(token) || Date.now() - (rec.lastReadAt || 0) < recheckMs) continue;
        const it = run.items.find((x) => x.token === token) || { token, href: rec.post.url, title: rec.post.title, order: run.items.length };
        toVisit.push({ ...it, direct: !inList.has(token), priceFrom: rec.post.price, tracked: true });
        queued.add(token);
      }
      run.toVisit = toVisit.length;
      this.store.saveRun(run, true);

      if (!run.items.length) {
        return this.finish(run, 'done', 'هیچ آگهی‌ای در نتایج جستجو پیدا نشد. نام خودرو یا لینک را بررسی کنید.');
      }
      if (!toVisit.length) {
        return this.finish(run, 'done', `آگهی جدیدی نبود. ${fa(run.stats.known)} آگهی را از قبل داشتیم.`);
      }

      // ---- 5. Read them ----
      const queue = H.looseOrder(toVisit);
      let sinceBreak = 0;
      let nextBreak = H.randInt(...pace.breakEvery);
      let n = 0;
      for (const item of queue) {
        if (this.control.stop) break;
        await this.pauseGate(run);
        n++;
        if (this.store.dailyCount() >= dailyLimit) {
          return this.finish(run, 'done',
            `به سقف روزانهٔ ${fa(dailyLimit)} آگهی رسیدیم؛ ${fa(run.stats.newAds)} آگهی جدید خوانده شد. بقیه را فردا ادامه دهید (یا سقف را در تنظیمات بیشتر کنید).`);
        }
        this.setStatus(run, 'reading', `در حال خواندن آگهی ${fa(n)} از ${fa(queue.length)}`, item.title || '');
        const t0 = Date.now();
        try {
          const post = await this.readAd(run, page, item, pace, listUrl);
          if (post) {
            const rec = this.store.rememberAd(post, key);
            post.firstSeenAt = rec.firstSeenAt;
            if (item.priceFrom != null || item.tracked) {
              if (item.priceFrom != null && post.price != null && post.price !== item.priceFrom) {
                post.priceChange = { from: item.priceFrom, to: post.price };
                run.stats.priceChanged++;
              }
              post.isNew = false;
            } else {
              post.isNew = true;
              run.stats.newAds++;
            }
            run.posts[item.token] = post;
            delete run.errors[item.token];
          }
        } catch (err) {
          const msg = String(err && err.message ? err.message : err).slice(0, 200);
          if (/حذف شده/.test(msg)) {
            this.store.markRemoved(item.token, key);
            if (item.tracked) {
              run.stats.sold = (run.stats.sold || 0) + 1;
              if (run.posts[item.token]) run.posts[item.token].removed = Date.now();
              continue;
            }
          }
          run.errors[item.token] = msg;
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
          await this.idle(H.natural(...pace.gap));
        }
      }
      return this.finish(run, this.control.stop ? 'stopped' : 'done');
    } finally {
      this.store.flush();
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
    await this.idle(H.natural(1200, 2600));
    if (this.control.stop) return page.url(); // «پایان» while opening the search

    let typed = false;
    if (c.query) {
      // Real Divar: the header box `input[name="search"]` («جستجو در سواری و وانت»).
      // The price filter boxes are also type="search", so they must never be picked.
      let box = null;
      for (const sel of ['input[name="search"]', 'input[name="q"]', 'input[placeholder*="جستجو"]:not([id*="price"])', 'input[type="search"]:not([id*="price"]):not([inputmode="numeric"])']) {
        box = await page.$(sel).catch(() => null);
        if (box && (await box.isVisible().catch(() => false))) break;
        box = null;
      }
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

    if (this.control.stop) return page.url();
    // Year / price filters (and the query, if typing did not work), like ticking filters on Divar.
    const want = new URL(target);
    const now = new URL(page.url());
    let needFilters = false;
    for (const k of ['production-year', 'price']) {
      const v = want.searchParams.get(k);
      if (v && now.searchParams.get(k) !== v) { now.searchParams.set(k, v); needFilters = true; }
    }
    if (!typed || needFilters) {
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

  /**
   * Scroll the result list (unevenly, with pauses) and collect ad links.
   * Stops when it has `maxAds` new ads, or when it reaches a long run of ads it
   * has already read (Divar shows newest first, so everything below is old).
   */
  async collect(run, page) {
    const c = run.criteria;
    const maxNew = Math.max(1, Number(c.maxAds) || 150);
    const useMemory = !c.recheckAll;
    const isKnown = (t) => useMemory && !!this.store.knownAd(t);
    // «آگهی‌های تا چه مدت پیش؟»: the list card says «۲ هفته پیش در …». Bumped ads («نردبان شده»)
    // show no time; they are not counted as old.
    const maxAgeMs = Number(c.maxAgeDays) > 0 ? Number(c.maxAgeDays) * 86400000 : null;
    const ageOf = (it) => { const t = P.parseRelativeAgo((it.lines || []).join(' '), it.seenAt || Date.now()); return t ? Date.now() - t : null; };
    const isOld = (it) => maxAgeMs != null && (ageOf(it) || 0) > maxAgeMs;
    await page.waitForSelector('a[href*="/v/"]', { timeout: 20000 }).catch(() => {});
    await H.sleep(H.natural(900, 1800));
    const found = new Map();
    let reason = '';
    const add = async () => {
      const listUrl = page.url(); // results come in pages; remember on which page each ad is
      const seenAt = Date.now();
      for (const it of await page.evaluate(S.collectListItems)) if (!found.has(it.token)) found.set(it.token, { ...it, listUrl, seenAt });
      run.items = Array.from(found.values());
    };
    let pages = 1;
    const counts = () => {
      let fresh = 0;
      let streak = 0;
      let oldStreak = 0;
      for (const it of run.items) {
        if (isOld(it)) { oldStreak++; continue; }
        if (ageOf(it) != null) oldStreak = 0;
        if (isKnown(it.token)) streak++;
        else { fresh++; streak = 0; }
      }
      return { fresh, streak, oldStreak };
    };
    let idle = 0;
    await add();
    while (!this.control.stop && idle < 6) {
      const { fresh, streak, oldStreak } = counts();
      if (fresh >= maxNew) { reason = 'max'; break; }
      if (oldStreak >= OLD_STREAK_STOP) { reason = 'old'; break; }
      if (useMemory && streak >= KNOWN_STREAK_STOP) { reason = 'known'; break; }
      await this.pauseGate(run);
      const before = found.size;
      const known = run.items.length - fresh;
      this.setStatus(run, 'collecting',
        `در حال مرور نتایج: ${fa(fresh)} آگهی جدید${known ? ` و ${fa(known)} آگهی که قبلاً دیده‌اید` : ''}`);
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

      // Real Divar shows 24 ads per page and a «بعدی» link at the bottom instead of loading more.
      if (idle >= 2 && pages < MAX_LIST_PAGES) {
        const next = await page.evaluate(S.nextPageLink).catch(() => null);
        if (next && next.href !== page.url()) {
          await H.sleep(H.natural(800, 2000));
          let response = null;
          const link = next.visible ? await page.$('a:text-is("بعدی")').catch(() => null) : null;
          if (link) {
            await H.clickElement(page, link).catch(() => {});
            const wantPage = new URL(next.href).searchParams.get('page');
            await page.waitForURL((u) => u.searchParams.get('page') === wantPage, { timeout: 20000 }).catch(() => {});
          }
          if (!link || new URL(page.url()).searchParams.get('page') !== new URL(next.href).searchParams.get('page')) {
            response = await page.goto(next.href, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
          }
          while (await this.handleBlock(run, page, response)) {
            if (this.control.stop) break;
            response = await page.goto(next.href, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
          }
          await page.waitForSelector('a[href*="/v/"]', { timeout: 20000 }).catch(() => {});
          await H.sleep(H.natural(900, 1800));
          pages++;
          idle = 0;
          await add();
        }
      }
    }
    // Keep the list up to the point we stopped; new ads beyond maxNew are left for next time.
    const items = [];
    let fresh = 0;
    let tooOld = 0;
    for (const it of found.values()) {
      if (isOld(it) && !isKnown(it.token)) { tooOld++; continue; } // older than the chosen period: not opened
      if (!isKnown(it.token)) { if (fresh >= maxNew) continue; fresh++; }
      items.push(it);
    }
    run.stats.tooOld = tooOld;
    run.items = items.map((it, i) => ({ ...it, order: i }));
    run.collectStop = reason || (this.control.stop ? 'user' : 'end');
    if (!this.control.cancel) this.control.stop = false; // «کافیه» during collection means: go read them
    this.store.saveRun(run, true);
    await H.scrollBy(page, -H.rand(3000, 6000)).catch(() => {});
  }

  /** Make sure the list page is showing (go back to it if needed). */
  async ensureList(page, listUrl) {
    // Which result page a URL shows («page=2» …), or null when it is not a result list.
    const pageNo = (u) => {
      try {
        const x = new URL(u);
        return /\/s\//.test(x.pathname) ? (x.searchParams.get('page') || '0') : null;
      } catch (_) { return null; }
    };
    const want = pageNo(listUrl);
    if (pageNo(page.url()) !== null && pageNo(page.url()) === want) return;
    if (pageNo(page.url()) === null) await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
    if (pageNo(page.url()) !== want) {
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
        if (!item.direct) await this.ensureList(page, item.listUrl || listUrl).catch(() => {});
        const card = attempt === 1 && !item.direct ? await this.findCard(page, item.token) : null;
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
        await H.readPage(adPage, H.natural(rMin, rMax) * Math.min(1.6, 0.7 + descLen / 6000), () => this.control.stop);

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
    const errs = Object.keys(run.errors).length;
    const st = run.stats || {};
    const parts = [`${fa(st.newAds || 0)} آگهی جدید`];
    if (st.priceChanged) parts.push(`${fa(st.priceChanged)} تغییر قیمت`);
    if (st.sold) parts.push(`${fa(st.sold)} آگهی پیگیری‌شده از دیوار حذف شد`);
    if (st.known) parts.push(`${fa(st.known)} آگهی از قبل`);
    if (st.tooOld) parts.push(`${fa(st.tooOld)} آگهی قدیمی‌تر از بازه باز نشد`);
    run.message = message || (status === 'stopped'
      ? `متوقف شد. ${parts.join('، ')}.`
      : `تمام شد: ${parts.join('، ')}${errs ? `؛ ${fa(errs)} آگهی باز نشد` : ''}.`);
    this.store.saveRun(run, true);
    Promise.resolve(this.onEvent(run, status)).catch(() => {});
    if (this.page) this.page.close().catch(() => {});
    this.page = null;
    return run;
  }
}

module.exports = { Scanner, SPEEDS, DEFAULT_DAILY_LIMIT, KNOWN_STREAK_STOP, OLD_STREAK_STOP, isLoggedIn, searchKey };
