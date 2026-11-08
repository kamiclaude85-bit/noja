'use strict';

/* =========================================================
   Noja — single-page UI (home + live results)
   ========================================================= */

const P = globalThis.NojaParser;
const ACTIVE = ['starting', 'waiting-login', 'collecting', 'reading', 'resting', 'blocked', 'paused'];

// ---------- tiny helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const fa = (n, opts) => (n == null || Number.isNaN(n) ? '—' : Number(n).toLocaleString('fa-IR', opts));
const faYear = (n) => fa(n, { useGrouping: false });

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v; // only used with static strings
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
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
  const parts = [];
  if (c.query) parts.push(c.query);
  else if (c.searchUrl) parts.push('جستجوی دیوار');
  if (c.yearMin || c.yearMax) {
    parts.push(c.yearMin === c.yearMax ? `مدل ${faYear(c.yearMin)}` : `مدل ${c.yearMin ? faYear(c.yearMin) : '…'} تا ${c.yearMax ? faYear(c.yearMax) : '…'}`);
  }
  return parts.join('، ');
}

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* ignore */ } },
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(body.error || `HTTP ${res.status}`); e.body = body; throw e; }
  return body;
}

// =========================================================
// App-level state (account, history)
// =========================================================
const app = { loggedIn: null, runs: [], busy: null, today: 0, dailyLimit: 300 };

async function refreshApp() {
  try {
    const s = await api('/api/state');
    Object.assign(app, s);
  } catch (_) {
    app.offline = true;
  }
  renderAccount();
  if (route.name === 'home') updateHomeNotices();
}

function renderAccount() {
  const acc = $('#account');
  acc.classList.toggle('on', !!app.loggedIn);
  $('.label', acc).textContent = app.offline ? 'ربات در دسترس نیست'
    : app.loggedIn ? 'به دیوار وصل هستید' : 'ورود به دیوار';
  acc.title = app.loggedIn ? 'حساب دیوار شما در کروم ربات فعال است.' : 'برای ورود، صفحهٔ دیوار در کروم باز می‌شود.';
}

$('#account').addEventListener('click', () => { if (!app.loggedIn) api('/api/login', { method: 'POST' }).catch(() => {}); });

function historyItem(r) {
  return h('a', { class: 'history-item', href: `#/run/${encodeURIComponent(r.id)}` },
    icon('history'),
    h('div', null,
      h('b', null, describeCriteria(r.criteria) || 'جستجو'),
      h('small', null, `${new Date(r.createdAt).toLocaleDateString('fa-IR', { month: 'long', day: 'numeric' })} · ${fa(r.read)} آگهی${ACTIVE.includes(r.status) ? ' · در حال انجام' : ''}`)));
}

const historyBtn = $('#historyBtn');
const historyPop = $('#historyPop');
historyBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  const open = historyPop.hidden;
  if (open) {
    await refreshApp();
    historyPop.replaceChildren(h('h3', null, 'جستجوهای قبلی'),
      app.runs.length ? app.runs.map(historyItem) : h('p', { class: 'muted', style: 'margin:8px 10px' }, 'هنوز جستجویی انجام نشده.'));
  }
  historyPop.hidden = !open;
  historyBtn.setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', (e) => { if (!historyPop.hidden && !historyPop.contains(e.target)) { historyPop.hidden = true; historyBtn.setAttribute('aria-expanded', 'false'); } });

// =========================================================
// Router
// =========================================================
let route = { name: 'home' };
function parseRoute() {
  const m = location.hash.match(/^#\/run\/([A-Za-z0-9_-]+)/);
  return m ? { name: 'run', id: m[1] } : { name: 'home' };
}
function onRoute() {
  historyPop.hidden = true;
  stopRun();
  route = parseRoute();
  window.scrollTo(0, 0);
  if (route.name === 'run') startRun(route.id);
  else renderHome();
}
window.addEventListener('hashchange', onRoute);

// =========================================================
// Home
// =========================================================
function renderHome() {
  document.title = 'نوجا';
  $('#runTitle').hidden = true;
  $('#newSearch').hidden = true;
  const saved = store.get('noja.form', {});
  const val = (k, d = '') => (saved[k] != null ? saved[k] : d);

  const cities = [['tehran', 'تهران'], ['karaj', 'کرج'], ['mashhad', 'مشهد'], ['isfahan', 'اصفهان'], ['shiraz', 'شیراز'], ['tabriz', 'تبریز'],
    ['ahvaz', 'اهواز'], ['qom', 'قم'], ['rasht', 'رشت'], ['kermanshah', 'کرمانشاه'], ['urmia', 'ارومیه'], ['kerman', 'کرمان'], ['yazd', 'یزد'],
    ['hamedan', 'همدان'], ['qazvin', 'قزوین'], ['arak', 'اراک'], ['sari', 'ساری'], ['gorgan', 'گرگان'], ['zanjan', 'زنجان'], ['ardabil', 'اردبیل'],
    ['bandar-abbas', 'بندرعباس'], ['zahedan', 'زاهدان'], ['iran', 'سراسر ایران']];
  const select = h('select', { name: 'city', id: 'f-city' }, cities.map(([v, t]) => h('option', { value: v, selected: val('city', 'tehran') === v }, t)));
  const speed = h('select', { name: 'speed', id: 'f-speed' },
    [['slow', 'آهسته — طبیعی‌ترین رفتار'], ['normal', 'معمولی'], ['fast', 'سریع']].map(([v, t]) => h('option', { value: v, selected: val('speed', 'normal') === v }, t)));

  const err = h('p', { class: 'form-error', role: 'alert' });
  const go = h('button', { class: 'btn primary lg', type: 'submit' }, icon('search'), 'پیدا کن');
  const form = h('form', { class: 'search-card', autocomplete: 'off', novalidate: true },
    h('div', { class: 'search-main' },
      h('label', { class: 'field-big' },
        h('span', { class: 'sr-only' }, 'نام خودرو'),
        icon('car', 'lg'),
        h('input', { name: 'query', id: 'f-query', placeholder: 'چه ماشینی؟ مثلاً پژو ۲۰۶', value: val('query'), autofocus: true })),
      go),
    h('div', { class: 'search-row' },
      h('label', { class: 'field' }, h('span', null, 'شهر'), select),
      h('label', { class: 'field' }, h('span', null, 'مدل از سال'), h('input', { name: 'yearMin', inputmode: 'numeric', placeholder: 'مثلاً ۹۷', value: val('yearMin') })),
      h('label', { class: 'field' }, h('span', null, 'تا سال'), h('input', { name: 'yearMax', inputmode: 'numeric', placeholder: 'مثلاً ۹۷', value: val('yearMax') }))),
    h('details', { class: 'adv' },
      h('summary', null, icon('sliders', 'sm'), 'تنظیمات بیشتر', icon('down', 'sm')),
      h('div', { class: 'adv-grid' },
        h('label', { class: 'field' }, h('span', null, 'کلمهٔ لازم در عنوان'), h('input', { name: 'keyword', placeholder: 'مثلاً 206', value: val('keyword') }),
          h('span', { class: 'help' }, 'آگهی‌هایی که این کلمه را ندارند کنار می‌روند')),
        h('label', { class: 'field' }, h('span', null, 'حداکثر تعداد آگهی'), h('input', { name: 'maxAds', inputmode: 'numeric', value: val('maxAds', '150') })),
        h('label', { class: 'field' }, h('span', null, 'سرعت ربات'), speed),
        h('label', { class: 'field' }, h('span', null, 'سقف آگهی در روز'), h('input', { name: 'dailyLimit', inputmode: 'numeric', value: val('dailyLimit', String(app.dailyLimit || 300)) }),
          h('span', { class: 'help', id: 'todayHelp' }, '')),
        h('label', { class: 'field wide' }, h('span', null, 'یا لینک یک جستجوی فیلترشده در دیوار'),
          h('input', { name: 'searchUrl', dir: 'ltr', placeholder: 'https://divar.ir/s/tehran/car/peugeot/206?...', value: val('searchUrl') }),
          h('span', { class: 'help' }, 'اگر خودتان در دیوار برند، تیپ یا رنگ را فیلتر کرده‌اید، لینک صفحه را اینجا بگذارید.')),
        h('label', { class: 'check wide' }, h('input', { type: 'checkbox', name: 'strictYear', checked: !!saved.strictYear }), 'آگهی‌هایی که سالشان معلوم نیست حذف شوند'))),
    err);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const data = Object.fromEntries(new FormData(form).entries());
    data.strictYear = form.elements.strictYear.checked;
    store.set('noja.form', data);
    if (!data.query.trim() && !data.searchUrl.trim()) {
      err.textContent = 'نام خودرو را بنویسید (یا لینک جستجوی دیوار را در «تنظیمات بیشتر» بگذارید).';
      form.elements.query.focus();
      return;
    }
    go.disabled = true;
    go.replaceChildren(icon('loader'), 'در حال شروع…');
    try {
      const { id } = await api('/api/scan', { method: 'POST', body: data });
      location.hash = `#/run/${id}`;
    } catch (ex) {
      err.textContent = ex.body && ex.body.id ? 'یک جستجو در حال انجام است.' : ex.message;
      go.disabled = false;
      go.replaceChildren(icon('search'), 'پیدا کن');
    }
  });

  const steps = [
    ['دیوار را باز می‌کند', 'در کروم خودش و با حساب شما، مثل یک کاربر معمولی جستجو می‌کند.'],
    ['آگهی‌ها را یکی‌یکی می‌خواند', 'با سرعت آدم، با مکث و استراحت، و با سقف روزانه.'],
    ['همه را کنار هم می‌گذارد', 'شخصی و نمایشگاهی جدا، با فیلتر، مقایسه و قیمت میانه.'],
  ];

  const view = h('main', { class: 'home' },
    h('h1', null, 'همهٔ آگهی‌های ماشینِ موردنظرت، یک‌جا'),
    h('p', { class: 'lead' }, 'نوجا در دیوار می‌گردد، آگهی‌ها را باز می‌کند و مشخصات را برایت مرتب می‌کند. تو فقط انتخاب کن.'),
    form,
    h('div', { id: 'homeNotices' }),
    h('div', { class: 'steps' }, steps.map(([t, s], i) => h('div', { class: 'step' }, h('span', { class: 'n' }, fa(i + 1)), h('div', null, h('b', null, t), h('span', null, s))))),
    h('div', { id: 'homeHistory' }));
  $('#view').replaceChildren(view);
  updateHomeNotices();
}

function updateHomeNotices() {
  const box = $('#homeNotices');
  if (!box) return;
  const items = [];
  if (app.busy) {
    items.push(h('div', { class: 'notice' }, icon('loader'), h('div', { class: 'grow' }, 'ربات در حال یک جستجوی دیگر است.'),
      h('a', { class: 'btn sm', href: `#/run/${encodeURIComponent(app.busy)}` }, 'دیدن پیشرفت')));
  }
  if (app.loggedIn === false && !app.offline) {
    items.push(h('div', { class: 'notice' }, icon('login'),
      h('div', { class: 'grow' }, h('b', null, 'یک بار وارد حساب دیوار شوید. '), 'می‌توانید همین حالا جستجو را شروع کنید؛ ربات صبر می‌کند تا وارد شوید.'),
      h('button', { class: 'btn sm', type: 'button', onclick: () => api('/api/login', { method: 'POST' }).catch(() => {}) }, 'ورود به دیوار')));
  }
  if (app.offline) items.push(h('div', { class: 'notice' }, icon('alert'), h('div', { class: 'grow' }, 'ارتباط با ربات قطع است. برنامهٔ نوجا را دوباره اجرا کنید.')));
  box.replaceChildren(...items);
  const help = $('#todayHelp');
  if (help) help.textContent = `امروز ${fa(app.today || 0)} آگهی باز شده`;
  const hist = $('#homeHistory');
  if (hist) {
    hist.replaceChildren(...(app.runs.length ? [
      h('h2', { class: 'section-title' }, icon('history', 'sm'), 'جستجوهای اخیر'),
      h('div', { class: 'history' }, app.runs.slice(0, 6).map(historyItem)),
    ] : []));
  }
}

// =========================================================
// Run view
// =========================================================
let R = null; // current run view state
let pollTimer = null;
let tickTimer = null;

function stopRun() {
  clearTimeout(pollTimer);
  clearInterval(tickTimer);
  R = null;
  closeOverlay();
}

function defaultFilters(c) {
  return {
    seller: 'all',
    priceMin: '', priceMax: c.priceMax ? String(Math.round(c.priceMax / 1e6)) : '',
    yearMin: c.yearMin ? String(c.yearMin) : '', yearMax: c.yearMax ? String(c.yearMax) : '',
    kmMax: c.mileageMax ? String(c.mileageMax) : '',
    gearbox: [], color: [],
    bodyOk: false, engineOk: false, priced: false, fav: false,
    keyword: c.keyword || '',
    strictYear: !!c.strictYear,
  };
}

function startRun(id) {
  R = {
    id,
    run: null,
    posts: [],
    filters: null,
    sort: store.get('noja.sort', 'default'),
    view: store.get('noja.view', 'list'),
    q: '',
    favorites: new Set(store.get('noja.favorites', [])),
    compare: new Set(),
    rows: new Map(),
    sig: '',
    optSig: '',
  };
  $('#newSearch').hidden = false;
  $('#view').replaceChildren(
    h('section', { class: 'status', id: 'status', 'aria-live': 'polite' }),
    h('div', { class: 'run' },
      h('aside', { class: 'filters', id: 'filters', 'aria-label': 'فیلترها' }),
      h('main', null,
        h('div', { class: 'results-head', id: 'resultsHead' }),
        h('div', { id: 'results' }, h('div', { class: 'list' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }))),
        h('div', { id: 'errorsBox' }))),
    h('div', { id: 'trayBox' }));
  poll();
  tickTimer = setInterval(tick, 1000);
}

async function poll() {
  clearTimeout(pollTimer);
  if (!R) return;
  const id = R.id;
  try {
    const run = await api(`/api/runs/${encodeURIComponent(id)}`);
    if (!R || R.id !== id) return;
    const sig = `${run.status}|${run.message}|${run.activity}|${run.items.length}|${run.posts.length}|${Object.keys(run.errors || {}).length}|${run.waitUntil}`;
    const first = !R.run;
    R.run = run;
    R.posts = run.posts;
    if (first) {
      R.filters = { ...defaultFilters(run.criteria), ...store.get(`noja.filters.${id}`, {}) };
      const title = describeCriteria(run.criteria);
      document.title = `نوجا — ${title}`;
      const rt = $('#runTitle');
      rt.hidden = false;
      rt.replaceChildren(h('span', null, '/'), h('b', null, title));
    }
    if (sig !== R.sig || first) {
      R.sig = sig;
      renderStatus();
      renderFilters();
      renderResults();
    }
    if (ACTIVE.includes(run.status)) pollTimer = setTimeout(poll, 1200);
    else refreshApp();
  } catch (e) {
    if (!R) return;
    if (/404|not found/i.test(e.message)) {
      $('#view').replaceChildren(h('main', { class: 'home' }, h('div', { class: 'empty' }, icon('alert'), h('b', null, 'این جستجو پیدا نشد'), h('a', { class: 'btn', href: '#/' }, 'بازگشت'))));
      return;
    }
    pollTimer = setTimeout(poll, 3000);
  }
}

async function control(action) {
  try { await api(`/api/runs/${encodeURIComponent(R.id)}/${action}`, { method: 'POST' }); } catch (e) { /* ignore */ }
  poll();
}

// ---------- status strip ----------
function etaText(run) {
  const total = run.items.length;
  const remaining = Math.max(0, total - run.posts.length - Object.keys(run.errors || {}).length);
  if (!remaining) return '';
  const s = run.stats || {};
  const per = s.opened ? s.readMs / s.opened + 3500 : 14000;
  const min = Math.max(1, Math.round((remaining * per) / 60000));
  return `حدود ${fa(min)} دقیقه مانده`;
}

function countdown(until) {
  const s = Math.max(0, Math.round((until - Date.now()) / 1000));
  return `${fa(Math.floor(s / 60))}:${String(s % 60).padStart(2, '0').replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d])}`;
}

function tick() {
  if (!R || !R.run || !R.run.waitUntil) return;
  const el = $('#statusMeta');
  if (el) el.textContent = countdown(R.run.waitUntil);
}

function renderStatus() {
  const run = R.run;
  const total = run.items.length;
  const done = run.posts.length + Object.keys(run.errors || {}).length;
  const st = run.status;
  const btn = (label, ic, onclick, cls = '') => h('button', { class: `btn sm ${cls}`, type: 'button', onclick }, ic ? icon(ic, 'sm') : null, label);
  const focus = () => api(`/api/runs/${encodeURIComponent(R.id)}/focus`, { method: 'POST' }).catch(() => {});

  let ic = 'loader'; let cls = ''; let title = run.message; let sub = ''; let meta = ''; let actions = []; let pulse = true; let pct = null;
  switch (st) {
    case 'starting':
      title = 'در حال آماده شدن…';
      break;
    case 'waiting-login':
      ic = 'login'; cls = 'attn'; pulse = false;
      title = 'یک بار وارد حساب دیوار شوید'; sub = run.message;
      actions = [btn('نمایش پنجرهٔ دیوار', 'external', focus), btn('وارد شدم', 'check', () => control('continue'), 'primary'), btn('لغو', null, () => control('stop'), 'ghost')];
      break;
    case 'collecting':
      ic = 'search'; title = 'در حال مرور نتایج دیوار'; sub = run.message; meta = `${fa(total)} آگهی پیدا شد`;
      actions = [btn('کافیه، برو سراغ آگهی‌ها', 'right', () => control('stop'))];
      break;
    case 'reading':
      ic = 'car'; title = run.message; sub = run.activity ? `الان: ${run.activity}` : ''; meta = etaText(run); pct = total ? done / total : 0;
      actions = [btn('مکث', 'pause', () => control('pause')), btn('پایان', 'stop', () => control('stop'), 'ghost')];
      break;
    case 'resting':
      ic = 'coffee'; title = 'استراحت کوتاه'; sub = run.message; meta = run.waitUntil ? countdown(run.waitUntil) : ''; pct = total ? done / total : 0; pulse = false;
      actions = [btn('ادامه بدون استراحت', 'play', () => control('continue')), btn('پایان', 'stop', () => control('stop'), 'ghost')];
      break;
    case 'blocked':
      ic = 'alert'; cls = 'attn'; pulse = false; title = 'دیوار تأیید می‌خواهد'; sub = run.message; meta = run.waitUntil ? countdown(run.waitUntil) : ''; pct = total ? done / total : 0;
      actions = [btn('نمایش پنجرهٔ دیوار', 'external', focus), btn('حل شد، ادامه', 'check', () => control('continue'), 'primary'), btn('پایان', null, () => control('stop'), 'ghost')];
      break;
    case 'paused':
      ic = 'pause'; pulse = false; title = 'ربات مکث کرده'; sub = `${fa(done)} از ${fa(total)} آگهی خوانده شده`; pct = total ? done / total : 0;
      actions = [btn('ادامه', 'play', () => control('resume'), 'primary'), btn('پایان', 'stop', () => control('stop'), 'ghost')];
      break;
    case 'done':
    case 'stopped':
      ic = 'check'; cls = 'done'; pulse = false; title = run.message; pct = 1;
      sub = run.stats ? `${fa(run.stats.opened)} آگهی باز شد${run.stats.cached ? ` · ${fa(run.stats.cached)} آگهی از جستجوهای قبلی` : ''}` : '';
      actions = [btn('جستجوی دوباره', 'history', rerun)];
      break;
    case 'error':
      ic = 'alert'; cls = 'err'; pulse = false; title = run.message;
      actions = [btn('دوباره امتحان کن', 'history', rerun)];
      break;
    default:
  }
  const iconBox = h('span', { class: `state-icon${pulse && ACTIVE.includes(st) ? ' pulse' : ''}` }, icon(ic));
  const bar = h('div', { class: 'bar' }, h('div', { style: `width:${pct == null ? (ACTIVE.includes(st) ? 8 : 100) : Math.round(pct * 100)}%` }));
  $('#status').className = `status ${cls}`;
  $('#status').replaceChildren(
    h('div', { class: 'status-inner' },
      iconBox,
      h('div', { class: 'text' }, h('b', null, title), sub ? h('span', null, sub) : null),
      meta ? h('div', { class: 'meta num', id: 'statusMeta' }, meta) : null,
      h('div', { class: 'actions' }, actions)),
    bar);
}

async function rerun() {
  try {
    const { id } = await api('/api/scan', { method: 'POST', body: R.run.criteria });
    location.hash = `#/run/${id}`;
  } catch (e) { alert(e.message); }
}

// ---------- filtering ----------
const num = (v) => { const n = P.parseNumber(v); return n == null ? null : n; };

function passes(p, f, skip) {
  if (skip !== 'seller' && f.seller !== 'all' && p.seller !== f.seller) return false;
  const yMin = num(f.yearMin) != null ? P.normalizeYear(num(f.yearMin)) : null;
  const yMax = num(f.yearMax) != null ? P.normalizeYear(num(f.yearMax)) : null;
  if (p.year != null) {
    if (yMin != null && p.year < yMin) return false;
    if (yMax != null && p.year > yMax) return false;
  } else if (f.strictYear && (yMin != null || yMax != null)) return false;
  const pMin = num(f.priceMin); const pMax = num(f.priceMax);
  if (p.price != null) {
    if (pMin != null && p.price < pMin * 1e6) return false;
    if (pMax != null && p.price > pMax * 1e6) return false;
  } else if (f.priced) return false;
  const kMax = num(f.kmMax);
  if (kMax != null && p.mileage != null && p.mileage > kMax) return false;
  if (skip !== 'gearbox' && f.gearbox.length && !f.gearbox.includes(p.gearbox)) return false;
  if (skip !== 'color' && f.color.length && !f.color.includes(p.color)) return false;
  if (f.bodyOk && conditionClass(p.body) !== 'good') return false;
  if (f.engineOk && (!p.engine || conditionClass(p.engine) === 'bad')) return false;
  if (f.fav && !R.favorites.has(p.token)) return false;
  if (f.keyword) {
    const hay = P.normalizeText(`${p.title} ${p.brand}`);
    if (!P.normalizeText(f.keyword).split(' ').filter(Boolean).every((w) => hay.includes(w))) return false;
  }
  if (R.q) {
    const hay = P.normalizeText([p.title, p.subtitle, p.color, p.brand, p.body, p.engine, p.chassis, p.gearbox, p.description].join(' '));
    if (!P.normalizeText(R.q).split(' ').every((w) => hay.includes(w))) return false;
  }
  return true;
}

function setFilter(patch) {
  Object.assign(R.filters, patch);
  store.set(`noja.filters.${R.id}`, R.filters);
  renderFilters(true);
  renderResults();
}

function countBy(list, key) {
  const m = new Map();
  for (const p of list) if (p[key]) m.set(p[key], (m.get(p[key]) || 0) + 1);
  return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
}

function renderFilters(force) {
  const box = $('#filters');
  const f = R.filters;
  const posts = R.posts;
  const optSig = JSON.stringify([countBy(posts, 'gearbox').map((x) => x[0]), countBy(posts, 'color').map((x) => x[0]), f]);
  if (!force && optSig === R.optSig && box.childElementCount) {
    updateSellerCounts();
    return;
  }
  if (!force && box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') { updateSellerCounts(); return; }
  R.optSig = optSig;

  const rangeInput = (key, ph) => {
    const input = h('input', { inputmode: 'numeric', placeholder: ph, value: f[key], 'aria-label': ph });
    let t = null;
    input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { R.filters[key] = input.value; store.set(`noja.filters.${R.id}`, R.filters); renderResults(); }, 300); });
    return input;
  };
  const chipGroup = (key, label) => {
    const opts = countBy(posts.filter((p) => passes(p, f, key)), key);
    const all = countBy(posts, key);
    if (all.length < 2) return null;
    return h('div', { class: 'fgroup' }, h('span', { class: 'label' }, label),
      h('div', { class: 'chips' }, all.map(([v]) => {
        const on = f[key].includes(v);
        const c = (opts.find((o) => o[0] === v) || [v, 0])[1];
        return h('button', {
          class: 'chip-btn', type: 'button', 'aria-pressed': String(on),
          onclick: () => setFilter({ [key]: on ? f[key].filter((x) => x !== v) : [...f[key], v] }),
        }, v, h('small', null, fa(c)));
      })));
  };
  const toggle = (key, label) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: !!f[key], onchange: (e) => setFilter({ [key]: e.target.checked }) }), label);

  const search = h('input', { type: 'search', placeholder: 'جستجو در آگهی‌ها (محله، رنگ، تیپ…)', value: R.q, 'aria-label': 'جستجو در آگهی‌ها' });
  let st = null;
  search.addEventListener('input', () => { clearTimeout(st); st = setTimeout(() => { R.q = search.value.trim(); renderResults(); }, 200); });

  box.replaceChildren(
    h('div', { class: 'filters-head' }, h('b', null, icon('sliders', 'sm'), 'فیلترها'),
      h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { R.filters = defaultFilters({}); R.q = ''; store.set(`noja.filters.${R.id}`, R.filters); renderFilters(true); renderResults(); } }, 'پاک کردن همه')),
    h('button', { class: 'btn primary filters-done', type: 'button', onclick: () => $('#filters').classList.remove('open') }, 'نمایش نتایج'),
    h('div', { class: 'fgroup', style: 'border-top:0;padding-top:0' }, search),
    h('div', { class: 'fgroup' }, h('span', { class: 'label' }, 'فروشنده'),
      h('div', { class: 'seg', id: 'sellerSeg' }, [['all', 'همه'], ['personal', 'شخصی'], ['dealer', 'نمایشگاهی']].map(([v, t]) =>
        h('button', { type: 'button', 'data-v': v, 'aria-pressed': String(f.seller === v), onclick: () => setFilter({ seller: v }) }, t, h('small', null, ''))))),
    h('div', { class: 'fgroup' }, h('span', { class: 'label' }, 'قیمت (میلیون تومان)'),
      h('div', { class: 'range' }, rangeInput('priceMin', 'از'), rangeInput('priceMax', 'تا'))),
    h('div', { class: 'fgroup' }, h('span', { class: 'label' }, 'سال مدل'),
      h('div', { class: 'range' }, rangeInput('yearMin', 'از'), rangeInput('yearMax', 'تا'))),
    h('div', { class: 'fgroup' }, h('span', { class: 'label' }, 'حداکثر کارکرد (کیلومتر)'), rangeInput('kmMax', 'مثلاً ۱۵۰۰۰۰')),
    chipGroup('gearbox', 'گیربکس'),
    chipGroup('color', 'رنگ'),
    h('div', { class: 'fgroup' }, h('span', { class: 'label' }, 'وضعیت'),
      toggle('bodyOk', 'فقط بدنهٔ سالم / بی‌رنگ'),
      toggle('engineOk', 'موتور سالم'),
      toggle('priced', 'فقط آگهی‌های قیمت‌دار'),
      toggle('fav', 'فقط نشان‌شده‌ها')),
    f.keyword ? h('div', { class: 'fgroup' }, h('span', { class: 'label' }, 'کلمهٔ لازم در عنوان'),
      h('button', { class: 'tag', type: 'button', onclick: () => setFilter({ keyword: '' }), 'aria-label': `حذف ${f.keyword}` }, f.keyword, icon('x'))) : null);
  updateSellerCounts();
}

function updateSellerCounts() {
  const seg = $('#sellerSeg');
  if (!seg) return;
  const base = R.posts.filter((p) => passes(p, R.filters, 'seller'));
  const counts = { all: base.length, personal: base.filter((p) => p.seller === 'personal').length, dealer: base.filter((p) => p.seller === 'dealer').length };
  for (const b of seg.querySelectorAll('button')) $('small', b).textContent = fa(counts[b.dataset.v]);
}

// ---------- results ----------
function sortList(list) {
  const by = (fn, dir) => (a, b) => {
    const x = fn(a); const y = fn(b);
    if (x == null && y == null) return a.order - b.order;
    if (x == null) return 1;
    if (y == null) return -1;
    return dir * (x - y) || a.order - b.order;
  };
  switch (R.sort) {
    case 'price-asc': return list.sort(by((p) => p.price, 1));
    case 'price-desc': return list.sort(by((p) => p.price, -1));
    case 'km-asc': return list.sort(by((p) => p.mileage, 1));
    case 'year-desc': return list.sort(by((p) => p.year, -1));
    default: return list.sort((a, b) => a.order - b.order);
  }
}

function filtered() {
  return sortList(R.posts.filter((p) => passes(p, R.filters)));
}

function delta(p, med) {
  if (!med || !p.price) return null;
  const r = p.price / med;
  if (r <= 0.92) return { cls: 'low', text: `${fa(Math.round((1 - r) * 100))}٪ زیر میانه` };
  if (r >= 1.08) return { cls: 'high', text: `${fa(Math.round((r - 1) * 100))}٪ بالای میانه` };
  return null;
}

function renderResults() {
  const list = filtered();
  const med = P.median(list.map((p) => p.price).filter((n) => n > 0));
  R.median = med;
  R.list = list;
  const active = ACTIVE.includes(R.run.status);

  // Header
  const prices = list.map((p) => p.price).filter((n) => n > 0);
  const summary = [];
  if (med) summary.push(h('span', null, 'میانهٔ قیمت ', h('b', null, formatPrice(med))));
  if (prices.length) summary.push(h('span', null, ' · ارزان‌ترین ', h('b', null, formatPrice(Math.min(...prices)))));
  const personal = list.filter((p) => p.seller === 'personal').length;
  if (list.length) summary.push(h('span', null, ` · ${fa(personal)} شخصی، ${fa(list.length - personal)} نمایشگاهی`));

  const sortSel = h('select', { 'aria-label': 'مرتب‌سازی', onchange: (e) => { R.sort = e.target.value; store.set('noja.sort', R.sort); renderResults(); } },
    [['default', 'جدیدترین در دیوار'], ['price-asc', 'ارزان‌ترین'], ['price-desc', 'گران‌ترین'], ['km-asc', 'کم‌کارکردترین'], ['year-desc', 'جدیدترین مدل']]
      .map(([v, t]) => h('option', { value: v, selected: R.sort === v }, t)));
  const viewBtn = (v, ic, label) => h('button', { type: 'button', 'aria-pressed': String(R.view === v), 'aria-label': label, title: label,
    onclick: () => { R.view = v; store.set('noja.view', v); R.rows.clear(); renderResults(); } }, icon(ic));

  $('#resultsHead').replaceChildren(
    h('div', null,
      h('h2', null, `${fa(list.length)} آگهی`, R.posts.length !== list.length ? h('span', { class: 'muted', style: 'font-size:15px;font-weight:400' }, ` از ${fa(R.posts.length)}`) : null),
      h('div', { class: 'summary' }, summary)),
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn filters-toggle', type: 'button', onclick: () => $('#filters').classList.add('open') }, icon('sliders', 'sm'), 'فیلترها'),
      sortSel,
      h('div', { class: 'toggle', role: 'group', 'aria-label': 'نحوهٔ نمایش' }, viewBtn('list', 'list', 'نمایش فهرستی'), viewBtn('table', 'table', 'نمایش جدولی')),
      h('button', { class: 'btn icon-only', type: 'button', title: 'خروجی اکسل (CSV)', 'aria-label': 'خروجی اکسل', onclick: exportCsv }, icon('download'))));

  // Body
  const box = $('#results');
  if (!list.length) {
    if (!R.posts.length && active) {
      box.replaceChildren(h('div', { class: 'list' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' })));
    } else if (!R.posts.length) {
      box.replaceChildren(h('div', { class: 'empty' }, icon('search'), h('b', null, 'آگهی‌ای خوانده نشد'), 'پیام بالای صفحه را ببینید.'));
    } else {
      box.replaceChildren(h('div', { class: 'empty' }, icon('sliders'), h('b', null, 'هیچ آگهی‌ای با این فیلترها نیست'),
        h('p', null, `${fa(R.posts.length)} آگهی خوانده شده، ولی فیلترها همه را کنار گذاشته‌اند.`),
        h('button', { class: 'btn', type: 'button', onclick: () => { R.filters = defaultFilters({}); R.q = ''; renderFilters(true); renderResults(); } }, 'پاک کردن فیلترها')));
    }
  } else if (R.view === 'table') {
    box.replaceChildren(renderTable(list, med));
  } else {
    let ul = $('.list', box);
    if (!ul || $('.skeleton', box)) { ul = h('div', { class: 'list' }); box.replaceChildren(ul); }
    const seen = new Set();
    list.forEach((p, i) => {
      const d = delta(p, med);
      const sig = `${R.favorites.has(p.token)}|${R.compare.has(p.token)}|${d ? d.text : ''}`;
      let entry = R.rows.get(p.token);
      if (!entry || entry.sig !== sig) {
        const el = renderRow(p, d);
        if (entry) { entry.el.replaceWith(el); el.style.animation = 'none'; }
        entry = { el, sig };
        R.rows.set(p.token, entry);
      }
      seen.add(p.token);
      if (ul.children[i] !== entry.el) ul.insertBefore(entry.el, ul.children[i] || null);
    });
    for (const [token, entry] of R.rows) if (!seen.has(token)) { entry.el.remove(); R.rows.delete(token); }
    if (active && R.run.status !== 'paused') {
      let sk = $('.skeleton', ul);
      if (!sk) ul.append(h('div', { class: 'skeleton', 'aria-hidden': 'true' }));
      else ul.append(sk);
    } else {
      const sk = $('.skeleton', ul);
      if (sk) sk.remove();
    }
  }

  // Errors
  const errs = Object.entries(R.run.errors || {});
  $('#errorsBox').replaceChildren(errs.length ? h('details', { class: 'errors' },
    h('summary', null, `${fa(errs.length)} آگهی باز نشد`),
    h('ul', null, errs.map(([token, msg]) => {
      const it = R.run.items.find((x) => x.token === token) || {};
      const url = safeDivarUrl(it.href);
      return h('li', null, `${it.title || token}: ${msg} `, url ? h('a', { href: url, target: '_blank', rel: 'noopener' }, 'باز کردن در دیوار') : null);
    }))) : '');

  renderTray();
}

function renderRow(p, d) {
  const img = safeImg((p.images || [])[0]);
  const fav = R.favorites.has(p.token);
  const cmp = R.compare.has(p.token);
  const cond = (label, value) => {
    if (!value) return null;
    const c = conditionClass(value);
    return h('span', { class: `cond${c ? ` ${c}` : ''}`, title: `${label}: ${value}` }, c === 'bad' ? icon('alert') : c === 'good' ? icon('check') : null, `${label}: ${value}`);
  };
  const row = h('article', { class: 'row', tabindex: '0', 'aria-label': p.title, onclick: () => openDrawer(p.token),
    onkeydown: (e) => { if (e.key === 'Enter') openDrawer(p.token); } },
    h('div', { class: 'thumb' },
      img ? h('img', { src: img, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : icon('image', 'lg'),
      p.images && p.images.length > 1 ? h('span', { class: 'count' }, icon('image', 'sm'), fa(p.images.length)) : null),
    h('div', { class: 'row-main' },
      h('h3', null, p.title || 'بدون عنوان'),
      p.subtitle ? h('div', { class: 'where' }, icon('pin', 'sm'), p.subtitle) : null,
      h('div', { class: 'facts' },
        p.year || p.yearText ? h('span', null, icon('calendar'), p.year ? faYear(p.year) : p.yearText) : null,
        p.mileage != null || p.mileageText ? h('span', { class: 'num' }, icon('gauge'), p.mileage != null ? `${fa(p.mileage)} کیلومتر` : p.mileageText) : null,
        p.gearbox ? h('span', null, icon('gear'), p.gearbox) : null,
        p.color ? h('span', null, icon('palette'), p.color) : null),
      h('div', { class: 'conds' }, cond('بدنه', p.body), cond('موتور', p.engine), conditionClass(p.chassis) === 'bad' ? cond('شاسی', p.chassis) : null)),
    h('div', { class: 'row-side' },
      p.price ? h('div', { class: 'price num' }, formatPrice(p.price), ' ', h('small', null, 'تومان')) : h('div', { class: 'price none' }, p.priceText || 'بدون قیمت'),
      d ? h('span', { class: `delta ${d.cls}` }, icon('trend', 'sm'), d.text) : null,
      sellerBadge(p),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn ghost icon-only sm star', type: 'button', 'aria-pressed': String(fav), 'aria-label': fav ? 'برداشتن نشان' : 'نشان کردن', title: fav ? 'برداشتن نشان' : 'نشان کردن',
          onclick: (e) => { e.stopPropagation(); toggleFav(p.token); } }, icon('star')),
        h('button', { class: 'btn ghost icon-only sm cmp-toggle', type: 'button', 'aria-pressed': String(cmp), 'aria-label': 'افزودن به مقایسه', title: 'افزودن به مقایسه',
          onclick: (e) => { e.stopPropagation(); toggleCompare(p.token); } }, icon('compare')),
        safeDivarUrl(p.url) ? h('a', { class: 'btn ghost icon-only sm', href: safeDivarUrl(p.url), target: '_blank', rel: 'noopener', 'aria-label': 'باز کردن در دیوار', title: 'باز کردن در دیوار',
          onclick: (e) => e.stopPropagation() }, icon('external')) : null)));
  return row;
}

function renderTable(list, med) {
  const cols = [
    ['', null], ['عنوان', null], ['فروشنده', null], ['قیمت', 'price'], ['مدل', 'year'], ['کارکرد', 'km'],
    ['رنگ', null], ['گیربکس', null], ['بدنه', null], ['موتور', null], ['محل', null], ['', null],
  ];
  const sortFor = { price: R.sort === 'price-desc' ? 'price-asc' : 'price-asc', year: 'year-desc', km: 'km-asc' };
  const head = h('tr', null, cols.map(([t, k]) => h('th', null, k
    ? h('button', { type: 'button', onclick: () => { R.sort = k === 'price' && R.sort === 'price-asc' ? 'price-desc' : sortFor[k]; store.set('noja.sort', R.sort); renderResults(); } }, t, icon('sort', 'sm'))
    : t)));
  const rows = list.map((p) => {
    const img = safeImg((p.images || [])[0]);
    const d = delta(p, med);
    const fav = R.favorites.has(p.token);
    const c = (v, cls) => h('td', cls ? { class: cls } : null, v || '—');
    return h('tr', { onclick: () => openDrawer(p.token) },
      h('td', null, img ? h('img', { src: img, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : ''),
      h('td', { class: 't' }, p.title),
      h('td', null, sellerBadge(p)),
      h('td', { class: 'num' }, p.price ? formatPrice(p.price) : (p.priceText || '—'), d ? h('div', null, h('span', { class: `delta ${d.cls}` }, d.text)) : null),
      c(p.year ? faYear(p.year) : p.yearText),
      c(p.mileage != null ? fa(p.mileage) : p.mileageText, 'num'),
      c(p.color), c(p.gearbox), c(p.body, conditionClass(p.body)), c(p.engine, conditionClass(p.engine) === 'bad' ? 'bad' : null), c(p.subtitle),
      h('td', null, h('button', { class: 'btn ghost icon-only sm star', type: 'button', 'aria-pressed': String(fav), 'aria-label': 'نشان کردن', onclick: (e) => { e.stopPropagation(); toggleFav(p.token); } }, icon('star'))));
  });
  return h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, head), h('tbody', null, rows)));
}

function toggleFav(token) {
  if (R.favorites.has(token)) R.favorites.delete(token);
  else R.favorites.add(token);
  store.set('noja.favorites', Array.from(R.favorites));
  renderResults();
  if (overlay && overlay.token === token) openDrawer(token);
}

function toggleCompare(token) {
  if (R.compare.has(token)) R.compare.delete(token);
  else if (R.compare.size >= 4) { alert('حداکثر ۴ آگهی را می‌شود با هم مقایسه کرد.'); return; } else R.compare.add(token);
  renderResults();
  if (overlay && overlay.token === token) openDrawer(token);
}

function renderTray() {
  const box = $('#trayBox');
  if (!box) return;
  if (!R.compare.size) { box.replaceChildren(); return; }
  box.replaceChildren(h('div', { class: 'tray', role: 'region', 'aria-label': 'مقایسه' },
    icon('compare'), `${fa(R.compare.size)} آگهی برای مقایسه`,
    h('button', { class: 'btn primary sm', type: 'button', disabled: R.compare.size < 2, onclick: openCompare }, 'مقایسه کن'),
    h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { R.compare.clear(); renderResults(); } }, 'پاک کردن')));
}

// ---------- overlays (drawer + compare) ----------
let overlay = null;
function closeOverlay() {
  if (!overlay) return;
  overlay.nodes.forEach((n) => n.remove());
  document.removeEventListener('keydown', overlay.onKey);
  document.body.style.overflow = '';
  const back = overlay.returnFocus;
  overlay = null;
  if (back && back.isConnected) back.focus();
}

function openOverlay(nodes, onKey, token) {
  const returnFocus = overlay ? overlay.returnFocus : document.activeElement;
  closeOverlay();
  const keyHandler = (e) => { if (e.key === 'Escape') closeOverlay(); else if (onKey) onKey(e); };
  document.addEventListener('keydown', keyHandler);
  document.body.style.overflow = 'hidden';
  nodes.forEach((n) => document.body.append(n));
  overlay = { nodes, onKey: keyHandler, token, returnFocus };
}

function openDrawer(token) {
  const p = R.posts.find((x) => x.token === token);
  if (!p) return;
  const list = R.list || [];
  const idx = list.findIndex((x) => x.token === token);
  const go = (d) => { const n = list[idx + d]; if (n) openDrawer(n.token); };
  const imgs = (p.images || []).map(safeImg).filter(Boolean);
  let gi = 0;
  const mainImg = imgs.length ? h('img', { src: imgs[0], alt: p.title, referrerpolicy: 'no-referrer' }) : null;
  const counter = h('span', { class: 'count num' }, imgs.length ? `${fa(1)} / ${fa(imgs.length)}` : '');
  const thumbs = h('div', { class: 'thumbs' });
  const show = (i) => {
    gi = (i + imgs.length) % imgs.length;
    mainImg.src = imgs[gi];
    counter.textContent = `${fa(gi + 1)} / ${fa(imgs.length)}`;
    thumbs.querySelectorAll('button').forEach((b, j) => b.setAttribute('aria-current', String(j === gi)));
  };
  imgs.forEach((src, i) => thumbs.append(h('button', { type: 'button', 'aria-current': String(i === 0), 'aria-label': `عکس ${fa(i + 1)}`, onclick: () => show(i) },
    h('img', { src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }))));
  const d = delta(p, R.median);
  const url = safeDivarUrl(p.url);
  const fav = R.favorites.has(p.token);
  const cmp = R.compare.has(p.token);

  const specRows = [
    ['مدل', p.year ? faYear(p.year) : p.yearText], ['کارکرد', p.mileage != null ? `${fa(p.mileage)} کیلومتر` : p.mileageText],
    ['رنگ', p.color], ['گیربکس', p.gearbox], ['سوخت', p.fuel], ['برند و تیپ', p.brand],
    ['بدنه', p.body], ['موتور', p.engine], ['شاسی', p.chassis], ['بیمهٔ شخص ثالث', p.insurance], ['معاوضه', p.exchange],
  ].filter(([, v]) => v);
  const shown = new Set(['کارکرد', 'مدل (سال تولید)', 'رنگ', 'برند و تیپ', 'نوع سوخت', 'موتور', 'شاسی جلو', 'شاسی عقب', 'بدنه', 'مهلت بیمهٔ شخص ثالث', 'گیربکس', 'قیمت پایه', 'معاوضه']);
  const extra = Object.entries(p.fields || {}).filter(([k]) => !shown.has(k) && !/قیمت/.test(k));

  const scrim = h('div', { class: 'scrim', onclick: closeOverlay });
  const panel = h('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': p.title },
    h('div', { class: 'drawer-head' },
      h('button', { class: 'btn ghost icon-only', type: 'button', 'aria-label': 'بستن', onclick: closeOverlay }, icon('x')),
      h('span', { class: 'grow num' }, idx >= 0 ? `آگهی ${fa(idx + 1)} از ${fa(list.length)}` : ''),
      h('button', { class: 'btn ghost icon-only', type: 'button', 'aria-label': 'آگهی قبلی', disabled: idx <= 0, onclick: () => go(-1) }, icon('right')),
      h('button', { class: 'btn ghost icon-only', type: 'button', 'aria-label': 'آگهی بعدی', disabled: idx < 0 || idx >= list.length - 1, onclick: () => go(1) }, icon('left'))),
    h('div', { class: 'drawer-body' },
      h('div', { class: 'gallery' }, mainImg || h('div', null, icon('image', 'lg'), ' بدون عکس'),
        imgs.length > 1 ? [
          h('button', { class: 'nav prev', type: 'button', 'aria-label': 'عکس قبلی', onclick: () => show(gi - 1) }, icon('right')),
          h('button', { class: 'nav next', type: 'button', 'aria-label': 'عکس بعدی', onclick: () => show(gi + 1) }, icon('left')),
          counter] : null),
      imgs.length > 1 ? thumbs : null,
      h('div', { class: 'd-section' },
        h('h2', { class: 'd-title' }, p.title),
        p.subtitle ? h('div', { class: 'where', style: 'margin-top:4px' }, icon('pin', 'sm'), p.subtitle) : null,
        h('div', { class: 'd-price' },
          p.price ? h('div', { class: 'price num' }, formatPrice(p.price), ' ', h('small', null, 'تومان')) : h('div', { class: 'price none' }, p.priceText || 'بدون قیمت'),
          d ? h('span', { class: `delta ${d.cls}` }, d.text) : null,
          sellerBadge(p)),
        h('div', { class: 'why' }, h('b', null, `چرا «${sellerLabel(p)}»؟ `), (p.sellerReasons || []).join('، ')),
        h('h3', { class: 'd-h' }, 'مشخصات'),
        h('div', { class: 'specs' }, specRows.map(([k, v]) => {
          const c = ['بدنه', 'موتور', 'شاسی'].includes(k) ? conditionClass(v) : null;
          return h('div', { class: 'spec' }, h('div', { class: 'k' }, k), h('div', { class: `v${c ? ` ${c}` : ''}` }, v));
        }), extra.map(([k, v]) => h('div', { class: 'spec' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)))),
        p.description ? [h('h3', { class: 'd-h' }, 'توضیحات فروشنده'), h('p', { class: 'desc' }, p.description)] : null)),
    h('div', { class: 'drawer-foot' },
      url ? h('a', { class: 'btn primary', href: url, target: '_blank', rel: 'noopener' }, icon('external'), 'دیدن آگهی در دیوار') : null,
      h('button', { class: 'btn star', type: 'button', 'aria-pressed': String(fav), onclick: () => toggleFav(p.token) }, icon('star'), fav ? 'نشان شده' : 'نشان کن'),
      h('button', { class: 'btn cmp-toggle', type: 'button', 'aria-pressed': String(cmp), onclick: () => toggleCompare(p.token) }, icon('compare'), cmp ? 'در مقایسه' : 'مقایسه')));

  openOverlay([scrim, panel], (e) => {
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === 'ArrowLeft') go(1);
    else if (e.key === 'ArrowRight') go(-1);
  }, token);
  $('.drawer-head button', panel).focus();
}

function openCompare() {
  const items = Array.from(R.compare).map((t) => R.posts.find((p) => p.token === t)).filter(Boolean);
  const best = (fn, dir) => {
    const vals = items.map(fn).filter((v) => v != null);
    if (vals.length < 2 || new Set(vals).size < 2) return null;
    return dir < 0 ? Math.min(...vals) : Math.max(...vals);
  };
  const minPrice = best((p) => p.price, -1);
  const minKm = best((p) => p.mileage, -1);
  const maxYear = best((p) => p.year, 1);
  const rows = [
    ['', (p) => { const img = safeImg((p.images || [])[0]); return img ? h('img', { src: img, alt: '', referrerpolicy: 'no-referrer' }) : ''; }],
    ['عنوان', (p) => h('b', null, p.title)],
    ['قیمت', (p) => h('span', { class: p.price != null && p.price === minPrice ? 'best' : null }, p.price ? `${formatPrice(p.price)} تومان` : (p.priceText || '—'))],
    ['مدل', (p) => h('span', { class: p.year != null && p.year === maxYear ? 'best' : null }, p.year ? faYear(p.year) : '—')],
    ['کارکرد', (p) => h('span', { class: p.mileage != null && p.mileage === minKm ? 'best' : null }, p.mileage != null ? `${fa(p.mileage)} کیلومتر` : '—')],
    ['فروشنده', (p) => sellerBadge(p)],
    ['رنگ', (p) => p.color || '—'], ['گیربکس', (p) => p.gearbox || '—'],
    ['بدنه', (p) => h('span', { class: conditionClass(p.body) === 'bad' ? 'cond bad' : null }, p.body || '—')],
    ['موتور', (p) => h('span', { class: conditionClass(p.engine) === 'bad' ? 'cond bad' : null }, p.engine || '—')],
    ['شاسی', (p) => p.chassis || '—'], ['بیمه', (p) => p.insurance || '—'], ['محل', (p) => p.subtitle || '—'],
    ['', (p) => (safeDivarUrl(p.url) ? h('a', { class: 'btn sm', href: safeDivarUrl(p.url), target: '_blank', rel: 'noopener' }, icon('external', 'sm'), 'دیوار') : '')],
  ];
  const scrim = h('div', { class: 'scrim', onclick: closeOverlay });
  const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'مقایسهٔ آگهی‌ها' },
    h('div', { class: 'modal-head' }, h('h2', null, 'مقایسهٔ آگهی‌ها'),
      h('button', { class: 'btn ghost icon-only', type: 'button', 'aria-label': 'بستن', onclick: closeOverlay }, icon('x'))),
    h('div', { class: 'modal-body' }, h('table', { class: 'compare' },
      h('tbody', null, rows.map(([label, fn]) => h('tr', null, h('th', { scope: 'row' }, label), items.map((p) => h('td', null, fn(p)))))))));
  openOverlay([scrim, modal]);
  $('.modal-head button', modal).focus();
}

// ---------- CSV ----------
function exportCsv() {
  const posts = R.list || [];
  const cols = [
    ['عنوان', (p) => p.title], ['نوع فروشنده', sellerLabel], ['قیمت (تومان)', (p) => p.price ?? p.priceText],
    ['مدل', (p) => p.year ?? p.yearText], ['کارکرد', (p) => p.mileage ?? p.mileageText], ['رنگ', (p) => p.color],
    ['گیربکس', (p) => p.gearbox], ['سوخت', (p) => p.fuel], ['بدنه', (p) => p.body], ['موتور', (p) => p.engine],
    ['شاسی', (p) => p.chassis], ['بیمه', (p) => p.insurance], ['برند و تیپ', (p) => p.brand], ['معاوضه', (p) => p.exchange],
    ['زمان و محل', (p) => p.subtitle], ['لینک', (p) => p.url], ['توضیحات', (p) => p.description],
  ];
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [cols.map(([k]) => esc(k)).join(','), ...posts.map((p) => cols.map(([, fn]) => esc(fn(p))).join(','))];
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `noja-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// =========================================================
refreshApp().then(onRoute);
setInterval(() => { if (route.name === 'home') refreshApp(); }, 5000);
