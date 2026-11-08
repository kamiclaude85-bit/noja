'use strict';

const P = globalThis.NojaParser;

// ---------- Config ----------
const API_URL = (token) => `https://api.divar.ir/v8/posts-v2/web/${encodeURIComponent(token)}`;
const PAGE_URL = (token) => `https://divar.ir/v/${encodeURIComponent(token)}`;
const CONCURRENCY = 2;
const DELAY_MIN = 500;
const DELAY_JITTER = 700;
const CACHE_TTL = 6 * 60 * 60 * 1000;
const PARSER_VERSION = 1;

// ---------- State ----------
const state = {
  job: null,
  items: [],                 // list-card info, in Divar order
  posts: new Map(),          // token -> parsed post
  status: new Map(),         // token -> 'pending' | 'loading' | 'done' | 'error'
  errors: new Map(),
  favorites: new Set(),
  tab: 'all',
  sort: 'default',
  view: 'cards',
  query: '',
  showOut: false,
  paused: false,
};

// ---------- Helpers ----------
const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fa = (n, opts) => (n == null ? '—' : Number(n).toLocaleString('fa-IR', opts));

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function safeDivarUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && /(^|\.)divar\.ir$/.test(url.hostname) ? url.href : null;
  } catch (_) { return null; }
}
function safeImg(u) {
  try { return new URL(u).protocol === 'https:' ? u : null; } catch (_) { return null; }
}

function formatPrice(n) {
  if (n == null) return null;
  if (n >= 1e9) return `${fa(n / 1e9, { maximumFractionDigits: 2 })} میلیارد`;
  if (n >= 1e6) return `${fa(n / 1e6, { maximumFractionDigits: 1 })} میلیون`;
  return fa(n);
}

function sellerLabel(p) {
  if (p.seller === 'dealer') return p.sellerConfidence === 'high' ? 'نمایشگاهی' : 'احتمالاً نمایشگاهی';
  return 'شخصی';
}

function badge(p) {
  return h('span', { class: `badge ${p.seller}`, title: p.sellerReasons.join('\n') }, sellerLabel(p));
}

function conditionClass(text) {
  if (!text) return null;
  if (/سالم|بدون رنگ|بی.?رنگ|پلمپ|تعویض نشده|اورجینال/.test(text) && !/رنگ‌?شدگی|تصادفی|تعویض شده|ضربه/.test(text)) return 'good';
  if (/تصادفی|تعویض|ضربه|رنگ‌?شدگی|صافکاری|نیاز به تعمیر|خوردگی|اوراقی/.test(text)) return 'bad';
  return null;
}

// ---------- Storage ----------
async function loadJob() {
  const params = new URLSearchParams(location.search);
  let id = params.get('job');
  if (!id) id = (await chrome.storage.local.get('lastJobId')).lastJobId;
  if (!id) return null;
  const key = `job:${id}`;
  const data = await chrome.storage.local.get(key);
  return data[key] || null;
}

async function loadCache(tokens) {
  const keys = tokens.map((t) => `post:${t}`);
  const data = keys.length ? await chrome.storage.local.get(keys) : {};
  const now = Date.now();
  for (const t of tokens) {
    const rec = data[`post:${t}`];
    if (rec && rec.v === PARSER_VERSION && now - rec.t < CACHE_TTL && rec.post) {
      state.posts.set(t, rec.post);
      state.status.set(t, 'done');
    }
  }
}

function saveCache(post) {
  chrome.storage.local.set({ [`post:${post.token}`]: { t: Date.now(), v: PARSER_VERSION, post } }).catch(() => {});
}

async function loadFavorites() {
  const { favorites = [] } = await chrome.storage.local.get('favorites');
  state.favorites = new Set(favorites);
}
function toggleFavorite(token) {
  if (state.favorites.has(token)) state.favorites.delete(token);
  else state.favorites.add(token);
  chrome.storage.local.set({ favorites: Array.from(state.favorites) });
  scheduleRender();
}

// ---------- Fetching ----------
class RateLimited extends Error {}

async function fetchApi(token) {
  const res = await fetch(API_URL(token), { headers: { accept: 'application/json' }, credentials: 'omit' });
  if (res.status === 429) throw new RateLimited('429');
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

/** Fallback: read the public ad page and turn its rows into widget-like objects. */
async function fetchPage(token) {
  const res = await fetch(PAGE_URL(token), { credentials: 'include' });
  if (res.status === 429) throw new RateLimited('429');
  if (!res.ok) throw new Error(`صفحه ${res.status}`);
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const blobs = [];
  for (const s of doc.querySelectorAll('script')) {
    const txt = (s.textContent || '').trim();
    if (!txt) continue;
    try {
      if (s.type === 'application/ld+json' || txt.startsWith('{')) blobs.push(JSON.parse(txt));
      else {
        const m = txt.match(/__PRELOADED_STATE__\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
        if (m) blobs.push(JSON.parse(m[1]));
      }
    } catch (_) { /* not JSON */ }
  }
  const rows = [];
  for (const t of doc.querySelectorAll('[class*="row__title"]')) {
    const row = t.closest('[class*="-row"]:not([class*="row__"])') || t.parentElement;
    const v = row && row.querySelector('[class*="row__value"]');
    if (v && v !== t) rows.push({ widget_type: 'UNEXPANDABLE_ROW', data: { title: t.textContent.trim(), value: v.textContent.trim() } });
  }
  for (const table of doc.querySelectorAll('table')) {
    const ths = Array.from(table.querySelectorAll('th'));
    const tds = Array.from(table.querySelectorAll('tbody td'));
    if (ths.length && ths.length === tds.length) {
      rows.push({ widget_type: 'GROUP_INFO_ROW', data: { items: ths.map((th, i) => ({ title: th.textContent.trim(), value: tds[i].textContent.trim() })) } });
    }
  }
  const descEl = doc.querySelector('[class*="description"] p, [class*="description-row"]');
  if (descEl) rows.push({ widget_type: 'DESCRIPTION_ROW', data: { text: descEl.textContent.trim() } });
  const h1 = doc.querySelector('h1');
  const images = Array.from(doc.querySelectorAll('img')).map((i) => i.getAttribute('src') || '').filter((s) => /divarcdn/.test(s));
  return {
    widgets: rows,
    blobs,
    images,
    seo: {
      title: (h1 && h1.textContent.trim()) || (doc.querySelector('meta[property="og:title"]') || {}).content || '',
      description: (doc.querySelector('meta[name="description"]') || {}).content || '',
    },
  };
}

function isUseful(post) {
  return post && (Object.keys(post.fields).length > 0 || post.price != null);
}

async function loadPost(item) {
  const token = item.token;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      let post = null;
      try {
        post = P.extractPost(await fetchApi(token), token, item);
      } catch (e) {
        if (e instanceof RateLimited) throw e;
        lastErr = e;
      }
      if (!isUseful(post)) {
        const fromPage = P.extractPost(await fetchPage(token), token, item);
        if (isUseful(fromPage) || !post) post = fromPage;
      }
      return post;
    } catch (e) {
      lastErr = e;
      const wait = e instanceof RateLimited ? 8000 * attempt : 1500 * attempt;
      setProgressNote(e instanceof RateLimited ? 'دیوار گفت آهسته‌تر! کمی صبر می‌کنیم…' : '');
      await sleep(wait);
    }
  }
  throw lastErr || new Error('نامشخص');
}

async function worker(queue) {
  while (queue.length) {
    while (state.paused) await sleep(400);
    const item = queue.shift();
    if (!item) break;
    state.status.set(item.token, 'loading');
    try {
      const post = await loadPost(item);
      post.order = item.order;
      state.posts.set(item.token, post);
      state.status.set(item.token, 'done');
      state.errors.delete(item.token);
      saveCache(post);
    } catch (e) {
      state.status.set(item.token, 'error');
      state.errors.set(item.token, String(e && e.message ? e.message : e));
    }
    updateProgress();
    scheduleRender();
    await sleep(DELAY_MIN + Math.random() * DELAY_JITTER);
  }
}

async function runQueue() {
  const queue = state.items.filter((it) => state.status.get(it.token) !== 'done');
  updateProgress();
  if (!queue.length) return;
  $('#pauseBtn').hidden = false;
  $('#retryBtn').hidden = true;
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));
  $('#pauseBtn').hidden = true;
  updateProgress();
}

// ---------- Progress ----------
let progressNote = '';
function setProgressNote(t) { progressNote = t; updateProgress(); }

function updateProgress() {
  const total = state.items.length;
  let done = 0;
  let errors = 0;
  for (const it of state.items) {
    const s = state.status.get(it.token);
    if (s === 'done') done++;
    else if (s === 'error') errors++;
  }
  const finished = done + errors;
  $('#bar').style.width = total ? `${(finished / total) * 100}%` : '0';
  let text;
  if (finished >= total) {
    text = `بررسی ${fa(total)} آگهی تمام شد${errors ? ` — ${fa(errors)} خطا` : ''}`;
    $('#retryBtn').hidden = !errors;
  } else {
    text = `${state.paused ? 'متوقف شد — ' : 'در حال بررسی — '}${fa(finished)} از ${fa(total)}${errors ? ` — ${fa(errors)} خطا` : ''}`;
  }
  $('#progressText').textContent = progressNote && finished < total ? `${text} — ${progressNote}` : text;
}

// ---------- Derived data ----------
function allPosts() {
  return state.items.map((it) => state.posts.get(it.token)).filter(Boolean);
}

function matched(p) {
  return P.matchesCriteria(p, state.job.criteria);
}

function searchHit(p) {
  if (!state.query) return true;
  const hay = P.normalizeText([p.title, p.subtitle, p.color, p.brand, p.body, p.engine, p.chassis, p.gearbox, p.description].join(' '));
  return P.normalizeText(state.query).split(' ').every((w) => hay.includes(w));
}

function inTab(p) {
  if (state.tab === 'personal') return p.seller === 'personal';
  if (state.tab === 'dealer') return p.seller === 'dealer';
  if (state.tab === 'fav') return state.favorites.has(p.token);
  return true;
}

function sortPosts(list) {
  const by = (fn, dir) => (a, b) => {
    const x = fn(a);
    const y = fn(b);
    if (x == null && y == null) return a.order - b.order;
    if (x == null) return 1;
    if (y == null) return -1;
    return dir * (x - y) || a.order - b.order;
  };
  switch (state.sort) {
    case 'price-asc': return list.sort(by((p) => p.price, 1));
    case 'price-desc': return list.sort(by((p) => p.price, -1));
    case 'km-asc': return list.sort(by((p) => p.mileage, 1));
    case 'year-desc': return list.sort(by((p) => p.year, -1));
    default: return list.sort((a, b) => a.order - b.order);
  }
}

// ---------- Rendering ----------
let renderTimer = null;
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; render(); }, 250);
}

function renderStats(pool, medianPrice) {
  const personal = pool.filter((p) => p.seller === 'personal');
  const dealer = pool.filter((p) => p.seller === 'dealer');
  const prices = pool.map((p) => p.price).filter((n) => n != null && n > 0);
  const kms = pool.map((p) => p.mileage).filter((n) => n != null);
  const personalMedian = P.median(personal.map((p) => p.price).filter((n) => n > 0));
  const stat = (k, v, s) => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), s ? h('div', { class: 's' }, s) : null);
  $('#stats').replaceChildren(
    stat('آگهی‌های مطابق', fa(pool.length), `از ${fa(state.items.length)} آگهی پیدا شده`),
    stat('شخصی', fa(personal.length), pool.length ? `${fa(Math.round((personal.length / pool.length) * 100))}٪` : ''),
    stat('نمایشگاهی', fa(dealer.length), pool.length ? `${fa(Math.round((dealer.length / pool.length) * 100))}٪` : ''),
    stat('میانهٔ قیمت', formatPrice(medianPrice) || '—', prices.length ? `از ${formatPrice(Math.min(...prices))} تا ${formatPrice(Math.max(...prices))}` : 'تومان'),
    stat('میانهٔ قیمت شخصی', formatPrice(personalMedian) || '—', 'تومان'),
    stat('میانهٔ کارکرد', kms.length ? `${fa(P.median(kms))}` : '—', 'کیلومتر'),
  );
  const counts = {
    all: pool.length,
    personal: personal.length,
    dealer: dealer.length,
    fav: pool.filter((p) => state.favorites.has(p.token)).length,
  };
  for (const [k, v] of Object.entries(counts)) {
    const el = document.querySelector(`[data-count="${k}"]`);
    if (el) el.textContent = fa(v);
  }
}

function priceCompare(p, medianPrice) {
  if (!medianPrice || !p.price) return null;
  const r = p.price / medianPrice;
  if (r <= 0.9) return h('span', { class: 'cmp low', title: 'در مقایسه با میانهٔ قیمت آگهی‌های مطابق' }, `${fa(Math.round((1 - r) * 100))}٪ زیر میانه`);
  if (r >= 1.1) return h('span', { class: 'cmp high', title: 'در مقایسه با میانهٔ قیمت آگهی‌های مطابق' }, `${fa(Math.round((r - 1) * 100))}٪ بالای میانه`);
  return null;
}

function gallery(p) {
  const imgs = p.images.map(safeImg).filter(Boolean);
  const media = h('div', { class: 'media' });
  if (!imgs.length) {
    media.append(h('div', { class: 'noimg' }, 'بدون عکس'));
  } else {
    let i = 0;
    const img = h('img', { src: imgs[0], alt: p.title, loading: 'lazy', referrerpolicy: 'no-referrer' });
    const count = h('span', { class: 'count' }, `${fa(1)} / ${fa(imgs.length)}`);
    const show = (d) => { i = (i + d + imgs.length) % imgs.length; img.src = imgs[i]; count.textContent = `${fa(i + 1)} / ${fa(imgs.length)}`; };
    media.append(img);
    if (imgs.length > 1) {
      media.append(
        h('button', { class: 'nav prev', 'aria-label': 'عکس قبلی', onclick: () => show(-1) }, '›'),
        h('button', { class: 'nav next', 'aria-label': 'عکس بعدی', onclick: () => show(1) }, '‹'),
        count,
      );
    }
  }
  media.append(badge(p));
  const fav = state.favorites.has(p.token);
  media.append(h('button', { class: 'fav', 'aria-pressed': fav ? 'true' : 'false', title: fav ? 'برداشتن نشان' : 'نشان کردن', onclick: () => toggleFavorite(p.token) }, fav ? '★' : '☆'));
  return media;
}

function card(p, medianPrice, isOut) {
  const url = safeDivarUrl(p.url);
  const chip = (label, value) => (value ? h('span', { class: 'chip' }, h('i', null, label), value) : null);
  const spec = (label, value) => {
    if (!value) return [];
    const cls = conditionClass(value);
    return [h('dt', null, label), h('dd', cls ? { class: cls } : null, value)];
  };
  const extraFields = Object.entries(p.fields);
  return h('article', { class: `card${isOut ? ' out' : ''}` },
    gallery(p),
    h('div', { class: 'body' },
      h('h2', { class: 'title' }, url ? h('a', { href: url, target: '_blank', rel: 'noopener' }, p.title || 'بدون عنوان') : (p.title || 'بدون عنوان')),
      p.subtitle ? h('div', { class: 'sub' }, p.subtitle) : null,
      h('div', { class: 'price-row' },
        h('div', { class: 'price', title: p.price ? `${fa(p.price)} تومان` : '' },
          p.price ? [formatPrice(p.price), ' ', h('small', null, 'تومان')] : (p.priceText || 'قیمت ذکر نشده')),
        priceCompare(p, medianPrice)),
      h('div', { class: 'chips' },
        chip('مدل', p.year ? fa(p.year, { useGrouping: false }) : p.yearText),
        chip('کارکرد', p.mileage != null ? `${fa(p.mileage)} کیلومتر` : p.mileageText),
        chip('رنگ', p.color),
        chip('گیربکس', p.gearbox),
        chip('سوخت', p.fuel)),
      h('dl', { class: 'specs' },
        spec('بدنه', p.body),
        spec('موتور', p.engine),
        spec('شاسی', p.chassis),
        spec('بیمه', p.insurance),
        spec('برند و تیپ', p.brand),
        spec('معاوضه', p.exchange)),
      p.description ? h('details', null, h('summary', null, 'توضیحات فروشنده'), h('p', null, p.description)) : null,
      extraFields.length ? h('details', null, h('summary', null, `همهٔ مشخصات (${fa(extraFields.length)})`),
        h('dl', { class: 'specs' }, extraFields.map(([k, v]) => [h('dt', null, k), h('dd', null, v)]))) : null,
      h('details', null, h('summary', null, `چرا «${sellerLabel(p)}»؟`), h('p', null, p.sellerReasons.join('\n'))),
      h('div', { class: 'actions' },
        url ? h('a', { class: 'btn primary', href: url, target: '_blank', rel: 'noopener' }, 'دیدن آگهی در دیوار') : null)));
}

function table(list, medianPrice, outSet) {
  const cols = ['', 'عنوان', 'فروشنده', 'قیمت', 'مدل', 'کارکرد', 'رنگ', 'گیربکس', 'بدنه', 'موتور', 'شاسی', 'بیمه', 'زمان و محل', ''];
  const rows = list.map((p) => {
    const url = safeDivarUrl(p.url);
    const img = safeImg(p.images[0]);
    const fav = state.favorites.has(p.token);
    const cell = (v, cls) => h('td', cls ? { class: cls } : null, v || '—');
    return h('tr', { class: outSet.has(p.token) ? 'out' : null },
      h('td', null, img ? h('img', { src: img, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : ''),
      h('td', { class: 't' }, url ? h('a', { href: url, target: '_blank', rel: 'noopener' }, p.title) : p.title),
      h('td', null, badge(p)),
      h('td', { title: p.price ? `${fa(p.price)} تومان` : '' }, p.price ? formatPrice(p.price) : (p.priceText || '—'), ' ', priceCompare(p, medianPrice)),
      cell(p.year ? fa(p.year, { useGrouping: false }) : p.yearText),
      cell(p.mileage != null ? fa(p.mileage) : p.mileageText),
      cell(p.color), cell(p.gearbox), cell(p.body, conditionClass(p.body) === 'bad' ? 'err' : null), cell(p.engine, conditionClass(p.engine) === 'bad' ? 'err' : null), cell(p.chassis, conditionClass(p.chassis) === 'bad' ? 'err wrap' : 'wrap'), cell(p.insurance), cell(p.subtitle),
      h('td', null, h('button', { class: 'ghost small', 'aria-pressed': fav ? 'true' : 'false', onclick: () => toggleFavorite(p.token), title: 'نشان کردن' }, fav ? '★' : '☆')));
  });
  return h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, cols.map((c) => h('th', null, c)))), h('tbody', null, rows)));
}

function render() {
  const posts = allPosts();
  const pool = posts.filter(matched);
  const outSet = new Set(posts.filter((p) => !matched(p)).map((p) => p.token));
  const medianPrice = P.median(pool.map((p) => p.price).filter((n) => n > 0));
  renderStats(pool, medianPrice);

  const base = state.showOut ? posts : pool;
  const list = sortPosts(base.filter(inTab).filter(searchHit));

  const note = $('#filteredNote');
  if (outSet.size) {
    note.hidden = false;
    note.replaceChildren(
      `${fa(outSet.size)} آگهی با فیلترهای شما (سال، قیمت، کارکرد یا کلمهٔ کلیدی) جور نبود و کنار گذاشته شد. `,
      h('button', { type: 'button', onclick: () => { state.showOut = !state.showOut; render(); } }, state.showOut ? 'پنهانشان کن' : 'نشانشان بده'));
  } else {
    note.hidden = true;
  }

  const container = $('#list');
  container.className = state.view === 'cards' ? 'cards' : '';
  if (state.view === 'cards') container.replaceChildren(...list.map((p) => card(p, medianPrice, outSet.has(p.token))));
  else container.replaceChildren(list.length ? table(list, medianPrice, outSet) : '');

  const errorsShown = state.tab === 'all' && state.errors.size && !state.query;
  if (errorsShown && state.view === 'cards') {
    for (const [token, err] of state.errors) {
      const item = state.items.find((it) => it.token === token);
      container.append(h('article', { class: 'card' }, h('div', { class: 'body' },
        h('h2', { class: 'title' }, (item && item.title) || token),
        h('div', { class: 'err' }, `خواندن جزئیات ممکن نشد: ${err}`),
        h('div', { class: 'actions' }, h('a', { class: 'btn line', href: PAGE_URL(token), target: '_blank', rel: 'noopener' }, 'باز کردن در دیوار')))));
    }
  }
  $('#empty').hidden = list.length > 0 || (errorsShown && state.view === 'cards');
  $('#empty').textContent = posts.length ? 'آگهی‌ای با این فیلترها پیدا نشد.' : 'در حال خواندن آگهی‌ها…';
}

// ---------- CSV ----------
function exportCsv() {
  const posts = sortPosts(allPosts().filter((p) => state.showOut || matched(p)).filter(inTab).filter(searchHit));
  const cols = [
    ['عنوان', (p) => p.title], ['نوع فروشنده', sellerLabel], ['قیمت (تومان)', (p) => p.price ?? p.priceText],
    ['مدل', (p) => p.year ?? p.yearText], ['کارکرد', (p) => p.mileage ?? p.mileageText], ['رنگ', (p) => p.color],
    ['گیربکس', (p) => p.gearbox], ['سوخت', (p) => p.fuel], ['بدنه', (p) => p.body], ['موتور', (p) => p.engine],
    ['شاسی', (p) => p.chassis], ['بیمه', (p) => p.insurance], ['برند و تیپ', (p) => p.brand], ['معاوضه', (p) => p.exchange],
    ['زمان و محل', (p) => p.subtitle], ['لینک', (p) => p.url], ['توضیحات', (p) => p.description],
  ];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.map(([k]) => esc(k)).join(','), ...posts.map((p) => cols.map(([, fn]) => esc(fn(p))).join(','))];
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `noja-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ---------- Wiring ----------
function describeCriteria(c, sourceUrl) {
  const parts = [];
  if (c.query) parts.push(`«${c.query}»`);
  if (c.keyword) parts.push(`عنوان شامل «${c.keyword}»`);
  if (c.yearMin || c.yearMax) {
    parts.push(c.yearMin === c.yearMax ? `مدل ${fa(c.yearMin, { useGrouping: false })}` : `مدل ${c.yearMin ? fa(c.yearMin, { useGrouping: false }) : '…'} تا ${c.yearMax ? fa(c.yearMax, { useGrouping: false }) : '…'}`);
  }
  if (c.priceMax) parts.push(`تا ${formatPrice(c.priceMax)} تومان`);
  if (c.mileageMax) parts.push(`کارکرد تا ${fa(c.mileageMax)}`);
  const el = $('#criteria');
  el.replaceChildren(parts.join('، ') || 'جستجوی دیوار');
  const src = safeDivarUrl(sourceUrl);
  if (src) el.append(' — ', h('a', { href: src, target: '_blank', rel: 'noopener' }, 'صفحهٔ جستجو در دیوار'));
}

function wire() {
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    state.tab = b.dataset.tab;
    for (const t of document.querySelectorAll('#tabs button')) t.setAttribute('aria-selected', String(t === b));
    render();
  });
  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; render(); });
  let t = null;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { state.query = e.target.value.trim(); render(); }, 200);
  });
  for (const b of document.querySelectorAll('.seg button')) {
    b.addEventListener('click', () => {
      state.view = b.dataset.view;
      for (const x of document.querySelectorAll('.seg button')) x.setAttribute('aria-pressed', String(x === b));
      try { localStorage.setItem('noja.view', state.view); } catch (_) { /* ignore */ }
      render();
    });
  }
  try {
    const v = localStorage.getItem('noja.view');
    if (v === 'table') document.querySelector('.seg button[data-view="table"]').click();
  } catch (_) { /* ignore */ }
  $('#exportBtn').addEventListener('click', exportCsv);
  $('#pauseBtn').addEventListener('click', () => {
    state.paused = !state.paused;
    $('#pauseBtn').textContent = state.paused ? 'ادامه' : 'توقف';
    updateProgress();
  });
  $('#retryBtn').addEventListener('click', () => {
    for (const token of state.errors.keys()) state.status.set(token, 'pending');
    state.errors.clear();
    runQueue();
  });
}

async function main() {
  wire();
  const job = await loadJob();
  if (!job) {
    $('#progressText').textContent = 'جستجویی پیدا نشد. از دکمهٔ افزونه یک جستجو شروع کنید.';
    $('#empty').hidden = false;
    $('#empty').textContent = 'هنوز جستجویی انجام نشده است.';
    return;
  }
  state.job = job;
  state.job.criteria = job.criteria || {};
  state.items = (job.items || []).map((it, i) => ({ ...it, order: i }));
  for (const it of state.items) state.status.set(it.token, 'pending');
  describeCriteria(state.job.criteria, job.sourceUrl);
  if (state.job.criteria.query) document.title = `نوجا · ${state.job.criteria.query}`;
  await Promise.all([loadFavorites(), loadCache(state.items.map((it) => it.token))]);
  for (const it of state.items) {
    const p = state.posts.get(it.token);
    if (p) p.order = it.order;
  }
  render();
  await runQueue();
  render();
}

main().catch((e) => {
  $('#progressText').textContent = `خطا: ${e && e.message ? e.message : e}`;
});
