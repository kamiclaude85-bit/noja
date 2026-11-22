/*
 * Local storage under the data folder:
 *   runs/<id>.json  one file per search run
 *   ads.json        permanent memory of every ad ever read (never reopened unless its price changes),
 *                   plus which saved search each ad belongs to
 *   daily.json      how many ad pages were opened today
 *   backups/        one compressed copy of ads.json per day (kept 30 days)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const CRM = require('./crm');
const P = require('./parser');

const MAX_RUNS = 30;
const BAMA_PRICES_KEY = '__bama_prices'; // see setBamaPrices
// Daily cap of each site (see caps()): 1 to 2000 ad pages a day, 300 unless set.
const CAPS_KEY = '__caps';
const CAP_SITES = ['divar', 'bama', 'hamrah', 'k45'];
const DEFAULT_CAP = 300;
const cleanCap = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 1 ? Math.min(n, 2000) : DEFAULT_CAP; };
const MAX_BACKUPS = 30;
/** Backup files: radyab-YYYY-MM-DD(-n).json.gz; older ones from before the rename are noja-…. */
const BACKUP_NAME_RE = /^(radyab|noja)-\d{4}-\d{2}-\d{2}(-\d+)?\.json\.gz$/;

function writeJson(file, data) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
  fs.renameSync(`${file}.tmp`, file);
}

class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.runsDir = path.join(dataDir, 'runs');
    fs.mkdirSync(this.runsDir, { recursive: true });
    this.timers = new Map();
    // What changed since the online panel last heard from us (see src/cloud.js).
    this.changes = { ads: new Set(), crm: new Set(), searches: false, runs: new Set() };

    this.dailyFile = path.join(dataDir, 'daily.json');
    this.daily = { date: '', count: 0 };
    try { this.daily = JSON.parse(fs.readFileSync(this.dailyFile, 'utf8')); } catch (_) { /* empty */ }

    this.adsFile = path.join(dataDir, 'ads.json');
    this.db = { ads: {}, searches: {}, version: 0 };
    try { this.db = { ads: {}, searches: {}, version: 0, ...JSON.parse(fs.readFileSync(this.adsFile, 'utf8')) }; } catch (_) { /* empty */ }
    this.reclassifyAll();

    this.backupDir = path.join(dataDir, 'backups');
    fs.mkdirSync(this.backupDir, { recursive: true });
    this.closeStaleRuns();
    this.ensureDailyCheck();
  }

  /**
   * At start: a run still marked as running was cut off (the bot or its Chrome was closed).
   * Mark it stopped, and send the latest runs to the online panel again, so it does not show
   * an old «در حال جمع کردن» forever.
   */
  closeStaleRuns() {
    const ACTIVE = ['starting', 'waiting-login', 'collecting', 'reading', 'resting', 'blocked', 'paused'];
    let files = [];
    try { files = fs.readdirSync(this.runsDir).filter((f) => f.endsWith('.json')); } catch (_) { return; }
    const recent = files.map((f) => [f, fs.statSync(path.join(this.runsDir, f)).mtimeMs]).sort((a, b) => b[1] - a[1]).slice(0, 8);
    for (const [f] of recent) {
      const run = this.loadRun(f.replace(/\.json$/, ''));
      if (!run) continue;
      if (ACTIVE.includes(run.status)) {
        run.status = 'stopped';
        run.message = 'ربات بسته شد و این جستجو نیمه‌کاره ماند. آگهی‌هایی که خوانده بود، مانده‌اند.';
        run.finishedAt = run.finishedAt || Date.now();
        run.activity = '';
        run.waitUntil = null;
        writeJson(this.runFile(run.id), run);
      }
      this.changes.runs.add(run.id);
    }
  }

  /** Apply the current personal/dealer rule to every saved ad (rules improve over time). */
  reclassifyAll() {
    for (const [token, rec] of Object.entries(this.db.ads || {})) {
      if (!rec || !rec.post) continue;
      const sig = () => `${rec.post.brand}|${rec.post.seller}|${rec.post.sellerConfidence}|${(rec.post.sellerReasons || []).join()}|${rec.post.publishedAt || ''}|${(rec.post.images || []).join()}`;
      const before = sig();
      P.reclassifySaved(rec.post);
      require('./bama').alignModel(rec.post);
      // Photos saved as 200×200 thumbnails: the full-size ones.
      if (Array.isArray(rec.post.images)) rec.post.images = rec.post.images.map(P.fullImage);
      // The panel says «سایت» where it used to name the site.
      if (Array.isArray(rec.post.sellerReasons)) {
        rec.post.sellerReasons = rec.post.sellerReasons.map((r) => String(r).replace('در مشخصات دیوار', 'در مشخصات آگهی').replace('دیوار این آگهی را شخصی', 'سایت این آگهی را شخصی'));
      }
      // Ads saved before the publish date was read: estimate it from «X ساعت پیش» at read time.
      P.estimatePublished(rec.post, rec.lastReadAt || rec.firstSeenAt);
      if (before !== sig()) this.changes.ads.add(token);
    }
  }

  /** Mark everything as changed, so the online panel gets a full copy (first connection). */
  markAllChanged() {
    for (const [token, rec] of Object.entries(this.db.ads)) {
      this.changes.ads.add(token);
      if (rec.crm) this.changes.crm.add(token);
    }
    this.changes.searches = true;
    for (const f of fs.readdirSync(this.runsDir)) if (f.endsWith('.json')) this.changes.runs.add(f.replace(/\.json$/, ''));
  }

  /** A follow-up change made in the online panel. The newer change wins. Returns true if applied. */
  setCrmFromHost(token, crm) {
    const rec = this.db.ads[token];
    if (!rec || !crm) return false;
    if (rec.crm && (rec.crm.updatedAt || 0) >= (crm.updatedAt || 0)) return false;
    rec.crm = crm;
    this.changes.crm.delete(token);
    this.bump();
    this.scheduleFlush();
    return true;
  }

  /** Bumped on every change, so the UI can ask "anything new?" cheaply. */
  get version() { return this.db.version || 0; }
  bump() { this.db.version = (this.db.version || 0) + 1; }

  // ---------- daily counter ----------
  /** How many ad pages the bot opened today (local date): on one site, or on all of them. */
  dailyCount(site) {
    const today = new Date().toLocaleDateString('en-CA');
    if (this.daily.date !== today) this.daily = { date: today, count: 0, bySite: {} };
    // a day file from before the count per site: what was opened was on the first site
    if (!this.daily.bySite) this.daily.bySite = this.daily.count ? { divar: this.daily.count } : {};
    return site ? this.daily.bySite[site] || 0 : this.daily.count;
  }

  /** Today's count of each site: { divar: 12, bama: 3 … }. */
  dailyCounts() { this.dailyCount(); return { ...this.daily.bySite }; }

  countView(site = 'divar') {
    this.dailyCount();
    this.daily.count++;
    this.daily.bySite[site] = (this.daily.bySite[site] || 0) + 1;
    // Times of the ad pages opened in the last 24 h (for the captcha log: how busy was the bot?).
    const now = Date.now();
    this.daily.times = (this.daily.times || []).filter((t) => now - t < 24 * 3600000);
    this.daily.times.push(now);
    writeJson(this.dailyFile, this.daily);
  }

  /** Ad pages opened in the last `ms` milliseconds. */
  viewsSince(ms) {
    const from = Date.now() - ms;
    return (this.daily.times || []).filter((t) => t >= from).length;
  }

  // ---------- captcha / «درخواست زیاد» log ----------
  // Every time Divar asks for a captcha or says «too many requests», what led to it is kept here,
  // so Divar's limits can be worked out later (data/blocks.json, last 2000 events).
  logBlock(ev) {
    const file = path.join(this.dir, 'blocks.json');
    let list = [];
    try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* first one */ }
    list.push(ev);
    writeJson(file, list.slice(-2000));
  }

  listBlocks() {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'blocks.json'), 'utf8')); } catch (_) { return []; }
  }

  // ---------- runs ----------
  runFile(id) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('bad run id');
    return path.join(this.runsDir, `${id}.json`);
  }

  loadRun(id) {
    try { return JSON.parse(fs.readFileSync(this.runFile(id), 'utf8')); } catch (_) { return null; }
  }

  saveRunNow(run) {
    writeJson(this.runFile(run.id), run);
    this.changes.runs.add(run.id);
  }

  /** Debounced save, so a long scan does not rewrite the file after every ad. */
  saveRun(run, immediate) {
    clearTimeout(this.timers.get(run.id));
    if (immediate) { this.timers.delete(run.id); this.saveRunNow(run); return; }
    this.timers.set(run.id, setTimeout(() => { this.timers.delete(run.id); this.saveRunNow(run); }, 1000));
  }

  listRuns() {
    // newest first by time («reread_…» runs used to sort above every dated run by their name)
    const stamp = (f) => { try { return fs.statSync(path.join(this.runsDir, f)).mtimeMs; } catch (_) { return 0; } };
    const files = fs.readdirSync(this.runsDir).filter((f) => f.endsWith('.json')).map((f) => [f, stamp(f)]).sort((a, b) => b[1] - a[1]).map(([f]) => f);
    for (const old of files.slice(MAX_RUNS)) fs.rmSync(path.join(this.runsDir, old), { force: true });
    return files.slice(0, MAX_RUNS).map((f) => {
      const run = this.loadRun(f.replace(/\.json$/, ''));
      if (!run) return null;
      return {
        id: run.id,
        createdAt: run.createdAt,
        status: run.status,
        criteria: run.criteria,
        found: run.items.length,
        read: Object.keys(run.posts).length,
        newCount: run.stats && run.stats.newAds != null ? run.stats.newAds : null,
      };
    }).filter(Boolean).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  // ---------- permanent ad memory ----------
  /** The stored record of an ad, or null if the bot has never read it. */
  knownAd(token) {
    return this.db.ads[token] || null;
  }

  /** Remember a freshly read ad. Keeps its price history when the price changes. */
  rememberAd(post, searchKey) {
    const now = Date.now();
    const prev = this.db.ads[post.token];
    const rec = prev || { firstSeenAt: now, priceHistory: [] };
    if (post.price != null) {
      const last = rec.priceHistory[rec.priceHistory.length - 1];
      if (!last || last.price !== post.price) rec.priceHistory.push({ t: now, price: post.price });
    }
    rec.post = post;
    rec.lastReadAt = now;
    delete rec.removed;
    this.db.ads[post.token] = rec;
    this.changes.ads.add(post.token);
    if (searchKey) this.addToSearch(searchKey, post.token);
    this.bump();
    this.scheduleFlush();
    return rec;
  }

  /** Remember that an ad was deleted on Divar, so it is not retried. */
  markRemoved(token, searchKey) {
    const rec = this.db.ads[token] || { firstSeenAt: Date.now(), priceHistory: [] };
    rec.removed = Date.now();
    this.db.ads[token] = rec;
    this.changes.ads.add(token);
    if (searchKey) this.addToSearch(searchKey, token);
    this.bump();
    this.scheduleFlush();
  }

  /** Ads this search is still following up (active stages), for the daily re-check. */
  trackedTokens(key) {
    return this.searchTokens(key).filter((t) => {
      const rec = this.db.ads[t];
      return rec && rec.post && !rec.removed && rec.crm && CRM.ACTIVE_STAGES.includes(rec.crm.stage);
    });
  }

  // ---------- follow-up ----------
  applyCrm(token, body) {
    const rec = this.db.ads[token];
    if (!rec || !rec.post) throw new Error('آگهی پیدا نشد');
    CRM.applyAction(rec, body);
    this.changes.crm.add(token);
    this.bump();
    this.scheduleFlush();
    return rec;
  }

  /** Everything the UI needs: every ad with its follow-up data, and the saved searches. */
  exportAds() {
    const bySearch = {};
    for (const [key, s] of Object.entries(this.db.searches)) for (const t of s.tokens) (bySearch[t] || (bySearch[t] = [])).push(key);
    const ads = [];
    for (const [token, rec] of Object.entries(this.db.ads)) {
      if (!rec.post) continue;
      ads.push({
        token,
        post: rec.post,
        crm: rec.crm || null,
        removed: rec.removed || null,
        firstSeenAt: rec.firstSeenAt,
        lastReadAt: rec.lastReadAt,
        priceHistory: rec.priceHistory || [],
        searches: bySearch[token] || [],
      });
    }
    const searches = Object.entries(this.db.searches).map(([key, s]) => ({
      key, criteria: s.criteria || null, lastRunAt: s.lastRunAt || null, createdAt: s.createdAt, count: s.tokens.length, auto: s.auto || null,
    }));
    return { version: this.version, ads, searches };
  }

  // ---------- backups ----------
  listBackups() {
    return fs.readdirSync(this.backupDir).filter((f) => BACKUP_NAME_RE.test(f))
      .map((name) => { const st = fs.statSync(path.join(this.backupDir, name)); return { name, size: st.size, t: st.mtimeMs }; })
      .sort((a, b) => b.t - a.t || (a.name < b.name ? 1 : -1));
  }

  backupPath(name) {
    if (!BACKUP_NAME_RE.test(name)) throw new Error('نام پشتیبان نامعتبر');
    return path.join(this.backupDir, name);
  }

  /** Write a compressed backup. `force` makes an extra one even if today's exists. */
  backupNow(force) {
    const day = new Date().toLocaleDateString('en-CA');
    let name = `radyab-${day}.json.gz`;
    if (fs.existsSync(path.join(this.backupDir, name))) {
      if (!force) return null;
      name = `radyab-${day}-${Date.now() % 100000}.json.gz`;
    }
    const payload = JSON.stringify({ app: 'radyab', kind: 'backup', createdAt: Date.now(), db: this.db });
    fs.writeFileSync(path.join(this.backupDir, name), zlib.gzipSync(payload));
    for (const old of this.listBackups().slice(MAX_BACKUPS)) fs.rmSync(path.join(this.backupDir, old.name), { force: true });
    return name;
  }

  /** Replace all ad data with a backup (takes a fresh backup of the current data first). */
  restore(obj) {
    const db = obj && obj.db;
    if (!db || typeof db !== 'object' || typeof db.ads !== 'object' || typeof db.searches !== 'object') {
      throw new Error('این فایل پشتیبان ردیاب نیست');
    }
    this.backupNow(true);
    this.db = { ads: db.ads, searches: db.searches, version: (this.db.version || 0) + 1 };
    this.reclassifyAll();
    this.markAllChanged();
    this.flush();
    return Object.keys(this.db.ads).length;
  }

  addToSearch(key, token) {
    const s = this.db.searches[key] || (this.db.searches[key] = { tokens: [], createdAt: Date.now() });
    if (!s.tokens.includes(token)) { s.tokens.push(token); this.changes.searches = true; this.bump(); }
  }

  /** Every ad this saved search has found so far (newest first). */
  searchTokens(key) {
    const s = this.db.searches[key];
    return s ? s.tokens.slice() : [];
  }

  /** Daily automatic recheck settings of a saved search ({ on, hour, full }). */
  setAuto(key, auto) {
    const s = this.db.searches[key];
    if (!s) throw new Error('این جستجو پیدا نشد');
    s.auto = auto;
    this.changes.searches = true;
    this.bump();
    this.scheduleFlush();
    return s;
  }

  /**
   * The daily price check's switch and last check: a hidden saved search (see daily.js), made
   * once, switched off.
   */
  ensureDailyCheck() {
    const { DAILY_KEY } = require('./daily');
    if (this.db.searches[DAILY_KEY]) return;
    this.db.searches[DAILY_KEY] = { tokens: [], createdAt: Date.now(), auto: { on: false, hour: 9, full: false }, criteria: { hidden: true, dailyCheck: {} } };
    this.changes.searches = true;
    this.scheduleFlush();
  }

  dailyCheck() { return this.db.searches[require('./daily').DAILY_KEY] || null; }

  /** Today's price check was lined up: { day, at, keys, idle, merged, by }. */
  markDailyCheck(info) {
    this.ensureDailyCheck();
    const s = this.dailyCheck();
    s.criteria = { hidden: true, dailyCheck: info };
    s.lastRunAt = info.at;
    this.changes.searches = true;
    this.bump();
    this.scheduleFlush();
  }

  /**
   * Daily cap of each site (ad pages a day), set in «تنظیمات». Kept as a hidden saved search, so
   * it reaches the online panel with the searches. Missing or odd values: DEFAULT_CAP.
   */
  caps() {
    const s = this.db.searches[CAPS_KEY];
    const c = (s && s.criteria && s.criteria.caps) || {};
    return Object.fromEntries(CAP_SITES.map((id) => [id, cleanCap(c[id])]));
  }

  capFor(site) { return this.caps()[site] || DEFAULT_CAP; }

  setCaps(caps) {
    const next = { ...this.caps() };
    for (const id of CAP_SITES) if (caps && caps[id] != null && caps[id] !== '') next[id] = cleanCap(caps[id]);
    this.db.searches[CAPS_KEY] = { tokens: [], createdAt: Date.now(), criteria: { hidden: true, caps: next } };
    this.changes.searches = true;
    this.bump();
    this.scheduleFlush();
    return next;
  }

  /** Remember that today's automatic check of this search was lined up. */
  markAutoRan(key, day) {
    const s = this.db.searches[key];
    if (!s) return;
    s.lastAutoDay = day;
    this.changes.searches = true;
    this.scheduleFlush();
  }

  /**
   * Delete a saved search for good: the search itself, its run history, and the ads only this
   * search had found. Kept: ads another search also found, and ads you are following up
   * (any follow-up except «حذف‌شده»). `keyOf(criteria)` gives a run's search key.
   * A backup is written first. What was deleted is remembered for the online panel (db.gone).
   */
  deleteSearch(key, keyOf) {
    const s = this.db.searches[key];
    if (!s) throw new Error('این جستجو پیدا نشد');
    try { this.backupNow(true); } catch (_) { /* the daily backup is still there */ }
    const elsewhere = new Set();
    for (const [k, o] of Object.entries(this.db.searches)) if (k !== key) for (const t of o.tokens) elsewhere.add(t);
    const gone = this.gone();
    const out = { removedAds: 0, keptAds: 0, removedRuns: 0 };
    for (const t of s.tokens) {
      const rec = this.db.ads[t];
      if (!rec || elsewhere.has(t)) continue;
      if (rec.crm && rec.crm.stage !== 'rejected') { out.keptAds++; continue; }
      delete this.db.ads[t];
      this.changes.ads.delete(t);
      this.changes.crm.delete(t);
      gone.ads.push(t);
      out.removedAds++;
    }
    delete this.db.searches[key];
    for (const f of fs.readdirSync(this.runsDir)) {
      if (!f.endsWith('.json')) continue;
      const id = f.replace(/\.json$/, '');
      const run = this.loadRun(id);
      let same = false;
      try { same = !!(run && keyOf && keyOf(run.criteria || {}) === key); } catch (_) { /* not this search */ }
      if (!same) continue;
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
      fs.rmSync(path.join(this.runsDir, f), { force: true });
      this.changes.runs.delete(id);
      gone.runs.push(id);
      out.removedRuns++;
    }
    gone.ads = gone.ads.slice(-5000);
    gone.runs = gone.runs.slice(-500);
    this.changes.searches = true;
    this.bump();
    this.flush();
    return out;
  }

  /** Deleted ads and runs the online panel has not heard about yet. */
  gone() {
    return this.db.gone || (this.db.gone = { ads: [], runs: [] });
  }

  /** The online panel has deleted these too. */
  clearGone(sent) {
    if (!sent || !this.db.gone) return;
    const ads = new Set(sent.ads); const runs = new Set(sent.runs);
    this.db.gone.ads = this.db.gone.ads.filter((t) => !ads.has(t));
    this.db.gone.runs = this.db.gone.runs.filter((id) => !runs.has(id));
    this.scheduleFlush();
  }

  /**
   * Bama's daily new-car prices. Kept as a hidden entry of the searches list, so they reach the
   * online panel the way searches already do (the panel takes them out of the list).
   */
  setBamaPrices(items) {
    this.db.searches[BAMA_PRICES_KEY] = { tokens: [], createdAt: Date.now(), criteria: { hidden: true, bamaPrices: { at: Date.now(), items } } };
    this.changes.searches = true;
    this.bump();
    this.scheduleFlush();
  }

  bamaPricesAt() {
    const s = this.db.searches[BAMA_PRICES_KEY];
    return (s && s.criteria && s.criteria.bamaPrices && s.criteria.bamaPrices.at) || 0;
  }

  touchSearch(key, criteria) {
    const s = this.db.searches[key] || (this.db.searches[key] = { tokens: [], createdAt: Date.now() });
    // what only one run needs (the daily check's extras) is not kept with the search
    const { daily, trackKeys, ...rest } = criteria;
    s.criteria = { ...rest, recheckAll: false, auto: false };
    s.lastRunAt = Date.now();
    // started by hand (not by a daily check): the search is in use
    if (!criteria.auto) s.lastHandAt = s.lastRunAt;
    this.changes.searches = true;
    this.bump();
    this.scheduleFlush();
  }

  scheduleFlush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), 1500);
  }

  flush() {
    clearTimeout(this.flushTimer);
    writeJson(this.adsFile, this.db);
  }
}

module.exports = { Store, CAPS_KEY, CAP_SITES, DEFAULT_CAP };
