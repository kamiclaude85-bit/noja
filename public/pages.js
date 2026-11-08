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
    const { id } = await api('/api/scan', { method: 'POST', body: { ...criteria, recheckAll: false } });
    location.hash = `#/run/${id}`;
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

function renderAds(view, params) {
  const viewName = AD_VIEWS[params.get('view')] ? params.get('view') : null;
  const tab = viewName ? null : (params.get('stage') || 'active');
  const searchKey = params.get('search') || '';
  const inSearch = (a) => !searchKey || a.searches.includes(searchKey);
  const ads = allAds().filter(inSearch);
  const nav = (patch) => {
    const q = new URLSearchParams({ ...(searchKey ? { search: searchKey } : {}), ...patch });
    location.hash = `#/ads?${q}`;
  };

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
    pageHead('پیگیری آگهی‌ها', 'هر آگهی را مثل یک لید پیگیری کنید: تماس، قرار بازدید، یادداشت.', [searchSel,
      h('a', { class: 'btn', href: '#/search' }, icon('plus', 'sm'), 'جستجوی جدید')]),
    tabs, quick, box));

  const title = viewName ? AD_VIEWS[viewName] : (AD_TABS.find((t) => t[0] === tab) || [null, ''])[1];
  mountBrowser({
    root: box,
    key: `ads.${searchKey || 'all'}`,
    criteria: {},
    // isNew / priceChange belong to a single run; here the stage tabs say what is new.
    getPosts: () => allAds().filter(inSearch).filter((a) => adTabMatch(adFlags(a), tab, viewName))
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
function renderSearch(view) {
  const saved = prefs.get('noja.form', {});
  const val = (k, d = '') => (saved[k] != null ? saved[k] : d);
  const cities = [['tehran', 'تهران'], ['karaj', 'کرج'], ['mashhad', 'مشهد'], ['isfahan', 'اصفهان'], ['shiraz', 'شیراز'], ['tabriz', 'تبریز'],
    ['ahvaz', 'اهواز'], ['qom', 'قم'], ['rasht', 'رشت'], ['kermanshah', 'کرمانشاه'], ['urmia', 'ارومیه'], ['kerman', 'کرمان'], ['yazd', 'یزد'],
    ['hamedan', 'همدان'], ['qazvin', 'قزوین'], ['arak', 'اراک'], ['sari', 'ساری'], ['gorgan', 'گرگان'], ['zanjan', 'زنجان'], ['ardabil', 'اردبیل'],
    ['bandar-abbas', 'بندرعباس'], ['zahedan', 'زاهدان'], ['iran', 'سراسر ایران']];
  const select = h('select', { name: 'city' }, cities.map(([v, t]) => h('option', { value: v, selected: val('city', 'tehran') === v }, t)));
  const speed = h('select', { name: 'speed' },
    [['slow', 'آهسته — طبیعی‌ترین رفتار'], ['normal', 'معمولی'], ['fast', 'سریع']].map(([v, t]) => h('option', { value: v, selected: val('speed', 'normal') === v }, t)));

  const err = h('p', { class: 'form-error', role: 'alert' });
  const go = h('button', { class: 'btn primary lg', type: 'submit' }, icon('search'), 'پیدا کن');
  const form = h('form', { class: 'search-card', autocomplete: 'off', novalidate: true },
    h('div', { class: 'search-main' },
      h('label', { class: 'field-big' }, h('span', { class: 'sr-only' }, 'نام خودرو'), icon('car', 'lg'),
        h('input', { name: 'query', placeholder: 'چه ماشینی؟ مثلاً پژو ۲۰۶', value: val('query'), autofocus: true })),
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
        h('label', { class: 'field' }, h('span', null, 'حداکثر آگهی جدید در هر بار'), h('input', { name: 'maxAds', inputmode: 'numeric', value: val('maxAds', '150') }),
          h('span', { class: 'help' }, 'آگهی‌هایی که قبلاً خوانده شده‌اند دوباره باز نمی‌شوند')),
        h('label', { class: 'field' }, h('span', null, 'سرعت ربات'), speed),
        h('label', { class: 'field' }, h('span', null, 'سقف آگهی در روز'), h('input', { name: 'dailyLimit', inputmode: 'numeric', value: val('dailyLimit', String(App.state.dailyLimit || 300)) }),
          h('span', { class: 'help' }, `امروز ${fa(App.state.today || 0)} آگهی باز شده`)),
        h('label', { class: 'field wide' }, h('span', null, 'یا لینک یک جستجوی فیلترشده در دیوار'),
          h('input', { name: 'searchUrl', dir: 'ltr', placeholder: 'https://divar.ir/s/tehran/car/peugeot/206?...', value: val('searchUrl') }),
          h('span', { class: 'help' }, 'اگر خودتان در دیوار برند، تیپ یا رنگ را فیلتر کرده‌اید، لینک صفحه را اینجا بگذارید.')),
        h('label', { class: 'check wide' }, h('input', { type: 'checkbox', name: 'strictYear', checked: !!saved.strictYear }), 'آگهی‌هایی که سالشان معلوم نیست حذف شوند'),
        h('label', { class: 'check wide' }, h('input', { type: 'checkbox', name: 'recheckAll' }), 'این بار همهٔ آگهی‌ها دوباره باز شوند (کندتر؛ معمولاً لازم نیست)'))),
    err);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const data = Object.fromEntries(new FormData(form).entries());
    data.strictYear = form.elements.strictYear.checked;
    data.recheckAll = form.elements.recheckAll.checked;
    prefs.set('noja.form', { ...data, recheckAll: false });
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

  const notices = [];
  if (App.state.busy) {
    notices.push(h('div', { class: 'notice' }, icon('loader'), h('div', { class: 'grow' }, 'ربات در حال یک جستجوی دیگر است.'),
      h('a', { class: 'btn sm', href: `#/run/${encodeURIComponent(App.state.busy)}` }, 'دیدن پیشرفت')));
  }
  if (App.state.loggedIn === false && !App.offline) {
    notices.push(h('div', { class: 'notice' }, icon('login'),
      h('div', { class: 'grow' }, h('b', null, 'یک بار وارد حساب دیوار شوید. '), 'می‌توانید همین حالا جستجو را شروع کنید؛ ربات صبر می‌کند تا وارد شوید.'),
      h('button', { class: 'btn sm', type: 'button', onclick: () => api('/api/login', { method: 'POST' }).catch(() => {}) }, 'ورود به دیوار')));
  }
  const steps = [
    ['دیوار را باز می‌کند', 'در کروم خودش و با حساب شما، مثل یک کاربر معمولی جستجو می‌کند.'],
    ['فقط آگهی‌های جدید را می‌خواند', 'آگهی‌ای که یک بار خوانده شده دیگر باز نمی‌شود؛ مگر قیمتش عوض شده باشد.'],
    ['برای پیگیری آماده می‌کند', 'شخصی و نمایشگاهی جدا، با قیمت میانه؛ بعد تماس و بازدید را پیگیری کنید.'],
  ];
  view.replaceChildren(h('div', { class: 'page narrow' },
    h('h1', { class: 'hero-title' }, 'همهٔ آگهی‌های ماشینِ موردنظرت، یک‌جا'),
    h('p', { class: 'lead' }, 'نوجا در دیوار می‌گردد، آگهی‌ها را باز می‌کند و مشخصات را برایت مرتب می‌کند. تو فقط انتخاب کن.'),
    form, ...notices,
    h('div', { class: 'steps' }, steps.map(([t, s], i) => h('div', { class: 'step' }, h('span', { class: 'n' }, fa(i + 1)), h('div', null, h('b', null, t), h('span', null, s)))))));
}

// =========================================================
// Runs (history)
// =========================================================
function renderRuns(view) {
  const STATUS = { done: 'تمام شده', stopped: 'متوقف شده', error: 'خطا' };
  const runs = App.state.runs || [];
  view.replaceChildren(h('div', { class: 'page' },
    pageHead('جستجوها', 'جستجوهای ذخیره‌شده و تاریخچهٔ اجرای ربات.', h('a', { class: 'btn primary', href: '#/search' }, icon('plus', 'sm'), 'جستجوی جدید')),
    App.searches.length ? h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, icon('search', 'sm'), 'جستجوهای ذخیره‌شده')),
      h('ul', { class: 'items' }, App.searches.map((s) => h('li', { class: 'item' },
        h('a', { class: 'item-main', href: `#/ads?search=${encodeURIComponent(s.key)}` }, h('b', null, describeCriteria(s.criteria)),
          h('small', null, `${fa(s.count)} آگهی${s.lastRunAt ? ` · آخرین بررسی ${agoFa(s.lastRunAt)}` : ''}`)),
        h('div', { class: 'item-actions' }, s.criteria ? h('button', { class: 'btn sm', type: 'button', disabled: !!App.state.busy, onclick: () => rerunSearch(s.criteria) },
          icon('refresh', 'sm'), 'بررسی جدیدها') : null))))) : null,
    h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, icon('history', 'sm'), 'اجراهای ربات')),
      runs.length ? h('ul', { class: 'items' }, runs.map((r) => h('li', { class: 'item' },
        h('a', { class: 'item-main', href: `#/run/${encodeURIComponent(r.id)}` }, h('b', null, describeCriteria(r.criteria)),
          h('small', null, `${new Date(r.createdAt).toLocaleString('fa-IR', { dateStyle: 'medium', timeStyle: 'short' })} · ${fa(r.read)} آگهی${r.newCount != null ? ` (${fa(r.newCount)} جدید)` : ''}`)),
        h('div', { class: 'item-actions' }, h('span', { class: 'muted' }, ACTIVE_RUN.includes(r.status) ? 'در حال انجام' : (STATUS[r.status] || r.status))))))
        : h('p', { class: 'muted empty-line' }, 'هنوز جستجویی انجام نشده.'))));
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
        getPosts: () => (RUN && RUN.run ? RUN.run.posts : []),
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
  try { await api(`/api/runs/${encodeURIComponent(RUN.id)}/${action}`, { method: 'POST' }); } catch (_) { /* ignore */ }
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
      actions = [btn('کافیه، برو سراغ آگهی‌ها', 'right', () => runControl('stop'))];
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
    h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, icon('database', 'sm'), 'پشتیبان‌ها')), list)));
  load().catch((e) => toast(e.message, 'err'));
}

// =========================================================
// Settings: reminders on the phone
// =========================================================
async function renderSettings(view) {
  let s = await api('/api/settings/notify').catch(() => null);
  if (!s) { view.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'empty' }, 'ارتباط با ربات برقرار نیست.'))); return; }
  const box = h('div');
  view.replaceChildren(h('div', { class: 'page narrow-ish' },
    pageHead('تنظیمات', 'یادآوری تماس‌ها، بازدیدها و آگهی‌های جدید را روی گوشی‌تان بگیرید.'), box));

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
      step(3, 'وصل کنید', h('p', null, cfg.chatId ? ['وصل است به: ', h('b', null, cfg.chatName || cfg.chatId)] : 'نوجا پیام شما را پیدا می‌کند و از این به بعد یادآوری‌ها را برایتان می‌فرستد.'),
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
        ch === 'bale' || ch === 'telegram' ? botPanel(ch) : ch === 'sms' ? smsPanel() : h('p', { class: 'muted' }, 'یادآوری فقط داخل نوجا (زنگوله) نشان داده می‌شود.')),
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
