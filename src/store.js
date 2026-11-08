/*
 * Local storage under the data folder:
 *   runs/<id>.json  one file per search run
 *   ads.json        permanent memory of every ad ever read (never reopened unless its price changes),
 *                   plus which saved search each ad belongs to
 *   daily.json      how many ad pages were opened today
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_RUNS = 30;

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

    this.dailyFile = path.join(dataDir, 'daily.json');
    this.daily = { date: '', count: 0 };
    try { this.daily = JSON.parse(fs.readFileSync(this.dailyFile, 'utf8')); } catch (_) { /* empty */ }

    this.adsFile = path.join(dataDir, 'ads.json');
    this.db = { ads: {}, searches: {} };
    try { this.db = { ads: {}, searches: {}, ...JSON.parse(fs.readFileSync(this.adsFile, 'utf8')) }; } catch (_) { /* empty */ }
  }

  // ---------- daily counter ----------
  /** How many ad pages the bot opened today (local date). */
  dailyCount() {
    const today = new Date().toLocaleDateString('en-CA');
    if (this.daily.date !== today) this.daily = { date: today, count: 0 };
    return this.daily.count;
  }

  countView() {
    this.dailyCount();
    this.daily.count++;
    writeJson(this.dailyFile, this.daily);
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
  }

  /** Debounced save, so a long scan does not rewrite the file after every ad. */
  saveRun(run, immediate) {
    clearTimeout(this.timers.get(run.id));
    if (immediate) { this.timers.delete(run.id); this.saveRunNow(run); return; }
    this.timers.set(run.id, setTimeout(() => { this.timers.delete(run.id); this.saveRunNow(run); }, 1000));
  }

  listRuns() {
    const files = fs.readdirSync(this.runsDir).filter((f) => f.endsWith('.json')).sort().reverse();
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
    }).filter(Boolean);
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
    if (searchKey) this.addToSearch(searchKey, post.token);
    this.scheduleFlush();
    return rec;
  }

  /** Remember that an ad was deleted on Divar, so it is not retried. */
  markRemoved(token, searchKey) {
    const rec = this.db.ads[token] || { firstSeenAt: Date.now(), priceHistory: [] };
    rec.removed = Date.now();
    this.db.ads[token] = rec;
    if (searchKey) this.addToSearch(searchKey, token);
    this.scheduleFlush();
  }

  addToSearch(key, token) {
    const s = this.db.searches[key] || (this.db.searches[key] = { tokens: [], createdAt: Date.now() });
    if (!s.tokens.includes(token)) s.tokens.push(token);
  }

  /** Every ad this saved search has found so far (newest first). */
  searchTokens(key) {
    const s = this.db.searches[key];
    return s ? s.tokens.slice() : [];
  }

  touchSearch(key, criteria) {
    const s = this.db.searches[key] || (this.db.searches[key] = { tokens: [], createdAt: Date.now() });
    s.criteria = criteria;
    s.lastRunAt = Date.now();
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

module.exports = { Store };
