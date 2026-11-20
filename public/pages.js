'use strict';
/* =========================================================
   Pages: dashboard, ads (follow-up), search, runs, live run, backup
   ========================================================= */

function pageHead(title, sub, actions) {
  // The page title is already in the top bar; here only the description and actions.
  void title;
  return h('div', { class: 'page-head' },
    h('div', null, sub ? h('p', { class: 'muted' }, sub) : null),
    actions ? h('div', { class: 'page-actions' }, actions) : null);
}

function allAds() { return Array.from(App.ads.values()); }

/** Start a search again (only new ads will be opened). */
async function rerunSearch(criteria) {
  try {
    await startScan({ ...criteria, recheckAll: false, auto: false });
  } catch (e) {
    if (e.body && e.body.id) location.hash = `#/run/${e.body.id}`;
    else toast(e.message, 'err');
  }
}

// =========================================================
// Dashboard
// =========================================================
function renderDashboard(view) {
  const ads = allAds().map((a) => ({ a, f: adFlags(a) }));
  const live = ads.filter((x) => !x.f.sold);
  const newToday = ads.filter((x) => x.f.isNewToday).length;
  const unreviewed = live.filter((x) => x.f.stage === 'new').length;
  const calls = live.filter((x) => x.f.callToday && !['bought', 'rejected'].includes(x.f.stage))
    .sort((x, y) => x.a.crm.nextCallAt - y.a.crm.nextCallAt);
  const due = calls.filter((x) => x.f.callDue).length;
  const visits = ads.filter((x) => x.f.stage === 'visit' && x.a.crm && x.a.crm.visitAt).sort((x, y) => x.a.crm.visitAt - y.a.crm.visitAt);
  const visitsSoon = visits.filter((x) => dayDiff(x.a.crm.visitAt) <= 1);
  const overdueVisits = visits.filter((x) => x.f.visitOverdue).length;
  const drops = ads.filter((x) => x.f.priceDrop && !x.f.sold && x.f.stage !== 'rejected').sort((x, y) => y.f.priceDrop.t - x.f.priceDrop.t);
  const tracking = ads.filter((x) => App.meta.activeStages.includes(x.f.stage));
  const soldTracked = ads.filter((x) => x.f.sold && App.meta.activeStages.includes(x.f.stage));

  if (!ads.length) {
    view.replaceChildren(h('div', { class: 'page' },
      pageHead('پیشخوان', 'هنوز آگهی‌ای جمع نشده است.'),
      h('div', { class: 'empty big' }, icon('car', 'xl'), h('b', null, 'اولین جستجو را شروع کنید'),
        h('p', null, 'بگویید دنبال چه ماشینی هستید؛ ربات آگهی‌ها را از دیوار جمع می‌کند و اینجا برای پیگیری آماده می‌شوند.'),
        h('a', { class: 'btn primary lg', href: '#/search' }, icon('search'), 'جستجوی جدید'))));
    return;
  }

  const kpi = (label, value, sub, href, cls, ic) => h('a', { class: `kpi${cls ? ` ${cls}` : ''}`, href },
    h('div', { class: 'kpi-top' }, h('span', null, label), icon(ic, 'sm')),
    h('div', { class: 'kpi-v num' }, fa(value)),
    h('div', { class: 'kpi-s' }, sub));

  const last = App.searches[0];
  const busy = App.state.busy;
  const botCard = h('div', { class: `card bot-card${busy ? ' busy' : ''}` },
    h('span', { class: `state-icon${busy ? ' pulse' : ''}` }, icon(busy ? 'car' : 'search')),
    h('div', { class: 'grow' },
      h('b', null, busy ? 'ربات در حال کار است' : 'آگهی‌های جدید را بگیرید'),
      h('div', { class: 'muted' }, busy ? 'نتایج همین حالا در حال اضافه شدن است.'
        : last ? `آخرین بررسی «${describeCriteria(last.criteria)}» ${last.lastRunAt ? agoFa(last.lastRunAt) : ''}. فقط آگهی‌های تازه باز می‌شوند.` : '')),
    busy ? h('a', { class: 'btn primary', href: `#/run/${busy}` }, 'دیدن پیشرفت')
      : last && last.criteria ? h('button', { class: 'btn primary', type: 'button', onclick: () => rerunSearch(last.criteria) }, icon('refresh', 'sm'), 'بررسی آگهی‌های جدید')
        : h('a', { class: 'btn primary', href: '#/search' }, 'جستجوی جدید'));

  const quickCall = (x) => {
    const p = x.a.post;
    const c = x.a.crm || {};
    const tel = c.phone ? `tel:${P.toEnDigits(c.phone).replace(/[^\d+]/g, '')}` : null;
    return h('li', { class: `item${x.f.callDue ? ' due' : ''}` },
      h('a', { class: 'item-main', href: `#/ads?open=${p.token}` },
        h('b', null, p.title),
        h('small', null, [x.f.callDue ? h('span', { class: 'bad' }, 'وقتش رسیده') : whenFa(c.nextCallAt),
          p.price ? ` · ${formatPrice(p.price)}` : '', x.f.missed ? ` · ${fa(x.f.missed)} بار جواب نداد` : ''])),
      h('div', { class: 'item-actions' },
        tel ? h('a', { class: 'btn sm icon-only', href: tel, 'aria-label': 'زنگ بزن', title: 'زنگ بزن' }, icon('phone', 'sm')) : null,
        h('button', { class: 'btn sm good', type: 'button', onclick: () => App.crm(p.token, { action: 'call', result: 'answered' }) }, 'جواب داد'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => App.crm(p.token, { action: 'call', result: 'no-answer' }).then(() => toast('تماس بعدی خودکار زمان‌بندی شد.')) }, 'جواب نداد')));
  };
  const visitItem = (x) => {
    const p = x.a.post;
    return h('li', { class: `item${x.f.visitOverdue ? ' due' : ''}` },
      h('a', { class: 'item-main', href: `#/ads?open=${p.token}` },
        h('b', null, p.title),
        h('small', null, x.f.visitOverdue ? h('span', { class: 'bad' }, `گذشته (${whenFa(x.a.crm.visitAt)}) — نتیجه را ثبت کنید`) : whenFa(x.a.crm.visitAt),
          p.subtitle ? ` · ${p.subtitle}` : '')),
      h('div', { class: 'item-actions' }, p.price ? h('span', { class: 'num muted' }, formatPrice(p.price)) : null));
  };
  const dropItem = (x) => {
    const p = x.a.post;
    return h('li', { class: 'item' },
      h('a', { class: 'item-main', href: `#/ads?open=${p.token}` }, h('b', null, p.title),
        h('small', null, `${formatPrice(x.f.priceDrop.from)} ← ${formatPrice(x.f.priceDrop.to)} · ${agoFa(x.f.priceDrop.t)}`)),
      h('div', { class: 'item-actions' }, h('span', { class: 'delta low' }, `${formatPrice(x.f.priceDrop.from - x.f.priceDrop.to)} ارزان‌تر`)));
  };
  const deals = ads.filter((x) => { const d = App.deals.get(x.a.token); return d && d.deal && !x.f.sold && x.f.stage !== 'rejected'; })
    .sort((x, y) => App.deals.get(y.a.token).score - App.deals.get(x.a.token).score);
  const dealItem = (x) => {
    const p = x.a.post;
    const d = App.deals.get(p.token);
    return h('li', { class: 'item' },
      h('a', { class: 'item-main', href: `#/deals?open=${p.token}` }, h('b', null, p.title),
        h('small', null, `${formatPrice(p.price)} · معمولاً ${formatPrice(d.expected)}${p.mileage != null ? ` · ${fa(p.mileage)} کیلومتر` : ''}`)),
      h('div', { class: 'item-actions' }, dealBadge(d, false), h('span', { class: 'delta low' }, `${fa(Math.round(d.discount * 100))}٪ ارزان‌تر`)));
  };
  const listCard = (title, ic, items, renderItem, emptyText, href) => h('section', { class: 'card' },
    h('div', { class: 'card-h' }, h('h2', null, icon(ic, 'sm'), title, items.length ? h('span', { class: 'count-pill' }, fa(items.length)) : null),
      href ? h('a', { class: 'link', href }, 'همه') : null),
    items.length ? h('ul', { class: 'items' }, items.slice(0, 8).map(renderItem)) : h('p', { class: 'muted empty-line' }, emptyText));

  // Funnel
  const order = ['new', 'shortlist', 'calling', 'waiting', 'talking', 'visit', 'visited', 'bought'];
  const counts = Object.fromEntries(order.map((s) => [s, live.filter((x) => x.f.stage === s).length]));
  const maxC = Math.max(1, ...Object.values(counts));
  const rejected = ads.filter((x) => x.f.stage === 'rejected');
  const reasons = {};
  for (const x of rejected) { const r = ((x.a.crm && x.a.crm.rejectReason) || 'نامشخص').split(' — ')[0]; reasons[r] = (reasons[r] || 0) + 1; }
  const funnel = h('section', { class: 'card' },
    h('div', { class: 'card-h' }, h('h2', null, icon('funnel', 'sm'), 'قیف پیگیری')),
    h('div', { class: 'funnel' }, order.map((s) => h('a', { class: 'f-row', href: `#/ads?stage=${s}` },
      h('span', { class: 'f-label' }, stageLabel(s)),
      h('span', { class: 'f-bar' }, h('span', { class: `f-fill s-${s}`, style: `width:${Math.max(counts[s] ? 4 : 0, (counts[s] / maxC) * 100)}%` })),
      h('span', { class: 'f-n num' }, fa(counts[s]))))),
    rejected.length ? h('div', { class: 'reasons' }, h('span', { class: 'muted' }, `${fa(rejected.length)} آگهی حذف شده: `),
      Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([r, n]) => h('span', { class: 'reason' }, `${r} ${fa(n)}`))) : null);

  view.replaceChildren(h('div', { class: 'page' },
    pageHead('پیشخوان', new Date().toLocaleDateString('fa-IR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })),
    botCard,
    h('div', { class: 'kpis' },
      kpi('آگهی جدید امروز', newToday, `${fa(unreviewed)} آگهی هنوز بررسی نشده`, '#/ads?stage=new', newToday ? 'blue' : '', 'plus'),
      kpi('تماس‌های امروز', calls.length, due ? `${fa(due)} مورد وقتش رسیده` : 'همه سر وقت', '#/ads?view=calls', due ? 'red' : '', 'phone'),
      kpi('قرار بازدید', visitsSoon.length, overdueVisits ? `${fa(overdueVisits)} نتیجه ثبت نشده` : 'امروز و فردا', '#/ads?stage=visit', overdueVisits ? 'red' : '', 'calendar'),
      kpi('کاهش قیمت', drops.length, 'در ۷ روز گذشته', '#/ads?view=drops', drops.length ? 'green' : '', 'trend'),
      kpi('در حال پیگیری', tracking.length, soldTracked.length ? `${fa(soldTracked.length)} تا از دیوار حذف شد` : 'فهرست کوتاه تا بازدید', '#/ads?stage=active', '', 'star')),
    h('div', { class: 'dash-grid' },
      listCard('پیشنهادهای ویژه', 'flame', deals, dealItem, 'فعلاً آگهی‌ای خیلی زیر قیمت معمول نیست. با آگهی‌های بیشتر دقیق‌تر می‌شود.', '#/deals'),
      listCard('تماس‌های امروز', 'phone', calls, quickCall, 'برای امروز تماسی برنامه‌ریزی نشده.', '#/ads?view=calls'),
      listCard('قرارهای بازدید', 'calendar', visits, visitItem, 'قرار بازدیدی ندارید.', '#/ads?stage=visit'),
      listCard('کاهش قیمت‌ها', 'trend', drops, dropItem, 'در این هفته قیمتی کم نشده.', '#/ads?view=drops'),
      funnel)));
}

// =========================================================
// Ads (follow-up)
// =========================================================
const AD_TABS = [
  ['active', 'همه (فعال)'], ['new', 'جدید'], ['shortlist', 'فهرست کوتاه'], ['calling', 'در حال تماس'], ['waiting', 'منتظر تماس'],
  ['talking', 'صحبت شد'], ['visit', 'قرار بازدید'], ['visited', 'بازدید شد'], ['bought', 'خریدم'], ['rejected', 'حذف‌شده‌ها'],
];
const AD_VIEWS = { calls: 'تماس‌های امروز', drops: 'کاهش قیمت', sold: 'حذف‌شده از دیوار' };

function adTabMatch(f, tab, viewName) {
  if (viewName === 'calls') return f.callToday && !['bought', 'rejected'].includes(f.stage);
  if (viewName === 'drops') return !!f.priceDrop && f.stage !== 'rejected';
  if (viewName === 'sold') return f.sold;
  if (tab === 'active') return f.stage !== 'rejected';
  return f.stage === tab;
}

// =========================================================
// Car models: one card per model (real photo, number of ads, average price and model year)
// =========================================================
let refreshModelStrip = null;

function modelGroups(ads) {
  const groups = new Map();
  for (const a of ads) {
    const m = P.modelOf(a.post);
    let g = groups.get(m.key);
    if (!g) groups.set(m.key, (g = { key: m.key, label: m.label, ads: [], trims: new Map() }));
    g.ads.push(a);
    const tk = P.normalizeText(m.trim);
    const t = g.trims.get(tk) || { key: tk, label: m.trim || 'بدون تیپ', ads: [] };
    t.ads.push(a);
    g.trims.set(tk, t);
  }
  return Array.from(groups.values()).sort((x, y) => y.ads.length - x.ads.length || x.label.localeCompare(y.label, 'fa'));
}

function groupStats(ads) {
  const prices = ads.map((a) => a.post.price).filter((n) => n > 0);
  // Foreign cars use the Western year (2014), Iranian ones the Persian year (1401): when both
  // are mixed, count everything in Persian years.
  let years = ads.map((a) => a.post.year).filter((n) => n > 1300);
  if (years.some((y) => y < 1700) && years.some((y) => y > 1900)) years = years.map((y) => (y > 1900 ? y - 621 : y));
  const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  // Photo: the newest ad of the group that has one.
  const withImg = ads.filter((a) => (a.post.images || []).length)
    .sort((x, y) => (y.post.publishedAt || y.firstSeenAt || 0) - (x.post.publishedAt || x.firstSeenAt || 0))[0];
  return { count: ads.length, price: avg(prices), year: avg(years), img: withImg ? safeImg(withImg.post.images[0]) : null };
}

/** The row of model cards (and the trim chips of the chosen model). `go(model, trim)` navigates. */
function modelStrip(ads, modelKey, trimKey, go) {
  const groups = modelGroups(ads);
  if (groups.length < 2 && !modelKey) return [];
  const pic = (src) => h('img', { src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  const card = (key, label, st, pressed, onclick) => h('button', { class: 'model-card', type: 'button', 'aria-pressed': String(pressed), onclick },
    h('div', { class: `mc-img${st.imgs ? ` mosaic n${st.imgs.length}` : ''}` },
      st.imgs ? st.imgs.map(pic) : st.img ? pic(st.img) : icon('image', 'lg')),
    h('b', null, label),
    h('span', { class: 'mc-count' }, `${fa(st.count)} آگهی`),
    h('dl', null,
      h('dt', null, 'میانگین قیمت'), h('dd', { class: 'num' }, st.price ? formatPrice(Math.round(st.price)) : '—'),
      h('dt', null, 'میانگین مدل'), h('dd', { class: 'num' }, st.year ? faYear(Math.round(st.year)) : '—')));
  const all = groupStats(ads);
  // «همه»: one real photo from each of the biggest models.
  const imgs = groups.map((g) => groupStats(g.ads).img).filter(Boolean).slice(0, 4);
  if (imgs.length > 1) all.imgs = imgs.length === 3 ? imgs.slice(0, 2) : imgs;
  const cards = [card('', 'همه', all, !modelKey, () => go('', ''))];
  for (const g of groups) cards.push(card(g.key, g.label, groupStats(g.ads), g.key === modelKey, () => go(g.key, '')));
  const out = [h('div', { class: 'models', role: 'group', 'aria-label': 'مدل خودرو' }, cards)];
  const sel = groups.find((g) => g.key === modelKey);
  if (sel) {
    const trims = sel.trims.size > 1 ? Array.from(sel.trims.values()).sort((x, y) => y.ads.length - x.ads.length) : [];
    out.push(h('div', { class: 'quick trims' },
      trims.length ? [
        h('button', { class: 'chip-btn', type: 'button', 'aria-pressed': String(!trimKey), onclick: () => go(modelKey, '') }, 'همهٔ تیپ‌ها', h('small', null, fa(sel.ads.length))),
        trims.map((t) => h('button', { class: 'chip-btn', type: 'button', 'aria-pressed': String(t.key === trimKey), onclick: () => go(modelKey, t.key) },
          t.label, h('small', null, fa(t.ads.length))))] : null,
      h('a', { class: 'chip-btn', href: `#/prices?model=${encodeURIComponent(modelKey)}` }, icon('trend', 'sm'), `قیمت‌یاب ${sel.label}`)));
  }
  return out;
}

// =========================================================
// «قیمت‌یاب»: what is a good price to buy, and to sell your own car
// =========================================================
let PRICE_TYPED = ''; // words in the model box, kept while the page redraws itself
// «ماشین خودم»: year, trim, mileage and body, kept while the page redraws itself
const MY_CAR = {};
const BODY_OPTIONS = [['clean', 'سالم و بی‌رنگ'], ['scratches', 'خط و خش جزیی'], ['paint', 'رنگ‌شدگی'], ['accident', 'تصادفی']];

/** The guide entry for an ad's model, trim and year (or for its model and year). */
function guideOf(p) {
  const m = P.modelOf(p);
  const t = P.normalizeText(m.trim);
  return App.guide.find((g) => g.enough && g.modelKey === m.key && P.normalizeText(g.trim) === t && g.year === p.year) || null;
}

function renderPrices(view, params) {
  if (!CATALOG.brands) { view.replaceChildren(h('div', { class: 'page' }, h('p', { class: 'muted' }, 'در حال بارگذاری…'))); loadCatalog().then(() => render()); return; }
  const entries = App.guide || [];
  // Models already read, biggest first
  const models = [];
  for (const g of entries) {
    let m = models.find((x) => x.key === g.modelKey);
    if (!m) models.push((m = { key: g.modelKey, label: g.label, total: 0 }));
    m.total += g.total;
  }
  // The model asked for: one already read, or one of Divar's that has no ads here yet.
  const cat = catalogModels();
  const asked = params.get('model') || '';
  const want = asked && !models.some((m) => m.key === asked) ? { key: asked, label: (cat.get(asked) || {}).label || asked } : null;
  const modelKey = want ? want.key : (asked || (models[0] ? models[0].key : ''));
  const go = (k) => { PRICE_TYPED = ''; location.hash = `#/prices?model=${encodeURIComponent(k)}`; };
  const mine = entries.filter((g) => g.modelKey === modelKey);
  const sure = mine.filter((g) => g.enough);
  const price = (n) => h('span', { class: 'num' }, formatPrice(n));

  // ---- which car: type its name, or tap one already read ----
  const search = h('input', { placeholder: 'مدل ماشین را بنویسید؛ مثلاً ۲۰۶، پاترول، مگان…', 'aria-label': 'جستجوی مدل', value: PRICE_TYPED });
  const chips = h('div', { class: 'quick model-chips' });
  let showAll = false;
  // Nothing typed: the chosen model first, then the ones already read.
  const mineFirst = () => [...(want ? [{ ...want, total: 0 }] : []), ...models].sort((a, b) => Number(b.key === modelKey) - Number(a.key === modelKey));
  const found = () => {
    const q = P.normalizeText(search.value);
    if (!q) return mineFirst();
    const out = models.filter((m) => m.key.includes(q) || P.normalizeText(m.label).includes(q));
    for (const c of cat.values()) {
      if (c.names.includes(q) && !out.some((m) => m.key === c.key)) out.push(models.find((m) => m.key === c.key) || { key: c.key, label: c.label, total: 0 });
    }
    return out.sort((a, b) => b.total - a.total || a.label.length - b.label.length).slice(0, 10);
  };
  const drawChips = () => {
    const every = found();
    const typed = !!search.value.trim();
    const list = typed || showAll || every.length <= 9 ? every : every.slice(0, 8);
    chips.replaceChildren(...list.map((m) => h('button', { class: 'chip-btn', type: 'button', 'aria-pressed': String(m.key === modelKey), onclick: () => go(m.key) },
      m.label, m.total ? h('small', null, fa(m.total)) : null)),
    ...(list.length < every.length ? [h('button', { class: 'chip-btn more', type: 'button', onclick: () => { showAll = true; drawChips(); } }, `${fa(every.length - list.length)} مدل دیگر`)] : []),
    ...(typed && !list.length ? [h('span', { class: 'muted' }, 'در فهرست دیوار پیدا نشد.')] : []));
  };
  search.addEventListener('input', () => { PRICE_TYPED = search.value; drawChips(); });
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const l = found(); if (search.value.trim() && l.length) go(l[0].key); } });
  drawChips();
  const head = pageHead('قیمت‌یاب', 'قیمت آگهی‌های دو ماه اخیر دیوار، هر شهر. آگهی‌های اقساطی و تصادفی حساب نمی‌شوند؛ ماشین رنگ‌دار با قیمتِ «اگر سالم بود» آمده. پای معامله معمولاً چند درصد پایین‌تر بسته می‌شود.');
  const picker = h('section', { class: 'card price-pick' }, h('label', { class: 'pick-search' }, icon('search'), search), chips);

  if (want || !entries.length) {
    const collect = () => startScan({ query: want.label, city: budgetCity(), maxAgeDays: reviewPeriod(), maxAds: 40, speed: 'slow' }).catch((e) => toast(e.message, 'err'));
    view.replaceChildren(h('div', { class: 'page' }, head, picker, want
      ? h('div', { class: 'empty big' }, icon('trend', 'xl'), h('b', null, 'از ', h('bdi', null, want.label), ' هنوز آگهی‌ای نخوانده‌ام'),
        h('p', null, 'ربات آگهی‌های این مدل را آرام از دیوار می‌خواند؛ بعد قیمت خرید و فروشش همین‌جا می‌آید.'),
        h('button', { class: 'btn primary lg', type: 'button', onclick: collect }, icon('search'), 'جمع‌آوری آگهی‌های این مدل'))
      : h('div', { class: 'empty big' }, icon('trend', 'xl'), h('b', null, 'هنوز آگهی کافی نیست'),
        h('p', null, 'مدل ماشین را بالا بنویسید تا ربات آگهی‌هایش را بخواند.'))));
    return;
  }

  // ---- «ماشین خودم» ----
  const myBox = h('div', { class: 'my-result' });
  // Every year from the oldest to the newest ad of this model (not only the years with enough
  // ads): a year without enough is priced from the nearest one, about 2% a year apart.
  const seenYears = mine.map((g) => g.year);
  const years = [];
  if (seenYears.length) for (let y = Math.max(...seenYears); y >= Math.min(...seenYears) - 3; y--) years.push(y);
  const ySel = h('select', { name: 'year', 'aria-label': 'سال' }, years.map((y) => h('option', { value: y }, faYear(y))));
  const tSel = h('select', { name: 'trim', 'aria-label': 'تیپ' });
  const km = h('input', { name: 'km', inputmode: 'numeric', placeholder: 'مثلاً ۸۰٬۰۰۰' });
  const body = h('select', { name: 'body', 'aria-label': 'بدنه' }, BODY_OPTIONS.map(([v, t]) => h('option', { value: v }, t)));
  // what was chosen before the page redrew itself (same model only)
  const mem = MY_CAR.model === modelKey ? { ...MY_CAR } : {};
  if (mem.year && years.includes(mem.year)) ySel.value = String(mem.year);
  if (mem.km) km.value = mem.km;
  if (mem.body) body.value = mem.body;
  const keep = () => Object.assign(MY_CAR, { model: modelKey, year: Number(ySel.value), trim: tSel.value, km: km.value, body: body.value });
  // trims of that year if read, else every trim of the model (value: the normalized trim)
  const allTrims = Array.from(new Map(mine.map((g) => [P.normalizeText(g.trim), g.trim || 'بدون تیپ'])).entries());
  const fillTrims = () => {
    const y = Number(ySel.value);
    const ofYear = Array.from(new Map(mine.filter((g) => g.year === y).map((g) => [P.normalizeText(g.trim), g.trim || 'بدون تیپ'])).entries());
    tSel.replaceChildren(...(ofYear.length ? ofYear : allTrims).map(([v, t]) => h('option', { value: v }, t)));
    if (mem.trim && [...tSel.options].some((o) => o.value === mem.trim)) tSel.value = mem.trim;
    tSel.closest('label').hidden = tSel.options.length < 2;
  };
  /** The market for the chosen year and trim: exact, else the nearest year (same trim first), moved ~2% a year. */
  const marketFor = (y, t) => {
    const exact = sure.find((g) => g.year === y && P.normalizeText(g.trim) === t);
    if (exact) return { g: exact, from: null };
    const pool = sure.filter((g) => P.normalizeText(g.trim) === t);
    const list = (pool.length ? pool : sure).slice().sort((a, b) => Math.abs(a.year - y) - Math.abs(b.year - y));
    const near = list[0];
    if (!near) return null;
    const f = 1.02 ** (P.shamsiYear(y) - P.shamsiYear(near.year));
    const g = { ...near, market: near.market * f, sellList: near.sellList * f, sellFast: near.sellFast * f, buyGood: near.buyGood * f };
    return { g, from: near };
  };
  const calc = () => {
    const m = marketFor(Number(ySel.value), tSel.value);
    const g = m && m.g;
    const r = g && NojaDeals.myCarPrice(g, { mileage: P.parseNumber(km.value), body: body.value });
    myBox.replaceChildren(...(r ? [
      h('p', { class: 'my-line' }, 'آگهی‌تان را با ', h('b', null, price(r.sellList)), ' ثبت کنید.', h('small', null, ' کمی بالاتر از قیمت بازار است تا جای چانه بماند.')),
      h('p', { class: 'my-line' }, 'اگر عجله دارید، تا ', h('b', null, price(r.sellFast)), ' پایین بیایید.', h('small', null, ' کمتر از این نفروشید.')),
      h('p', { class: 'muted' }, m.from
        ? `تقریبی: از این سال و تیپ آگهی کافی نیست؛ از روی ${fa(m.from.n)} آگهی ${m.from.trim || ''} ${faYear(m.from.year)}، با حدود ۲٪ فرق برای هر سال.`
        : `از روی ${fa(g.n)} آگهی${g.sure ? '' : ' — کم‌اطمینان'}`),
    ] : [h('p', { class: 'muted' }, 'برای این مدل هنوز آگهی کافی نیست.')]));
  };
  ySel.addEventListener('change', () => { mem.trim = ''; fillTrims(); calc(); keep(); });
  for (const el of [tSel, body]) el.addEventListener('change', () => { calc(); keep(); });
  km.addEventListener('input', () => { calc(); keep(); });
  const myCard = sure.length ? h('section', { class: 'card my-car' },
    h('div', { class: 'card-h' }, h('h2', null, icon('car', 'sm'), 'ماشین خودم را بفروشم؟')),
    h('div', { class: 'my-form' },
      h('label', { class: 'field' }, h('span', null, 'سال'), ySel),
      h('label', { class: 'field' }, h('span', null, 'تیپ'), tSel),
      h('label', { class: 'field' }, h('span', null, 'کارکرد (کیلومتر)'), km),
      h('label', { class: 'field' }, h('span', null, 'بدنه'), body)),
    myBox) : null;

  // ---- which trim: «همهٔ تیپ‌ها» or one ----
  const trimList = [];
  for (const g of mine) {
    const t = P.normalizeText(g.trim);
    let x = trimList.find((y) => y.key === t);
    if (!x) trimList.push((x = { key: t, label: g.trim || 'بدون تیپ', n: 0 }));
    x.n += g.total;
  }
  trimList.sort((a, b) => b.n - a.n);
  const askedTrim = params.get('trim') || '';
  const trimKey = trimList.some((t) => t.key === askedTrim) ? askedTrim : '';
  const goTrim = (t) => setParam({ trim: t, cy: '' }); // keeps the mileage and the chart view
  const trimBtn = (t) => h('button', { class: 'chip-btn', type: 'button', 'aria-pressed': String(t.key === trimKey), onclick: () => goTrim(t.key) }, t.label, h('small', null, fa(t.n)));
  const trimChips = trimList.length > 1 ? h('div', { class: 'quick trims' },
    h('button', { class: 'chip-btn', type: 'button', 'aria-pressed': String(!trimKey), onclick: () => goTrim('') }, 'همهٔ تیپ‌ها', h('small', null, fa(trimList.reduce((s, t) => s + t.n, 0)))),
    // the 5 with most ads (and the chosen one); the rest behind a button
    trimList.filter((t, i) => i < 5 || t.key === trimKey).map(trimBtn),
    trimList.length > 5 ? h('button', { class: 'chip-btn more', type: 'button', onclick: (e) => { e.currentTarget.replaceWith(...trimList.filter((t, i) => i >= 5 && t.key !== trimKey).map(trimBtn)); } }, `${fa(trimList.length - 5 - (trimList.findIndex((t) => t.key === trimKey) >= 5 ? 1 : 0))} تیپ دیگر`) : null) : null;
  const shown = trimKey ? mine.filter((g) => P.normalizeText(g.trim) === trimKey)
    : trimList.length > 1 ? (App.guideAll || []).filter((g) => g.modelKey === modelKey) : mine;
  const label = (mine[0] || {}).label || modelKey;
  const trimName = trimKey ? trimList.find((t) => t.key === trimKey).label : trimList.length > 1 ? 'همهٔ تیپ‌ها' : (trimList[0] || {}).label;

  // ---- mileage of the car wanted: every number below is for it ----
  const kmVal = P.parseNumber(params.get('km'));
  const by = params.get('by') === 'km' ? 'km' : 'year';
  const setParam = (patch) => {
    const q = new URLSearchParams({ model: modelKey, ...(trimKey ? { trim: trimKey } : {}), ...(kmVal != null ? { km: kmVal } : {}), ...(by === 'km' ? { by } : {}), ...(params.get('cy') ? { cy: params.get('cy') } : {}), ...patch });
    for (const [k, v] of Array.from(q.entries())) if (v === '' || v == null) q.delete(k);
    location.hash = `#/prices?${q}`;
  };
  const kmIn = h('input', { inputmode: 'numeric', placeholder: 'مثلاً ۶۰٬۰۰۰', value: kmVal != null ? fa(kmVal) : '', 'aria-label': 'کارکرد ماشین' });
  const applyKm = () => { const n = P.parseNumber(kmIn.value); setParam({ km: n != null ? String(n < 1000 && n > 0 ? n * 1000 : n) : '' }); };
  kmIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyKm(); } });
  kmIn.addEventListener('change', applyKm);
  const kmBox = h('section', { class: 'card km-box' },
    h('label', { class: 'km-field' }, h('span', null, icon('gauge', 'sm'), 'کارکرد ماشینی که می‌خواهید'), kmIn, h('small', null, 'کیلومتر')),
    h('div', { class: 'quick' },
      [[0, 'صفر'], [20000, '۲۰ هزار'], [50000, '۵۰ هزار'], [100000, '۱۰۰ هزار'], [150000, '۱۵۰ هزار']].map(([n, t]) =>
        h('button', { class: 'chip-btn', type: 'button', 'aria-pressed': String(kmVal === n), onclick: () => setParam({ km: String(n) }) }, t)),
      kmVal != null ? h('button', { class: 'chip-btn more', type: 'button', onclick: () => setParam({ km: '' }) }, 'همهٔ کارکردها') : null),
    h('p', { class: 'muted km-help' }, kmVal != null
      ? `قیمت‌های زیر برای ماشینی با ${fa(Math.round(kmVal / 1000))} هزار کیلومتر حساب شده‌اند (کارکرد بیشتر، قیمت کمتر).`
      : 'کارکرد را بنویسید تا قیمت هر سال برای همان کارکرد حساب شود؛ خالی باشد، قیمت با کارکرد معمول هر سال است.'));
  const forKm = (g) => (kmVal != null && g.enough && g.medKm != null ? NojaDeals.myCarPrice(g, { mileage: kmVal, body: 'clean' }) : g);

  // ---- chart: every asking price by model year (or by mileage for one year) ----
  const chart = priceChart(modelKey, trimKey, trimList, { by, cy: Number(params.get('cy')) || 0, km: kmVal, guide: shown, setParam });

  // ---- one card per year ----
  const perTrim = (year) => trimKey || trimList.length < 2 ? [] : mine.filter((g) => g.year === year && g.enough).sort((a, b) => b.n - a.n);
  const cards = shown.slice().sort((a, b) => b.year - a.year).map((g0) => {
    const g = { ...g0, ...forKm(g0) };
    const adsHref = `#/ads?${new URLSearchParams({ stage: 'active', model: g.modelKey, ...(trimKey ? { trim: trimKey } : {}) })}`;
    const trims = perTrim(g.year).map((t) => ({ ...t, ...forKm(t) }));
    return h('section', { class: `card guide${g.enough ? '' : ' thin'}` },
      h('div', { class: 'guide-h' },
        h('b', { class: 'num' }, faYear(g.year)),
        h('small', null, `${fa(g.enough ? g.n : g.total)} آگهی`),
        g.enough && !g.sure ? h('span', { class: 'chip-status' }, 'کم‌اطمینان') : null),
      g.enough ? [
        h('div', { class: 'g-market' }, h('span', null, kmVal != null && g0.medKm != null ? `قیمت بازار با ${fa(Math.round(kmVal / 1000))} هزار کیلومتر` : 'قیمت بازار'), h('b', null, price(g.market))),
        h('div', { class: 'g-split' },
          h('div', { class: 'g-cell buy' }, h('span', null, 'خرید خوب تا'), h('b', null, price(g.buyGood))),
          h('div', { class: 'g-cell sell' }, h('span', null, 'فروش: در آگهی بنویسید'), h('b', null, price(g.sellList)))),
        h('div', { class: 'g-row' }, h('span', null, 'اگر عجله دارید، کمتر نفروشید از'), h('b', null, price(g.sellFast))),
        trims.length > 1 ? h('div', { class: 'g-trims' }, trims.map((t) => h('span', null, h('i', { style: `background:${trimColor(trimList, P.normalizeText(t.trim))}` }), h('bdi', null, t.trim || 'بدون تیپ'), ' ', h('b', { class: 'num' }, formatPrice(t.market))))) : null,
        h('div', { class: 'g-foot' },
          g.medKm != null ? h('span', null, g.medKm < 1000 ? 'بیشترشان صفر کیلومتر' : `کارکرد معمول ${fa(Math.round(g.medKm / 1000))} هزار`) : h('span'),
          h('a', { href: adsHref }, 'دیدن آگهی‌ها', icon('left', 'sm'))),
      ] : h('p', { class: 'muted' }, 'آگهی کافی نیست (دست‌کم ۳ آگهی نقدی لازم است).'));
  });

  view.replaceChildren(h('div', { class: 'page' }, head, picker,
    h('div', { class: 'price-title' }, h('h2', null, h('bdi', null, label), trimName ? h('small', null, ' · ', h('bdi', null, trimName)) : null)),
    trimChips, kmBox, newCarCard(modelKey, trimKey), chart, h('div', { class: 'guide-grid' }, cards), myCard));
  if (sure.length) { fillTrims(); calc(); }
}

/**
 * «قیمت روز صفر» from Bama for this model (or the chosen trim): market and factory price of
 * each trim and year, as Bama lists them that day.
 */
function newCarCard(modelKey, trimKey) {
  const rows = bamaNewPrices(modelKey).filter((r) => !trimKey || r.trimKey === trimKey);
  if (!rows.length) return null;
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.year}|${r.trim}|${r.note}`;
    const g = groups.get(k) || { year: r.year, trim: r.trim, note: r.note };
    if (r.kind === 'بازار') g.market = r; else if (r.kind === 'کارخانه') g.factory = r; else g.dealer = r;
    groups.set(k, g);
  }
  const list = Array.from(groups.values()).filter((g) => g.market || g.factory).sort((a, b) => b.year - a.year || (a.market ? a.market.price : 0) - (b.market ? b.market.price : 0));
  const at = App.bamaPrices && App.bamaPrices.at;
  return h('section', { class: 'card new-prices' },
    h('div', { class: 'card-h' }, h('h2', null, icon('trend', 'sm'), 'قیمت روز صفر کیلومتر'),
      h('small', { class: 'muted' }, `از باما${at ? ` · ${agoFa(at)}` : ''}`)),
    h('div', { class: 'np-table', role: 'table' },
      h('div', { class: 'np-row np-head', role: 'row' }, h('span', null, 'تیپ'), h('span', null, 'بازار'), h('span', null, 'کارخانه')),
      list.slice(0, 14).map((g) => h('div', { class: 'np-row', role: 'row' },
        h('span', null, h('bdi', null, g.trim || 'معمولی'), h('small', null, ` ${toFaYearShort(g.year)}${g.note ? ` · ${g.note}` : ''}`)),
        h('b', { class: 'num' }, g.market ? formatPrice(g.market.price) : '—'),
        h('span', { class: 'num muted' }, g.factory ? formatPrice(g.factory.price) : '—')))),
    h('p', { class: 'muted np-note' }, 'قیمت بازار یعنی قیمت صفرِ تحویلی امروز در بازار؛ قیمت کارخانه یعنی قیمت فروش رسمی شرکت (با ثبت‌نام و انتظار).'));
}

// Colors of the trims on the chart: fixed order (most ads first), validated palette; the rest is «سایر».
const TRIM_SLOTS = 5;
function trimColor(trimList, key) {
  const i = trimList.findIndex((t) => t.key === key);
  return i >= 0 && i < TRIM_SLOTS ? `var(--series-${i + 1})` : 'var(--series-other)';
}

/**
 * Price chart of one model: each dot is an ad's asking price (cash, last two months) by model
 * year; a line joins the middle price of each year, one line per trim (or just the chosen trim,
 * with its «خرید خوب» line dashed). Hover a dot for the ad; tap it to open the ad.
 */
function priceChart(modelKey, trimKey, trimList, opts = {}) {
  const now = Date.now();
  const every = [];
  for (const a of App.ads.values()) {
    const p = a.post;
    if (!p || a.removed || !NojaDeals.marketable(p, now)) continue;
    const m = P.modelOf(p);
    if (m.key !== modelKey) continue;
    every.push({ token: p.token, url: safeDivarUrl(p.url), year: P.shamsiYear(p.year), price: p.price, km: p.mileage, trim: P.normalizeText(m.trim), trimLabel: m.trim || 'بدون تیپ', title: p.title });
  }
  // A price far from the others of its model year, any trim («۳۰ میلیارد» typed for «۳ میلیارد»), is left out.
  const mid = new Map();
  for (const x of every) { if (!mid.has(x.year)) mid.set(x.year, []); mid.get(x.year).push(x.price); }
  for (const [k, v] of mid) mid.set(k, P.median(v));
  const pts = every.filter((x) => x.price <= mid.get(x.year) * 1.6 && x.price >= mid.get(x.year) * 0.6 && (!trimKey || x.trim === trimKey));
  if (pts.length < 3) return null;
  if (opts.by === 'km') return priceKmChart(pts, trimKey, trimList, opts);
  const years = Array.from(new Set(pts.map((x) => x.year))).sort((a, b) => a - b);
  // Far-off prices would squash the rest: the scale covers the middle 96%.
  const sorted = pts.map((x) => x.price).sort((a, b) => a - b);
  const q = (f) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * f)))];
  let lo = q(0.02);
  let hi = q(0.98);
  const pad = (hi - lo) * 0.12 || hi * 0.1;
  lo = Math.max(0, lo - pad);
  hi += pad;
  const W = 640;
  const H = 280;
  const M = { l: 56, r: 16, t: 14, b: 30 };
  const x0 = (y) => M.l + (years.length === 1 ? (W - M.l - M.r) / 2 : ((years.indexOf(y)) / (years.length - 1)) * (W - M.l - M.r));
  const yv = (v) => M.t + (1 - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (H - M.t - M.b);
  const NS = 'http://www.w3.org/2000/svg';
  const s = (tag, attrs, ...kids) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v); for (const c of kids) if (c != null) el.append(c); return el; };
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'pchart-svg', role: 'img', 'aria-label': 'نمودار قیمت آگهی‌ها بر اساس سال' });
  // grid + price axis (4 steps, rounded to a nice number)
  const step = niceStep((hi - lo) / 4);
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    svg.append(s('line', { x1: M.l, x2: W - M.r, y1: yv(v), y2: yv(v), class: 'pc-grid' }));
    svg.append(s('text', { x: M.l - 8, y: yv(v) + 5, class: 'pc-axis', 'text-anchor': 'end' }, priceShort(v)));
  }
  for (const y of years) svg.append(s('text', { x: x0(y), y: H - 8, class: 'pc-axis', 'text-anchor': 'middle' }, toFaYearShort(y)));
  // lines: the middle price per year, per trim (top 5 trims) or of the chosen trim
  const lineFor = (list) => years.map((y) => { const v = list.filter((x) => x.year === y).map((x) => x.price).sort((a, b) => a - b); return v.length ? [y, v[Math.floor((v.length - 1) / 2)]] : null; }).filter(Boolean);
  const series = trimKey ? [{ key: trimKey, list: pts }] : trimList.slice(0, TRIM_SLOTS).map((t) => ({ key: t.key, list: pts.filter((x) => x.trim === t.key) })).filter((x) => x.list.length >= 2);
  for (const se of series) {
    const line = lineFor(se.list);
    if (line.length < 2) continue;
    svg.append(s('polyline', { points: line.map(([y, v]) => `${x0(y)},${yv(v)}`).join(' '), class: 'pc-line', style: `stroke:${trimKey ? 'var(--series-1)' : trimColor(trimList, se.key)}` }));
  }
  if (trimKey) {
    const good = lineFor(pts).map(([y, v]) => [y, v * NojaDeals.ZONES.good]);
    if (good.length >= 2) svg.append(s('polyline', { points: good.map(([y, v]) => `${x0(y)},${yv(v)}`).join(' '), class: 'pc-line good' }));
  }
  // dots, spread a little inside their year so they do not hide each other
  const tip = h('div', { class: 'pc-tip', hidden: true });
  const wrap = h('div', { class: 'pchart-wrap' });
  const byYear = new Map();
  for (const x of pts) { if (!byYear.has(x.year)) byYear.set(x.year, []); byYear.get(x.year).push(x); }
  const span = years.length > 1 ? Math.min(28, (W - M.l - M.r) / (years.length - 1) / 3) : 40;
  for (const [y, list] of byYear) {
    list.sort((a, b) => a.price - b.price);
    list.forEach((x, i) => {
      const cx = x0(y) + (list.length > 1 ? (i / (list.length - 1) - 0.5) * span : 0);
      const dot = s('circle', { cx, cy: yv(x.price), r: 4.5, class: 'pc-dot', style: `fill:${trimKey ? 'var(--series-1)' : trimColor(trimList, x.trim)}`, tabindex: '0' });
      const show = () => {
        tip.replaceChildren(h('b', null, x.title), h('span', { class: 'num' }, `${formatPrice(x.price)} تومان`), h('span', null, `${toFaYearShort(x.year)}${x.km != null ? ` · ${fa(x.km)} کیلومتر` : ''} · ${x.trimLabel}`));
        tip.hidden = false;
        tip.classList.toggle('below', yv(x.price) < 110); // near the top: show it under the dot
        const r = wrap.getBoundingClientRect();
        const k = r.width / W;
        tip.style.left = `${Math.min(r.width - 10, Math.max(10, cx * k))}px`;
        tip.style.top = `${yv(x.price) * k}px`;
      };
      dot.addEventListener('mouseenter', show);
      dot.addEventListener('focus', show);
      dot.addEventListener('mouseleave', () => { tip.hidden = true; });
      dot.addEventListener('blur', () => { tip.hidden = true; });
      dot.addEventListener('click', () => window.open(x.url || `https://divar.ir/v/${encodeURIComponent(x.token)}`, '_blank', 'noopener'));
      svg.append(dot);
    });
  }
  wrap.append(svg, tip);
  const legend = trimKey ? h('div', { class: 'pc-legend' },
    h('span', null, h('i', { class: 'dot', style: 'background:var(--series-1)' }), 'قیمت هر آگهی'),
    h('span', null, h('i', { class: 'ln', style: 'background:var(--series-1)' }), 'قیمت وسط هر سال'),
    h('span', null, h('i', { class: 'ln dash' }), 'خرید خوب تا'))
    : h('div', { class: 'pc-legend' }, series.map((se) => h('span', null, h('i', { class: 'dot', style: `background:${trimColor(trimList, se.key)}` }), h('bdi', null, (trimList.find((t) => t.key === se.key) || {}).label))),
      trimList.length > TRIM_SLOTS ? h('span', null, h('i', { class: 'dot', style: 'background:var(--series-other)' }), 'سایر تیپ‌ها') : null);
  return h('section', { class: 'card pchart' },
    h('div', { class: 'card-h' }, h('h2', null, icon('trend', 'sm'), 'قیمت آگهی‌ها'), chartModeToggle(opts)),
    h('small', { class: 'muted pc-sub' }, `${fa(pts.length)} آگهی · قیمت به میلیارد تومان · روی هر نقطه بروید یا بزنید`),
    legend, wrap);
}

/** «بر اساس سال | بر اساس کارکرد» switch of the price chart. */
function chartModeToggle(opts) {
  if (!opts.setParam) return null;
  const btn = (v, t) => h('button', { type: 'button', 'aria-pressed': String((opts.by || 'year') === v), onclick: () => opts.setParam({ by: v === 'km' ? 'km' : '' }) }, t);
  return h('div', { class: 'seg-toggle', role: 'group', 'aria-label': 'نمودار بر اساس' }, btn('year', 'بر اساس سال'), btn('km', 'بر اساس کارکرد'));
}

/**
 * Price by mileage for one model year: a dot per ad, the market line of that year (its middle
 * price moved by the mileage slope) and its «خرید خوب» line; the chosen mileage is marked.
 */
function priceKmChart(all, trimKey, trimList, opts) {
  const counts = new Map();
  for (const x of all) if (x.km != null) counts.set(x.year, (counts.get(x.year) || 0) + 1);
  const years = Array.from(counts.entries()).filter(([, n]) => n >= 3).map(([y]) => y).sort((a, b) => b - a);
  const head = (body) => h('section', { class: 'card pchart' },
    h('div', { class: 'card-h' }, h('h2', null, icon('gauge', 'sm'), 'قیمت آگهی‌ها'), chartModeToggle(opts)), ...body);
  if (!years.length) return head([h('p', { class: 'muted' }, 'برای مقایسه با کارکرد، از هیچ سالی هنوز ۳ آگهی با کارکرد معلوم نیست.')]);
  const year = years.includes(opts.cy) ? opts.cy : years.slice().sort((a, b) => counts.get(b) - counts.get(a))[0];
  const yearChips = h('div', { class: 'quick' }, years.map((y) => h('button', { class: 'chip-btn', type: 'button', 'aria-pressed': String(y === year), onclick: () => opts.setParam({ cy: String(y) }) }, toFaYearShort(y), h('small', null, fa(counts.get(y))))));
  const pts = all.filter((x) => x.year === year && x.km != null);
  const g = (opts.guide || []).find((x) => x.enough && P.shamsiYear(x.year) === year) || null;
  let kmHi = Math.max(...pts.map((x) => x.km), opts.km || 0);
  kmHi = niceStep(kmHi / 4) * 4 || 10000;
  const prices = pts.map((x) => x.price);
  let lo = Math.min(...prices);
  let hi = Math.max(...prices);
  const pad = (hi - lo) * 0.15 || hi * 0.1;
  lo = Math.max(0, lo - pad);
  hi += pad;
  const W = 640;
  const H = 280;
  const M = { l: 56, r: 16, t: 14, b: 30 };
  const xv = (k) => M.l + (Math.min(kmHi, Math.max(0, k)) / kmHi) * (W - M.l - M.r);
  const yv = (v) => M.t + (1 - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (H - M.t - M.b);
  const NS = 'http://www.w3.org/2000/svg';
  const s = (tag, attrs, ...kids) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v); for (const c of kids) if (c != null) el.append(c); return el; };
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'pchart-svg', role: 'img', 'aria-label': `نمودار قیمت آگهی‌های ${toFaYearShort(year)} بر اساس کارکرد` });
  const step = niceStep((hi - lo) / 4);
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    svg.append(s('line', { x1: M.l, x2: W - M.r, y1: yv(v), y2: yv(v), class: 'pc-grid' }));
    svg.append(s('text', { x: M.l - 8, y: yv(v) + 5, class: 'pc-axis', 'text-anchor': 'end' }, priceShort(v)));
  }
  const kStep = niceStep(kmHi / 4);
  for (let k = 0; k <= kmHi; k += kStep) svg.append(s('text', { x: xv(k), y: H - 8, class: 'pc-axis', 'text-anchor': 'middle' }, fa(Math.round(k / 1000))));
  // the market of that year at each mileage (clamped like the cards), and its good-buy line
  const at = (k) => (g && g.medKm != null ? Math.min(g.market * 1.2, Math.max(g.market * 0.8, g.market + g.perKm * (k - g.medKm))) : null);
  if (g && g.medKm != null) {
    const line = [0, kmHi / 4, kmHi / 2, (kmHi * 3) / 4, kmHi].map((k) => [k, at(k)]);
    svg.append(s('polyline', { points: line.map(([k, v]) => `${xv(k)},${yv(v)}`).join(' '), class: 'pc-line', style: 'stroke:var(--series-1)' }));
    svg.append(s('polyline', { points: line.map(([k, v]) => `${xv(k)},${yv(v * NojaDeals.ZONES.good)}`).join(' '), class: 'pc-line good' }));
  }
  if (opts.km != null) {
    svg.append(s('line', { x1: xv(opts.km), x2: xv(opts.km), y1: M.t, y2: H - M.b, class: 'pc-mark' }));
    if (at(opts.km)) svg.append(s('circle', { cx: xv(opts.km), cy: yv(at(opts.km)), r: 6, class: 'pc-mark-dot' }));
  }
  const tip = h('div', { class: 'pc-tip', hidden: true });
  const wrap = h('div', { class: 'pchart-wrap' });
  for (const x of pts) {
    const cx = xv(x.km);
    const dot = s('circle', { cx, cy: yv(x.price), r: 4.5, class: 'pc-dot', style: `fill:${trimKey ? 'var(--series-1)' : trimColor(trimList, x.trim)}`, tabindex: '0' });
    const show = () => {
      tip.replaceChildren(h('b', null, x.title), h('span', { class: 'num' }, `${formatPrice(x.price)} تومان`), h('span', null, `${fa(x.km)} کیلومتر · ${x.trimLabel}`));
      tip.hidden = false;
      tip.classList.toggle('below', yv(x.price) < 110);
      const r = wrap.getBoundingClientRect();
      const k = r.width / W;
      tip.style.left = `${Math.min(r.width - 10, Math.max(10, cx * k))}px`;
      tip.style.top = `${yv(x.price) * k}px`;
    };
    dot.addEventListener('mouseenter', show);
    dot.addEventListener('focus', show);
    dot.addEventListener('mouseleave', () => { tip.hidden = true; });
    dot.addEventListener('blur', () => { tip.hidden = true; });
    dot.addEventListener('click', () => window.open(x.url || `https://divar.ir/v/${encodeURIComponent(x.token)}`, '_blank', 'noopener'));
    svg.append(dot);
  }
  wrap.append(svg, tip);
  const perK = g && g.medKm != null ? Math.round((-g.perKm * 10000) / 1e6) : null;
  return head([
    h('small', { class: 'muted pc-sub' }, `مدل ${toFaYearShort(year)} · ${fa(pts.length)} آگهی · قیمت به میلیارد تومان، کارکرد به هزار کیلومتر`),
    yearChips,
    h('div', { class: 'pc-legend' },
      h('span', null, h('i', { class: 'dot', style: 'background:var(--series-1)' }), 'قیمت هر آگهی'),
      g && g.medKm != null ? h('span', null, h('i', { class: 'ln', style: 'background:var(--series-1)' }), 'قیمت بازار با هر کارکرد') : null,
      g && g.medKm != null ? h('span', null, h('i', { class: 'ln dash' }), 'خرید خوب تا') : null,
      opts.km != null ? h('span', null, h('i', { class: 'ln mark' }), `کارکرد شما: ${fa(Math.round(opts.km / 1000))} هزار`) : null),
    wrap,
    perK ? h('p', { class: 'muted pc-sub' }, `در این سال، هر ۱۰ هزار کیلومتر کارکرد بیشتر حدود ${fa(perK)} میلیون تومان از قیمت کم می‌کند.`) : null,
    !trimKey && trimList.length > 1 ? h('p', { class: 'muted pc-sub' }, 'رنگ هر نقطه تیپ آن است؛ تیپ‌ها قیمت‌های متفاوتی دارند. برای مقایسهٔ دقیق‌تر با کارکرد، بالای صفحه یک تیپ را انتخاب کنید.') : null,
  ]);
}

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}
/** Axis label in billions: 3_450_000_000 → «۳٫۴۵» (the unit is in the chart's title). */
function priceShort(v) {
  return (v / 1e9).toLocaleString('fa-IR', { maximumFractionDigits: 2 });
}
function toFaYearShort(y) { return fa(y).replace(/٬/g, ''); }

function renderAds(view, params) {
  const viewName = AD_VIEWS[params.get('view')] ? params.get('view') : null;
  const tab = viewName ? null : (params.get('stage') || 'active');
  const searchKey = params.get('search') || '';
  const modelKey = params.get('model') || '';
  const trimKey = params.get('trim') || '';
  const period = reviewPeriod();
  const city = reviewCity();
  const inSearch = (a) => (!searchKey || a.searches.includes(searchKey)) && inPeriod(a, period) && inCity(a, city);
  const inModel = (a) => {
    if (!modelKey) return true;
    const m = P.modelOf(a.post);
    return m.key === modelKey && (!trimKey || P.normalizeText(m.trim) === trimKey);
  };
  const ads = allAds().filter(inSearch);
  // Switching tabs keeps the chosen model; choosing a model keeps the tab.
  const nav = (patch) => {
    const keep = { ...(searchKey ? { search: searchKey } : {}), ...(modelKey ? { model: modelKey } : {}), ...(trimKey ? { trim: trimKey } : {}) };
    const q = new URLSearchParams(Object.entries({ ...keep, ...patch }).filter(([, v]) => v));
    location.hash = `#/ads?${q}`;
  };
  const here = viewName ? { view: viewName } : { stage: tab };
  const strip = h('div', { class: 'models-wrap' });
  const drawStrip = () => strip.replaceChildren(...modelStrip(
    allAds().filter(inSearch).filter((a) => adTabMatch(adFlags(a), tab, viewName)),
    modelKey, trimKey,
    (m, t) => nav({ ...here, model: m || '', trim: t || '' })));
  refreshModelStrip = drawStrip;

  const tabs = h('div', { class: 'stage-tabs', role: 'tablist' },
    AD_TABS.map(([k, label]) => {
      const n = ads.filter((a) => adTabMatch(adFlags(a), k)).length;
      return h('button', { role: 'tab', type: 'button', 'aria-selected': String(tab === k), onclick: () => nav({ stage: k }) },
        label, h('small', { class: 'num' }, fa(n)));
    }));
  const quick = h('div', { class: 'quick' }, Object.entries(AD_VIEWS).map(([k, label]) => {
    const n = ads.filter((a) => adTabMatch(adFlags(a), null, k)).length;
    return h('button', { class: 'chip-btn', type: 'button', 'aria-pressed': String(viewName === k), onclick: () => (viewName === k ? nav({}) : nav({ view: k })) },
      k === 'calls' ? icon('phone', 'sm') : k === 'drops' ? icon('trend', 'sm') : icon('alert', 'sm'), label, h('small', null, fa(n)));
  }));
  const searchSel = App.searches.length > 1 ? h('select', { class: 'search-sel', 'aria-label': 'جستجو', onchange: (e) => {
    const q = new URLSearchParams(params); if (e.target.value) q.set('search', e.target.value); else q.delete('search'); location.hash = `#/ads?${q}`;
  } }, h('option', { value: '' }, 'همهٔ جستجوها'), App.searches.map((s) => h('option', { value: s.key, selected: s.key === searchKey }, `${describeCriteria(s.criteria)} (${fa(s.count)})`))) : null;

  const box = h('div');
  view.replaceChildren(h('div', { class: 'page wide' },
    pageHead('پیگیری آگهی‌ها', 'هر آگهی را مثل یک لید پیگیری کنید: تماس، قرار بازدید، یادداشت.', [citySelect(() => render()), periodSelect(() => render()), searchSel,
      h('a', { class: 'btn', href: '#/search' }, icon('plus', 'sm'), 'جستجوی جدید')]),
    tabs, quick, strip, box));
  drawStrip();

  const title = viewName ? AD_VIEWS[viewName] : (AD_TABS.find((t) => t[0] === tab) || [null, ''])[1];
  mountBrowser({
    root: box,
    key: `ads.${searchKey || 'all'}`,
    criteria: {},
    // isNew / priceChange belong to a single run; here the stage tabs say what is new.
    getPosts: () => allAds().filter(inSearch).filter(inModel).filter((a) => adTabMatch(adFlags(a), tab, viewName))
      .sort((x, y) => (y.firstSeenAt || 0) - (x.firstSeenAt || 0) || (x.post.order || 0) - (y.post.order || 0))
      .map((a, i) => ({ ...a.post, isNew: false, priceChange: null, order: i })),
    title: (n) => `${title} — ${fa(n)} آگهی`,
    emptyTitle: viewName === 'calls' ? 'برای امروز تماسی نیست' : 'آگهی‌ای در این بخش نیست',
    emptyText: viewName === 'calls' ? 'با «جواب نداد» یا یادآوری تماس، آگهی‌ها اینجا می‌آیند.' : '',
  });
  if (viewName === 'calls') { B.sort = 'next-call'; renderResults(); }
  const open = params.get('open');
  if (open) setTimeout(() => openDrawer(open), 50);
}

// =========================================================
// New search
// =========================================================
// =========================================================
// Runs (history)
// =========================================================
/** «کپچا و محدودیت‌ها»: every captcha / «درخواست زیاد» and how busy the bot was just before. */
function blocksCard() {
  const box = h('section', { class: 'card', hidden: true });
  api('/api/blocks').then(({ blocks }) => {
    const WHERE = { ad: 'صفحهٔ آگهی', list: 'فهرست جستجو', other: 'صفحهٔ دیگر' };
    const HOW = { user: 'خودتان حل کردید', timeout: 'ربات ۵ دقیقه صبر کرد', stop: 'جستجو متوقف شد', auto: 'خودش رفع شد' };
    const week = blocks.filter((b) => Date.now() - b.t < 7 * DAY).length;
    const avg = (k) => (blocks.length ? Math.round(blocks.reduce((x, b) => x + (b[k] || 0), 0) / blocks.length) : 0);
    box.hidden = false;
    box.replaceChildren(
      h('div', { class: 'card-h' }, h('h2', null, icon('shield', 'sm'), 'کپچا و محدودیت‌ها'),
        h('span', { class: 'chip-status' }, blocks.length ? `${fa(week)} بار در ۷ روز اخیر` : 'تا حالا نبوده')),
      blocks.length ? [
        h('p', { class: 'muted', style: 'margin:0 0 8px' },
          `به‌طور میانگین وقتی دیوار تأیید خواسته، ربات در یک ساعت قبلش ${fa(avg('views1h'))} آگهی و در ۲۴ ساعت قبلش ${fa(avg('views24h'))} آگهی باز کرده بود.`),
        h('ul', { class: 'items' }, blocks.slice(-15).reverse().map((b) => h('li', { class: 'item' },
          h('div', { class: 'item-main' },
            h('b', null, `${dateTimeFa(b.t)} · ${WHERE[b.where] || b.where}`),
            h('small', null, [
              `یک ساعت قبلش ${fa(b.views1h)} آگهی`, `۲۴ ساعت قبلش ${fa(b.views24h)}`,
              `${fa(b.runMinutes)} دقیقه بعد از شروع جستجو`, b.sinceLastBlockMin != null ? `${fa(b.sinceLastBlockMin)} دقیقه بعد از کپچای قبلی` : null,
              HOW[b.resolved] || '',
            ].filter(Boolean).join(' · ')))))),
      ] : h('p', { class: 'muted empty-line' }, 'هر بار دیوار کپچا یا «درخواست زیاد» نشان دهد، اینجا ثبت می‌شود تا الگوی دیوار معلوم شود.'));
  }).catch(() => {}); // the online panel has no captcha log (it is kept on the PC)
  return box;
}

// ---------- daily automatic check of a saved search ----------
const hourFa = (hr) => `ساعت ${fa(hr)}${hr < 12 ? ' صبح' : hr < 17 ? ' بعدازظهر' : ' شب'}`;
function autoLabel(a) { return `هر روز از ${hourFa(a.hour)}${a.full ? ' · همهٔ آگهی‌ها' : ''}`; }

function autoDialog(s, done) {
  const a = { on: true, hour: 9, full: false, ...(s.auto || {}) };
  if (!s.auto) a.on = true;
  const on = h('input', { type: 'checkbox', checked: a.on });
  const hour = h('select', { 'aria-label': 'ساعت' }, Array.from({ length: 18 }, (_, i) => i + 6).map((hr) => h('option', { value: hr, selected: hr === a.hour }, hourFa(hr))));
  const mode = (full, title, note) => h('label', { class: 'check mode' }, h('input', { type: 'radio', name: 'automode', value: full ? 'full' : 'new', checked: a.full === full }),
    h('span', null, h('b', null, title), h('small', null, note)));
  const opts = h('div', { class: 'auto-opts' },
    h('label', { class: 'field-inline' }, 'از', hour, 'به بعد'),
    mode(false, 'فقط آگهی‌های جدید', 'سریع؛ آگهی‌هایی که پیگیری می‌کنید هم دوباره دیده می‌شوند.'),
    mode(true, 'همهٔ آگهی‌های بازه', 'کندتر؛ تغییر قیمت و فروش‌رفته‌ها را هم پیدا می‌کند.'));
  const sync = () => { opts.hidden = !on.checked; };
  on.addEventListener('change', sync);
  sync();
  openDialog('بررسی خودکار روزانه', h('div', { class: 'auto-dialog' },
    h('p', { class: 'muted' }, describeCriteria(s.criteria)),
    h('label', { class: 'check' }, on, 'هر روز خودش بررسی کند'),
    opts,
    h('p', { class: 'muted small' }, 'کامپیوتر و ربات باید روشن باشند؛ اگر خاموش بود، با روشن شدن انجام می‌شود.')),
  (close) => [
    h('button', { class: 'btn', type: 'button', onclick: close }, 'انصراف'),
    h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      const body = { key: s.key, on: on.checked, hour: Number(hour.value), full: !!opts.querySelector('input[value=full]').checked };
      try {
        const r = await api('/api/search-auto', { method: 'POST', body });
        s.auto = r.auto;
        close();
        toast(r.auto.on ? `از این به بعد ${autoLabel(r.auto)} بررسی می‌شود.` : 'بررسی خودکار خاموش شد.');
        done();
      } catch (e) { toast(e.message, 'err'); }
    } }, 'ذخیره'),
  ]);
}

// ---------- delete a saved search for good ----------
function deleteSearchDialog(s, done) {
  // Ads only this search had found; the ones being followed up stay.
  const mine = Array.from(App.ads.values()).filter((a) => a.searches.length === 1 && a.searches[0] === s.key);
  const kept = mine.filter((a) => a.crm && a.crm.stage !== 'rejected').length;
  const removed = mine.length - kept;
  openDialog('حذف جستجو', h('div', { class: 'auto-dialog' },
    h('p', null, h('b', null, describeCriteria(s.criteria))),
    h('p', { class: 'muted' }, `این جستجو${removed ? ` با ${fa(removed)} آگهی‌اش` : ''} و تاریخچهٔ اجرایش پاک می‌شود.`),
    kept ? h('p', { class: 'muted' }, `${fa(kept)} آگهی که پیگیری می‌کنید می‌ماند.`) : null),
  (close) => [
    h('button', { class: 'btn', type: 'button', onclick: close }, 'انصراف'),
    h('button', { class: 'btn danger', type: 'button', onclick: async () => {
      try {
        await api('/api/search-delete', { method: 'POST', body: { key: s.key } });
        close();
        toast('جستجو پاک شد.');
        await Promise.all([App.refreshAds(true), App.refreshState()]);
        done();
      } catch (e) { toast(e.message, 'err'); }
    } }, icon('trash', 'sm'), 'حذف'),
  ]);
}

function renderRuns(view) {
  const runs = App.state.runs || [];
  // Divar and Bama can run together: one «الان» card each
  const ids = typeof liveIds === 'function' ? liveIds() : (App.state.busy ? [App.state.busy] : []);
  const busyId = ids[0] || null;
  const currents = ids.map((id) => (typeof liveRun === 'function' && liveRun(id)) || runs.find((r) => r.id === id) || { id });
  const queue = App.queue || [];
  const redraw = async () => { await App.refreshState(); if (PAGE.name === 'runs') renderRuns(view); };
  const act = async (fn) => { try { await fn(); } catch (e) { toast(e.message, 'err'); } await redraw(); };
  const site = (c) => (c && c.source === 'bama' ? h('span', { class: 'src-tag bama' }, 'باما') : h('span', { class: 'src-tag divar' }, 'دیوار'));
  const where = (c) => [c && c.city && CITY_NAME[c.city] ? CITY_NAME[c.city] : '', c && c.maxAds ? `تا ${fa(c.maxAds)} آگهی` : ''].filter(Boolean).join(' · ');

  // ---- 1. now ----
  const NOW = { starting: 'در حال شروع', 'waiting-login': 'منتظر ورود شما به دیوار', collecting: 'در حال جمع کردن فهرست آگهی‌ها', reading: 'در حال خواندن آگهی‌ها',
    resting: 'استراحت کوتاه (مثل یک آدم)', blocked: 'منتظر شما — دیوار سؤال امنیتی پرسیده', paused: 'مکث کرده' };
  const nowCardFor = (cur) => {
    const c = cur.criteria || {};
    const total = cur.toVisit || 0;
    const done = cur.stats ? cur.stats.opened || 0 : 0;
    const paused = cur.status === 'paused';
    const control = (action) => act(() => api(`/api/runs/${encodeURIComponent(cur.id)}/${action}`, { method: 'POST' }));
    return h('section', { class: 'card run-now' },
      h('div', { class: 'run-now-h' }, h('span', { class: `live-pulse${paused ? ' off' : ''}`, 'aria-hidden': 'true' }), h('b', null, 'الان'), site(c),
        h('span', { class: 'run-state' }, NOW[cur.status] || 'در حال کار')),
      h('h2', { class: 'run-now-title' }, describeCriteria(c)),
      where(c) ? h('small', { class: 'muted' }, where(c)) : null,
      cur.message ? h('p', { class: 'run-now-msg' }, cur.message, cur.activity ? [' — ', h('bdi', null, `«${cur.activity}»`)] : null) : null,
      total ? h('div', { class: 'run-progress' },
        h('div', { class: 'live-progress' }, h('span', { style: `width:${Math.min(100, Math.round((done / total) * 100))}%` })),
        h('small', { class: 'num' }, `${fa(done)} از ${fa(total)} آگهی`)) : null,
      cur.stats ? h('div', { class: 'run-stats' },
        h('span', null, h('b', { class: 'num' }, fa(cur.stats.newAds || 0)), ' آگهی جدید'),
        cur.stats.priceChanged ? h('span', null, h('b', { class: 'num' }, fa(cur.stats.priceChanged)), ' تغییر قیمت') : null) : null,
      h('div', { class: 'run-actions' },
        h('button', { class: 'btn danger', type: 'button', onclick: () => control(cur.status === 'collecting' ? 'cancel' : 'stop') }, icon('stop', 'sm'), 'توقف این جستجو'),
        paused ? h('button', { class: 'btn', type: 'button', onclick: () => control('resume') }, icon('play', 'sm'), 'ادامه')
          : h('button', { class: 'btn', type: 'button', onclick: () => control('pause') }, icon('pause', 'sm'), 'مکث'),
        h('a', { class: 'btn ghost', href: `#/run/${encodeURIComponent(cur.id)}` }, 'دیدن آگهی‌های این جستجو')),
      h('p', { class: 'muted run-note' }, cur.status === 'reading' ? '«توقف» آگهی‌ای را که باز است تمام می‌کند و بعد می‌ایستد؛ آگهی‌های خوانده‌شده می‌مانند.' : 'با «توقف»، جستجوی بعدی نوبت شروع می‌شود.'));
  };
  let nowCard;
  if (currents.length) nowCard = currents.map(nowCardFor);
  else {
    const off = App.host && !App.bot.online;
    nowCard = h('section', { class: 'card run-now idle' },
      h('div', { class: 'run-now-h' }, h('span', { class: 'live-pulse off', 'aria-hidden': 'true' }), h('b', null, off ? 'ربات خاموش است' : 'ربات بیکار است')),
      h('p', { class: 'muted' }, off ? 'کامپیوتر ربات روشن نیست؛ جستجوهای نوبت با روشن شدنش شروع می‌شوند.' : queue.length ? 'جستجوی بعدی نوبت تا چند ثانیهٔ دیگر شروع می‌شود.' : 'جستجویی در نوبت نیست.'),
      h('a', { class: 'btn primary', href: '#/search' }, icon('plus', 'sm'), 'جستجوی جدید'));
  }

  // ---- 2. waiting, in order ----
  const move = (q, to) => act(() => api(`/api/queue/${encodeURIComponent(q.id)}/move`, { method: 'POST', body: { to } }));
  const queueCard = h('section', { class: 'card run-queue' },
    h('div', { class: 'card-h' }, h('h2', null, icon('clock', 'sm'), 'در نوبت', h('small', { class: 'num' }, ` ${fa(queue.length)}`)),
      queue.length > 1 ? h('button', { class: 'btn sm danger-ghost', type: 'button', onclick: () => { if (confirm('همهٔ جستجوهای نوبت حذف شوند؟')) act(() => api('/api/queue', { method: 'DELETE' })); } }, icon('trash', 'sm'), 'خالی کردن نوبت') : null),
    queue.length ? h('ol', { class: 'q-list' }, queue.map((q, i) => h('li', { class: 'q-item' },
      h('span', { class: 'q-no num' }, fa(i + 1)),
      h('div', { class: 'q-main' }, h('b', null, describeCriteria(q.criteria)), h('small', { class: 'muted' }, site(q.criteria), ' ', where(q.criteria))),
      h('div', { class: 'q-actions' },
        i > 0 ? h('button', { class: 'btn sm', type: 'button', title: 'اول از همه', onclick: () => move(q, 'top') }, 'اول') : null,
        i > 0 ? h('button', { class: 'btn sm icon-only', type: 'button', 'aria-label': 'یکی بالاتر', title: 'یکی بالاتر', onclick: () => move(q, 'up') }, '▲') : null,
        i < queue.length - 1 ? h('button', { class: 'btn sm icon-only', type: 'button', 'aria-label': 'یکی پایین‌تر', title: 'یکی پایین‌تر', onclick: () => move(q, 'down') }, '▼') : null,
        h('button', { class: 'btn sm icon-only danger-ghost', type: 'button', 'aria-label': 'حذف از نوبت', title: 'حذف از نوبت', onclick: () => act(() => api(`/api/queue/${encodeURIComponent(q.id)}`, { method: 'DELETE' })) }, icon('x', 'sm'))))))
      : h('p', { class: 'muted empty-line' }, 'نوبت خالی است.'),
    queue.length ? h('p', { class: 'muted run-note' }, 'ربات جستجوها را یکی‌یکی و به همین ترتیب انجام می‌دهد. با «اول» یا فلش‌ها ترتیب را عوض کنید.') : null);

  // ---- 3. done ----
  const STATUS = { done: ['تمام شد', 'ok'], stopped: ['متوقف شد', 'muted'], error: ['خطا', 'bad'] };
  const past = runs.filter((r) => !ids.includes(r.id) && !ACTIVE_RUN.includes(r.status)).slice(0, 15);
  const historyCard = h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, icon('history', 'sm'), 'انجام‌شده')),
    past.length ? h('ul', { class: 'items run-history' }, past.map((r) => {
      const [label, cls] = STATUS[r.status] || [r.status, 'muted'];
      return h('li', { class: 'item' },
        h('a', { class: 'item-main', href: `#/run/${encodeURIComponent(r.id)}` },
          h('b', null, describeCriteria(r.criteria)),
          h('small', null, site(r.criteria), ` ${agoFa(r.createdAt)} · ${fa(r.read)} آگهی خوانده شد${r.newCount != null ? ` · ${fa(r.newCount)} جدید` : ''}${r.criteria && r.criteria.auto ? ' · خودکار' : ''}`)),
        h('div', { class: 'item-actions' }, h('span', { class: `run-pill ${cls}` }, label),
          r.criteria ? h('button', { class: 'btn sm', type: 'button', title: 'همین جستجو دوباره', onclick: () => rerunSearch(r.criteria) }, icon('refresh', 'sm'), 'دوباره') : null));
    })) : h('p', { class: 'muted empty-line' }, 'هنوز جستجویی تمام نشده.'));

  // ---- 4. saved searches ----
  const savedCard = App.searches.length ? h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, icon('search', 'sm'), 'جستجوهای ذخیره‌شده')),
    h('ul', { class: 'items saved-list' }, App.searches.map((s) => h('li', { class: 'item' },
      h('a', { class: 'item-main', href: `#/ads?search=${encodeURIComponent(s.key)}` }, h('b', null, describeCriteria(s.criteria)),
        h('small', null, `${fa(s.count)} آگهی${s.lastRunAt ? ` · آخرین بررسی ${agoFa(s.lastRunAt)}` : ''}`),
        s.auto && s.auto.on ? h('small', { class: 'auto-line' }, icon('clock', 'sm'), autoLabel(s.auto)) : null),
      h('div', { class: 'item-actions' }, s.criteria ? h('button', { class: `btn sm${s.auto && s.auto.on ? ' on' : ''}`, type: 'button', 'aria-label': 'بررسی خودکار روزانه', title: 'بررسی خودکار روزانه', onclick: () => autoDialog(s, () => renderRuns(view)) },
        icon('clock', 'sm'), 'خودکار') : null, s.criteria ? h('button', { class: 'btn sm', type: 'button', onclick: () => rerunSearch(s.criteria) },
        icon('refresh', 'sm'), 'بررسی جدیدها') : null,
      h('button', { class: 'btn danger-ghost sm', type: 'button', 'aria-label': 'حذف جستجو', title: 'حذف جستجو', onclick: () => deleteSearchDialog(s, () => renderRuns(view)) },
        icon('trash', 'sm'))))))) : null;

  view.replaceChildren(h('div', { class: 'page' },
    pageHead('جستجوهای من', 'کاری که ربات الان می‌کند، جستجوهایی که در نوبت‌اند، و آن‌هایی که تمام شده‌اند.', h('a', { class: 'btn primary', href: '#/search' }, icon('plus', 'sm'), 'جستجوی جدید')),
    nowCard, queueCard, historyCard, savedCard, blocksCard()));
  // (the live bar fetches it and redraws this page when it has it)
  if (ids.some((id) => !(typeof liveRun === 'function' && liveRun(id))) && typeof updateLiveBar === 'function') updateLiveBar();
}

// =========================================================
// Live run
// =========================================================
let RUN = null;
function stopRunView() { if (RUN) { clearTimeout(RUN.timer); clearInterval(RUN.tick); } RUN = null; }

function renderRun(view, id) {
  RUN = { id, run: null, sig: '', timer: null, tick: null };
  const box = h('div', { class: 'page wide' });
  view.replaceChildren(h('section', { class: 'status', id: 'status', 'aria-live': 'polite' }), box);
  RUN.box = box;
  RUN.tick = setInterval(() => {
    if (!RUN || !RUN.run || !RUN.run.waitUntil) return;
    const el = $('#statusMeta');
    if (el) el.textContent = countdown(RUN.run.waitUntil);
  }, 1000);
  pollRun();
}

function countdown(until) {
  const s = Math.max(0, Math.round((until - Date.now()) / 1000));
  return faDigits(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
}

async function pollRun() {
  if (!RUN) return;
  clearTimeout(RUN.timer);
  const id = RUN.id;
  try {
    const run = await api(`/api/runs/${encodeURIComponent(id)}`);
    if (!RUN || RUN.id !== id) return;
    const sig = `${run.status}|${run.message}|${run.activity}|${run.items.length}|${run.posts.length}|${Object.keys(run.errors || {}).length}|${run.waitUntil}`;
    const first = !RUN.run;
    RUN.run = run;
    if (first) {
      setTitle(describeCriteria(run.criteria));
      mountBrowser({
        root: RUN.box,
        key: `run.${id}`,
        criteria: run.criteria,
        showOnlyNew: true,
        getPosts: () => (RUN && RUN.run ? App.relevantPosts(RUN.run.posts, RUN.run.criteria) : []),
        active: () => !!(RUN && RUN.run && ACTIVE_RUN.includes(RUN.run.status)),
        emptyTitle: 'آگهی‌ای خوانده نشد',
        emptyText: 'پیام بالای صفحه را ببینید.',
        below: () => runErrors(RUN.run),
      });
    }
    if (sig !== RUN.sig || first) {
      RUN.sig = sig;
      renderRunStatus();
      if (!first) refreshBrowser();
      if (!ACTIVE_RUN.includes(run.status)) { App.refreshAds(); App.refreshState(); }
    }
    if (ACTIVE_RUN.includes(run.status)) RUN.timer = setTimeout(pollRun, 1200);
  } catch (e) {
    if (!RUN) return;
    if (e.status === 404) {
      RUN.box.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'empty' }, icon('alert'), h('b', null, 'این جستجو پیدا نشد'), h('a', { class: 'btn', href: '#/' }, 'بازگشت'))));
      return;
    }
    RUN.timer = setTimeout(pollRun, 3000);
  }
}

function runErrors(run) {
  const errs = Object.entries((run && run.errors) || {});
  if (!errs.length) return null;
  return h('details', { class: 'errors' }, h('summary', null, `${fa(errs.length)} آگهی باز نشد`),
    h('ul', null, errs.map(([token, msg]) => {
      const it = run.items.find((x) => x.token === token) || {};
      const url = safeDivarUrl(it.href);
      return h('li', null, `${it.title || token}: ${msg} `, url ? h('a', { href: url, target: '_blank', rel: 'noopener' }, 'باز کردن در دیوار') : null);
    })));
}

async function runControl(action) {
  // «پایان» shows at once that it was pressed (on the online panel the bot gets it at its next check-in).
  const enough = action === 'stop' && RUN.run && RUN.run.status === 'collecting'; // «کافیه»: go on to reading
  if ((action === 'stop' && !enough) || action === 'cancel') { RUN.stopping = { action, at: Date.now() }; renderRunStatus(); }
  try { await api(`/api/runs/${encodeURIComponent(RUN.id)}/${action}`, { method: 'POST' }); } catch (e) { RUN.stopping = null; toast(e.message, 'err'); }
  pollRun();
}

function renderRunStatus() {
  const run = RUN.run;
  const st = run.status;
  const total = run.toVisit != null ? run.toVisit : run.items.length;
  const done = run.toVisit != null ? (run.stats ? run.stats.opened : 0) : run.posts.length;
  const btn = (label, ic, onclick, cls = '') => h('button', { class: `btn sm ${cls}`, type: 'button', onclick }, ic ? icon(ic, 'sm') : null, label);
  const focus = () => api(`/api/runs/${encodeURIComponent(RUN.id)}/focus`, { method: 'POST' }).catch(() => {});
  const eta = () => {
    const s = run.stats || {};
    const remaining = Math.max(0, (run.toVisit || 0) - (s.opened || 0));
    if (!remaining) return '';
    const per = s.opened ? s.readMs / s.opened + 3500 : 14000;
    return `حدود ${fa(Math.max(1, Math.round((remaining * per) / 60000)))} دقیقه مانده`;
  };

  let ic = 'loader'; let cls = ''; let title = run.message; let sub = ''; let meta = ''; let actions = []; let pulse = true; let pct = null;
  switch (st) {
    case 'starting': title = 'در حال آماده شدن…'; break;
    case 'waiting-login':
      ic = 'login'; cls = 'attn'; pulse = false; title = 'یک بار وارد حساب دیوار شوید'; sub = run.message;
      actions = [btn('نمایش پنجرهٔ دیوار', 'external', focus), btn('وارد شدم', 'check', () => runControl('continue'), 'primary'), btn('لغو', null, () => runControl('stop'), 'ghost')];
      break;
    case 'collecting':
      ic = 'search'; title = 'در حال مرور نتایج دیوار'; sub = run.message;
      actions = [btn('کافیه، برو سراغ آگهی‌ها', 'right', () => runControl('stop')), btn('پایان', 'stop', () => runControl('cancel'), 'ghost')];
      break;
    case 'reading':
      ic = 'car'; title = run.message; sub = run.activity ? `الان: ${run.activity}` : ''; meta = eta(); pct = total ? done / total : 0;
      actions = [btn('مکث', 'pause', () => runControl('pause')), btn('پایان', 'stop', () => runControl('stop'), 'ghost')];
      break;
    case 'resting':
      ic = 'coffee'; title = 'استراحت کوتاه'; sub = run.message; meta = run.waitUntil ? countdown(run.waitUntil) : ''; pct = total ? done / total : 0; pulse = false;
      actions = [btn('ادامه بدون استراحت', 'play', () => runControl('continue')), btn('پایان', 'stop', () => runControl('stop'), 'ghost')];
      break;
    case 'blocked':
      ic = 'alert'; cls = 'attn'; pulse = false; title = 'دیوار تأیید می‌خواهد'; sub = run.message; meta = run.waitUntil ? countdown(run.waitUntil) : ''; pct = total ? done / total : 0;
      actions = [btn('نمایش پنجرهٔ دیوار', 'external', focus), btn('حل شد، ادامه', 'check', () => runControl('continue'), 'primary'), btn('پایان', null, () => runControl('stop'), 'ghost')];
      break;
    case 'paused':
      ic = 'pause'; pulse = false; title = 'ربات مکث کرده'; sub = `${fa(done)} از ${fa(total)} آگهی خوانده شده`; pct = total ? done / total : 0;
      actions = [btn('ادامه', 'play', () => runControl('resume'), 'primary'), btn('پایان', 'stop', () => runControl('stop'), 'ghost')];
      break;
    case 'done': case 'stopped':
      ic = 'check'; cls = 'done'; pulse = false; pct = 1;
      sub = 'آگهی‌ها در «پیگیری آگهی‌ها» هم هستند؛ آنجا تماس و بازدید را ثبت کنید.';
      actions = [h('a', { class: 'btn sm primary', href: '#/ads?stage=new' }, icon('list', 'sm'), 'رفتن به پیگیری')];
      break;
    case 'error':
      ic = 'alert'; cls = 'err'; pulse = false;
      actions = [btn('دوباره امتحان کن', 'refresh', () => rerunSearch(run.criteria))];
      break;
    default:
  }
  if (RUN.stopping && !ACTIVE_RUN.includes(st)) RUN.stopping = null;
  if (RUN.stopping) {
    ic = 'loader'; pulse = true; cls = '';
    title = 'در حال توقف…';
    sub = App.host ? 'دستور توقف برای ربات روی کامپیوتر فرستاده شد؛ چند ثانیه طول می‌کشد.' : 'ربات بعد از همین لحظه متوقف می‌شود.';
    actions = [];
  }
  const status = $('#status');
  if (!status) return;
  status.className = `status ${cls}`;
  status.replaceChildren(
    h('div', { class: 'status-inner' },
      h('span', { class: `state-icon${pulse && ACTIVE_RUN.includes(st) ? ' pulse' : ''}` }, icon(ic)),
      h('div', { class: 'text' }, h('b', null, title), sub ? h('span', null, sub) : null),
      meta ? h('div', { class: 'meta num', id: 'statusMeta' }, meta) : null,
      h('div', { class: 'actions' }, actions)),
    h('div', { class: 'bar' }, h('div', { style: `width:${pct == null ? (ACTIVE_RUN.includes(st) ? 8 : 100) : Math.round(pct * 100)}%` })));
}

// =========================================================
// Backup
// =========================================================
async function renderBackup(view) {
  const list = h('ul', { class: 'items' }, h('li', { class: 'muted empty-line' }, 'در حال بارگذاری…'));
  const load = async () => {
    const { backups } = await api('/api/backups');
    list.replaceChildren(...(backups.length ? backups.map((b) => h('li', { class: 'item' },
      h('div', { class: 'item-main' }, h('b', { dir: 'ltr', class: 'num' }, b.name), h('small', null, `${new Date(b.t).toLocaleString('fa-IR', { dateStyle: 'medium', timeStyle: 'short' })} · ${fa(Math.ceil(b.size / 1024))} کیلوبایت`)),
      h('div', { class: 'item-actions' }, h('a', { class: 'btn sm', href: `/api/backups/${encodeURIComponent(b.name)}`, download: b.name }, icon('download', 'sm'), 'دانلود'))))
      : [h('li', { class: 'muted empty-line' }, 'هنوز پشتیبانی نیست.')]));
  };
  const now = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
    now.disabled = true;
    try { await api('/api/backups', { method: 'POST' }); toast('پشتیبان ساخته شد.'); await load(); } catch (e) { toast(e.message, 'err'); }
    now.disabled = false;
  } }, icon('database', 'sm'), 'پشتیبان همین حالا');

  const file = h('input', { type: 'file', accept: '.gz,.json,application/gzip,application/json', class: 'sr-only', id: 'restoreFile' });
  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    if (!confirm('همهٔ داده‌های فعلی (آگهی‌ها، یادداشت‌ها، وضعیت‌ها) با این پشتیبان جایگزین می‌شود. قبلش خودکار یک پشتیبان از وضعیت فعلی گرفته می‌شود. ادامه می‌دهید؟')) { file.value = ''; return; }
    try {
      let text;
      if (/\.gz$/i.test(f.name)) {
        const stream = f.stream().pipeThrough(new DecompressionStream('gzip'));
        text = await new Response(stream).text();
      } else text = await f.text();
      const r = await api('/api/backups/restore', { method: 'POST', body: text });
      toast(`${fa(r.count)} آگهی برگردانده شد.`);
      await App.refreshAds(true);
      await load();
    } catch (e) {
      toast(e.message, 'err');
    }
    file.value = '';
  });

  view.replaceChildren(h('div', { class: 'page' },
    pageHead('پشتیبان', 'هر روز خودکار یک نسخه از همهٔ آگهی‌ها، یادداشت‌ها و وضعیت‌های پیگیری گرفته می‌شود (۳۰ روز نگه داشته می‌شود).',
      [now, h('label', { class: 'btn', for: 'restoreFile' }, icon('upload', 'sm'), 'بارگذاری پشتیبان'), file]),
    h('div', { class: 'notice soft' }, icon('shield'), h('div', { class: 'grow' },
      'پشتیبان‌ها در پوشهٔ ', h('code', null, 'data/backups'), ' کنار برنامه هستند. گاهی یکی را دانلود کنید و جای دیگری (فلش یا ایمیل) نگه دارید.')),
    h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, icon('database', 'sm'), 'پشتیبان‌ها')), list),
    App.host ? updateCard() : null));
  load().catch((e) => toast(e.message, 'err'));
}

/** Online panel: install «ردیاب-آپدیت.zip» from here (like Noja), or go back to an earlier version. */
function updateCard() {
  const box = h('section', { class: 'card' });
  const verText = (v) => (v && v.builtAt ? dateTimeFa(v.builtAt) : (v && v.version) || 'نامشخص');
  const draw = async () => {
    let info;
    try {
      const r = await fetch('update.php?action=info', { cache: 'no-store' });
      info = await r.json();
      if (!r.ok) throw new Error(info.error || r.status);
    } catch (e) { box.replaceChildren(h('p', { class: 'muted' }, `به‌روزرسانی در دسترس نیست: ${e.message}`)); return; }
    const file = h('input', { type: 'file', accept: '.zip,application/zip', class: 'sr-only', id: 'updFile' });
    const post = async (fd, okText) => {
      fd.append('token', info.token);
      const r = await fetch('update.php', { method: 'POST', body: fd });
      const b = await r.json().catch(() => ({}));
      if (!r.ok || b.ok === false) throw new Error(b.error || `خطای ${r.status}`);
      toast(okText(b));
      setTimeout(() => location.reload(), 1500); // load the new panel files
    };
    file.addEventListener('change', async () => {
      const f = file.files[0];
      if (!f) return;
      if (!confirm(`«${f.name}» نصب شود؟ پیش از نصب، از فایل‌های فعلی پشتیبان گرفته می‌شود و تنظیمات و داده‌ها دست نمی‌خورند.`)) { file.value = ''; return; }
      const fd = new FormData();
      fd.append('action', 'apply');
      fd.append('pkg', f);
      try { await post(fd, (b) => `به‌روزرسانی نصب شد (${fa(b.applied)} فایل).`); } catch (e) { toast(e.message, 'err'); }
      file.value = '';
    });
    const rollback = async (b) => {
      if (!confirm(`برگشت به نسخهٔ قبل از ${b.at ? dateTimeFa(Date.parse(b.at)) : b.id}؟`)) return;
      const fd = new FormData();
      fd.append('action', 'rollback');
      fd.append('backup', b.id);
      try { await post(fd, (r) => `نسخهٔ قبل برگردانده شد (${fa(r.restored)} فایل).`); } catch (e) { toast(e.message, 'err'); }
    };
    box.replaceChildren(
      h('div', { class: 'card-h' }, h('h2', null, icon('upload', 'sm'), 'به‌روزرسانی ردیاب'),
        h('span', { class: 'chip-status' }, `نسخهٔ فعلی: ${verText(info.version)}`)),
      h('p', { class: 'muted', style: 'margin:0 0 12px' }, 'فایل «ردیاب-آپدیت.zip» را انتخاب کنید. پیش از نصب از فایل‌های فعلی پشتیبان گرفته می‌شود؛ تنظیمات و داده‌ها دست نمی‌خورند.'),
      info.zip ? h('label', { class: 'btn primary', for: 'updFile' }, icon('upload', 'sm'), 'انتخاب فایل و نصب') : h('p', { class: 'form-error' }, 'افزونهٔ Zip روی هاست فعال نیست.'),
      file,
      info.backups.length ? [
        h('h3', { class: 'd-h', style: 'margin-top:16px' }, 'نسخه‌های قبلی (برای برگشت)'),
        h('ul', { class: 'items' }, info.backups.slice(0, 5).map((b) => h('li', { class: 'item' },
          h('div', { class: 'item-main' }, h('b', null, b.at ? dateTimeFa(Date.parse(b.at)) : b.id), h('small', null, `${fa(b.files || 0)} فایل`)),
          h('div', { class: 'item-actions' }, h('button', { class: 'btn sm', type: 'button', onclick: () => rollback(b) }, icon('undo', 'sm'), 'برگشت'))))),
      ] : null);
  };
  box.append(h('p', { class: 'muted' }, 'در حال بارگذاری…'));
  draw();
  return box;
}

// =========================================================
// Settings: reminders on the phone
// =========================================================
/** PC only: connect this bot to the online panel (address + bot key from the panel's setup page). */
async function drawCloud(box) {
  let c = await api('/api/cloud').catch(() => null);
  if (!c) return;
  const draw = () => {
    const status = !c.url ? 'وصل نیست'
      : c.lastError ? `خطا: ${c.lastError}`
        : c.lastSyncAt ? `وصل است · آخرین همگام‌سازی ${agoFa(c.lastSyncAt)}` : 'در حال اتصال…';
    const url = h('input', { name: 'url', dir: 'ltr', placeholder: 'https://radyab.nojakasht.com', value: c.url || '' });
    const key = h('input', { name: 'key', dir: 'ltr', placeholder: c.hasKey ? c.key : 'rk_…', autocomplete: 'off' });
    const btn = h('button', { class: 'btn primary', type: 'submit' }, icon('check', 'sm'), c.url ? 'ذخیره و همگام‌سازی' : 'وصل کن');
    const form = h('form', { class: 'card', style: 'margin-bottom:16px' },
      h('div', { class: 'card-h' }, h('h2', null, icon('refresh', 'sm'), 'پنل آنلاین'),
        h('span', { class: `chip-status${c.connected ? ' on' : ''}` }, status)),
      h('p', { class: 'muted', style: 'margin:0 0 12px' }, 'با وصل کردن، آگهی‌ها و پیگیری‌ها روی پنل آنلاین هم دیده می‌شوند و از گوشی هم می‌شود جستجو خواست. حساب دیوار روی همین کامپیوتر می‌ماند.'),
      h('div', { class: 'search-row two' },
        h('label', { class: 'field' }, h('span', null, 'نشانی پنل'), url),
        h('label', { class: 'field' }, h('span', null, 'کلید ربات'), key)),
      h('div', { style: 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap' }, btn,
        c.url ? h('button', { class: 'btn', type: 'button', onclick: async () => {
          if (!confirm('اتصال به پنل آنلاین قطع شود؟')) return;
          try { c = await api('/api/cloud', { method: 'POST', body: { url: '', key: '' } }); toast('اتصال قطع شد.'); draw(); } catch (e) { toast(e.message, 'err'); }
        } }, 'قطع اتصال') : null));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      btn.disabled = true;
      try {
        c = await api('/api/cloud', { method: 'POST', body: { url: url.value, key: key.value } });
        if (c.lastError) toast(c.lastError, 'err'); else toast('به پنل آنلاین وصل شد.');
      } catch (ex) { toast(ex.message, 'err'); }
      draw();
    });
    box.replaceChildren(form);
  };
  draw();
}

async function renderSettings(view) {
  let s = await api('/api/settings/notify').catch(() => null);
  if (!s) { view.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'empty' }, 'ارتباط با ربات برقرار نیست.'))); return; }
  const box = h('div');
  const cloudBox = h('div');
  view.replaceChildren(h('div', { class: 'page narrow-ish' },
    pageHead('تنظیمات', 'یادآوری تماس‌ها، بازدیدها و آگهی‌های جدید را روی گوشی‌تان بگیرید.'), cloudBox, box));
  if (!App.host) drawCloud(cloudBox);

  const save = async (patch, msg) => {
    try { s = await api('/api/settings/notify', { method: 'POST', body: patch }); if (msg) toast(msg); draw(); } catch (e) { toast(e.message, 'err'); }
  };
  const run = async (path, okMsg, btn) => {
    if (btn) btn.disabled = true;
    try { const r = await api(path, { method: 'POST', body: {} }); if (r && r.channel !== undefined) s = r; toast(okMsg); draw(); } catch (e) { toast(e.message, 'err'); }
    if (btn) btn.disabled = false;
  };

  function botPanel(ch) {
    const app = ch === 'bale' ? 'بله' : 'تلگرام';
    const cfg = s[ch];
    const token = h('input', { dir: 'ltr', placeholder: cfg.hasToken ? `${cfg.token} (ذخیره شده)` : '123456789:AAH…', autocomplete: 'off', 'aria-label': 'توکن بات' });
    const connectBtn = h('button', { class: 'btn', type: 'button', disabled: !cfg.hasToken, onclick: (e) => run('/api/notify/find-chat', 'وصل شد.', e.currentTarget) }, icon('check', 'sm'), 'اتصال');
    const testBtn = h('button', { class: 'btn primary', type: 'button', disabled: !s.ready, onclick: (e) => run('/api/notify/test', `پیام آزمایشی به ${app} فرستاده شد.`, e.currentTarget) }, icon('bell', 'sm'), 'پیام آزمایشی');
    const step = (n, title, ...body) => h('li', { class: `setup-step${n === 1 && cfg.hasToken ? ' done' : ''}${n === 3 && cfg.chatId ? ' done' : ''}` },
      h('span', { class: 'n' }, fa(n)), h('div', null, h('b', null, title), ...body));
    return h('ol', { class: 'setup-steps' },
      step(1, `در ${app} یک بات بسازید`,
        h('p', null, `در ${app} به `, h('code', { dir: 'ltr' }, '@BotFather'), ' پیام بدهید، ', h('code', { dir: 'ltr' }, '/newbot'),
          ' را بزنید و یک اسم و نام کاربری بدهید. توکنی را که می‌دهد اینجا بچسبانید.'),
        h('div', { class: 'crm-row' }, token, h('button', { class: 'btn', type: 'button', onclick: () => {
          if (!token.value.trim()) { toast('توکن را وارد کنید.', 'err'); return; }
          save({ channel: ch, [ch]: { token: token.value.trim() } }, 'توکن ذخیره شد.');
        } }, 'ذخیره'))),
      step(2, 'به بات خودتان پیام بدهید', h('p', null, `بات تازه را در ${app} باز کنید و یک پیام (مثلاً «سلام») بفرستید.`)),
      step(3, 'وصل کنید', h('p', null, cfg.chatId ? ['وصل است به: ', h('b', null, cfg.chatName || cfg.chatId)] : 'ردیاب پیام شما را پیدا می‌کند و از این به بعد یادآوری‌ها را برایتان می‌فرستد.'),
        h('div', { class: 'crm-row' }, connectBtn)),
      step(4, 'امتحان کنید', h('div', { class: 'crm-row' }, testBtn)));
  }

  function smsPanel() {
    const key = h('input', { dir: 'ltr', placeholder: s.sms.hasKey ? `${s.sms.apiKey} (ذخیره شده)` : 'کلید API از پنل sms.ir', autocomplete: 'off' });
    const line = h('input', { dir: 'ltr', inputmode: 'numeric', placeholder: 'شمارهٔ خط، مثلاً 3000xxxx', value: s.sms.line });
    const mobile = h('input', { dir: 'ltr', inputmode: 'tel', placeholder: '09xxxxxxxxx', value: s.sms.mobile });
    return h('div', { class: 'sms-grid' },
      h('p', { class: 'muted', style: 'margin:0' }, 'همان سرویس sms.ir که در نوژا دارید. هر پیامک هزینهٔ معمول خودش را دارد.'),
      h('label', { class: 'field' }, h('span', null, 'کلید API'), key),
      h('label', { class: 'field' }, h('span', null, 'شمارهٔ خط'), line),
      h('label', { class: 'field' }, h('span', null, 'موبایل شما'), mobile),
      h('div', { class: 'crm-row' },
        h('button', { class: 'btn', type: 'button', onclick: () => save({ channel: 'sms', sms: { apiKey: key.value.trim(), line: line.value, mobile: mobile.value } }, 'ذخیره شد.') }, 'ذخیره'),
        h('button', { class: 'btn primary', type: 'button', disabled: !s.ready, onclick: (e) => run('/api/notify/test', 'پیامک آزمایشی فرستاده شد.', e.currentTarget) }, icon('bell', 'sm'), 'پیامک آزمایشی')));
  }

  function draw() {
    const ch = s.channel;
    const chans = [['bale', 'بله', 'پیشنهادی؛ بدون فیلتر'], ['telegram', 'تلگرام', ''], ['sms', 'پیامک', 'sms.ir'], ['', 'خاموش', '']];
    const ev = s.events;
    const evToggle = (k, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!ev[k], onchange: (e) => save({ events: { [k]: e.target.checked } }) }), label);
    const hours = (k) => h('select', { 'aria-label': k === 'from' ? 'از ساعت' : 'تا ساعت', onchange: (e) => save({ quiet: { [k]: Number(e.target.value) } }) },
      Array.from({ length: 24 }, (_, i) => h('option', { value: i, selected: s.quiet[k] === i }, `ساعت ${faDigits(i)}`)));
    box.replaceChildren(
      h('section', { class: 'card' },
        h('div', { class: 'card-h' }, h('h2', null, icon('bell', 'sm'), 'یادآوری روی گوشی'),
          s.ready ? h('span', { class: 'stage s-bought' }, icon('check', 'sm'), 'فعال') : h('span', { class: 'stage' }, 'غیرفعال')),
        s.lastError ? h('div', { class: 'crm-alert' }, icon('alert'), `آخرین ارسال ناموفق بود: ${s.lastError}`) : null,
        h('div', { class: 'seg chan', role: 'group', 'aria-label': 'روش ارسال' }, chans.map(([v, t, sub]) =>
          h('button', { type: 'button', 'aria-pressed': String(ch === v), onclick: () => save({ channel: v }) }, t, sub ? h('small', null, sub) : null))),
        ch === 'bale' || ch === 'telegram' ? botPanel(ch) : ch === 'sms' ? smsPanel() : h('p', { class: 'muted' }, 'یادآوری فقط داخل ردیاب (زنگوله) نشان داده می‌شود.')),
      h('section', { class: 'card' },
        h('div', { class: 'card-h' }, h('h2', null, 'چه چیزهایی فرستاده شود؟')),
        evToggle('calls', 'وقتی وقت تماس با فروشنده رسیده (با شماره و لینک آگهی)'),
        evToggle('visits', 'یک ساعت قبل از قرار بازدید، و اگر نتیجهٔ بازدید ثبت نشده'),
        evToggle('runs', 'بعد از هر بررسی: تعداد آگهی‌های جدید و ارزان‌ترین‌ها، کاهش قیمت‌ها'),
        evToggle('needsYou', 'وقتی ربات منتظر شماست (ورود به دیوار یا کپچا)')),
      h('section', { class: 'card' },
        h('div', { class: 'card-h' }, h('h2', null, 'ساعت سکوت')),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!s.quiet.enabled, onchange: (e) => save({ quiet: { enabled: e.target.checked } }) }), 'شب‌ها پیام نفرست (بعداً، صبح فرستاده می‌شود)'),
        h('div', { class: 'crm-row', style: 'max-width:420px' }, h('span', null, 'از'), hours('from'), h('span', null, 'تا'), hours('to')),
        h('p', { class: 'muted', style: 'font-size:13px' }, 'یادآوری بازدید و «ربات منتظر شماست» همیشه فوری فرستاده می‌شوند.')));
  }
  draw();
}


// =========================================================
// Special offers
// =========================================================
// =========================================================
// «خرید با بودجه»: the best buys in a price range
// =========================================================
function budgetCity() { return (CITIES.find(([, n]) => n === reviewCity()) || ['tehran'])[0]; }

// renderBudget: see budget.js

function renderDeals(view, params) {
  const tab = ['caution', 'dealer', 'drops'].includes(params.get('view')) ? params.get('view') : '';
  const caution = tab === 'caution';
  const searchKey = params.get('search') || '';
  const modelKey = params.get('model') || '';
  const year = Number(params.get('year')) || 0;
  const city = reviewCity();
  const period = reviewPeriod();
  const base = (a) => (!searchKey || a.searches.includes(searchKey)) && inCity(a, city) && inPeriod(a, period) && !a.removed && stageOf(a) !== 'rejected';
  // «ارزان‌شده»: the seller lowered the price in the last 7 days (judged on the price bar).
  const isPick = (a, t) => { if (t === 'drops') return !!adFlags(a).priceDrop; const d = App.deals.get(a.token); return !!d && (t ? d.level === t : d.deal); };
  const picks = allAds().filter((a) => base(a) && isPick(a, tab));
  const count = (c) => allAds().filter((a) => base(a) && isPick(a, c)).length;
  const nav = (patch) => {
    const keep = { ...(searchKey ? { search: searchKey } : {}), ...(tab ? { view: tab } : {}), ...(modelKey ? { model: modelKey } : {}), ...(year ? { year } : {}) };
    location.hash = `#/deals?${new URLSearchParams(Object.entries({ ...keep, ...patch }).filter(([, v]) => v))}`;
  };
  const tabs = h('div', { class: 'stage-tabs', role: 'tablist' },
    h('button', { role: 'tab', type: 'button', 'aria-selected': String(!tab), onclick: () => nav({ view: '' }) }, icon('flame', 'sm'), 'پیشنهاد ویژه', h('small', { class: 'num' }, fa(count('')))),
    h('button', { role: 'tab', type: 'button', 'aria-selected': String(tab === 'drops'), onclick: () => nav({ view: 'drops' }) }, icon('trend', 'sm'), 'ارزان‌شده', h('small', { class: 'num' }, fa(count('drops')))),
    h('button', { role: 'tab', type: 'button', 'aria-selected': String(tab === 'dealer'), onclick: () => nav({ view: 'dealer' }) }, icon('store', 'sm'), 'نمایشگاهی', h('small', { class: 'num' }, fa(count('dealer')))),
    h('button', { role: 'tab', type: 'button', 'aria-selected': String(caution), onclick: () => nav({ view: 'caution' }) }, icon('alert', 'sm'), 'با احتیاط', h('small', { class: 'num' }, fa(count('caution')))));
  const searchSel = App.searches.length > 1 ? h('select', { class: 'search-sel', 'aria-label': 'جستجو', onchange: (e) => nav({ search: e.target.value }) },
    h('option', { value: '' }, 'همهٔ جستجوها'), App.searches.map((s) => h('option', { value: s.key, selected: s.key === searchKey }, describeCriteria(s.criteria)))) : null;

  // Model → year: deals are only comparable within the same model and model year.
  const models = new Map();
  for (const a of picks) {
    const m = P.modelOf(a.post);
    const g = models.get(m.key) || { key: m.key, label: m.label, n: 0, years: new Map() };
    g.n++;
    if (a.post.year) g.years.set(a.post.year, (g.years.get(a.post.year) || 0) + 1);
    models.set(m.key, g);
  }
  const list = Array.from(models.values()).sort((x, y) => y.n - x.n);
  const sel = models.get(modelKey);
  const modelChips = list.length > 1 || modelKey ? h('div', { class: 'quick' },
    h('button', { class: 'chip-btn', type: 'button', 'aria-pressed': String(!modelKey), onclick: () => nav({ model: '', year: '' }) }, 'همهٔ مدل‌ها', h('small', null, fa(picks.length))),
    list.map((g) => h('button', { class: 'chip-btn', type: 'button', 'aria-pressed': String(g.key === modelKey), onclick: () => nav({ model: g.key, year: '' }) }, g.label, h('small', null, fa(g.n))))) : null;
  const yearChips = sel && sel.years.size ? h('div', { class: 'quick trims' },
    h('button', { class: 'chip-btn', type: 'button', 'aria-pressed': String(!year), onclick: () => nav({ year: '' }) }, 'همهٔ سال‌ها', h('small', null, fa(sel.n))),
    Array.from(sel.years.entries()).sort((x, y) => y[0] - x[0]).map(([y, n]) => h('button', { class: 'chip-btn', type: 'button', 'aria-pressed': String(y === year), onclick: () => nav({ year: y }) }, faYear(y), h('small', null, fa(n))))) : null;
  // The market for the chosen model + year, so each deal can be judged against it.
  const market = sel && year ? App.guide.filter((g) => g.enough && g.modelKey === modelKey && g.year === year) : [];
  const marketLine = market.length ? h('div', { class: 'notice soft' }, icon('trend'), h('div', { class: 'grow' },
    market.map((g, i) => [i ? ' · ' : '', h('bdi', null, `${g.trim || g.label} ${faYear(g.year)}: `), 'بازار ', h('b', { class: 'num' }, formatPrice(g.market)), ' · خرید خوب تا ', h('b', { class: 'num' }, formatPrice(g.buyGood))]))) : null;

  const box = h('div');
  view.replaceChildren(h('div', { class: 'page wide' },
    pageHead('پیشنهاد ویژه', caution
      ? 'خیلی ارزان‌تر از بقیه، تصادفی، یا قیمتی که احتمالاً پیش‌پرداخت/اقساطی است. قبل از هر کاری با دقت بررسی کنید.'
      : tab === 'dealer'
        ? 'ارزان‌تر از هم‌مدل‌ها، ولی فروشنده نمایشگاه، واسطه یا فروشندهٔ حواله است.'
        : tab === 'drops'
          ? 'فروشنده در ۷ روز گذشته قیمت را پایین آورده. در صفحهٔ هر آگهی، نوار قیمت می‌گوید قیمت تازه عالی، خوب، معقول یا گران است.'
        : 'فقط فروشندهٔ شخصی. هر آگهی با آگهی‌های همان مدل، تیپ و سال مقایسه شده؛ کارکرد و رنگ و تعویضی (از مشخصات و توضیحات) در قیمت معمولش حساب شده.',
    [citySelect(() => render()), periodSelect(() => render()), searchSel]),
    tabs, modelChips, yearChips, marketLine, box));
  mountBrowser({
    root: box,
    key: `deals.${searchKey || 'all'}`,
    criteria: {},
    getPosts: () => allAds().filter((a) => base(a) && isPick(a, tab))
      .filter((a) => !modelKey || P.modelOf(a.post).key === modelKey)
      .filter((a) => !year || a.post.year === year)
      .map((a, i) => ({ ...a.post, isNew: false, priceChange: null, order: i })),
    title: (n) => `${caution ? 'با احتیاط' : tab === 'dealer' ? 'نمایشگاهی' : tab === 'drops' ? 'ارزان‌شده' : 'پیشنهاد ویژه'}${sel ? ` — ${sel.label}${year ? ` ${faYear(year)}` : ''}` : ''} — ${fa(n)} آگهی`,
    emptyTitle: caution ? 'آگهی مشکوکی نیست' : tab === 'dealer' ? 'آگهی نمایشگاهیِ ارزانی نیست' : tab === 'drops' ? 'این هفته کسی قیمتش را پایین نیاورده' : 'فعلاً پیشنهاد ویژه‌ای نیست',
    emptyText: tab === 'drops' ? 'وقتی فروشنده‌ای قیمتش را پایین بیاورد، اینجا می‌آید.' : 'وقتی آگهی‌ای از هم‌مدل‌ها و هم‌سال‌هایش ارزان‌تر باشد، اینجا می‌آید.',
    // the verdict of the price bar, so a lowered price can be judged from the list
    rowNote: (p) => {
      const v = p._deal && NojaDeals.priceVerdict(p.price, p._deal.expected);
      return v ? h('div', { class: `zone-note z-${v.zone}` }, ZONE_TEXT[v.zone], p._deal.approx ? ' (تقریبی)' : '', ` · خوب تا ${formatPrice(v.good)}`) : null;
    },
  });
  // Grouped: model, then newest model year, then the best deal first.
  B.sort = 'model-year';
  renderResults();
  const open = params.get('open');
  if (open) setTimeout(() => openDrawer(open), 50);
}
