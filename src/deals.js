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

  const api = { computeDeals, modelName, DEAL_MIN, HOT_MIN, TOO_CHEAP };
  root.NojaDeals = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
