/*
 * همراه مکانیک (hamrah-mechanic.com) and خودرو۴۵ (khodro45.com): companies that inspect cars and
 * sell them with an expert report. The bot reads them like Bama: only their pages, at a person's
 * pace (brand → model by clicking, the list scrolled slowly, each ad opened from its card and
 * read for a while). No phone number is ever read (Hamrah's page carries its consultant's number;
 * it is left alone).
 *
 * Pure helpers here (tested); the browser side is in page-scripts.js, the steps in scanner.js.
 */
'use strict';

const P = require('./parser');

const SITES = {
  hamrah: {
    id: 'hamrah', name: 'همراه مکانیک', host: 'https://www.hamrah-mechanic.com', prefix: 'hm-', start: '/cars-for-sale/',
    hostRe: /(^|\.)hamrah-mechanic\.com$/, adRe: /\/cars-for-sale\/[^/]+\/[^/]+\/(\d{5,})\/?$/, cardSel: 'a[href*="/cars-for-sale/"]',
  },
  k45: {
    id: 'k45', name: 'خودرو۴۵', host: 'https://khodro45.com', prefix: 'k45-', start: '/buy-car/',
    hostRe: /(^|\.)khodro45\.com$/, adRe: /\/buy-car\/[^/]+\/[^/]+\/(cla-[a-z0-9]+)\/?$/i, cardSel: 'a[href*="/cla-"]',
  },
};
const COMPANY_IDS = Object.keys(SITES);
const isCompany = (source) => COMPANY_IDS.includes(source);

function siteOfUrl(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== 'https:') return null;
    return COMPANY_IDS.find((id) => SITES[id].hostRe.test(x.hostname)) || null;
  } catch (_) { return null; }
}

function tokenOf(siteId, href) {
  const s = SITES[siteId];
  let path = String(href || '');
  try { path = new URL(path, s.host).pathname; } catch (_) { /* keep */ }
  const m = path.match(s.adRe);
  return m ? `${s.prefix}${m[1].toLowerCase()}` : null;
}
const siteOfToken = (t) => COMPANY_IDS.find((id) => String(t || '').startsWith(SITES[id].prefix)) || null;

const digits = (s) => P.toEnDigits(String(s || '')).replace(/[٬,،\s]/g, '');
const YEAR_RE = /^(13[5-9]\d|14[0-2]\d|19[89]\d|20[0-3]\d)$/;
// tags printed on cards that are not part of the car's name
const CARD_TAGS = /^(خرید اقساطی|اقساطی|شاسی پلمپ|کم کارکرد|سند تک برگ|بی رنگ|پیشنهاد ویژه|فروش فوری|قابل معاوضه|کارشناسی شده|جدید|ویژه)$/;
// the gearbox line alone («اتوماتیک توربو» is a trim)
const GEAR_RE = /^(دنده ?ای|اتومات(یک)?)$/;

/** First number of 7+ digits after «قیمت» (the current price; a crossed-out old price comes after it). */
function priceAfterLabel(lines) {
  const i = lines.findIndex((l) => /^قیمت/.test(String(l).trim()));
  for (const l of lines.slice(i >= 0 ? i : 0)) {
    const s = digits(l).replace(/تومان$/, '');
    if (/^\d{7,}$/.test(s)) return Number(s);
  }
  return null;
}

/**
 * A list card's lines → { name, year, trim, km, gearbox, place, price }.
 * Hamrah: «پژو 206 | 1400 | تیپ 2 | 85,525 km | دنده ای | تهران، پیروزی | قیمت | 1,850,000,000 | تومان»
 * Khodro45: «خرید اقساطی | پژو | 206 | 1400 | تیپ 2 | 86,575 km | تهران | شاسی پلمپ | … | قیمت | 1,818,000,000»
 */
function parseCard(lines) {
  const L = (lines || []).map((l) => String(l).trim()).filter((l) => l && l !== '|');
  const yi = L.findIndex((l) => YEAR_RE.test(digits(l)));
  const out = { name: '', year: null, trim: '', km: null, gearbox: '', place: '', price: priceAfterLabel(L) };
  if (yi < 0) return out;
  out.name = L.slice(0, yi).filter((l) => !CARD_TAGS.test(l)).join(' ').replace(/\s+/g, ' ').trim();
  out.year = Number(digits(L[yi]));
  const ki = L.findIndex((l, i) => i > yi && /(km|کیلومتر)$/i.test(l));
  if (ki > yi + 1) out.trim = L.slice(yi + 1, ki).filter((l) => !GEAR_RE.test(l)).join(' ').trim();
  if (ki >= 0) {
    const n = Number(digits(L[ki]).replace(/km|کیلومتر/gi, ''));
    if (Number.isFinite(n)) out.km = n;
    for (const l of L.slice(ki + 1)) {
      if (/^قیمت/.test(l)) break;
      if (GEAR_RE.test(l)) { out.gearbox = out.gearbox || l; continue; }
      if (CARD_TAGS.test(l) || /خدمات|گارانتی|گزارش/.test(l)) continue;
      if (!out.place) out.place = l;
    }
  }
  const g = L.find((l) => GEAR_RE.test(l));
  if (g && !out.gearbox) out.gearbox = g;
  return out;
}

/** «تهران، پیروزی» / «تهران, شعبه …» → is it in the chosen city (Persian name)? */
function inCity(place, cityFa) {
  if (!cityFa || !place) return true;
  return P.normalizeText(place).startsWith(P.normalizeText(cityFa));
}

/**
 * Pick a make and model from the site's own list: [{ brand, model, path }] where brand and
 * model are the Persian names. Every word of the model's name must be in what was asked for
 * («پژو 206» → «206», not «206 صندوقدار»); the most words win.
 */
function pickModel(catalog, query) {
  const q = P.normalizeText(query).replace(/[،,()]/g, ' ').split(' ').filter(Boolean);
  const has = (w) => q.some((x) => x === w || (w.length > 2 && x.length > 2 && (x.startsWith(w) || w.startsWith(x))));
  let best = null;
  for (const c of catalog || []) {
    const b = P.normalizeText(c.brand).split(' ').filter(Boolean);
    let m = P.normalizeText(c.model).split(' ').filter(Boolean);
    // «پژو 206» as the model name: the make is already said
    if (m.length > b.length && b.every((w, i) => m[i] === w)) m = m.slice(b.length);
    const brandSaid = b.length && b.every(has);
    let score;
    // a make on its own («کوییک»: Khodro45 files Saipa's models as makes): only when it is asked for
    if (!m.length) {
      if (!brandSaid) continue;
      score = b.length * 2;
    } else {
      if (!m.every(has)) continue;
      score = m.length * 2 + (brandSaid ? 1 : 0);
    }
    if (/صندوق ?دار|sd\b|کروک|وانت|استیشن/.test(P.normalizeText(c.model)) && !q.some((x) => /صندوق|sd|کروک|وانت|استیشن/.test(x))) continue;
    if (!best || score > best.score) best = { ...c, score };
  }
  return best;
}

// The panel's cities in Persian (Hamrah Mechanic's cards say «تهران، پیروزی»).
const CITY_FA = {
  tehran: 'تهران', karaj: 'کرج', mashhad: 'مشهد', isfahan: 'اصفهان', shiraz: 'شیراز', tabriz: 'تبریز', ahvaz: 'اهواز', qom: 'قم',
  rasht: 'رشت', kermanshah: 'کرمانشاه', urmia: 'ارومیه', kerman: 'کرمان', yazd: 'یزد', hamedan: 'همدان', qazvin: 'قزوین', arak: 'اراک',
  sari: 'ساری', gorgan: 'گرگان', zanjan: 'زنجان', ardabil: 'اردبیل', 'bandar-abbas': 'بندرعباس', zahedan: 'زاهدان',
};

// Hamrah Mechanic lists models under their maker: a model asked for without it («شاهین») is looked for here.
const MAKER_OF = { سایپا: /شاهین|ساینا|کوییک|کوئیک|تیبا|پراید|سهند|آریا|اطلس|سکو/, 'ایران خودرو': /دنا|رانا|سمند|تارا|سورن|ری ?را|هایما|رونیز|پژو/ };

/** Hamrah Mechanic's makes to open for a query: the ones named in it, then the usual maker of the model (at most 3). */
function hamrahMakes(brands, query) {
  const q = P.normalizeText(query);
  const words = q.split(' ').filter(Boolean);
  const named = (brands || []).filter(([, n]) => {
    const b = P.normalizeText(n).split(' ').filter(Boolean);
    return b.length && b.every((w) => words.includes(w));
  });
  const guessed = (brands || []).filter(([, n]) => {
    const key = Object.keys(MAKER_OF).find((k) => P.normalizeText(k) === P.normalizeText(n));
    return key && MAKER_OF[key].test(q);
  });
  const out = [];
  for (const x of [...named, ...guessed]) if (!out.some((y) => y[0] === x[0])) out.push(x);
  return out.slice(0, 3);
}

/** The list address of a model page and the search's city (Khodro45 has the city in its path). */
function listUrl(siteId, path, c = {}, page = 1) {
  const s = SITES[siteId];
  const u = new URL(path, s.host);
  if (siteId === 'k45' && CITY_FA[c.city] && /^\/buy-car\/[a-z0-9-]+\/?$/.test(u.pathname)) u.pathname = u.pathname.replace(/\/?$/, `/${c.city}/`);
  if (page > 1) u.searchParams.set('page', String(page));
  return u.href;
}

// ---------- the expert report → body, chassis ----------
const MINOR_PART = /سپر|شیشه|آینه|چراغ|لاستیک|زاپاس|آج|فلاپ|قاب|برف ?پاک/;
const FRAME_PART = /شاسی|ستون|سینی|ناودانی|کف صندوق|کف اتاق|پالونی|سقف/;

/**
 * Damaged parts of an expert report ([{ part, text }]) in Divar's body words.
 * Returns { body, chassis, painted[], replaced[], frame[] }.
 *   painted:  painted parts («رنگ شدگی», «تعویض و رنگ», «نقاشی»), not «بدون رنگ» / «رنگ پریدگی» / «پاشش رنگ»;
 *   replaced: replaced panels (not bumpers, glass, lights …);
 *   frame:    the frame cut, welded, pulled or replaced (an accident car).
 */
function bodyFromReport(parts) {
  const painted = new Set();
  const replaced = new Set();
  const frame = new Set();
  let minor = false;
  for (const x of parts || []) {
    const part = P.normalizeText(x.part);
    const t = P.normalizeText(x.text);
    if (!part || !t) continue;
    const small = MINOR_PART.test(part);
    if (/رنگ ?شدگی|رنگ شده|نقاشی|تعویض و رنگ|^رنگ$/.test(t) && !/بدون رنگ/.test(t) && !small) painted.add(part);
    if (/تعویض/.test(t) && !small && !FRAME_PART.test(part)) replaced.add(part);
    if (FRAME_PART.test(part) && !/سقف/.test(part) && /جوش|برش|کشیده|تعمیر|تعویض|بریده/.test(t)) frame.add(part);
    if (/صافکاری|خط|خش|فرو ?رفتگی|لیسه|قلم ?گیری|پریدگی|پاشش|خوردگی/.test(t)) minor = true;
  }
  let body;
  if (painted.size) body = `رنگ‌شدگی در ${painted.size} ناحیه`;
  else if (minor) body = 'صافکاری بی‌رنگ';
  else body = 'سالم و بی‌خط و خش';
  if (replaced.size) body += `، تعویض ${replaced.size} قطعه`;
  const chassis = frame.size ? `ضربه و تعمیر: ${[...frame].join('، ')}` : 'سالم';
  return { body, chassis, painted: [...painted], replaced: [...replaced], frame: [...frame] };
}

/** One line for the ad page: «کاپوت: رنگ شدگی؛ درب موتور: تعویض و رنگ …» (damaged parts only). */
function reportLine(parts) {
  return (parts || []).filter((x) => x.part && x.text).map((x) => `${String(x.part).trim()}: ${String(x.text).trim()}`).join('؛ ');
}

/**
 * What was read from an ad page (raw) plus its list card (item) → the same post shape as a
 * Divar ad. raw: { title, name, year, trim, km, place, price, rows {label: value}, parts [{ part, text }],
 * images, gearbox, color, removed }.
 */
function toPost(siteId, raw, item = {}) {
  const s = SITES[siteId];
  const card = item.card || parseCard(item.lines || []);
  const name = String(raw.name || card.name || '').trim();
  const trim = String(raw.trim || card.trim || '').trim();
  const year = Number(raw.year || card.year) || null;
  const km = raw.km != null ? Number(raw.km) : card.km;
  const price = Number(raw.price) > 0 ? Number(raw.price) : card.price;
  const rows = raw.rows || {};
  const model = P.divarModelName(name);
  const brand = [model, trim].filter(Boolean).join(' ').replace(/\s+/g, ' ');
  const rep = raw.parts && raw.parts.length ? bodyFromReport(raw.parts) : null;
  let body = rep ? rep.body : '';
  if (!body && rows['وضعیت بدنه']) {
    const v = P.normalizeText(rows['وضعیت بدنه']);
    const n = Number((v.match(/(\d+)/) || [])[1]) || 1;
    if (/رنگ/.test(v) && !/بدون رنگ/.test(v)) body = `رنگ‌شدگی در ${n} ناحیه`;
    else if (/تعویض/.test(v)) body = `سالم و بی‌خط و خش، تعویض ${n} قطعه`;
    else if (/بدون رنگ|سالم/.test(v)) body = 'سالم و بی‌خط و خش';
  }
  const fields = {};
  // rows already shown as the ad's own specs (colour, gearbox …) are not repeated
  const SHOWN = /^(کارکرد|گیربکس|سوخت|نوع سوخت|رنگ|رنگ بدنه|مانده بیمه|بیمه|وضعیت فنی|سواری)$/;
  for (const [k, v] of Object.entries(rows)) if (k && v && !SHOWN.test(k) && !/تماس|تلفن|موبایل|مشاور|کد آگهی|کد خودرو/.test(k)) fields[k] = String(v);
  if (year) fields['مدل (سال تولید)'] = String(year);
  if (km != null) fields['کارکرد'] = String(km);
  if (brand) fields['برند و مدل'] = brand;
  if (price) fields['قیمت'] = `${price.toLocaleString('en-US')} تومان`;
  if (rep && raw.parts.length) fields['گزارش کارشناسی'] = reportLine(raw.parts);
  const place = raw.place || card.place || '';
  const post = {
    token: item.token || tokenOf(siteId, raw.url || item.href),
    source: siteId,
    url: raw.url || item.href,
    title: [name, trim, year].filter(Boolean).join(' ').replace(/\s+/g, ' ') || item.title || '',
    subtitle: place ? `در ${place}` : '',
    description: `کارشناسی‌شده و فروش از ${s.name}.`,
    images: (raw.images || []).slice(0, 12),
    fields,
    price,
    priceText: price ? `${price.toLocaleString('fa-IR')} تومان` : 'بدون قیمت',
    mileage: Number.isFinite(km) ? km : null,
    mileageText: Number.isFinite(km) ? String(km) : '',
    year,
    yearText: year ? String(year) : '',
    color: raw.color || rows['رنگ بدنه'] || rows['رنگ'] || '',
    brand,
    fuel: rows['سوخت'] || rows['نوع سوخت'] || '',
    gearbox: raw.gearbox || rows['گیربکس'] || card.gearbox || '',
    body,
    engine: rows['وضعیت فنی'] || '',
    chassis: rep ? rep.chassis : '',
    insurance: rows['مانده بیمه'] || rows['بیمه'] || '',
    company: siteId,
  };
  P.classifySeller(post, { strongDealer: [`فروش از ${s.name}`], personalMarks: [] });
  return post;
}

module.exports = { SITES, COMPANY_IDS, CITY_FA, isCompany, siteOfUrl, siteOfToken, tokenOf, parseCard, priceAfterLabel, inCity, pickModel, hamrahMakes, listUrl, bodyFromReport, reportLine, toPost };
