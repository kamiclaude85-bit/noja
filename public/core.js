'use strict';
/* =========================================================
   Radyab — shared helpers and app data (loaded first)
   ========================================================= */

const P = globalThis.NojaParser;
const ACTIVE_RUN = ['starting', 'waiting-login', 'collecting', 'reading', 'resting', 'blocked', 'paused'];

// ---------- DOM ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value' && (tag === 'input' || tag === 'textarea' || tag === 'select')) el.value = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function icon(name, cls) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `icon${cls ? ` ${cls}` : ''}`);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

// ---------- numbers & dates ----------
const fa = (n, opts) => (n == null || Number.isNaN(n) ? '—' : Number(n).toLocaleString('fa-IR', opts));
const faYear = (n) => fa(n, { useGrouping: false });
const faDigits = (s) => String(s).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);

function formatPrice(n) {
  if (n == null) return null;
  if (n >= 1e9) return `${fa(n / 1e9, { maximumFractionDigits: 2 })} میلیارد`;
  if (n >= 1e6) return `${fa(n / 1e6, { maximumFractionDigits: 1 })} میلیون`;
  return fa(n);
}

const DAY = 24 * 60 * 60 * 1000;
function startOfDay(t = Date.now()) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
function dayDiff(t) { return Math.round((startOfDay(t) - startOfDay()) / DAY); }
function timeFa(t) { return new Date(t).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }); }
function dateFa(t) { return new Date(t).toLocaleDateString('fa-IR', { weekday: 'long', month: 'long', day: 'numeric' }); }

/** «امروز ۱۸:۰۰»، «فردا ۱۰:۰۰»، «شنبه ۱۲ آبان ۱۰:۰۰» */
function whenFa(t) {
  const d = dayDiff(t);
  const day = d === 0 ? 'امروز' : d === 1 ? 'فردا' : d === -1 ? 'دیروز' : d === 2 ? 'پس‌فردا' : dateFa(t);
  return `${day} ${timeFa(t)}`;
}

/** «۵ دقیقه پیش»، «۲ ساعت پیش»، «دیروز» … */
function agoFa(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'لحظاتی پیش';
  if (s < 3600) return `${fa(Math.floor(s / 60))} دقیقه پیش`;
  if (s < 86400 && dayDiff(t) === 0) return `${fa(Math.floor(s / 3600))} ساعت پیش`;
  const d = -dayDiff(t);
  if (d === 1) return `دیروز ${timeFa(t)}`;
  if (d < 7) return `${fa(d)} روز پیش`;
  return new Date(t).toLocaleDateString('fa-IR', { month: 'long', day: 'numeric' });
}

// ---------- ads ----------
function safeDivarUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && /(^|\.)divar\.ir$/.test(url.hostname) ? url.href : null;
  } catch (_) { return null; }
}
function safeImg(u) {
  try { return new URL(u).protocol === 'https:' ? u : null; } catch (_) { return null; }
}

function conditionClass(text) {
  if (!text) return null;
  if (/تصادفی|تعویض شده|ضربه|رنگ‌?شدگی|رنگ شدگی|صافکاری|نیاز به تعمیر|خوردگی|اوراقی|لکه/.test(text)) return 'bad';
  if (/سالم|بدون رنگ|بی.?رنگ|پلمپ|تعویض نشده|اورجینال/.test(text)) return 'good';
  return null;
}

// ---------- city ----------
const CITIES = [['tehran', 'تهران'], ['karaj', 'کرج'], ['mashhad', 'مشهد'], ['isfahan', 'اصفهان'], ['shiraz', 'شیراز'], ['tabriz', 'تبریز'],
  ['ahvaz', 'اهواز'], ['qom', 'قم'], ['rasht', 'رشت'], ['kermanshah', 'کرمانشاه'], ['urmia', 'ارومیه'], ['kerman', 'کرمان'], ['yazd', 'یزد'],
  ['hamedan', 'همدان'], ['qazvin', 'قزوین'], ['arak', 'اراک'], ['sari', 'ساری'], ['gorgan', 'گرگان'], ['zanjan', 'زنجان'], ['ardabil', 'اردبیل'],
  ['bandar-abbas', 'بندرعباس'], ['zahedan', 'زاهدان'], ['iran', 'سراسر ایران']];
const CITY_NAME = Object.fromEntries(CITIES);

/** The city of an ad: from the place line («تهران، شهرری»), else from the search that found it. */
function cityOf(ad) {
  const place = P.placeOf(ad.post && ad.post.subtitle);
  const first = place.split('،')[0].trim();
  if (CITIES.some(([, n]) => n === first)) return first;
  for (const key of ad.searches || []) {
    const s = App.searches.find((x) => x.key === key);
    const c = s && s.criteria && s.criteria.city;
    if (c && c !== 'iran') return CITY_NAME[c] || c;
  }
  return '';
}

/** The city chosen for reviewing ads ('' = all cities); remembered on this device. */
function reviewCity() { return prefs.get('radyab.city', ''); }
function inCity(ad, city = reviewCity()) { return !city || cityOf(ad) === city; }

/** «شهر» select with the cities that have ads; `onchange(city)`. */
function citySelect(onchange) {
  const cur = reviewCity();
  const counts = new Map();
  for (const a of App.ads.values()) { const c = cityOf(a); if (c) counts.set(c, (counts.get(c) || 0) + 1); }
  if (cur && !counts.has(cur)) counts.set(cur, 0);
  const list = Array.from(counts.entries()).sort((x, y) => y[1] - x[1]);
  return h('label', { class: 'period-sel' }, icon('pin', 'sm'),
    h('select', { 'aria-label': 'شهر', onchange: (e) => { prefs.set('radyab.city', e.target.value); onchange(e.target.value); } },
      h('option', { value: '' }, 'همهٔ شهرها'),
      list.map(([c, n]) => h('option', { value: c, selected: c === cur }, `${c} (${fa(n)})`))));
}

// ---------- period («آگهی‌های تا چه مدت پیش») ----------
const PERIODS = [[7, '۱ هفتهٔ اخیر'], [14, '۲ هفتهٔ اخیر'], [30, '۱ ماه اخیر'], [60, '۲ ماه اخیر'], [90, '۳ ماه اخیر'], [0, 'همه']];
const DEFAULT_PERIOD = 30;

/** The period chosen for reviewing ads (days, 0 = all); remembered on this device. */
function reviewPeriod() { const v = Number(prefs.get('radyab.period', DEFAULT_PERIOD)); return PERIODS.some(([d]) => d === v) ? v : DEFAULT_PERIOD; }

/** In the chosen period? Ads you are following up always count, and so do ads with no known date. */
function inPeriod(ad, days = reviewPeriod()) {
  if (!days) return true;
  if (ad.crm && App.meta.activeStages.includes(ad.crm.stage)) return true;
  const t = ad.post && ad.post.publishedAt;
  return !t || Date.now() - t <= days * DAY;
}

/** «بازهٔ زمانی» select; `onchange(days)`. */
function periodSelect(onchange) {
  const cur = reviewPeriod();
  return h('label', { class: 'period-sel' }, icon('clock', 'sm'),
    h('select', { 'aria-label': 'بازهٔ زمانی', onchange: (e) => { prefs.set('radyab.period', Number(e.target.value)); onchange(Number(e.target.value)); } },
      PERIODS.map(([d, t]) => h('option', { value: d, selected: d === cur }, t))));
}

// ---------- publish time & place ----------
/** «۱۷ آبان ۱۴۰۵، ۲۲:۵۶» */
function dateTimeFa(t) {
  return new Date(t).toLocaleString('fa-IR', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** For an estimated time: «حدود ۵ ساعت پیش», «حدود ۳ روز پیش» (no false minutes). */
function roughAgoFa(t) {
  const hrs = Math.max(0, (Date.now() - t) / 3600000);
  if (hrs < 1) return 'کمتر از یک ساعت پیش';
  if (hrs < 24) return `حدود ${fa(Math.round(hrs))} ساعت پیش`;
  const d = Math.round(hrs / 24);
  return d < 30 ? `حدود ${fa(d)} روز پیش` : `حدود ${fa(Math.round(d / 30))} ماه پیش`;
}

/** «انتشار: ۲ روز پیش» (+ «نردبان: …» when bumped later), with the exact date on hover. */
function publishedLine(p, cls = 'where') {
  const place = P.placeOf(p.subtitle);
  const bits = [];
  if (place) bits.push(h('span', null, icon('pin', 'sm'), place));
  if (p.publishedAt) {
    const exact = `${dateTimeFa(p.publishedAt)}${p.publishedApprox ? ' (تقریبی)' : ''}`;
    bits.push(h('span', { class: 'pub', title: `انتشار آگهی: ${exact}` }, icon('clock', 'sm'), `انتشار ${p.publishedApprox ? roughAgoFa(p.publishedAt) : agoFa(p.publishedAt)}`));
  }
  if (p.bumpedAt && (!p.publishedAt || p.bumpedAt - p.publishedAt > 3600000)) {
    bits.push(h('span', { class: 'pub', title: `آخرین نردبان: ${dateTimeFa(p.bumpedAt)}` }, `نردبان ${agoFa(p.bumpedAt)}`));
  }
  return bits.length ? h('div', { class: cls }, bits) : null;
}

function sellerLabel(p) {
  if (p.seller === 'dealer') return p.sellerConfidence === 'high' ? 'نمایشگاهی' : 'احتمالاً نمایشگاهی';
  return 'شخصی';
}
function sellerBadge(p) {
  return h('span', { class: `seller ${p.seller}`, title: (p.sellerReasons || []).join('\n') },
    icon(p.seller === 'dealer' ? 'store' : 'user'), sellerLabel(p));
}

function describeCriteria(c) {
  if (!c) return 'جستجو';
  const parts = [];
  if (c.query) parts.push(c.query);
  else if (c.searchUrl) parts.push('جستجوی دیوار');
  else if (c.priceMin || c.priceMax) parts.push('همهٔ خودروها');
  if (c.yearMin || c.yearMax) {
    parts.push(c.yearMin === c.yearMax ? `مدل ${faYear(c.yearMin)}` : `مدل ${c.yearMin ? faYear(c.yearMin) : '…'} تا ${c.yearMax ? faYear(c.yearMax) : '…'}`);
  }
  if (c.priceMin || c.priceMax) {
    parts.push(c.priceMin && c.priceMax ? `${formatPrice(c.priceMin)} تا ${formatPrice(c.priceMax)}`
      : c.priceMin ? `از ${formatPrice(c.priceMin)}` : `تا ${formatPrice(c.priceMax)}`);
  }
  return parts.join('، ') || 'جستجو';
}

// ---------- local prefs (per browser) ----------
const prefs = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* ignore */ } },
};

// ---------- server ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: opts.body !== undefined ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  // Online panel (on the host): not signed in yet, or the session ended.
  if (res.status === 401 && typeof showLogin === 'function') showLogin();
  if (res.status === 503 && body.setup) { location.href = 'setup.php'; }
  if (!res.ok) { const e = new Error(body.error || `HTTP ${res.status}`); e.body = body; e.status = res.status; throw e; }
  return body;
}

/**
 * Start a search. On the PC the bot starts right away (→ live view). On the online panel the
 * search goes to the bot through a queue: it starts when the PC is on.
 */
async function startScan(criteria) {
  const r = await api('/api/scan', { method: 'POST', body: criteria });
  if (r.queued) {
    toast(App.bot.online ? 'جستجو برای ربات فرستاده شد.' : 'کامپیوتر خاموش است؛ جستجو در صف ماند و با روشن شدن ربات شروع می‌شود.');
    await App.refreshState();
    location.hash = '#/runs';
  } else {
    location.hash = `#/run/${r.id}`;
  }
}

// ---------- toast ----------
function toast(text, kind) {
  let box = $('#toasts');
  if (!box) { box = h('div', { id: 'toasts', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: `toast${kind ? ` ${kind}` : ''}` }, kind === 'err' ? icon('alert', 'sm') : icon('check', 'sm'), text);
  box.append(t);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 3200);
}

// =========================================================
// App data: bot state + ad memory with follow-up (synced from the server)
// =========================================================
const App = {
  state: { loggedIn: null, runs: [], busy: null, today: 0, dailyLimit: 300 },
  version: 0,
  ads: new Map(), // token -> { token, post, crm, removed, firstSeenAt, lastReadAt, priceHistory, searches }
  deals: new Map(), // token -> special-offer analysis (see src/deals.js)
  guide: [], // «قیمت‌یاب»: buy / market / sell per model + trim + year (see src/deals.js)
  searches: [],
  meta: { stages: {}, activeStages: [], rejectReasons: [], callResults: {} },
  listeners: new Set(),
  offline: false,
  // Online panel only: the panel runs on the host, the bot on the PC.
  host: false,
  bot: { online: false, lastSeenAt: null },
  queue: [],
};

/** «قیمت‌یاب» numbers, from the ads of the chosen period only (prices change quickly). */
App.computeGuide = () => {
  const ads = Array.from(App.ads.values()).filter((a) => a.post && inPeriod(a) && inCity(a));
  App.guide = globalThis.NojaDeals.priceGuide(ads.map((a) => ({ ...a.post, removed: a.removed })));
};

App.onChange = (fn) => { App.listeners.add(fn); return () => App.listeners.delete(fn); };
App.emit = (what) => { for (const fn of App.listeners) { try { fn(what); } catch (e) { console.error(e); } } };

App.refreshState = async () => {
  try {
    App.state = { ...App.state, ...(await api('/api/state')) };
    App.offline = false;
    App.host = App.state.mode === 'host';
    App.queue = App.state.queue || []; // searches waiting their turn (phone, «خرید با بودجه»)
    if (App.host) App.bot = App.state.bot || { online: false, lastSeenAt: null };
  } catch (_) {
    App.offline = true;
  }
  App.emit('state');
};

App.refreshAds = async (force) => {
  try {
    const r = await api(`/api/ads${!force && App.version ? `?since=${App.version}` : ''}`);
    if (r.unchanged) return false;
    App.version = r.version;
    App.ads = new Map(r.ads.map((a) => [a.token, a]));
    App.searches = r.searches.sort((a, b) => (b.lastRunAt || 0) - (a.lastRunAt || 0));
    App.meta = { stages: r.stages, activeStages: r.activeStages, rejectReasons: r.rejectReasons, callResults: r.callResults };
    App.deals = globalThis.NojaDeals.computeDeals(r.ads.map((a) => ({ ...a.post, removed: a.removed })));
    App.computeGuide();
    App.emit('ads');
    return true;
  } catch (_) {
    return false;
  }
};

/** Run a follow-up action on an ad and update local data. */
App.crm = async (token, body) => {
  try {
    const r = await api(`/api/ads/${encodeURIComponent(token)}/crm`, { method: 'POST', body });
    const ad = App.ads.get(token);
    if (ad) ad.crm = r.crm;
    App.version = r.version;
    App.emit('ads');
    return r.crm;
  } catch (e) {
    toast(e.message, 'err');
    throw e;
  }
};

// ---------- derived follow-up info (computed, never stored: Noja's rule) ----------
function stageOf(ad) { return (ad && ad.crm && ad.crm.stage) || 'new'; }
function stageLabel(stage) { return App.meta.stages[stage] || stage; }
const FINAL_STAGES = ['bought', 'rejected'];

function adFlags(ad) {
  const now = Date.now();
  const c = (ad && ad.crm) || {};
  const stage = stageOf(ad);
  const open = !FINAL_STAGES.includes(stage) && !(ad && ad.removed);
  const f = {
    stage,
    sold: !!(ad && ad.removed),
    callDue: open && c.nextCallAt && c.nextCallAt <= now,
    callToday: open && c.nextCallAt && dayDiff(c.nextCallAt) <= 0,
    visitToday: stage === 'visit' && c.visitAt && dayDiff(c.visitAt) === 0,
    visitTomorrow: stage === 'visit' && c.visitAt && dayDiff(c.visitAt) === 1,
    visitOverdue: stage === 'visit' && c.visitAt && c.visitAt < now - 2 * 60 * 60 * 1000,
    missed: c.missed || 0,
    priceDrop: null,
    isNewToday: stage === 'new' && ad && ad.firstSeenAt && dayDiff(ad.firstSeenAt) === 0,
  };
  const ph = (ad && ad.priceHistory) || [];
  if (ph.length >= 2) {
    const last = ph[ph.length - 1];
    const prev = ph[ph.length - 2];
    if (last.price < prev.price && now - last.t < 7 * DAY) f.priceDrop = { from: prev.price, to: last.price, t: last.t };
  }
  return f;
}

/** Post enriched with its follow-up data, for lists. */
function enrich(post) {
  const ad = App.ads.get(post.token);
  return { ...post, _ad: ad || null, _f: adFlags(ad), _deal: App.deals.get(post.token) || null };
}

/** «پیشنهاد ویژه» / «با احتیاط» badge for an ad, or null. */
function dealBadge(deal, long) {
  if (!deal || !deal.level) return null;
  const pct = fa(Math.round(deal.discount * 100));
  if (deal.level === 'caution') {
    return h('span', { class: 'deal-badge caution', title: deal.warnings.join('\n') }, icon('alert', 'sm'), long ? `${pct}٪ ارزان‌تر — با احتیاط` : 'با احتیاط');
  }
  return h('span', { class: `deal-badge ${deal.level}`, title: deal.reasons.join('\n') }, icon('flame', 'sm'),
    long ? `پیشنهاد ویژه — ${pct}٪ زیر قیمت معمول` : 'پیشنهاد ویژه');
}

function stageChip(stage, extra) {
  return h('span', { class: `stage s-${stage}` }, stageLabel(stage), extra || null);
}
