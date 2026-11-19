'use strict';
/* =========================================================
   «جستجوی ماشین»: one form for finding cars — which cars (Divar's own makes and models),
   budget, model year, mileage, a few more filters folded away. From it the bot can be sent
   to Divar, or the best buys among the ads already read are shown — each judged against
   its own model and year.
   ========================================================= */

/** Divar's makes and models (built once from Divar's car pages: divar-models.json). */
const CATALOG = { brands: null, loading: null, items: null, models: null };
function loadCatalog() {
  if (CATALOG.brands) return Promise.resolve(CATALOG.brands);
  if (!CATALOG.loading) {
    CATALOG.loading = fetch('divar-models.json').then((r) => r.json()).then((j) => { CATALOG.brands = j.brands || []; return CATALOG.brands; })
      .catch(() => { CATALOG.brands = []; return CATALOG.brands; });
  }
  return CATALOG.loading;
}

/** Everything you can pick: a whole make («رانا») or one model («پژو 206»). */
function catalogItems() {
  if (CATALOG.items) return CATALOG.items;
  const out = [];
  for (const b of CATALOG.brands || []) {
    out.push({ key: b.slug, fa: b.fa, path: b.slug, origin: b.origin || '', brand: true });
    for (const m of b.models || []) out.push({ key: `${b.slug}/${m.slug}`, fa: m.fa, path: `${b.slug}/${m.slug}`, origin: b.origin || '' });
  }
  if (CATALOG.brands) CATALOG.items = out;
  return out;
}

/**
 * Divar's models, grouped the way ads are grouped here («نیسان پاترول 2 در» and «… 4 در» are both
 * «نیسان پاترول»): Map of model key → { key, label, names } (names: every Divar name of it, for searching).
 */
function catalogModels() {
  if (CATALOG.models) return CATALOG.models;
  const out = new Map();
  for (const b of CATALOG.brands || []) {
    for (const x of (b.models && b.models.length ? b.models : [b])) {
      const m = P.modelOf({ brand: x.fa });
      if (!m.key) continue;
      const e = out.get(m.key) || { key: m.key, label: m.label, names: '' };
      e.names += ` ${P.normalizeText(x.fa)}`;
      out.set(m.key, e);
    }
  }
  return (CATALOG.models = out);
}

// Shown before typing: popular Iranian and imported choices (only those Divar actually lists).
const POPULAR = ['peugeot/206', 'pride', 'runna', 'dena', 'samand', 'tiba', 'saipa-shahin', 'quick', 'peugeot/pars',
  'renault/megan', 'nissan/maxima-im', 'hyundai/elantra', 'kia/cerato', 'toyota/corolla'];

const BUDGET_PREF = 'radyab.budget2';
let BUDGET_TYPED = ''; // words in the model box, kept while the page redraws itself
function budgetPrefs() {
  return { from: '', to: '', picks: [], origin: '', yearMin: '', yearMax: '', gearbox: '', personal: false, bodyOk: false, chassisOk: false, kmMax: '',
    speed: 'slow', maxAds: '100', link: '', ...prefs.get(BUDGET_PREF, {}) };
}

/** Divar search address for one pick (or for all cars) with the limits and filters. */
function divarBudgetUrl(path, o) {
  const q = new URLSearchParams();
  if (o.q) q.set('q', o.q);
  if (o.min || o.max) q.set('price', `${o.min || ''}-${o.max || ''}`);
  if (o.yearMin || o.yearMax) q.set('production-year', `${o.yearMin || ''}-${o.yearMax || ''}`);
  if (o.kmMax) q.set('usage', `-${o.kmMax}`);
  if (!path && o.origin) q.set('brand_model_manufacturer_origin', o.origin);
  if (o.gearbox) q.set('gearbox', o.gearbox);
  if (o.personal) q.set('business-type', 'personal');
  if (o.bodyOk) q.set('body_status', 'intact');
  if (o.chassisOk) q.set('chassis_status', 'both-healthy');
  const qs = q.toString();
  return `https://divar.ir/s/${budgetCity()}/car${path ? `/${path}` : ''}${qs ? `?${qs}` : ''}`;
}

/** What the bot is doing right now, when it matters for starting a search. */
function searchNotices() {
  const out = [];
  if (App.state.busy) {
    out.push(h('div', { class: 'notice' }, icon('loader'), h('div', { class: 'grow' }, 'ربات در حال یک جستجوی دیگر است؛ جستجوی تازه در نوبت می‌ماند.'),
      h('a', { class: 'btn sm', href: `#/run/${encodeURIComponent(App.state.busy)}` }, 'دیدن پیشرفت')));
  }
  if (App.host && !App.bot.online) {
    out.push(h('div', { class: 'notice' }, icon('clock'),
      h('div', { class: 'grow' }, h('b', null, 'کامپیوتر خاموش است. '), 'جستجو در صف می‌ماند و با روشن شدن ربات شروع می‌شود.')));
  }
  if (App.state.loggedIn === false && !App.offline && !App.host) {
    out.push(h('div', { class: 'notice' }, icon('login'),
      h('div', { class: 'grow' }, h('b', null, 'یک بار وارد حساب دیوار شوید. '), 'می‌توانید همین حالا جستجو را شروع کنید؛ ربات صبر می‌کند تا وارد شوید.'),
      h('button', { class: 'btn sm', type: 'button', onclick: () => api('/api/login', { method: 'POST' }).catch(() => {}) }, 'ورود به دیوار')));
  }
  return out;
}

function renderBudget(view, params) {
  if (!CATALOG.brands) { view.replaceChildren(h('div', { class: 'page' }, h('p', { class: 'muted' }, 'در حال بارگذاری…'))); loadCatalog().then(() => render()); return; }
  const s = budgetPrefs();
  const save = (patch) => { Object.assign(s, patch); prefs.set(BUDGET_PREF, s); };
  // Prices are typed in millions; a big number is taken as toman.
  const toToman = (v) => { const n = P.parseNumber(v); return n == null ? 0 : (n < 100000 ? n * 1e6 : n); };
  // Years as Divar filters them: Persian («۹۸» → 1398; a Western year → its Persian one).
  const toYear = (v) => { const n = P.normalizeYear(v); return n ? P.shamsiYear(n) : null; };
  const shown = params.get('go') === '1';
  const caution = params.get('view') === 'caution';
  const items = catalogItems();
  const byKey = new Map(items.map((i) => [i.key, i]));

  // ---- 1. which cars ----
  // A pick is one of Divar's makes or models, or just the words typed («پاترول»: every ad that says so).
  const pickOf = (k) => byKey.get(k) || (/^t:./.test(k) ? { key: k, fa: k.slice(2), text: true } : null);
  const matching = (q) => items.filter((i) => P.normalizeText(i.fa).includes(q) || i.key.includes(q)).sort((a, b) => Number(!!b.brand) - Number(!!a.brand) || a.fa.length - b.fa.length);
  let picks = (s.picks || []).filter(pickOf);
  const chips = h('div', { class: 'pick-chips' });
  const sugg = h('div', { class: 'pick-sugg', role: 'listbox' });
  const search = h('input', { placeholder: 'مثلاً ۲۰۶، رانا، مگان، ماکسیما…', 'aria-label': 'جستجوی مدل', value: BUDGET_TYPED });
  const originSeg = h('div', { class: 'seg' }, [['', 'همه'], ['domestic', 'ایرانی'], ['foreign', 'وارداتی']].map(([v, t]) => h('button', {
    type: 'button', 'aria-pressed': String((s.origin || '') === v), onclick: (e) => { save({ origin: v }); $$('button', originSeg).forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); },
  }, t)));
  const drawPicks = () => {
    chips.replaceChildren(...picks.map((k) => h('button', { class: 'pick-chip', type: 'button', title: 'حذف', onclick: () => { picks = picks.filter((x) => x !== k); save({ picks }); drawPicks(); drawSugg(); } },
      pickOf(k).fa, icon('x', 'sm'))));
    originSeg.hidden = picks.length > 0; // with chosen models, «ایرانی / وارداتی» is not needed
  };
  const addPick = (key) => { if (!picks.includes(key)) picks = [...picks, key].slice(0, 8); save({ picks }); search.value = ''; BUDGET_TYPED = ''; drawPicks(); drawSugg(); };
  // Words typed but no suggestion tapped still count: the one model they name, else the words themselves.
  const takeTyped = () => {
    const text = search.value.replace(/\s+/g, ' ').trim();
    const q = P.normalizeText(text);
    if (!q) return;
    const list = matching(q);
    const one = list.find((i) => P.normalizeText(i.fa) === q) || (list.length === 1 ? list[0] : null);
    addPick(one ? one.key : `t:${text}`);
  };
  const drawSugg = () => {
    const q = P.normalizeText(search.value);
    let list;
    if (q) {
      list = matching(q).slice(0, 8);
    } else {
      // Nothing typed: a few popular ones to start from — not once a car has been chosen.
      list = picks.length ? [] : POPULAR.slice(0, 8).map((k) => byKey.get(k)).filter(Boolean);
    }
    list = list.filter((i) => !picks.includes(i.key));
    const all = q && list.length > 1 && !picks.includes(`t:${search.value.trim()}`) ? [h('button', { class: 'chip-btn', type: 'button', role: 'option', onclick: () => { takeTyped(); search.focus(); } }, h('b', null, `همهٔ «${search.value.trim()}»ها`))] : [];
    sugg.replaceChildren(...all, ...list.map((i) => h('button', { class: 'chip-btn', type: 'button', role: 'option', onclick: () => { addPick(i.key); search.focus(); } },
      i.brand ? h('b', null, i.fa) : i.fa, i.brand ? h('small', null, 'همهٔ مدل‌ها') : null)),
    ...(q && !list.length ? [h('span', { class: 'muted' }, 'در فهرست دیوار نیست؛ با همین نوشته جستجو می‌شود.')] : []));
  };
  search.addEventListener('input', drawSugg);
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter' && search.value.trim()) { e.preventDefault(); takeTyped(); } });

  // ---- 2. budget, model year, mileage ----
  const fromIn = h('input', { inputmode: 'numeric', placeholder: 'مثلاً ۱۰۰۰', value: s.from });
  const toIn = h('input', { inputmode: 'numeric', placeholder: 'مثلاً ۲۰۰۰', value: s.to });
  const yMinIn = h('input', { inputmode: 'numeric', placeholder: 'مثلاً ۹۵', value: s.yearMin });
  const yMaxIn = h('input', { inputmode: 'numeric', placeholder: 'مثلاً ۱۴۰۲', value: s.yearMax });
  const km = h('input', { inputmode: 'numeric', placeholder: 'مثلاً ۱۵۰٬۰۰۰', value: s.kmMax });

  // ---- 3. more filters (folded) ----
  const gear = h('select', null, [['', 'فرقی نمی‌کند'], ['automatic', 'اتوماتیک'], ['manual', 'دنده‌ای']].map(([v, t]) => h('option', { value: v, selected: s.gearbox === v }, t)));
  const personal = h('input', { type: 'checkbox', checked: !!s.personal });
  const bodyOk = h('input', { type: 'checkbox', checked: !!s.bodyOk });
  const chassisOk = h('input', { type: 'checkbox', checked: !!s.chassisOk });
  const nMore = [s.gearbox, s.personal, s.bodyOk, s.chassisOk].filter(Boolean).length;
  const more = h('details', { class: 'adv', open: nMore > 0 },
    h('summary', null, icon('sliders', 'sm'), nMore ? `فیلترهای بیشتر (${fa(nMore)})` : 'فیلترهای بیشتر', icon('down', 'sm')),
    h('div', { class: 'adv-grid' },
      h('label', { class: 'field' }, h('span', null, 'گیربکس'), gear),
      h('label', { class: 'check wide' }, personal, 'فقط فروشندهٔ شخصی'),
      h('label', { class: 'check wide' }, bodyOk, 'بدنهٔ سالم و بی‌رنگ'),
      h('label', { class: 'check wide' }, chassisOk, 'شاسی‌ها سالم و پلمب')));

  // ---- 4. how the bot works (folded) ----
  const speed = h('select', null, [['slow', 'آهسته — طبیعی‌ترین رفتار'], ['normal', 'معمولی'], ['fast', 'سریع']].map(([v, t]) => h('option', { value: v, selected: (s.speed || 'slow') === v }, t)));
  const maxAds = h('input', { inputmode: 'numeric', value: s.maxAds });
  const link = h('input', { dir: 'ltr', placeholder: 'https://divar.ir/s/tehran/car/…', value: s.link });
  const recheck = h('input', { type: 'checkbox' });
  const bot = h('details', { class: 'adv', open: !!s.link },
    h('summary', null, icon('gear', 'sm'), 'تنظیمات ربات', icon('down', 'sm')),
    h('div', { class: 'adv-grid' },
      h('label', { class: 'field' }, h('span', null, 'سرعت ربات'), speed),
      h('label', { class: 'field' }, h('span', null, 'حداکثر آگهی جدید در هر جستجو'), maxAds,
        h('span', { class: 'help' }, `امروز ${fa(App.state.today || 0)} آگهی باز شده`)),
      h('label', { class: 'field wide' }, h('span', null, 'یا لینک یک جستجوی آماده در دیوار'), link,
        h('span', { class: 'help' }, 'اگر خودتان در دیوار فیلتر کرده‌اید، لینک صفحه را اینجا بگذارید؛ به‌جای انتخاب‌های بالا همین جستجو می‌شود.')),
      h('label', { class: 'check wide' }, recheck, 'این بار همهٔ آگهی‌ها دوباره باز شوند (کندتر؛ معمولاً لازم نیست)')));

  const err = h('p', { class: 'form-error', role: 'alert' });
  const goBtn = h('button', { class: 'btn primary lg', type: 'submit' }, icon('search'), 'جستجو در دیوار');
  const showBtn = h('button', { class: 'btn lg', type: 'button' }, icon('flame'), 'بهترین‌های خوانده‌شده');
  const form = h('form', { class: 'search-card budget-form', autocomplete: 'off', novalidate: true },
    h('div', { class: 'field-label' }, 'چه ماشینی؟', h('small', null, ' (خالی بگذارید یعنی همه)')),
    chips, h('label', { class: 'pick-search' }, icon('search'), search), sugg, originSeg,
    h('div', { class: 'field-label' }, 'بودجه (میلیون تومان)'),
    h('div', { class: 'search-row two' },
      h('label', { class: 'field' }, h('span', null, 'از'), fromIn),
      h('label', { class: 'field' }, h('span', null, 'تا'), toIn)),
    h('div', { class: 'search-row' },
      h('label', { class: 'field' }, h('span', null, 'مدل از سال'), yMinIn),
      h('label', { class: 'field' }, h('span', null, 'تا سال'), yMaxIn),
      h('label', { class: 'field' }, h('span', null, 'حداکثر کارکرد (کیلومتر)'), km)),
    more, bot,
    h('div', { class: 'form-actions' }, goBtn, showBtn),
    err);
  // What is typed stays, even if the page redraws itself before a button is pressed.
  const keep = () => {
    BUDGET_TYPED = search.value;
    save({ from: fromIn.value.trim(), to: toIn.value.trim(), yearMin: yMinIn.value.trim(), yearMax: yMaxIn.value.trim(), kmMax: km.value.trim(),
      gearbox: gear.value, personal: personal.checked, bodyOk: bodyOk.checked, chassisOk: chassisOk.checked,
      speed: speed.value, maxAds: maxAds.value.trim(), link: link.value.trim() });
  };
  form.addEventListener('input', keep);
  form.addEventListener('change', keep);

  // ---- the limits, as numbers ----
  const limits = () => {
    const min = toToman(s.from); const max = toToman(s.to);
    const yMin = toYear(s.yearMin); const yMax = toYear(s.yearMax);
    return { min, max, yMin, yMax, kmMax: P.parseNumber(s.kmMax) || null };
  };
  const check = () => {
    takeTyped();
    keep();
    err.textContent = '';
    const L = limits();
    if (L.min && L.max && L.min > L.max) { err.textContent = 'بودجهٔ «از» بیشتر از «تا» است.'; return null; }
    if (L.yMin && L.yMax && L.yMin > L.yMax) { err.textContent = 'سال «از» بیشتر از «تا» است.'; return null; }
    return L;
  };

  // ---- send the bot to Divar ----
  const pickItems = () => picks.map(pickOf);
  // Where on Divar a pick is searched: its own page; typed words → the models they name, else Divar's text search.
  const divarTargets = (i) => {
    if (!i.text) return [{ path: i.path, name: i.fa }];
    const list = matching(P.normalizeText(i.fa));
    const models = list.filter((x) => !x.brand);
    const found = (models.length ? models : list).slice(0, 4).map((x) => ({ path: x.path, name: x.fa }));
    return found.length ? found : [{ path: '', q: i.fa, name: i.fa }];
  };
  const searchDivar = async (L, btn) => {
    const o = { min: L.min, max: L.max, yearMin: L.yMin, yearMax: L.yMax, kmMax: L.kmMax, origin: s.origin, gearbox: s.gearbox, personal: s.personal, bodyOk: s.bodyOk, chassisOk: s.chassisOk };
    const base = { city: budgetCity(), maxAgeDays: reviewPeriod(), maxAds: P.parseNumber(s.maxAds) || 100, speed: s.speed || 'slow', recheckAll: recheck.checked,
      priceMin: L.min || null, priceMax: L.max || null, yearMin: L.yMin, yearMax: L.yMax, mileageMax: L.kmMax };
    let list;
    if (s.link) {
      if (!/^https:\/\/([a-z0-9-]+\.)?divar\.ir\/s\//.test(s.link)) { err.textContent = 'لینک باید نشانی یک صفحهٔ جستجوی دیوار باشد (divar.ir/s/…).'; return; }
      // A ready-made Divar search: its own filters are the limits.
      list = [{ city: base.city, maxAgeDays: base.maxAgeDays, maxAds: base.maxAds, speed: base.speed, recheckAll: base.recheckAll, searchUrl: s.link }];
    } else {
      const seen = new Set();
      const picked = pickItems();
      if (!picked.length && !L.min && !L.max) { err.textContent = 'ماشین یا بودجه را مشخص کنید.'; search.focus(); return; }
      const targets = (picked.length ? picked.flatMap(divarTargets) : [{ path: '', name: '' }]).filter((t) => !seen.has(t.path + (t.q || '')) && seen.add(t.path + (t.q || ''))).slice(0, 12);
      list = targets.map((t) => ({ ...base, query: t.name, searchUrl: divarBudgetUrl(t.path, { ...o, q: t.q }) }));
    }
    const label = btn.textContent;
    btn.disabled = true;
    const queue = async () => {
      const batch = list.length > 1 ? Math.random().toString(36).slice(2, 10) : '';
      await api('/api/scan-batch', { method: 'POST', body: { items: list.map((x) => ({ ...x, batch })) } });
      toast(list.length > 1 ? `${fa(list.length)} جستجو در نوبت ربات گذاشته شد.` : 'جستجو در نوبت ربات گذاشته شد.');
      await App.refreshState();
      location.hash = '#/runs';
    };
    try {
      if (list.length === 1 && !App.state.busy) await startScan(list[0]);
      else await queue();
    } catch (e) {
      // The bot turned out to be busy: line the search up instead.
      if (e.body && e.body.id) { try { await queue(); return; } catch (e2) { err.textContent = e2.message; } } else err.textContent = e.message;
      toast(err.textContent, 'err');
      btn.disabled = false;
      btn.textContent = label;
    }
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); const L = check(); if (L) searchDivar(L, goBtn); });
  showBtn.addEventListener('click', () => { if (check()) location.hash = '#/search?go=1'; });
  drawPicks();
  drawSugg();

  const head = pageHead('جستجوی ماشین', 'ماشین و محدوده‌ات را بگو؛ ربات از دیوار جمع می‌کند و بهترین‌ها را با هم‌مدل و هم‌سال خودشان می‌سنجد.',
    [citySelect(() => { App.computeGuide(); render(); }), periodSelect(() => { App.computeGuide(); render(); })]);
  if (!shown) { view.replaceChildren(h('div', { class: 'page narrow' }, head, form, ...searchNotices())); return; }

  // ---- the best buys among the ads already read ----
  const L = limits();
  const picked = pickItems();
  const wanted = (p) => {
    if (!picked.length) return true;
    const name = P.normalizeText(`${p.brand || ''} ${p.title || ''}`);
    return picked.some((i) => (i.text ? P.normalizeText(i.fa).split(' ').every((w) => name.includes(w)) : false) || name.includes(P.normalizeText(i.fa.replace(/^(?:خودرو\s*)/, ''))));
  };
  const posts = allAds().filter((a) => inCity(a) && inPeriod(a) && stageOf(a) !== 'rejected').map((a) => ({ ...a.post, removed: a.removed }))
    .filter(wanted)
    .filter((p) => picked.length || !s.origin || !p.year || (s.origin === 'foreign' ? p.year > 1900 : p.year < 1700))
    .filter((p) => p.year == null || P.yearInRange(p.year, L.yMin, L.yMax))
    .filter((p) => !s.gearbox || !p.gearbox || (s.gearbox === 'automatic' ? /اتومات/.test(p.gearbox) : /دنده/.test(p.gearbox)))
    .filter((p) => !s.bodyOk || bodyClean(p))
    .filter((p) => !s.chassisOk || !/ضرب|تصادف|تعویض/.test(p.chassis || ''));
  const r = NojaDeals.budgetPicks(posts, App.deals, { min: L.min, max: L.max || Infinity, personalOnly: !!s.personal, kmMax: L.kmMax });
  const good = r.picks.filter((x) => !x.caution);
  const bad = r.picks.filter((x) => x.caution);
  const byToken = new Map(r.picks.map((x) => [x.token, x]));
  const gatherMissing = async () => {
    const batch = Math.random().toString(36).slice(2, 10);
    const list = r.missing.filter((m) => m.year && m.label !== 'نامشخص').slice(0, 6).map((m) => {
      const ys = m.year > 1900 ? [m.year - 622, m.year - 621] : [m.year, m.year];
      return { query: m.label, yearMin: ys[0], yearMax: ys[1], city: budgetCity(), maxAgeDays: reviewPeriod(), maxAds: 40, speed: 'slow', batch };
    });
    try { await api('/api/scan-batch', { method: 'POST', body: { items: list } }); toast(`${fa(list.length)} جستجوی هم‌مدل در نوبت ربات گذاشته شد.`); await App.refreshState(); location.hash = '#/runs'; } catch (e) { toast(e.message, 'err'); }
  };

  const what = picked.length ? picked.map((i) => i.fa).join('، ') : ({ domestic: 'ماشین‌های ایرانی', foreign: 'ماشین‌های وارداتی' }[s.origin] || 'همهٔ ماشین‌ها');
  const bits = [what];
  if (L.min || L.max) bits.push(L.min && L.max ? `${formatPrice(L.min)} تا ${formatPrice(L.max)}` : L.min ? `از ${formatPrice(L.min)}` : `تا ${formatPrice(L.max)}`);
  if (L.yMin || L.yMax) bits.push(L.yMin === L.yMax ? `مدل ${faYear(L.yMin)}` : `مدل ${L.yMin ? faYear(L.yMin) : '…'} تا ${L.yMax ? faYear(L.yMax) : '…'}`);
  if (L.kmMax) bits.push(`تا ${fa(Math.round(L.kmMax / 1000))} هزار کیلومتر`);
  const divarBtn = h('button', { class: 'btn sm primary', type: 'button', onclick: () => searchDivar(L, divarBtn) }, icon('search', 'sm'), 'جستجو در دیوار');
  const summary = h('div', { class: 'budget-summary' },
    h('div', { class: 'grow' },
      h('b', null, bits.join(' · ')),
      h('small', null, r.total ? `${fa(r.total)} آگهی در حافظه؛ ${fa(r.picks.length)} تا با هم‌مدل‌هایشان مقایسه شدند.` : 'هنوز آگهی‌ای از این‌ها در حافظه نیست.')),
    h('a', { class: 'btn sm', href: '#/search' }, icon('sliders', 'sm'), 'تغییر'),
    divarBtn);
  const missing = r.missing.length ? h('div', { class: 'notice' }, icon('alert'), h('div', { class: 'grow' },
    h('b', null, 'هم‌مدل کافی برای مقایسه ندارند: '),
    r.missing.slice(0, 6).map((m, i) => [i ? '، ' : '', h('bdi', null, `${m.label}${m.year ? ` ${faYear(m.year)}` : ''}`), ` (${fa(m.count)})`])),
    h('button', { class: 'btn sm', type: 'button', onclick: gatherMissing }, icon('refresh', 'sm'), 'جمع‌آوری هم‌مدل‌ها')) : null;
  const nav = (patch) => { const q = new URLSearchParams({ go: '1', ...(caution ? { view: 'caution' } : {}), ...patch }); for (const [k, v] of Array.from(q.entries())) if (!v) q.delete(k); location.hash = `#/search?${q}`; };
  const tabs = h('div', { class: 'stage-tabs', role: 'tablist' },
    h('button', { role: 'tab', type: 'button', 'aria-selected': String(!caution), onclick: () => nav({ view: '' }) }, icon('flame', 'sm'), 'بهترین خریدها', h('small', { class: 'num' }, fa(good.length))),
    h('button', { role: 'tab', type: 'button', 'aria-selected': String(caution), onclick: () => nav({ view: 'caution' }) }, icon('alert', 'sm'), 'با احتیاط', h('small', { class: 'num' }, fa(bad.length))));

  const box = h('div');
  view.replaceChildren(h('div', { class: 'page wide' }, head, summary, err, missing, tabs, box));
  const list = caution ? bad : good;
  mountBrowser({
    root: box,
    key: 'budget',
    criteria: {},
    getPosts: () => list.map((x, i) => ({ ...x.post, isNew: false, priceChange: null, order: i })),
    rowNote: (p) => {
      const x = byToken.get(p.token);
      if (!x) return null;
      return h('div', { class: 'why-row' },
        h('span', { class: 'rank num' }, fa(list.indexOf(x) + 1)),
        h('span', { class: 'why-good' }, x.reasons.slice(0, 3).join(' · ')),
        x.warnings.length ? h('span', { class: 'why-bad' }, x.warnings.slice(0, 2).join(' · ')) : null);
    },
    title: (n) => `${caution ? 'با احتیاط' : 'بهترین خریدها'} — ${fa(n)} آگهی`,
    emptyTitle: r.total ? 'آگهی قابل مقایسه‌ای نیست' : 'هنوز آگهی‌ای نیست',
    emptyText: '«جستجو در دیوار» را بزنید؛ ربات آگهی‌های همین ماشین‌ها در این محدوده را جمع می‌کند.',
  });
  B.sort = 'default';
  renderResults();
}
