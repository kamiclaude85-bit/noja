// Pricing audit of one ad and its trim: every factor checked against the ads read (data, not
// assumptions). Usage: node tools/audit-pricing.js <ad token>   (reads data/ads.json, read-only)
const fs = require('fs');
const zlib = require('zlib');
const P = require('../src/parser');
const D = require('../src/deals');
const j = JSON.parse(fs.readFileSync(require('path').join(__dirname, '..', 'data', 'ads.json'), 'utf8'));
const TOKEN = process.argv[2];
if (!TOKEN) { console.error('usage: node tools/audit-pricing.js <ad token>'); process.exit(1); }
const bp = j.searches.__bama_prices && j.searches.__bama_prices.criteria.bamaPrices;
const newItems = bp ? bp.items : [];
const now = Date.now();
const DAY = 864e5;
const recs = Object.entries(j.ads).filter(([, a]) => a.post).map(([t, a]) => ({ ...a.post, token: t, removed: a.removed, firstSeenAt: a.firstSeenAt, priceHistory: a.priceHistory || [] }));
const TRIM = D.trimOf(recs.find((p) => p.token === TOKEN));
const MK = P.modelOf(recs.find((p) => p.token === TOKEN)).key;
const grp = recs.filter((p) => P.modelOf(p).key === MK && D.trimOf(p) === TRIM);
const M = (x) => Math.round(x / 1e6);
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const q = (a, f) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) * f)] : null; };
const out = (...x) => console.log(...x);

out('TRIM', TRIM, 'ads of this trim (all years):', grp.length);
const deals = D.computeDeals(recs, { newPrices: newItems });
// 1-2. per year: what is in the market and what is left out
for (const y of [1401, 1402, 1403, 1404, 1405]) {
  const g = grp.filter((p) => P.shamsiYear(p.year) === y);
  if (!g.length) continue;
  const mk = g.filter((p) => D.marketable(p, now));
  const why = g.filter((p) => !D.marketable(p, now)).map((p) => (D.isInstallment(p) ? 'installment' : D.isHavaleh(p) ? 'havaleh' : !p.price ? 'noprice' : p.publishedAt && now - p.publishedAt > 60 * DAY ? 'old' : 'other'));
  const prices = mk.map((p) => p.price);
  out(`\n== ${y}: ${g.length} ads, in market ${mk.length}; left out: ${JSON.stringify(why.reduce((o, k) => ((o[k] = (o[k] || 0) + 1), o), {}))}`);
  out('   prices (M):', prices.map(M).sort((a, c) => a - c).join(','));
  out('   median', M(med(prices)), 'q25', M(q(prices, 0.25)), 'q75', M(q(prices, 0.75)), 'spread', Math.round(((q(prices, 0.75) - q(prices, 0.25)) / med(prices)) * 100) + '%');
  // 3. zero-km
  const zero = mk.filter((p) => (p.mileage != null && p.mileage < 1000) || /صفر/.test(p.title || ''));
  out('   zero-km in market:', zero.length, zero.map((p) => `${M(p.price)}@${p.mileage}km`).join(' '));
  // 4. dealer vs private
  const dl = mk.filter((p) => p.seller === 'dealer'); const pv = mk.filter((p) => p.seller !== 'dealer');
  out('   dealer', dl.length, 'median', M(med(dl.map((p) => p.price))), '| private', pv.length, 'median', M(med(pv.map((p) => p.price))));
  // sources
  out('   sources', JSON.stringify(mk.reduce((o, p) => ((o[p.source || 'divar'] = (o[p.source || 'divar'] || 0) + 1), o), {})));
  // 5. age
  const ages = mk.map((p) => Math.round((now - (p.publishedAt || p.firstSeenAt)) / DAY));
  out('   ad age days: median', med(ages), 'max', Math.max(...ages), '| >30d:', ages.filter((a) => a > 30).length);
  const dropped = mk.filter((p) => p.priceHistory.length > 1);
  out('   price changed:', dropped.length, dropped.map((p) => p.priceHistory.map((h) => M(h.price)).join('→')).join(' ; '));
  // 7. mileage
  const pts = mk.filter((p) => p.mileage != null && p.mileage >= 1000).map((p) => [p.mileage, p.price]);
  if (pts.length >= 6) {
    const mx = pts.reduce((s, [x]) => s + x, 0) / pts.length; const my = pts.reduce((s, [, v]) => s + v, 0) / pts.length;
    const slope = pts.reduce((s, [x, v]) => s + (x - mx) * (v - my), 0) / pts.reduce((s, [x]) => s + (x - mx) ** 2, 0);
    out('   km: median', med(pts.map((x) => x[0])), '| data slope per 10k km:', M(slope * 1e4), 'M (', Math.round((slope * 1e4 / my) * 1000) / 10, '% )');
  }
  // 8. body
  const lv = (p) => P.bodyCondition(p).level || 'unknown';
  const byBody = {};
  for (const p of mk) (byBody[lv(p)] = byBody[lv(p)] || []).push(p.price);
  out('   body:', Object.entries(byBody).map(([k, v]) => `${k} n=${v.length} med=${M(med(v))}`).join(' | '));
  // 11. Divar's own verdict vs ours
  const dv = mk.filter((p) => p.fields && p.fields['ارزیابی قیمت']);
  const agree = { same: 0, diff: 0 }; const diffs = [];
  for (const p of dv) {
    const d = deals.get(p.token); if (!d) continue;
    const v = D.priceVerdict(p.price, d.expected, d.fairTop).zone;
    const ours = v === 'high' ? 'بالاتر' : v === 'great' ? 'پایین' : 'محدوده';
    const theirs = /بالا/.test(p.fields['ارزیابی قیمت']) ? 'بالاتر' : /پایین|کمتر|مناسب/.test(p.fields['ارزیابی قیمت']) ? 'پایین' : 'محدوده';
    if (ours === theirs) agree.same++; else { agree.diff++; diffs.push(`${M(p.price)}:${p.fields['ارزیابی قیمت']}/ours ${v}`); }
  }
  out('   Divar verdict agreement', JSON.stringify(agree), diffs.slice(0, 6).join(' ; '));
  // colours / city
  out('   colours', JSON.stringify(mk.reduce((o, p) => ((o[p.color || '?'] = (o[p.color || '?'] || 0) + 1), o), {})));
  out('   cities', JSON.stringify(mk.reduce((o, p) => { const c = (String(p.subtitle || '').match(/در ([^،,]+)/) || [])[1] || '?'; o[c] = (o[c] || 0) + 1; return o; }, {})));
}
// 9. year step from medians (market only, clean)
const yMed = {};
for (const y of [1401, 1402, 1403, 1404, 1405]) { const v = grp.filter((p) => P.shamsiYear(p.year) === y && D.marketable(p, now) && (P.bodyCondition(p).level || 'clean') === 'clean').map((p) => p.price); if (v.length >= 3) yMed[y] = M(med(v)); }
out('\nclean medians by year', JSON.stringify(yMed));
// 10. new car
out('new-car rows (Bama, full list):', newItems.filter((r) => P.modelOf({ brand: `${P.divarModelName(`${r.make} ${r.model}`)} ${r.trim}` }).key === MK).map((r) => `${r.year} ${r.kind} ${M(r.price)} ${r.trim} ${r.note}`).join(' | '));
// the screenshot ad
const d = deals.get(TOKEN);
out('\nAD waAw3Vt3', JSON.stringify({ expected: M(d.expected), discount: Math.round(d.discount * 1000) / 10, level: d.level, approx: d.approx, sure: d.sure, peers: d.peers, medKm: d.medKm, range: d.range.map(M), newCar: d.newCar, capped: d.capped }));
// 13. private sellers with dealer words
const sus = grp.filter((p) => p.seller !== 'dealer' && /نمایشگاه|اتوگالری|معاوضه|تحویل فوری|خرید و فروش|همکار|صفر کارخانه|حواله/.test(`${p.title} ${p.description}`));
out('private but dealer-like words:', sus.length, sus.slice(0, 5).map((p) => `${M(p.price)} «${p.title}»`).join(' | '));
