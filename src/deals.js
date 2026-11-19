/*
 * Prices: «پیشنهاد ویژه», «قیمت‌یاب» and the best buys of «جستجوی ماشین» all use ONE rule,
 * so a car shows the same percent everywhere and on every device:
 *
 *   1. The market of a model + trim + model year is the middle asking price of its ads from the
 *      last MARKET_DAYS days (any city), each price turned into "as if the body were clean"
 *      (a painted car's price is divided by its body factor). Installment / «حواله» prices
 *      and accident cars are left out of the market.
 *   2. The usual price of one ad = that market (without the ad itself), moved for its mileage,
 *      times its own body factor (paint, replaced parts…, read from the specs AND the text).
 *   3. Its percent = how far its price is under that usual price.
 *
 * Dealers and «حواله» are never a special offer (listed apart). Accident cars, prices that
 * look too low and installment prices are «با احتیاط».
 *
 * Works in the browser (globalThis.NojaDeals) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  const P = root.NojaParser || (typeof require === 'function' ? require('./parser') : null);
  const DAY = 864e5;
  const MARKET_DAYS = 60; // the market is the asking prices of the last two months
  const DEAL_MIN = 0.05; // at least 5% under the usual price (after extras / problems)
  const HOT_MIN = 0.12;
  const TOO_CHEAP = 0.3; // more than 30% under: suspicious
  const GUIDE_MIN = 3; // fewer comparable ads: no numbers
  const GUIDE_SURE = 5; // fewer: «کم‌اطمینان»
  const INSTALLMENT_RE = /پیش\s?پرداخت|اقساط|قسطی|وام|لیزینگ|بیعانه|ضامن|شرایطی|چک\s?(صیادی|ماهانه)/;
  const HAVALEH_RE = /حواله/;

  /** A price that can be compared: there is one, and it is not a made-up one («۱٬۰۰۰ تومان»). */
  const realPrice = (p) => !!p && p.price > 0 && !P.fakePrice(p.price);
  const textOf = (p) => `${p.title || ''} ${p.description || ''} ${p.priceText || ''}`;
  const isInstallment = (p) => INSTALLMENT_RE.test(textOf(p));
  const isHavaleh = (p) => HAVALEH_RE.test(P.normalizeText(`${p.title || ''} ${p.description || ''}`));

  // Body condition is read once per ad object.
  const bodyCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  function condOf(p) {
    if (!bodyCache) return P.bodyCondition(p);
    let c = bodyCache.get(p);
    if (!c) { c = P.bodyCondition(p); bodyCache.set(p, c); }
    return c;
  }

  function badness(text) {
    if (!text) return null;
    if (/تصادفی|تعویض شده|ضربه|رنگ‌?شدگی|رنگ شدگی|صافکاری|نیاز به تعمیر|خوردگی|اوراقی|لکه/.test(text)) return 'bad';
    if (/سالم|بدون رنگ|بی.?رنگ|پلمپ|تعویض نشده|اورجینال/.test(text)) return 'good';
    return null;
  }

  /** «پژو 206 تیپ ۲» → "پژو 206 تیپ 2". Falls back to the title without «مدل …». */
  function modelName(p) {
    const raw = p.brand || String(p.title || '').replace(/[،,]?\s*مدل\s*[\d۰-۹]+.*$/, '');
    return P.normalizeText(raw).replace(/[«»"'()]/g, '').trim();
  }
  function groupKey(p) {
    const m = P.modelOf(p);
    return `${m.key}|${P.normalizeText(m.trim)}|${p.year}`;
  }

  function median(a) {
    const s = a.slice().sort((x, y) => x - y);
    if (!s.length) return null;
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /** Least-squares slope of price on mileage (toman per km), or null. */
  function slope(points) {
    if (points.length < 6) return null;
    const mx = points.reduce((s, p) => s + p[0], 0) / points.length;
    const my = points.reduce((s, p) => s + p[1], 0) / points.length;
    let num = 0;
    let den = 0;
    for (const [x, y] of points) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
    if (!den) return null;
    const b = num / den;
    return b < 0 ? b : null; // more km should never make a car more expensive
  }

  const fa = (n) => Number(n).toLocaleString('fa-IR');
  function priceFa(n) {
    if (n >= 1e9) return `${(n / 1e9).toLocaleString('fa-IR', { maximumFractionDigits: 2 })} میلیارد`;
    return `${(n / 1e6).toLocaleString('fa-IR', { maximumFractionDigits: 0 })} میلیون`;
  }

  function quantile(sorted, f) {
    const i = (sorted.length - 1) * f;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }
  /** Round to 5 million toman (prices are quoted that way). */
  const round5m = (n) => Math.round(n / 5e6) * 5e6;

  /** Ads whose price can be part of a market: real cash price of a car you can see, recent enough. */
  function marketable(p, now) {
    return realPrice(p) && p.year && !isInstallment(p) && !isHavaleh(p) && condOf(p).level !== 'accident'
      && (!p.publishedAt || now - p.publishedAt <= MARKET_DAYS * DAY);
  }

  /**
   * Market of one group (already marketable ads). Prices are "as if clean" (price / body factor).
   * Far-off prices are left out.
   */
  function guideFor(list) {
    const clean = (p) => p.price / condOf(p).factor;
    const med0 = median(list.map(clean));
    const used = med0 ? list.filter((p) => clean(p) > med0 * 0.75 && clean(p) < med0 * 1.35) : [];
    if (used.length < GUIDE_MIN) return { n: used.length, enough: false };
    const prices = used.map(clean).sort((a, b) => a - b);
    const market = quantile(prices, 0.5);
    const kms = used.filter((p) => p.mileage != null);
    const medKm = kms.length ? median(kms.map((p) => p.mileage)) : null;
    const b = slope(kms.map((p) => [p.mileage, clean(p)])) ?? -market * 1e-6; // ~1% per 10,000 km
    return {
      n: used.length,
      skipped: list.length - used.length,
      enough: true,
      sure: used.length >= GUIDE_SURE,
      min: prices[0],
      max: prices[prices.length - 1],
      marketRaw: market,
      // «خرید خوب» is the same line as on the price bar (3% under the usual price), everywhere.
      buyGood: round5m(market * ZONES.good),
      market: round5m(market),
      sellList: round5m(Math.max(market * 1.02, quantile(prices, 0.6))),
      // never below «خرید خوب»: selling fast should still beat a good buy
      sellFast: round5m(Math.max(market * ZONES.good, Math.min(market * 0.98, quantile(prices, 0.35)))),
      medKm,
      perKm: b,
      painted: used.filter((p) => condOf(p).rank >= 2).length,
      tokens: used.map((p) => p.token),
    };
  }

  function marketGroups(posts, now, allTrims = false) {
    const groups = new Map();
    for (const p of posts) {
      if (!marketable(p, now)) continue;
      const m = P.modelOf(p);
      // allTrims: one market per model and year, every trim together («همهٔ تیپ‌ها»)
      const key = allTrims ? `${m.key}||${p.year}` : groupKey(p);
      if (!groups.has(key)) groups.set(key, { key, modelKey: m.key, label: m.label, trim: allTrims ? '' : m.trim, year: p.year, list: [] });
      groups.get(key).list.push(p);
    }
    return groups;
  }

  /** The usual price of this ad: market (clean) → its mileage → its body. */
  function usualPrice(p, g) {
    let clean = g.marketRaw;
    if (p.mileage != null && g.medKm != null) clean = Math.min(clean * 1.2, Math.max(clean * 0.8, clean + g.perKm * (p.mileage - g.medKm)));
    return clean * condOf(p).factor;
  }

  /** Judge one ad against its market (built without the ad itself). */
  function judge(p, g) {
    const c = condOf(p);
    const expected = usualPrice(p, g);
    const discount = (expected - p.price) / expected;
    const reasons = [];
    const warnings = [];
    let score = discount;
    const basis = g.approx === 'years' ? `${fa(g.n)} آگهی همین مدل و تیپ از سال‌های نزدیک، تقریبی`
      : g.approx === 'trims' ? `${fa(g.n)} آگهی همین مدل با تیپ‌های دیگر، تقریبی`
        : g.approx === 'few' ? `فقط ${fa(g.n)} آگهی هم‌مدل و هم‌سال، تقریبی` : `${fa(g.n)} آگهی هم‌مدل و هم‌سال`;
    if (discount > 0.005) reasons.push(`${fa(Math.round(discount * 100))}٪ زیر قیمت معمول (${priceFa(Math.round(expected))}، از روی ${basis})`);
    else if (discount < -0.005) warnings.push(`${fa(Math.round(-discount * 100))}٪ گران‌تر از هم‌مدل‌ها`);
    if (p.mileage != null && g.medKm && p.mileage < g.medKm * 0.8) reasons.push(`کارکرد کم (${fa(Math.round(p.mileage / 1000))} هزار، معمول ${fa(Math.round(g.medKm / 1000))} هزار)`);

    // Body: already in the usual price; say so, and flag a seller who says two things.
    if (c.conflict) warnings.unshift(`در مشخصات «${c.spec[0]}» آمده، ولی در توضیحات نوشته: «${c.words.join('»، «')}»`);
    if (c.level === 'clean') reasons.push('بدنه سالم');
    else if (c.level) {
      const off = Math.round((1 - c.factor) * 100);
      warnings.push(`بدنه: ${c.label}${c.spec.length && !c.conflict ? ` («${c.spec[0]}»)` : ''} — قیمت معمولش ${fa(off)}٪ کمتر حساب شد`);
    }
    if (c.sheet) warnings.push('برگهٔ کارشناسی در عکس‌هاست — قبل از تماس ببینید');
    if (badness(p.engine) === 'bad') { score -= 0.1; warnings.push(`موتور: ${p.engine}`); }

    // Recent repairs and extras (لاستیک نو، تسمه تایم…) add a little; bad signs take away.
    const tags = P.valueTags ? P.valueTags(p) : [];
    score += P.valueBoost ? P.valueBoost(tags) : 0;
    const good = tags.filter((t) => !t.bad).map((t) => t.label);
    if (good.length) reasons.push(good.join('، '));
    for (const t of tags.filter((x) => x.bad)) warnings.push(t.label);

    const havaleh = isHavaleh(p);
    const dealer = p.seller === 'dealer' || havaleh;
    if (havaleh) warnings.push('حواله است، نه ماشین تحویلی؛ احتمالاً واسطه یا نمایشگاه');
    else if (dealer) warnings.push('نمایشگاهی');
    else reasons.push('فروشنده شخصی');

    const installment = isInstallment(p);
    const tooCheap = discount > TOO_CHEAP;
    const accident = c.level === 'accident';
    if (installment) warnings.unshift('قیمت احتمالاً پیش‌پرداخت یا اقساطی است');
    if (tooCheap) warnings.unshift('خیلی ارزان‌تر از بقیه؛ ممکن است تصادفی، پیش‌پرداخت یا کلاهبرداری باشد');
    if (accident) warnings.unshift('تصادفی یا ضربهٔ شاسی');
    const cheap = score >= DEAL_MIN;
    const caution = (installment || tooCheap || accident) && discount > DEAL_MIN;
    // An approximate comparison is good enough to judge a price (the bar), not to put an ad in
    // the special-offer, dealer or caution lists.
    let level = null;
    if (g.approx) level = null;
    else if (caution) level = 'caution';
    else if (cheap && dealer) level = 'dealer';
    else if (cheap) level = score >= HOT_MIN ? 'hot' : 'good';
    return {
      model: g.key, peers: g.n, sure: g.sure && !g.approx, approx: g.approx || null, installment, expected: Math.round(expected), discount, score,
      // what it was compared with: the asking prices (as if clean) and the usual mileage
      range: [Math.round(g.min), Math.round(g.max)], medKm: g.medKm,
      level, deal: level === 'hot' || level === 'good', caution: level === 'caution', dealer,
      body: c, reasons, warnings,
    };
  }

  /**
   * posts: parsed posts (token, price, year, mileage, brand, title, body, engine, chassis, seller, description).
   * Returns Map token → { model, peers, expected, discount, score, level, deal, caution, dealer, body, reasons[], warnings[] }
   * for every ad that has enough comparable ads. level: hot | good | dealer | caution | null.
   */
  const YEAR_STEP = 0.02; // one model year newer ≈ 2% dearer (Tehran asking prices, Nov 2026)

  /**
   * Too few ads of the same trim and year: compare with the same model and trim from nearby
   * years (±2), then with other trims of the model (±1 year); prices moved to this ad's year.
   * Marked `approx`.
   */
  const DEAL_PEERS = 5; // an exact comparison needs this many other ads of the same model, trim and year

  /**
   * The market one ad is judged against, most exact first:
   *   ≥5 of the same trim and year → exact (the only kind that can make the lists)
   *   ≥5 of the same trim, ±2 years · ≥5 of the model, ±1 year · then the same with ≥3 → approx
   * Prices of other years are moved to this ad's year.
   */
  function marketFor(p, exactList, modelList) {
    const y = P.shamsiYear(p.year);
    const trim = P.normalizeText(P.modelOf(p).trim);
    const others = (modelList || []).filter((q) => q.token !== p.token);
    const moved = (qs) => qs.map((q) => {
      const c = { ...q, price: q.price * (1 + YEAR_STEP) ** (y - P.shamsiYear(q.year)) };
      if (bodyCache) bodyCache.set(c, condOf(q));
      return c;
    });
    const exact = guideFor((exactList || []).filter((q) => q.token !== p.token));
    if (exact.enough && exact.n >= DEAL_PEERS) return exact;
    const years = guideFor(moved(others.filter((q) => P.normalizeText(P.modelOf(q).trim) === trim && Math.abs(P.shamsiYear(q.year) - y) <= 2)));
    if (years.enough && years.n >= DEAL_PEERS) return { ...years, approx: 'years' };
    const trims = guideFor(moved(others.filter((q) => Math.abs(P.shamsiYear(q.year) - y) <= 1)));
    if (trims.enough && trims.n >= DEAL_PEERS) return { ...trims, approx: 'trims' };
    if (exact.enough) return { ...exact, approx: 'few' };
    if (years.enough) return { ...years, approx: 'years' };
    if (trims.enough) return { ...trims, approx: 'trims' };
    return null;
  }

  function computeDeals(posts, { now = Date.now() } = {}) {
    const groups = marketGroups(posts, now);
    const byModel = new Map();
    for (const g of groups.values()) {
      if (!byModel.has(g.modelKey)) byModel.set(g.modelKey, []);
      byModel.get(g.modelKey).push(...g.list);
    }
    const out = new Map();
    for (const p of posts) {
      if (!realPrice(p) || p.removed || !p.year) continue;
      const key = groupKey(p);
      const g0 = groups.get(key);
      const g = marketFor(p, g0 && g0.list, byModel.get(P.modelOf(p).key));
      if (!g) continue;
      out.set(p.token, judge(p, { ...g, key }));
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // «قیمت‌یاب» — price guide for one model + trim + year (for a clean body).
  //   buyGood  : a quarter of the ads are cheaper (buying up to this is a good buy)
  //   market   : the middle price (median)
  //   sellList : what to write in your ad (a little above the middle, room to bargain)
  //   sellFast : a little under the middle, to sell quickly
  // ---------------------------------------------------------------------------
  /** Body condition of «ماشین خودم» → price factor (same factors as the ads). */
  const BODY_FACTORS = { clean: 1, scratches: P.BODY_LEVELS.minor.factor, paint: P.BODY_LEVELS.paint.factor, accident: P.BODY_LEVELS.accident.factor };

  /**
   * Price guide for every model + trim + year with enough ads.
   * posts: parsed posts (removed ones count too: they were on sale at that price).
   * Returns [{ key, modelKey, label, trim, year, ...guideFor }] sorted by model size, then year.
   */
  function priceGuide(posts, { now = Date.now(), allTrims = false } = {}) {
    const groups = marketGroups(posts, now, allTrims);
    const sizes = new Map();
    for (const g of groups.values()) sizes.set(g.modelKey, (sizes.get(g.modelKey) || 0) + g.list.length);
    return Array.from(groups.values())
      .map((g) => ({ key: g.key, modelKey: g.modelKey, label: g.label, trim: g.trim, year: g.year, total: g.list.length, ...guideFor(g.list) }))
      .sort((a, b) => sizes.get(b.modelKey) - sizes.get(a.modelKey) || a.modelKey.localeCompare(b.modelKey)
        || Number(b.enough) - Number(a.enough) || b.year - a.year || b.n - a.n);
  }

  /** «ماشین خودم»: the guide adjusted for its mileage and body. */
  function myCarPrice(g, { mileage, body } = {}) {
    if (!g || !g.enough) return null;
    const f = BODY_FACTORS[body] || 1;
    let kmDelta = 0;
    if (mileage != null && g.medKm != null) kmDelta = g.perKm * (mileage - g.medKm);
    const adj = (n) => round5m(Math.min(n * 1.2, Math.max(n * 0.8, n + kmDelta)) * f);
    return { sellList: adj(g.sellList), sellFast: adj(g.sellFast), market: adj(g.market), buyGood: adj(g.buyGood) };
  }

  // ---------------------------------------------------------------------------
  // Best buys in a price range («جستجوی ماشین»): the same judgement as «پیشنهاد ویژه»
  // (pass its Map, or it is worked out here), filtered to the range. Cars without enough
  // comparables are listed apart, so the bot can gather their same-model ads.
  // ---------------------------------------------------------------------------
  function budgetPicks(posts, deals, { min, max, personalOnly = false, kmMax = null } = {}) {
    const judged = deals instanceof Map ? deals : computeDeals(posts);
    const inRange = posts.filter((p) => realPrice(p) && !p.removed && p.price <= max && p.price >= (min || 0)
      && (!personalOnly || (p.seller !== 'dealer' && !isHavaleh(p))) && (kmMax == null || p.mileage == null || p.mileage <= kmMax));
    const picks = [];
    const missing = new Map();
    for (const p of inRange) {
      const d = judged.get(p.token);
      if (!d) {
        const m = P.modelOf(p);
        const mk = `${m.key}|${p.year || ''}`;
        const x = missing.get(mk) || { modelKey: m.key, label: m.label, year: p.year || null, count: 0 };
        x.count++;
        missing.set(mk, x);
        continue;
      }
      picks.push({ token: p.token, post: p, ...d });
    }
    picks.sort((a, b) => Number(a.caution) - Number(b.caution) || b.score - a.score);
    return {
      total: inRange.length,
      picks,
      missing: Array.from(missing.values()).sort((a, b) => b.count - a.count),
    };
  }

  // ---------------------------------------------------------------------------
  // Buy advice for one ad, from its usual price (same model/trim/year, its km and body):
  //   great ≤ 8% under · good ≤ 3% under · fair up to 4% over · above that: expensive.
  // ---------------------------------------------------------------------------
  const ZONES = { great: 0.92, good: 0.97, fair: 1.04 };
  function priceVerdict(price, expected) {
    if (!(price > 0) || !(expected > 0)) return null;
    const great = round5m(expected * ZONES.great);
    const good = round5m(expected * ZONES.good);
    const fair = round5m(expected * ZONES.fair);
    const zone = price <= great ? 'great' : price <= good ? 'good' : price <= fair ? 'fair' : 'high';
    return { zone, great, good, fair, expected: round5m(expected), diff: price - expected };
  }

  const api = { computeDeals, priceVerdict, ZONES, isInstallment, marketable: (p, now = Date.now()) => marketable(p, now), modelName, priceGuide, myCarPrice, budgetPicks, isHavaleh, BODY_FACTORS, DEAL_MIN, HOT_MIN, TOO_CHEAP, MARKET_DAYS };
  root.NojaDeals = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
