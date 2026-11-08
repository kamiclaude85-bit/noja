'use strict';

const P = globalThis.NojaParser;
const ACTIVE = ['starting', 'waiting-login', 'collecting', 'reading', 'blocked', 'paused'];

const state = {
  runId: new URLSearchParams(location.search).get('run'),
  run: null,
  posts: [],
  favorites: new Set(),
  tab: 'all',
  sort: 'default',
  view: 'cards',
  query: '',
  showOut: false,
  signature: '',
};

// ---------- Helpers ----------
const $ = (sel) => document.querySelector(sel);
const fa = (n, opts) => (n == null ? '—' : Number(n).toLocaleString('fa-IR', opts));
const faYear = (n) => fa(n, { useGrouping: false });

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
  return h('span', { class: `badge ${p.seller}`, title: (p.sellerReasons || []).join('\n') }, sellerLabel(p));
}

function conditionClass(text) {
  if (!text) return null;
  if (/تصادفی|تعویض شده|ضربه|رنگ‌?شدگی|رنگ شدگی|صافکاری|نیاز به تعمیر|خوردگی|اوراقی|لکه/.test(text)) return 'bad';
  if (/سالم|بدون رنگ|بی.?رنگ|پلمپ|تعویض نشده|اورجینال/.test(text)) return 'good';
  return null;
}

// ---------- Favorites (kept in this browser) ----------
function loadFavorites() {
  try { state.favorites = new Set(JSON.parse(localStorage.getItem('noja.favorites') || '[]')); } catch (_) { state.favorites = new Set(); }
}
function toggleFavorite(token) {
  if (state.favorites.has(token)) state.favorites.delete(token);
  else state.favorites.add(token);
  try { localStorage.setItem('noja.favorites', JSON.stringify(Array.from(state.favorites))); } catch (_) { /* ignore */ }
  render();
}

// ---------- Server ----------
async function api(path, method) {
  const res = await fetch(path, { method: method || 'GET' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

async function control(action) {
  try { await api(`/api/runs/${encodeURIComponent(state.runId)}/${action}`, 'POST'); } catch (e) { alert(e.message); }
  poll(true);
}

// ---------- Derived ----------
function matched(p) { return P.matchesCriteria(p, state.run.criteria); }
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

// ---------- Header / banner ----------
function describeCriteria(c, sourceUrl) {
  const parts = [];
  if (c.query) parts.push(`«${c.query}»`);
  if (c.keyword) parts.push(`عنوان شامل «${c.keyword}»`);
  if (c.yearMin || c.yearMax) {
    parts.push(c.yearMin === c.yearMax ? `مدل ${faYear(c.yearMin)}` : `مدل ${c.yearMin ? faYear(c.yearMin) : '…'} تا ${c.yearMax ? faYear(c.yearMax) : '…'}`);
  }
  if (c.priceMax) parts.push(`تا ${formatPrice(c.priceMax)} تومان`);
  if (c.mileageMax) parts.push(`کارکرد تا ${fa(c.mileageMax)}`);
  const el = $('#criteria');
  el.replaceChildren(parts.join('، ') || 'جستجوی دیوار');
  const src = safeDivarUrl(sourceUrl);
  if (src) el.append(' — ', h('a', { href: src, target: '_blank', rel: 'noopener' }, 'صفحهٔ جستجو در دیوار'));
  if (c.query) document.title = `نوجا — ${c.query}`;
}

function renderStatus() {
  const run = state.run;
  const total = run.items.length;
  const read = state.posts.length;
  const errs = Object.keys(run.errors || {}).length;
  const active = ACTIVE.includes(run.status);
  const finished = read + errs;
  $('#bar').style.width = run.status === 'collecting' || !total ? (active ? '6%' : '100%') : `${Math.min(100, (finished / total) * 100)}%`;
  $('#progressText').textContent = active
    ? (run.status === 'collecting' ? `${fa(total)} آگهی پیدا شد` : `${fa(finished)} از ${fa(total)} آگهی`)
    : run.message;

  const banner = $('#banner');
  const btns = [];
  let attn = false;
  let title = run.message;
  if (run.status === 'waiting-login' || run.status === 'blocked') {
    attn = true;
    title = run.status === 'waiting-login' ? 'لطفاً وارد حساب دیوار شوید' : 'دیوار تأیید می‌خواهد';
    btns.push(h('button', { class: 'btn-main', onclick: () => control('continue') }, 'ادامه'));
    btns.push(h('button', { class: 'ghost', onclick: () => control('stop') }, 'لغو'));
  } else if (run.status === 'paused') {
    btns.push(h('button', { class: 'btn-main', onclick: () => control('resume') }, 'ادامه'));
    btns.push(h('button', { class: 'ghost', onclick: () => control('stop') }, 'پایان و نمایش نتایج'));
  } else if (run.status === 'collecting') {
    btns.push(h('button', { class: 'ghost', onclick: () => control('stop') }, 'کافیه، برو سراغ خواندن آگهی‌ها'));
  } else if (active) {
    btns.push(h('button', { class: 'ghost', onclick: () => control('pause') }, 'مکث'));
    btns.push(h('button', { class: 'ghost', onclick: () => control('stop') }, 'پایان و نمایش نتایج'));
  }
  banner.hidden = false;
  banner.className = `banner${attn ? ' attn' : ''}`;
  const msg = h('div', null,
    active ? h('b', null, h('span', { class: 'spin' }), title) : h('b', null, title),
    title !== run.message ? h('span', null, run.message) : null);
  $('#bannerMsg').replaceChildren(msg);
  $('#bannerBtns').replaceChildren(...btns);
}

// ---------- Rendering ----------
function renderStats(pool, medianPrice) {
  const personal = pool.filter((p) => p.seller === 'personal');
  const dealer = pool.filter((p) => p.seller === 'dealer');
  const prices = pool.map((p) => p.price).filter((n) => n != null && n > 0);
  const kms = pool.map((p) => p.mileage).filter((n) => n != null);
  const personalMedian = P.median(personal.map((p) => p.price).filter((n) => n > 0));
  const stat = (k, v, s) => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), s ? h('div', { class: 's' }, s) : null);
  $('#stats').replaceChildren(
    stat('آگهی‌های مطابق', fa(pool.length), `از ${fa(state.posts.length)} آگهی خوانده‌شده`),
    stat('شخصی', fa(personal.length), pool.length ? `${fa(Math.round((personal.length / pool.length) * 100))}٪` : ''),
    stat('نمایشگاهی', fa(dealer.length), pool.length ? `${fa(Math.round((dealer.length / pool.length) * 100))}٪` : ''),
    stat('میانهٔ قیمت', formatPrice(medianPrice) || '—', prices.length ? `از ${formatPrice(Math.min(...prices))} تا ${formatPrice(Math.max(...prices))}` : 'تومان'),
    stat('میانهٔ قیمت شخصی', formatPrice(personalMedian) || '—', 'تومان'),
    stat('میانهٔ کارکرد', kms.length ? fa(P.median(kms)) : '—', 'کیلومتر'),
  );
  const counts = { all: pool.length, personal: personal.length, dealer: dealer.length, fav: pool.filter((p) => state.favorites.has(p.token)).length };
  for (const [k, v] of Object.entries(counts)) {
    const el = document.querySelector(`[data-count="${k}"]`);
    if (el) el.textContent = fa(v);
  }
}

function priceCompare(p, medianPrice) {
  if (!medianPrice || !p.price) return null;
  const r = p.price / medianPrice;
  if (r <= 0.9) return h('span', { class: 'cmp low', title: 'نسبت به میانهٔ قیمت آگهی‌های مطابق' }, `${fa(Math.round((1 - r) * 100))}٪ زیر میانه`);
  if (r >= 1.1) return h('span', { class: 'cmp high', title: 'نسبت به میانهٔ قیمت آگهی‌های مطابق' }, `${fa(Math.round((r - 1) * 100))}٪ بالای میانه`);
  return null;
}

function gallery(p) {
  const imgs = (p.images || []).map(safeImg).filter(Boolean);
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
  const extra = Object.entries(p.fields || {});
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
        chip('مدل', p.year ? faYear(p.year) : p.yearText),
        chip('کارکرد', p.mileage != null ? `${fa(p.mileage)} کیلومتر` : p.mileageText),
        chip('رنگ', p.color),
        chip('گیربکس', p.gearbox),
        chip('سوخت', p.fuel)),
      h('dl', { class: 'specs' },
        spec('بدنه', p.body), spec('موتور', p.engine), spec('شاسی', p.chassis),
        spec('بیمه', p.insurance), spec('برند و تیپ', p.brand), spec('معاوضه', p.exchange)),
      p.description ? h('details', null, h('summary', null, 'توضیحات فروشنده'), h('p', null, p.description)) : null,
      extra.length ? h('details', null, h('summary', null, `همهٔ مشخصات (${fa(extra.length)})`),
        h('dl', { class: 'specs' }, extra.map(([k, v]) => [h('dt', null, k), h('dd', null, v)]))) : null,
      h('details', null, h('summary', null, `چرا «${sellerLabel(p)}»؟`), h('p', null, (p.sellerReasons || []).join('\n'))),
      h('div', { class: 'actions' },
        url ? h('a', { class: 'btn primary', href: url, target: '_blank', rel: 'noopener' }, 'دیدن آگهی در دیوار') : null)));
}

function table(list, medianPrice, outSet) {
  const cols = ['', 'عنوان', 'فروشنده', 'قیمت', 'مدل', 'کارکرد', 'رنگ', 'گیربکس', 'بدنه', 'موتور', 'شاسی', 'بیمه', 'زمان و محل', ''];
  const rows = list.map((p) => {
    const url = safeDivarUrl(p.url);
    const img = safeImg((p.images || [])[0]);
    const fav = state.favorites.has(p.token);
    const cell = (v, cls) => h('td', cls ? { class: cls } : null, v || '—');
    const bad = (v) => (conditionClass(v) === 'bad' ? 'err' : null);
    return h('tr', { class: outSet.has(p.token) ? 'out' : null },
      h('td', null, img ? h('img', { src: img, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : ''),
      h('td', { class: 't' }, url ? h('a', { href: url, target: '_blank', rel: 'noopener' }, p.title) : p.title),
      h('td', null, badge(p)),
      h('td', { title: p.price ? `${fa(p.price)} تومان` : '' }, p.price ? formatPrice(p.price) : (p.priceText || '—'), ' ', priceCompare(p, medianPrice)),
      cell(p.year ? faYear(p.year) : p.yearText),
      cell(p.mileage != null ? fa(p.mileage) : p.mileageText),
      cell(p.color), cell(p.gearbox), cell(p.body, bad(p.body)), cell(p.engine, bad(p.engine)),
      cell(p.chassis, `wrap${bad(p.chassis) ? ' err' : ''}`), cell(p.insurance), cell(p.subtitle),
      h('td', null, h('button', { class: 'ghost small', 'aria-pressed': fav ? 'true' : 'false', onclick: () => toggleFavorite(p.token), title: 'نشان کردن' }, fav ? '★' : '☆')));
  });
  return h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, cols.map((c) => h('th', null, c)))), h('tbody', null, rows)));
}

function render() {
  if (!state.run) return;
  renderStatus();
  const posts = state.posts;
  const pool = posts.filter(matched);
  const outSet = new Set(posts.filter((p) => !matched(p)).map((p) => p.token));
  const medianPrice = P.median(pool.map((p) => p.price).filter((n) => n > 0));
  renderStats(pool, medianPrice);

  const base = state.showOut ? posts : pool;
  const list = sortPosts(base.filter(inTab).filter(searchHit));

  const note = $('#filteredNote');
  note.hidden = !outSet.size;
  if (outSet.size) {
    note.replaceChildren(
      `${fa(outSet.size)} آگهی با فیلترهای شما (سال، قیمت، کارکرد یا کلمهٔ کلیدی) جور نبود و کنار گذاشته شد. `,
      h('button', { type: 'button', onclick: () => { state.showOut = !state.showOut; render(); } }, state.showOut ? 'پنهانشان کن' : 'نشانشان بده'));
  }

  const container = $('#list');
  container.className = state.view === 'cards' ? 'cards' : '';
  if (state.view === 'cards') container.replaceChildren(...list.map((p) => card(p, medianPrice, outSet.has(p.token))));
  else container.replaceChildren(list.length ? table(list, medianPrice, outSet) : '');

  const errors = Object.entries(state.run.errors || {});
  const showErrors = state.tab === 'all' && !state.query && state.view === 'cards' && errors.length;
  if (showErrors) {
    for (const [token, err] of errors) {
      const item = state.run.items.find((it) => it.token === token);
      const url = safeDivarUrl(item && item.href);
      container.append(h('article', { class: 'card' }, h('div', { class: 'body' },
        h('h2', { class: 'title' }, (item && item.title) || token),
        h('div', { class: 'err' }, `خواندن این آگهی ممکن نشد: ${err}`),
        url ? h('div', { class: 'actions' }, h('a', { class: 'btn line', href: url, target: '_blank', rel: 'noopener' }, 'باز کردن در دیوار')) : null)));
    }
  }
  const active = ACTIVE.includes(state.run.status);
  $('#empty').hidden = list.length > 0 || showErrors;
  $('#empty').textContent = posts.length ? 'آگهی‌ای با این فیلترها پیدا نشد.' : (active ? 'ربات در حال کار است؛ آگهی‌ها به‌محض خوانده‌شدن اینجا ظاهر می‌شوند…' : 'آگهی‌ای خوانده نشد.');
}

// ---------- CSV ----------
function exportCsv() {
  const posts = sortPosts(state.posts.filter((p) => state.showOut || matched(p)).filter(inTab).filter(searchHit));
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

// ---------- Polling ----------
let pollTimer = null;
async function poll(immediate) {
  clearTimeout(pollTimer);
  try {
    const run = await api(`/api/runs/${encodeURIComponent(state.runId)}`);
    const sig = `${run.status}|${run.message}|${run.items.length}|${run.posts.length}|${Object.keys(run.errors || {}).length}`;
    if (sig !== state.signature || immediate) {
      const first = !state.run;
      state.signature = sig;
      state.run = run;
      state.posts = run.posts;
      if (first) describeCriteria(run.criteria, run.sourceUrl);
      else if (run.sourceUrl) describeCriteria(run.criteria, run.sourceUrl);
      render();
    }
    if (ACTIVE.includes(run.status)) pollTimer = setTimeout(poll, 1500);
  } catch (e) {
    $('#progressText').textContent = `ارتباط با ربات برقرار نیست (${e.message}).`;
    pollTimer = setTimeout(poll, 4000);
  }
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
    if (localStorage.getItem('noja.view') === 'table') {
      state.view = 'table';
      for (const x of document.querySelectorAll('.seg button')) x.setAttribute('aria-pressed', String(x.dataset.view === 'table'));
    }
  } catch (_) { /* ignore */ }
  $('#exportBtn').addEventListener('click', exportCsv);
}

wire();
loadFavorites();
if (!state.runId) {
  $('#progressText').textContent = 'جستجویی انتخاب نشده است.';
  $('#empty').hidden = false;
  $('#empty').textContent = 'از صفحهٔ اصلی یک جستجو شروع کنید.';
} else {
  poll(true);
}
