/*
 * «خرید با بودجه» on the PC: after the price-range search finishes, find the cars it turned
 * up that have too few same-model, same-year ads to judge their price, and line up a search
 * for each of those models (slowly, one after another, within the daily cap).
 */
'use strict';

const D = require('./deals');

const MAX_FOLLOW_UPS = 6;

/** Searches to queue after a budget run (criteria objects), biggest gaps first. */
function followUpSearches(store, run) {
  const c = run.criteria || {};
  const b = c.budget;
  if (!b || !(b.max > 0)) return [];
  const periodMs = Number(c.maxAgeDays) > 0 ? Number(c.maxAgeDays) * 86400000 : null;
  const posts = Object.values(store.db.ads)
    .filter((r) => r.post && (!periodMs || !r.post.publishedAt || Date.now() - r.post.publishedAt <= periodMs))
    .map((r) => ({ ...r.post, removed: r.removed }));
  const guide = D.priceGuide(posts);
  const { missing } = D.budgetPicks(posts, guide, { min: b.min, max: b.max, personalOnly: b.personalOnly });
  const out = [];
  for (const m of missing) {
    if (!m.year || !m.label || m.label === 'نامشخص') continue;
    // Divar's year filter is in Persian years; foreign cars are listed by Western year.
    const years = m.year > 1900 ? [m.year - 622, m.year - 621] : [m.year, m.year];
    out.push({
      query: m.label, yearMin: years[0], yearMax: years[1], city: c.city, maxAds: 40,
      maxAgeDays: c.maxAgeDays, speed: c.speed, dailyLimit: c.dailyLimit, batch: c.batch,
    });
    if (out.length >= MAX_FOLLOW_UPS) break;
  }
  return out;
}

module.exports = { followUpSearches, MAX_FOLLOW_UPS };
