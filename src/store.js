/* Saves runs (one JSON file each) and a cache of already-read ads under the data folder. */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CACHE_TTL = 6 * 60 * 60 * 1000;
const MAX_RUNS = 30;

class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.runsDir = path.join(dataDir, 'runs');
    fs.mkdirSync(this.runsDir, { recursive: true });
    this.cacheFile = path.join(dataDir, 'cache.json');
    this.cache = {};
    try { this.cache = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')); } catch (_) { /* empty */ }
    this.timers = new Map();
  }

  runFile(id) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('bad run id');
    return path.join(this.runsDir, `${id}.json`);
  }

  loadRun(id) {
    try { return JSON.parse(fs.readFileSync(this.runFile(id), 'utf8')); } catch (_) { return null; }
  }

  saveRunNow(run) {
    const file = this.runFile(run.id);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(run));
    fs.renameSync(`${file}.tmp`, file);
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
      };
    }).filter(Boolean);
  }

  cachedPost(token) {
    const rec = this.cache[token];
    return rec && Date.now() - rec.t < CACHE_TTL ? rec.post : null;
  }

  cachePost(post) {
    this.cache[post.token] = { t: Date.now(), post };
    clearTimeout(this.cacheTimer);
    this.cacheTimer = setTimeout(() => this.flushCache(), 2000);
  }

  flushCache() {
    const now = Date.now();
    for (const [k, v] of Object.entries(this.cache)) if (now - v.t > CACHE_TTL) delete this.cache[k];
    fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache));
  }
}

module.exports = { Store };
