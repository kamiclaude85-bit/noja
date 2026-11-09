/*
 * «پیشنهاد ویژه» — finds ads priced well below what the same car usually costs.
 *
 * Each ad is compared with the other ads of the same model (brand/trim) and the
 * same model year. The usual price is their median, adjusted for mileage
 * (a regression on the group when it is big enough, otherwise ~1% per 10,000 km).
 * Problems lower the score (painted/accident body, engine, chassis, dealer).
 * Ads that look too cheap, or whose price is probably a down payment for
 * installments, are kept apart with a warning instead of being recommended.
 *
 * Works in the browser (globalThis.NojaDeals) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  const P = root.NojaParser || (typeof require === 'function' ? require('./parser') : null);
  const MIN_PEERS = 3; // other ads of the same model+year needed for a fair comparison
  const DEAL_MIN = 0.05; // at least 5% under the usual price (after penalties)
  const HOT_MIN = 0.12;
  const TOO_CHEAP = 0.3; // more than 30% under: suspicious
  const INSTALLMENT_RE = /پیش\s?پرداخت|اقساط|قسطی|وام|لیزینگ|بیعانه|چک\s?(صیادی|ماهانه)/;

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

  /**
   * posts: array of parsed posts (token, price, year, mileage, brand, title, body, engine, chassis, seller, description).
   * Returns Map token → { model, peers, expected, discount, score, level, deal, caution, reasons[], warnings[] }.
   */
  function computeDeals(posts) {
    const priced = posts.filter((p) => p && p.price > 1e6 && !p.removed);
    const groups = new Map();
    for (const p of priced) {
      const key = `${modelName(p)}|${p.year || '?'}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    const out = new Map();
    for (const [key, list] of groups) {
      if (key.endsWith('|?')) continue; // year unknown: no fair comparison
      for (const p of list) {
        const peers = list.filter((q) => q.token !== p.token);
        if (peers.length < MIN_PEERS) continue;
        const med = median(peers.map((q) => q.price));
        const kms = peers.filter((q) => q.mileage != null);
        const medKm = kms.length ? median(kms.map((q) => q.mileage)) : null;
        let expected = med;
        if (p.mileage != null && medKm != null) {
          const b = slope(kms.map((q) => [q.mileage, q.price])) ?? -med * 1e-6; // ~1% per 10,000 km
          expected = Math.min(med * 1.2, Math.max(med * 0.8, med + b * (p.mileage - medKm)));
        }
        const discount = (expected - p.price) / expected;
        let score = discount;
        const reasons = [];
        const warnings = [];
        if (discount > 0) reasons.push(`${fa(Math.round(discount * 100))}٪ ارزان‌تر از قیمت معمول (${priceFa(expected)}، از روی ${fa(peers.length)} آگهی مشابه)`);
        if (p.mileage != null && medKm && p.mileage < medKm * 0.8) reasons.push(`کارکرد کمتر از معمول (${fa(p.mileage)} در برابر ${fa(Math.round(medKm))})`);
        const body = badness(p.body); const engine = badness(p.engine); const chassis = badness(p.chassis);
        if (body === 'bad') { score -= 0.06; warnings.push(`بدنه: ${p.body}`); } else if (body === 'good') reasons.push('بدنه سالم');
        if (engine === 'bad') { score -= 0.1; warnings.push(`موتور: ${p.engine}`); }
        if (chassis === 'bad') { score -= 0.12; warnings.push(`شاسی: ${p.chassis}`); }
        if (p.seller === 'dealer') score -= 0.02; else reasons.push('فروشنده شخصی');
        // Recent repairs and extras (لاستیک نو، تسمه تایم…) add a little; bad signs take away.
        const tags = P.valueTags ? P.valueTags(p) : [];
        score += P.valueBoost ? P.valueBoost(tags) : 0;
        const goodTags = tags.filter((t) => !t.bad).map((t) => t.label);
        if (goodTags.length) reasons.push(goodTags.join('، '));
        for (const t of tags.filter((x) => x.bad)) warnings.push(t.label);
        const installment = INSTALLMENT_RE.test(`${p.description || ''} ${p.priceText || ''}`);
        const tooCheap = discount > TOO_CHEAP;
        if (installment) warnings.unshift('قیمت احتمالاً پیش‌پرداخت یا اقساطی است');
        if (tooCheap) warnings.unshift('خیلی ارزان‌تر از بقیه؛ ممکن است تصادفی، پیش‌پرداخت یا کلاهبرداری باشد');
        const caution = (installment || tooCheap) && discount > DEAL_MIN;
        const deal = !caution && score >= DEAL_MIN;
        out.set(p.token, {
          model: key, peers: peers.length, expected: Math.round(expected), discount, score,
          level: deal ? (score >= HOT_MIN ? 'hot' : 'good') : caution ? 'caution' : null,
          deal, caution, reasons, warnings,
        });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // «قیمت‌یاب» — price guide for one model + trim + year, from the asking prices on Divar.
  //   buyGood  : a quarter of the ads are cheaper (buying up to this is a good buy)
  //   market   : the middle price (median)
  //   sellList : what to write in your ad (a little above the middle, room to bargain)
  //   sellFast : a little under the middle, to sell quickly
  // Installment / «شرایطی» prices (down payments) and far-off prices are left out.
  // ---------------------------------------------------------------------------
  const GUIDE_MIN = 3; // fewer ads: no numbers
  const GUIDE_SURE = 5; // fewer ads: «کم‌اطمینان»
  const GUIDE_INSTALLMENT_RE = /پیش\s?پرداخت|اقساط|قسطی|وام|لیزینگ|بیعانه|ضامن|شرایطی|چک\s?(صیادی|ماهانه)/;
  /** Body condition of «ماشین خودم» → price factor. */
  const BODY_FACTORS = { clean: 1, scratches: 0.98, paint: 0.94, accident: 0.88 };

  function quantile(sorted, f) {
    const i = (sorted.length - 1) * f;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }
  /** Round to 5 million toman (prices are quoted that way). */
  const round5m = (n) => Math.round(n / 5e6) * 5e6;

  function guideFor(list) {
    const cash = list.filter((p) => !GUIDE_INSTALLMENT_RE.test(`${p.title || ''} ${p.description || ''} ${p.priceText || ''}`));
    const med0 = median(cash.map((p) => p.price));
    const used = med0 ? cash.filter((p) => p.price > med0 * 0.75 && p.price < med0 * 1.35) : [];
    if (used.length < GUIDE_MIN) return { n: used.length, enough: false };
    const prices = used.map((p) => p.price).sort((a, b) => a - b);
    const market = quantile(prices, 0.5);
    const kms = used.filter((p) => p.mileage != null);
    const medKm = kms.length ? median(kms.map((p) => p.mileage)) : null;
    const b = slope(kms.map((p) => [p.mileage, p.price])) ?? -market * 1e-6; // ~1% per 10,000 km
    return {
      n: used.length,
      skipped: list.length - used.length,
      enough: true,
      sure: used.length >= GUIDE_SURE,
      min: prices[0],
      max: prices[prices.length - 1],
      buyGood: round5m(quantile(prices, 0.25)),
      market: round5m(market),
      sellList: round5m(Math.max(market * 1.02, quantile(prices, 0.6))),
      // never below «خرید خوب»: selling fast should still beat a good buy
      sellFast: round5m(Math.max(quantile(prices, 0.25), Math.min(market * 0.98, quantile(prices, 0.35)))),
      medKm,
      perKm: b,
      tokens: used.map((p) => p.token),
    };
  }

  /**
   * Price guide for every model + trim + year with enough ads.
   * posts: parsed posts (removed ones count too: they were on sale at that price).
   * Returns [{ key, modelKey, label, trim, year, ...guideFor }] sorted by model size, then year.
   */
  function priceGuide(posts) {
    const groups = new Map();
    for (const p of posts) {
      if (!p || !(p.price > 1e6) || !p.year) continue;
      const m = P.modelOf(p);
      const key = `${m.key}|${P.normalizeText(m.trim)}|${p.year}`;
      if (!groups.has(key)) groups.set(key, { key, modelKey: m.key, label: m.label, trim: m.trim, year: p.year, list: [] });
      groups.get(key).list.push(p);
    }
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

  const api = { computeDeals, modelName, priceGuide, myCarPrice, BODY_FACTORS, DEAL_MIN, HOT_MIN, TOO_CHEAP };
  root.NojaDeals = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
