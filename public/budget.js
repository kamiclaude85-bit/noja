'use strict';
/* =========================================================
   «خرید با بودجه»: a price range + the cars you like (Divar's own makes and models),
   a few more filters folded away, then the best buys — each judged against its own
   model and year.
   ========================================================= */

/** Divar's makes and models (built once from Divar's car pages: divar-models.json). */
const CATALOG = { brands: null, loading: null };
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
  const out = [];
  for (const b of CATALOG.brands || []) {
    out.push({ key: b.slug, fa: b.fa, path: b.slug, origin: b.origin || '', brand: true });
    for (const m of b.models || []) out.push({ key: `${b.slug}/${m.slug}`, fa: m.fa, path: `${b.slug}/${m.slug}`, origin: b.origin || '' });
  }
  return out;
}

// Shown before typing: popular Iranian and imported choices (only those Divar actually lists).
const POPULAR = ['peugeot/206', 'pride', 'runna', 'dena', 'samand', 'tiba', 'saipa-shahin', 'quick', 'peugeot/pars',
  'renault/megan', 'nissan/maxima-im', 'hyundai/elantra', 'kia/cerato', 'toyota/corolla'];

const BUDGET_PREF = 'radyab.budget2';
function budgetPrefs() {
  return { from: '', to: '', picks: [], origin: '', gearbox: '', personal: false, bodyOk: false, chassisOk: false, kmMax: '', ...prefs.get(BUDGET_PREF, {}) };
}

/** Divar search address for one pick (or for all cars) with the price range and filters. */
function divarBudgetUrl(path, o) {
  const city = (CITIES.find(([, n]) => n === reviewCity()) || ['tehran'])[0];
  const q = new URLSearchParams();
  q.set('price', `${o.min}-${o.max}`);
  if (!path && o.origin) q.set('brand_model_manufacturer_origin', o.origin);
  if (o.gearbox) q.set('gearbox', o.gearbox);
  if (o.personal) q.set('business-type', 'personal');
  if (o.bodyOk) q.set('body_status', 'intact');
  if (o.chassisOk) q.set('chassis_status', 'both-healthy');
  if (o.kmMax) q.set('usage', `-${o.kmMax}`);
  return `https://divar.ir/s/${city}/car${path ? `/${path}` : ''}?${q}`;
}

function renderBudget(view, params) {
  if (!CATALOG.brands) { view.replaceChildren(h('div', { class: 'page' }, h('p', { class: 'muted' }, 'در حال بارگذاری…'))); loadCatalog().then(() => render()); return; }
  const s = budgetPrefs();
  const save = (patch) => prefs.set(BUDGET_PREF, { ...s, ...patch });
  const toToman = (v) => { const n = P.parseNumber(v); return n == null ? 0 : (n < 100000 ? n * 1e6 : n); };
  const shown = params.get('go') === '1';
  const caution = params.get('view') === 'caution';
  const items = catalogItems();
  const byKey = new Map(items.map((i) => [i.key, i]));

  // ---- 1. price range ----
  const fromIn = h('input', { inputmode: 'numeric', placeholder: 'مثلاً ۱۰۰۰', value: s.from });
  const toIn = h('input', { inputmode: 'numeric', placeholder: 'مثلاً ۲۰۰۰', value: s.to });

  // ---- 2. which cars ----
  let picks = (s.picks || []).filter((k) => byKey.has(k));
  const chips = h('div', { class: 'pick-chips' });
  const sugg = h('div', { class: 'pick-sugg', role: 'listbox' });
  const search = h('input', { placeholder: 'مثلاً ۲۰۶، رانا، مگان، ماکسیما…', 'aria-label': 'جستجوی مدل' });
  const originSeg = h('div', { class: 'seg' }, [['', 'همه'], ['domestic', 'ایرانی'], ['foreign', 'وارداتی']].map(([v, t]) => h('button', {
    type: 'button', 'aria-pressed': String((s.origin || '') === v), onclick: (e) => { s.origin = v; save({ origin: v }); $$('button', originSeg).forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); },
  }, t)));
  const drawPicks = () => {
    chips.replaceChildren(...picks.map((k) => h('button', { class: 'pick-chip', type: 'button', title: 'حذف', onclick: () => { picks = picks.filter((x) => x !== k); save({ picks }); drawPicks(); drawSugg(); } },
      byKey.get(k).fa, icon('x', 'sm'))));
    originSeg.hidden = picks.length > 0; // with chosen models, «ایرانی / وارداتی» is not needed
  };
  const drawSugg = () => {
    const q = P.normalizeText(search.value);
    let list;
    if (q) {
      list = items.filter((i) => P.normalizeText(i.fa).includes(q) || i.key.includes(q)).sort((a, b) => Number(!!b.brand) - Number(!!a.brand) || a.fa.length - b.fa.length).slice(0, 8);
    } else {
      list = POPULAR.map((k) => byKey.get(k)).filter(Boolean);
    }
    list = list.filter((i) => !picks.includes(i.key));
    sugg.replaceChildren(...list.map((i) => h('button', { class: 'chip-btn', type: 'button', role: 'option', onclick: () => { picks = [...picks, i.key].slice(0, 8); save({ picks }); search.value = ''; drawPicks(); drawSugg(); search.focus(); } },
      i.brand ? h('b', null, i.fa) : i.fa, i.brand ? h('small', null, 'همهٔ مدل‌ها') : null)),
    ...(q && !list.length ? [h('span', { class: 'muted' }, 'در فهرست دیوار پیدا نشد.')] : []));
  };
  search.addEventListener('input', drawSugg);

  // ---- 3. more filters (folded) ----
  const gear = h('select', null, [['', 'فرقی نمی‌کند'], ['automatic', 'اتوماتیک'], ['manual', 'دنده‌ای']].map(([v, t]) => h('option', { value: v, selected: s.gearbox === v }, t)));
  const personal = h('input', { type: 'checkbox', checked: !!s.personal });
  const bodyOk = h('input', { type: 'checkbox', checked: !!s.bodyOk });
  const chassisOk = h('input', { type: 'checkbox', checked: !!s.chassisOk });
  const km = h('input', { inputmode: 'numeric', placeholder: 'مثلاً ۱۵۰٬۰۰۰', value: s.kmMax });
  const nMore = [s.gearbox, s.personal, s.bodyOk, s.chassisOk, s.kmMax].filter(Boolean).length;
  const more = h('details', { class: 'adv', open: nMore > 0 },
    h('summary', null, icon('sliders', 'sm'), nMore ? `فیلترهای بیشتر (${fa(nMore)})` : 'فیلترهای بیشتر', icon('down', 'sm')),
    h('div', { class: 'adv-grid' },
      h('label', { class: 'field' }, h('span', null, 'گیربکس'), gear),
      h('label', { class: 'field' }, h('span', null, 'حداکثر کارکرد (کیلومتر)'), km),
      h('label', { class: 'check wide' }, personal, 'فقط فروشندهٔ شخصی'),
      h('label', { class: 'check wide' }, bodyOk, 'بدنهٔ سالم و بی‌رنگ'),
      h('label', { class: 'check wide' }, chassisOk, 'شاسی‌ها سالم و پلمب')));

  const err = h('p', { class: 'form-error', role: 'alert' });
  const form = h('form', { class: 'search-card budget-form', autocomplete: 'off' },
    h('div', { class: 'field-label' }, 'بودجه (میلیون تومان)'),
    h('div', { class: 'search-row two' },
      h('label', { class: 'field' }, h('span', null, 'از'), fromIn),
      h('label', { class: 'field' }, h('span', null, 'تا'), toIn)),
    h('div', { class: 'field-label' }, 'چه ماشین‌هایی؟', h('small', null, ' (خالی بگذارید یعنی همه)')),
    chips, h('label', { class: 'pick-search' }, icon('search'), search), sugg, originSeg,
    more,
    h('div', { class: 'form-actions' },
      h('button', { class: 'btn primary lg', type: 'submit' }, icon('flame'), 'بهترین‌ها را نشان بده')),
    err);
  const readForm = () => {
    const o = { from: fromIn.value.trim(), to: toIn.value.trim(), picks, origin: s.origin || '', gearbox: gear.value, personal: personal.checked, bodyOk: bodyOk.checked, chassisOk: chassisOk.checked, kmMax: km.value.trim() };
    save(o);
    return o;
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const o = readForm();
    const min = toToman(o.from); const max = toToman(o.to);
    if (!max) { err.textContent = 'سقف بودجه («تا») را بنویسید.'; toIn.focus(); return; }
    if (min && min > max) { err.textContent = '«از» بیشتر از «تا» است.'; return; }
    location.hash = '#/budget?go=1';
  });
  drawPicks();
  drawSugg();

  const head = pageHead('خرید با بودجه', 'هر ماشین فقط با هم‌مدل و هم‌سال خودش مقایسه می‌شود؛ بعد سلامت، کارکرد، امکانات و نوع فروشنده.',
    [citySelect(() => { App.computeGuide(); render(); }), periodSelect(() => { App.computeGuide(); render(); })]);
  const min = toToman(s.from); const max = toToman(s.to);
  if (!shown || !max) { view.replaceChildren(h('div', { class: 'page' }, head, form)); return; }

  // ---- results from the ads already read ----
  const pickItems = picks.map((k) => byKey.get(k));
  const wanted = (p) => {
    if (!pickItems.length) return true;
    const name = P.normalizeText(`${p.brand || ''} ${p.title || ''}`);
    return pickItems.some((i) => name.includes(P.normalizeText(i.fa.replace(/^(?:خودرو\s*)/, ''))));
  };
  const kmMax = P.parseNumber(s.kmMax);
  const posts = allAds().filter((a) => inCity(a) && inPeriod(a) && stageOf(a) !== 'rejected').map((a) => ({ ...a.post, removed: a.removed }))
    .filter(wanted)
    .filter((p) => pickItems.length || !s.origin || !p.year || (s.origin === 'foreign' ? p.year > 1900 : p.year < 1700))
    .filter((p) => !s.gearbox || !p.gearbox || (s.gearbox === 'automatic' ? /اتومات/.test(p.gearbox) : /دنده/.test(p.gearbox)))
    .filter((p) => !s.bodyOk || conditionClass(p.body) === 'good')
    .filter((p) => !s.chassisOk || !/ضرب|تصادف|تعویض/.test(p.chassis || ''));
  const r = NojaDeals.budgetPicks(posts, App.guide, { min, max, personalOnly: !!s.personal, kmMax: kmMax || null });
  const good = r.picks.filter((x) => !x.caution);
  const bad = r.picks.filter((x) => x.caution);
  const byToken = new Map(r.picks.map((x) => [x.token, x]));
  const batchId = () => Math.random().toString(36).slice(2, 10);
  const searchDivar = async () => {
    const o = { min, max, origin: s.origin, gearbox: s.gearbox, personal: s.personal, bodyOk: s.bodyOk, chassisOk: s.chassisOk, kmMax: kmMax || null };
    const batch = batchId();
    const paths = pickItems.length ? pickItems.map((i) => i.path) : [''];
    const items = paths.map((p) => ({ searchUrl: divarBudgetUrl(p, o), city: budgetCity(), maxAgeDays: reviewPeriod(), maxAds: pickItems.length ? 50 : 100,
      speed: 'slow', batch, budget: { min, max, personalOnly: !!s.personal } }));
    try {
      await api('/api/scan-batch', { method: 'POST', body: { items } });
      toast(items.length > 1 ? `${fa(items.length)} جستجو در نوبت ربات گذاشته شد.` : 'جستجو در دیوار شروع شد.');
      await App.refreshState();
      location.hash = '#/runs';
    } catch (e) { toast(e.message, 'err'); }
  };
  const gatherMissing = async () => {
    const batch = batchId();
    const list = r.missing.filter((m) => m.year && m.label !== 'نامشخص').slice(0, 6).map((m) => {
      const ys = m.year > 1900 ? [m.year - 622, m.year - 621] : [m.year, m.year];
      return { query: m.label, yearMin: ys[0], yearMax: ys[1], city: budgetCity(), maxAgeDays: reviewPeriod(), maxAds: 40, speed: 'slow', batch };
    });
    try { await api('/api/scan-batch', { method: 'POST', body: { items: list } }); toast(`${fa(list.length)} جستجوی هم‌مدل در نوبت ربات گذاشته شد.`); await App.refreshState(); location.hash = '#/runs'; } catch (e) { toast(e.message, 'err'); }
  };

  const what = pickItems.length ? pickItems.map((i) => i.fa).join('، ') : ({ domestic: 'ماشین‌های ایرانی', foreign: 'ماشین‌های وارداتی' }[s.origin] || 'همهٔ ماشین‌ها');
  const summary = h('div', { class: 'budget-summary' },
    h('div', { class: 'grow' },
      h('b', null, `${formatPrice(min || 0)} تا ${formatPrice(max)} · ${what}`),
      h('small', null, r.total ? `${fa(r.total)} آگهی در حافظه؛ ${fa(r.picks.length)} تا با هم‌مدل‌هایشان مقایسه شدند.` : 'هنوز آگهی‌ای از این‌ها در حافظه نیست.')),
    h('a', { class: 'btn sm', href: '#/budget' }, icon('sliders', 'sm'), 'تغییر'),
    h('button', { class: 'btn sm primary', type: 'button', onclick: searchDivar }, icon('search', 'sm'), 'جستجو در دیوار'));
  const missing = r.missing.length ? h('div', { class: 'notice' }, icon('alert'), h('div', { class: 'grow' },
    h('b', null, 'هم‌مدل کافی برای مقایسه ندارند: '),
    r.missing.slice(0, 6).map((m, i) => [i ? '، ' : '', h('bdi', null, `${m.label}${m.year ? ` ${faYear(m.year)}` : ''}`), ` (${fa(m.count)})`])),
    h('button', { class: 'btn sm', type: 'button', onclick: gatherMissing }, icon('refresh', 'sm'), 'جمع‌آوری هم‌مدل‌ها')) : null;
  const nav = (patch) => { const q = new URLSearchParams({ go: '1', ...(caution ? { view: 'caution' } : {}), ...patch }); for (const [k, v] of Array.from(q.entries())) if (!v) q.delete(k); location.hash = `#/budget?${q}`; };
  const tabs = h('div', { class: 'stage-tabs', role: 'tablist' },
    h('button', { role: 'tab', type: 'button', 'aria-selected': String(!caution), onclick: () => nav({ view: '' }) }, icon('flame', 'sm'), 'بهترین خریدها', h('small', { class: 'num' }, fa(good.length))),
    h('button', { role: 'tab', type: 'button', 'aria-selected': String(caution), onclick: () => nav({ view: 'caution' }) }, icon('alert', 'sm'), 'با احتیاط', h('small', { class: 'num' }, fa(bad.length))));

  const box = h('div');
  view.replaceChildren(h('div', { class: 'page wide' }, head, summary, missing, tabs, box));
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
    emptyText: '«جستجو در دیوار» را بزنید؛ ربات آگهی‌های همین ماشین‌ها در این بازهٔ قیمت را جمع می‌کند.',
  });
  B.sort = 'default';
  renderResults();
}
