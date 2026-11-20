/*
 * باما (bama.ir): the second place the bot reads car ads from.
 *
 * Only Bama's pages are opened, the way a visitor would (bama.ir/robots.txt keeps bots off
 * its API, so the bot never calls it). A list page shows the newest 30 ads of a model; the bot
 * picks the model the way a person does (all cars → the make → the model), may sort by
 * cheapest, and reads each ad page. Sellers' phone numbers are never read.
 *
 * Pure helpers here (tested); the browser side is in page-scripts.js, the steps in scanner.js.
 */
'use strict';

const P = require('./parser');

const HOST = 'https://bama.ir';
const TOKEN_PREFIX = 'bm-';

function isBamaUrl(u) {
  try { const x = new URL(u); return x.protocol === 'https:' && /(^|\.)bama\.ir$/.test(x.hostname); } catch (_) { return false; }
}

/** «/car/detail-uwx5rlrz-samand-soren-plus-1402» → «bm-uwx5rlrz» (kept apart from Divar's tokens). */
function tokenOf(href) {
  const m = String(href || '').match(/\/car\/detail-([a-z0-9]{5,20})-/i);
  return m ? `${TOKEN_PREFIX}${m[1]}` : null;
}
const isBamaToken = (t) => String(t || '').startsWith(TOKEN_PREFIX);

/** The model year at the end of an ad's address («…-1402» → 1402, «…-2017» → 2017). */
function yearOfHref(href) {
  const m = String(href || '').match(/-(\d{4})(?:[/?#]|$)/);
  return m ? Number(m[1]) : null;
}

/** «۵٬۰۰۰٬۰۰۰٬۰۰۰ تومان», «5,000,000,000» → number; «توافقی» → null. */
function priceOf(lines) {
  for (const l of lines || []) {
    const s = P.toEnDigits(String(l)).replace(/[٬,\s]/g, '');
    if (/^\d{7,}$/.test(s)) return Number(s);
  }
  return null;
}

/**
 * Pick the link for a make or model from a list of { href, text } where text is
 * «خرید و فروش پژو 207». Every word of the link's name must be in what was asked for
 * («207» also matches «207i»); the longest such name wins.
 */
function pickLink(links, query) {
  const q = P.normalizeText(query).replace(/[،,]/g, ' ').split(' ').filter(Boolean);
  const has = (w) => q.some((x) => x === w || x.startsWith(w) || (w.length > 2 && w.startsWith(x) && x.length > 2));
  let best = null;
  for (const l of links || []) {
    const name = P.normalizeText(String(l.text || '').replace(/خرید\s*و\s*فروش/, '')).replace(/[()]/g, ' ').split(' ').filter(Boolean);
    if (!name.length || !name.every(has)) continue;
    if (/وارداتی|کروک|صندوقدار|استیشن/.test(l.text) && !q.some((x) => /وارداتی|کروک|صندوق|استیشن/.test(x))) continue;
    if (!best || name.length > best.n) best = { ...l, n: name.length };
  }
  return best;
}

/** The list address for a model page and the search's limits (one model year goes in the path). */
function listUrl(modelUrl, c = {}, { sort } = {}) {
  const u = new URL(modelUrl, HOST);
  const lim = P.limitsOf(c);
  const y1 = lim.yearMin != null ? P.shamsiYear(lim.yearMin) : null;
  const y2 = lim.yearMax != null ? P.shamsiYear(lim.yearMax) : null;
  if (y1 && y1 === y2 && /^\/car\/[a-z0-9-]+$/.test(u.pathname) && !/-y\d{4}$/.test(u.pathname)) u.pathname += `-y${y1}`;
  if (c.personalOnly) u.searchParams.set('seller', '1');
  if (sort === 'cheapest') u.searchParams.set('sort', '4');
  return u.href;
}

// Bama's model names that Divar writes differently (normalized Bama name → Divar's).
const MODEL_ALIASES = {
  'پژو 207': 'پژو 207i',
};

// Bama's «وضعیت بدنه» in Divar's words, so the same body rules apply to both.
function bodyInDivarWords(v) {
  const s = P.normalizeText(v);
  if (!s) return '';
  if (/اوراقی/.test(s)) return 'اوراقی';
  if (/تصادف/.test(s)) return 'تصادفی';
  if (/تمام ?رنگ/.test(s)) return 'تمام‌رنگ';
  if (/دور ?رنگ/.test(s)) return 'دوررنگ';
  if (/صافکاری/.test(s) && /بدون|بی/.test(s)) return 'صافکاری بی‌رنگ';
  if (/خط|خش/.test(s)) return 'خط و خش جزیی';
  if (/بدون ?رنگ|سالم|بی ?رنگ/.test(s)) return 'سالم و بی‌خط و خش';
  if (/(^| )(چند|سه|۳|3)( |$)/.test(s) && /رنگ|لکه/.test(s)) return 'رنگ‌شدگی در ۳ ناحیه';
  if (/(^| )(دو|۲|2)( |$)/.test(s) && /رنگ|لکه/.test(s)) return 'رنگ‌شدگی در ۲ ناحیه';
  if (/رنگ|لکه/.test(s)) return 'رنگ‌شدگی در ۱ ناحیه';
  return v;
}

/**
 * Turn what was read from a Bama ad page into the same post shape as a Divar ad.
 * raw: { ld (the page's schema.org Car), rows: {label: value}, place, ago, dealer, images, title }.
 */
function toPost(raw, item = {}) {
  const ld = raw.ld || {};
  const token = item.token || tokenOf(ld.url || item.href);
  const rows = raw.rows || {};
  const make = String((ld.brand && ld.brand.name) || '').trim();
  // «سمند،  سورن» → model «سورن»; trim from the card/page («پلاس EF7 بنزینی»).
  const nameParts = String(ld.name || '').split(/[،,]/).map((s) => s.trim()).filter(Boolean);
  const model = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
  const trim = String(raw.trim || '').trim();
  // Divar's name for the same model, so both sites land in one price market.
  const divarModel = MODEL_ALIASES[P.normalizeText(`${make} ${model}`)] || `${make} ${model}`.trim();
  const brand = [divarModel, trim].filter(Boolean).join(' ').replace(/\s+/g, ' ');
  const price = ld.offers && Number(ld.offers.price) > 0 ? Number(ld.offers.price) : priceOf(item.lines);
  const km = ld.mileageFromOdometer && ld.mileageFromOdometer.value != null ? Number(ld.mileageFromOdometer.value) : null;
  const year = Number(ld.vehicleModelDate || ld.productionDate) || yearOfHref(item.href) || null;
  const body = bodyInDivarWords(rows['وضعیت بدنه'] || '');
  const fields = {};
  for (const [k, v] of Object.entries(rows)) if (k && v && !/تماس|تلفن|موبایل/.test(k)) fields[k] = v;
  if (year) fields['مدل (سال تولید)'] = String(year);
  if (km != null) fields['کارکرد'] = String(km);
  if (brand) fields['برند و مدل'] = brand;
  if (price) fields['قیمت'] = `${price.toLocaleString('en-US')} تومان`;
  const post = {
    token,
    source: 'bama',
    url: ld.url || item.href,
    title: [nameParts.join(' '), trim, year].filter(Boolean).join(' ').replace(/\s+/g, ' ') || item.title || '',
    subtitle: [raw.ago, raw.place ? `در ${raw.place}` : ''].filter(Boolean).join(' '),
    description: String(ld.description || '').replace(/^خرید خودرو .*? در شهر [^،]+،\s*/, '').trim(),
    images: (raw.images || []).slice(0, 12),
    fields,
    price,
    priceText: price ? `${price.toLocaleString('fa-IR')} تومان` : (raw.priceText || 'توافقی'),
    mileage: km,
    mileageText: km != null ? String(km) : '',
    year,
    yearText: year ? String(year) : '',
    color: ld.color || rows['رنگ بدنه'] || '',
    brand,
    fuel: ld.fuelType || '',
    gearbox: ld.vehicleTransmission || rows['گیربکس'] || '',
    body,
    engine: '',
    chassis: '',
    insurance: '',
  };
  const t = P.parseRelativeAgo(raw.ago, Date.now());
  if (t) { post.publishedAt = t; post.publishedApprox = true; }
  P.classifySeller(post, { strongDealer: raw.dealer ? [`نمایشگاه در باما: ${raw.dealer}`] : [], personalMarks: raw.dealer ? [] : [] });
  return post;
}

/** Saved Bama ads: their model under Divar's name (aliases added later apply to old ads too). */
function alignModel(post) {
  if (!post || post.source !== 'bama' || !post.brand) return post;
  for (const [from, to] of Object.entries(MODEL_ALIASES)) {
    if (P.normalizeText(post.brand).startsWith(from + ' ') || P.normalizeText(post.brand) === from) post.brand = to + post.brand.slice(from.length);
  }
  return post;
}

module.exports = { alignModel, HOST, TOKEN_PREFIX, isBamaUrl, isBamaToken, tokenOf, yearOfHref, priceOf, pickLink, listUrl, bodyInDivarWords, toPost };
