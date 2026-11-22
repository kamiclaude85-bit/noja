/*
 * Daily price history: once a day (renewed through the day, the last one counts) the usual market
 * price of every model + trim + year with enough ads, and of every model + year with all trims
 * together, is kept in data/price-history.json. Used for «a week / a month ago → today» (stories,
 * reels, trends). Kept 400 days.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const D = require('./deals');

const KEEP_DAYS = 400;
const localDay = (t) => new Date(t).toLocaleDateString('en-CA');

class PriceHistory {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'price-history.json');
    this.db = { days: {} };
    try { this.db = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) { /* first day */ }
    if (!this.db.days) this.db.days = {};
  }

  /** Today's prices from the ads in memory (posts: every ad read, sold ones too). */
  snapshot(posts, now = Date.now()) {
    const rows = {};
    const keep = (g, all) => {
      if (!g.enough) return;
      rows[all ? `${g.modelKey}||${g.year}` : g.key] = {
        model: g.modelKey, label: g.label, trim: all ? '' : g.trim, year: g.year,
        market: g.market, buyGood: g.buyGood, n: g.n, medKm: g.medKm,
      };
    };
    for (const g of D.priceGuide(posts, { now })) keep(g, false);
    for (const g of D.priceGuide(posts, { now, allTrims: true })) keep(g, true);
    const day = localDay(now);
    this.db.days[day] = { at: now, rows };
    const days = Object.keys(this.db.days).sort();
    for (const d of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) delete this.db.days[d];
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.db));
    fs.renameSync(tmp, this.file);
    return { day, rows: Object.keys(rows).length };
  }

  /** The price series of one market key («model|trim|year», or «model||year» for all trims). */
  series(key) {
    return Object.keys(this.db.days).sort().map((day) => {
      const r = this.db.days[day].rows[key];
      return r ? { day, market: r.market, n: r.n } : null;
    }).filter(Boolean);
  }

  /** Price of a market key on a day (or the closest earlier day kept). */
  priceOn(key, day) {
    const days = Object.keys(this.db.days).filter((d) => d <= day).sort().reverse();
    for (const d of days) { const r = this.db.days[d].rows[key]; if (r) return { day: d, ...r }; }
    return null;
  }

  days() { return Object.keys(this.db.days).sort(); }
}

module.exports = { PriceHistory, localDay };
