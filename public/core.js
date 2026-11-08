'use strict';
/* =========================================================
   Noja — shared helpers and app data (loaded first)
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
  if (c.yearMin || c.yearMax) {
    parts.push(c.yearMin === c.yearMax ? `مدل ${faYear(c.yearMin)}` : `مدل ${c.yearMin ? faYear(c.yearMin) : '…'} تا ${c.yearMax ? faYear(c.yearMax) : '…'}`);
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
  if (!res.ok) { const e = new Error(body.error || `HTTP ${res.status}`); e.body = body; e.status = res.status; throw e; }
  return body;
}

// ---------- toast ----------
function toast(text, kind) {
  let box = $('#toasts');
  if (!box) { box = h('div', { id: 'toasts', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: `toast${kind ? ` ${kind}` : ''}` }, kind === 'err' ? icon('alert', 'sm') : icon('check', 'sm'), text);
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 3200);
}

// =========================================================
// App data: bot state + ad memory with follow-up (synced from the server)
// =========================================================
const App = {
  state: { loggedIn: null, runs: [], busy: null, today: 0, dailyLimit: 300 },
  version: 0,
  ads: new Map(), // token -> { token, post, crm, removed, firstSeenAt, lastReadAt, priceHistory, searches }
  searches: [],
  meta: { stages: {}, activeStages: [], rejectReasons: [], callResults: {} },
  listeners: new Set(),
  offline: false,
};

App.onChange = (fn) => { App.listeners.add(fn); return () => App.listeners.delete(fn); };
App.emit = (what) => { for (const fn of App.listeners) { try { fn(what); } catch (e) { console.error(e); } } };

App.refreshState = async () => {
  try {
    App.state = { ...App.state, ...(await api('/api/state')) };
    App.offline = false;
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
  return { ...post, _ad: ad || null, _f: adFlags(ad) };
}

function stageChip(stage, extra) {
  return h('span', { class: `stage s-${stage}` }, stageLabel(stage), extra || null);
}
