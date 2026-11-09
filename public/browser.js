'use strict';
/* =========================================================
   Listing component: filters + rows/table + drawer (with follow-up) + compare
   One instance on screen at a time (module state `B`).
   ========================================================= */

let B = null;

function defaultFilters(c = {}) {
  return {
    seller: 'all',
    priceMin: c.priceMin ? String(Math.round(c.priceMin / 1e6)) : '', priceMax: c.priceMax ? String(Math.round(c.priceMax / 1e6)) : '',
    yearMin: c.yearMin ? String(c.yearMin) : '', yearMax: c.yearMax ? String(c.yearMax) : '',
    kmMax: c.mileageMax ? String(c.mileageMax) : '',
    gearbox: [], color: [],
    bodyOk: false, engineOk: false, priced: false, tracking: false, onlyNew: false, hideSold: false,
    keyword: c.keyword || '',
    strictYear: !!c.strictYear,
  };
}

/**
 * opts: { root, key, criteria, getPosts, showOnlyNew, title(n), emptyText, active(), below }
 */
function mountBrowser(opts) {
  B = {
    opts,
    posts: [],
    filters: { ...defaultFilters(opts.criteria), ...prefs.get(`noja.filters.${opts.key}`, {}) },
    sort: prefs.get('noja.sort', 'default'),
    view: prefs.get('noja.view', 'list'),
    q: '',
    compare: new Set(),
    rows: new Map(),
    optSig: '',
    list: [],
    median: null,
  };
  opts.root.replaceChildren(
    h('div', { class: 'run' },
      h('aside', { class: 'filters', id: 'filters', 'aria-label': 'فیلترها' }),
      h('section', { class: 'results-col' },
        h('div', { class: 'results-head', id: 'resultsHead' }),
        h('div', { id: 'results' }, skeletons()),
        h('div', { id: 'belowBox' }))),
    h('div', { id: 'trayBox' }));
  refreshBrowser();
}

function unmountBrowser() { B = null; closeOverlay(); }

function skeletons() { return h('div', { class: 'list' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' })); }

function refreshBrowser(force) {
  if (!B) return;
  B.posts = B.opts.getPosts().map(enrich);
  renderFilters(force);
  renderResults();
  if (overlay && overlay.kind === 'drawer') {
    const el = document.activeElement;
    const typing = el && /INPUT|TEXTAREA/.test(el.tagName) && overlay.nodes.some((n) => n.contains(el));
    if (!typing) openDrawer(overlay.token, true);
  }
}

// ---------- filtering ----------
const numIn = (v) => { const n = P.parseNumber(v); return n == null ? null : n; };

function passes(p, f, skip) {
  if (skip !== 'seller' && f.seller !== 'all' && p.seller !== f.seller) return false;
  const yMin = numIn(f.yearMin) != null ? P.normalizeYear(numIn(f.yearMin)) : null;
  const yMax = numIn(f.yearMax) != null ? P.normalizeYear(numIn(f.yearMax)) : null;
  if (p.year != null) {
    if (yMin != null && p.year < yMin) return false;
    if (yMax != null && p.year > yMax) return false;
  } else if (f.strictYear && (yMin != null || yMax != null)) return false;
  const pMin = numIn(f.priceMin); const pMax = numIn(f.priceMax);
  if (p.price != null) {
    if (pMin != null && p.price < pMin * 1e6) return false;
    if (pMax != null && p.price > pMax * 1e6) return false;
  } else if (f.priced) return false;
  const kMax = numIn(f.kmMax);
  if (kMax != null && p.mileage != null && p.mileage > kMax) return false;
  if (skip !== 'gearbox' && f.gearbox.length && !f.gearbox.includes(p.gearbox)) return false;
  if (skip !== 'color' && f.color.length && !f.color.includes(p.color)) return false;
  if (f.bodyOk && conditionClass(p.body) !== 'good') return false;
  if (f.engineOk && (!p.engine || conditionClass(p.engine) === 'bad')) return false;
  if (f.tracking && !App.meta.activeStages.includes(p._f.stage)) return false;
  if (f.onlyNew && !p.isNew && !p.priceChange) return false;
  if (f.hideSold && p._f.sold) return false;
  if (B.opts.extraFilter && !B.opts.extraFilter(p)) return false;
  if (f.keyword) {
    const hay = P.normalizeText(`${p.title} ${p.brand}`);
    if (!P.normalizeText(f.keyword).split(' ').filter(Boolean).every((w) => hay.includes(w))) return false;
  }
  if (B.q) {
    const c = (p._ad && p._ad.crm) || {};
    const hay = P.normalizeText([p.title, p.subtitle, p.color, p.brand, p.body, p.engine, p.chassis, p.gearbox, p.description, c.phone,
      ...(c.notes || []).map((n) => n.text)].join(' '));
    if (!P.normalizeText(B.q).split(' ').every((w) => hay.includes(w))) return false;
  }
  return true;
}

function saveFilters() { prefs.set(`noja.filters.${B.opts.key}`, B.filters); }
function setFilter(patch) {
  Object.assign(B.filters, patch);
  saveFilters();
  renderFilters(true);
  renderResults();
}
function resetFilters() {
  B.filters = defaultFilters({});
  B.q = '';
  saveFilters();
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
  if (!box) return;
  const f = B.filters;
  const posts = B.posts;
  const fresh = posts.filter((p) => p.isNew || p.priceChange).length;
  const optSig = JSON.stringify([countBy(posts, 'gearbox').map((x) => x[0]), countBy(posts, 'color').map((x) => x[0]), f, fresh, posts.length]);
  if (!force && optSig === B.optSig && box.childElementCount) { updateSellerCounts(); return; }
  if (!force && box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') { updateSellerCounts(); return; }
  B.optSig = optSig;

  const rangeInput = (key, ph) => {
    const input = h('input', { inputmode: 'numeric', placeholder: ph, value: f[key], 'aria-label': ph });
    let t = null;
    input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { B.filters[key] = input.value; saveFilters(); renderResults(); }, 300); });
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

  const search = h('input', { type: 'search', placeholder: 'جستجو (محله، رنگ، شماره، یادداشت…)', value: B.q, 'aria-label': 'جستجو در آگهی‌ها' });
  let st = null;
  search.addEventListener('input', () => { clearTimeout(st); st = setTimeout(() => { B.q = search.value.trim(); renderResults(); }, 200); });

  box.replaceChildren(...[
    h('div', { class: 'filters-head' }, h('b', null, icon('sliders', 'sm'), 'فیلترها'),
      h('button', { class: 'btn ghost sm', type: 'button', onclick: resetFilters }, 'پاک کردن همه')),
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
      B.opts.showOnlyNew ? toggle('onlyNew', `فقط جدیدها و تغییر قیمت‌ها (${fa(fresh)})`) : null,
      toggle('bodyOk', 'فقط بدنهٔ سالم / بی‌رنگ'),
      toggle('engineOk', 'موتور سالم'),
      toggle('priced', 'فقط آگهی‌های قیمت‌دار'),
      toggle('tracking', 'فقط آگهی‌های در حال پیگیری'),
      toggle('hideSold', 'آگهی‌های حذف‌شده از دیوار را نشان نده')),
    f.keyword ? h('div', { class: 'fgroup' }, h('span', { class: 'label' }, 'کلمهٔ لازم در عنوان'),
      h('button', { class: 'tag', type: 'button', onclick: () => setFilter({ keyword: '' }), 'aria-label': `حذف ${f.keyword}` }, f.keyword, icon('x'))) : null,
  ].filter(Boolean));
  updateSellerCounts();
}

function updateSellerCounts() {
  const seg = $('#sellerSeg');
  if (!seg) return;
  const base = B.posts.filter((p) => passes(p, B.filters, 'seller'));
  const counts = { all: base.length, personal: base.filter((p) => p.seller === 'personal').length, dealer: base.filter((p) => p.seller === 'dealer').length };
  for (const b of $$('button', seg)) $('small', b).textContent = fa(counts[b.dataset.v]);
}

// ---------- results ----------
function sortList(list) {
  const by = (fn, dir) => (a, b) => {
    const x = fn(a); const y = fn(b);
    if (x == null && y == null) return (a.order || 0) - (b.order || 0);
    if (x == null) return 1;
    if (y == null) return -1;
    return dir * (x - y) || (a.order || 0) - (b.order || 0);
  };
  switch (B.sort) {
    case 'price-asc': return list.sort(by((p) => p.price, 1));
    case 'price-desc': return list.sort(by((p) => p.price, -1));
    case 'km-asc': return list.sort(by((p) => p.mileage, 1));
    case 'year-desc': return list.sort(by((p) => p.year, -1));
    case 'published': return list.sort(by((p) => p.publishedAt || null, -1));
    case 'model-year': {
      // biggest model first, then the newest model year, then the best deal / cheapest
      const size = new Map();
      for (const p of list) { const k = P.modelOf(p).key; size.set(k, (size.get(k) || 0) + 1); }
      return list.sort((a, b) => {
        const ka = P.modelOf(a).key; const kb = P.modelOf(b).key;
        return (size.get(kb) - size.get(ka)) || ka.localeCompare(kb) || (b.year || 0) - (a.year || 0)
          || ((b._deal ? b._deal.score : -1) - (a._deal ? a._deal.score : -1)) || (a.price || 0) - (b.price || 0);
      });
    }
    case 'deal': return list.sort(by((p) => (p._deal ? p._deal.score : null), -1));
    case 'next-call': return list.sort(by((p) => (p._ad && p._ad.crm && p._ad.crm.nextCallAt) || null, 1));
    case 'updated': return list.sort(by((p) => (p._ad && p._ad.crm && p._ad.crm.updatedAt) || (p._ad && p._ad.firstSeenAt) || null, -1));
    default: return list.sort((a, b) => (a.order || 0) - (b.order || 0));
  }
}

function delta(p, med) {
  // Prefer the usual price of the same model+year (special-offer analysis) over the list median.
  if (p._deal && p._deal.expected && p.price) {
    const r = p.price / p._deal.expected;
    if (r <= 0.95) return { cls: 'low', text: `${fa(Math.round((1 - r) * 100))}٪ زیر قیمت معمول` };
    if (r >= 1.05) return { cls: 'high', text: `${fa(Math.round((r - 1) * 100))}٪ بالای قیمت معمول` };
    return null;
  }
  if (!med || !p.price) return null;
  const r = p.price / med;
  if (r <= 0.92) return { cls: 'low', text: `${fa(Math.round((1 - r) * 100))}٪ زیر میانه` };
  if (r >= 1.08) return { cls: 'high', text: `${fa(Math.round((r - 1) * 100))}٪ بالای میانه` };
  return null;
}

function priceChangeOf(p) {
  if (p.priceChange) return p.priceChange;
  if (p._f && p._f.priceDrop) return p._f.priceDrop;
  return null;
}

function priceChangeBadge(p) {
  const pc = priceChangeOf(p);
  if (!pc || pc.from == null) return null;
  const diff = pc.to - pc.from;
  return h('span', { class: `delta ${diff < 0 ? 'low' : 'high'}`, title: `قبلاً ${formatPrice(pc.from)} تومان` },
    `${formatPrice(Math.abs(diff))} ${diff < 0 ? 'ارزان‌تر شد' : 'گران‌تر شد'}`);
}

function renderResults() {
  if (!B || !$('#results')) return;
  const list = sortList(B.posts.filter((p) => passes(p, B.filters)));
  const med = P.median(list.map((p) => p.price).filter((n) => n > 0));
  B.median = med;
  B.list = list;
  const active = B.opts.active ? B.opts.active() : false;

  const prices = list.map((p) => p.price).filter((n) => n > 0);
  const summary = [];
  const fresh = list.filter((p) => p.isNew).length;
  if (fresh) summary.push(h('span', { class: 'new-pill' }, `${fa(fresh)} جدید`), ' ');
  if (med) summary.push(h('span', null, 'میانهٔ قیمت ', h('b', null, formatPrice(med))));
  if (prices.length) summary.push(h('span', null, ' · ارزان‌ترین ', h('b', null, formatPrice(Math.min(...prices)))));
  const personal = list.filter((p) => p.seller === 'personal').length;
  if (list.length) summary.push(h('span', null, ` · ${fa(personal)} شخصی، ${fa(list.length - personal)} نمایشگاهی`));

  const sortOpts = [['default', 'جدیدترین در دیوار'], ['price-asc', 'ارزان‌ترین'], ['price-desc', 'گران‌ترین'], ['km-asc', 'کم‌کارکردترین'], ['year-desc', 'جدیدترین مدل'], ['published', 'تازه‌ترین انتشار'], ['model-year', 'مدل و سال'],
    ['deal', 'بهترین پیشنهاد'], ['updated', 'آخرین پیگیری'], ['next-call', 'نزدیک‌ترین تماس']];
  const sortSel = h('select', { 'aria-label': 'مرتب‌سازی', onchange: (e) => { B.sort = e.target.value; prefs.set('noja.sort', B.sort); renderResults(); } },
    sortOpts.map(([v, t]) => h('option', { value: v, selected: B.sort === v }, t)));
  const viewBtn = (v, ic, label) => h('button', { type: 'button', 'aria-pressed': String(B.view === v), 'aria-label': label, title: label,
    onclick: () => { B.view = v; prefs.set('noja.view', v); B.rows.clear(); renderResults(); } }, icon(ic));

  $('#resultsHead').replaceChildren(
    h('div', null,
      h('h2', null, B.opts.title ? B.opts.title(list.length) : `${fa(list.length)} آگهی`,
        B.posts.length !== list.length ? h('span', { class: 'muted', style: 'font-size:15px;font-weight:400' }, ` از ${fa(B.posts.length)}`) : null),
      h('div', { class: 'summary' }, summary)),
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn filters-toggle', type: 'button', onclick: () => $('#filters').classList.add('open') }, icon('sliders', 'sm'), 'فیلترها'),
      sortSel,
      h('div', { class: 'toggle', role: 'group', 'aria-label': 'نحوهٔ نمایش' }, viewBtn('list', 'list', 'نمایش فهرستی'), viewBtn('table', 'table', 'نمایش جدولی')),
      h('button', { class: 'btn icon-only', type: 'button', title: 'خروجی اکسل (CSV)', 'aria-label': 'خروجی اکسل', onclick: exportCsv }, icon('download'))));

  const box = $('#results');
  if (!list.length) {
    if (!B.posts.length && active) box.replaceChildren(skeletons());
    else if (!B.posts.length) box.replaceChildren(h('div', { class: 'empty' }, icon('search'), h('b', null, B.opts.emptyTitle || 'آگهی‌ای نیست'), B.opts.emptyText || ''));
    else {
      box.replaceChildren(h('div', { class: 'empty' }, icon('sliders'), h('b', null, 'هیچ آگهی‌ای با این فیلترها نیست'),
        h('p', null, `${fa(B.posts.length)} آگهی هست، ولی فیلترها همه را کنار گذاشته‌اند.`),
        h('button', { class: 'btn', type: 'button', onclick: resetFilters }, 'پاک کردن فیلترها')));
    }
    B.rows.clear();
  } else if (B.view === 'table') {
    box.replaceChildren(renderTable(list, med));
    B.rows.clear();
  } else {
    let ul = $('.list', box);
    if (!ul || $('.skeleton', box) || $('.empty', box)) { ul = h('div', { class: 'list' }); box.replaceChildren(ul); B.rows.clear(); }
    const seen = new Set();
    list.forEach((p, i) => {
      const d = delta(p, med);
      const c = (p._ad && p._ad.crm) || {};
      const sig = `${B.compare.has(p.token)}|${d ? d.text : ''}|${c.updatedAt || 0}|${p._f.sold}|${p._f.callDue}|${p.price}|${p._deal ? `${p._deal.level}${p._deal.discount.toFixed(3)}` : ''}`;
      let entry = B.rows.get(p.token);
      if (!entry || entry.sig !== sig) {
        const el = renderRow(p, d);
        if (entry) { entry.el.replaceWith(el); el.style.animation = 'none'; }
        entry = { el, sig };
        B.rows.set(p.token, entry);
      }
      seen.add(p.token);
      if (ul.children[i] !== entry.el) ul.insertBefore(entry.el, ul.children[i] || null);
    });
    for (const [token, entry] of B.rows) if (!seen.has(token)) { entry.el.remove(); B.rows.delete(token); }
    // «مدل و سال»: a small heading above the first ad of each model + year.
    let prev = '';
    list.forEach((p) => {
      const el = B.rows.get(p.token).el;
      const m = P.modelOf(p);
      const key = `${m.key}|${p.year || ''}`;
      if (B.sort === 'model-year' && key !== prev) el.dataset.group = `${m.label}${p.year ? ` · ${faYear(p.year)}` : ''}`;
      else delete el.dataset.group;
      prev = key;
    });
    const sk = $('.skeleton', ul);
    if (active) { if (!sk) ul.append(h('div', { class: 'skeleton', 'aria-hidden': 'true' })); else ul.append(sk); } else if (sk) sk.remove();
  }
  if (B.opts.below) $('#belowBox').replaceChildren(B.opts.below() || '');
  renderTray();
}

function followLine(p) {
  const f = p._f;
  const c = (p._ad && p._ad.crm) || {};
  const bits = [];
  if (f.sold) bits.push(h('span', { class: 'cond bad' }, icon('alert'), 'از دیوار حذف شد (احتمالاً فروخته شد)'));
  if (f.visitOverdue) bits.push(h('span', { class: 'cond bad' }, icon('alert'), 'نتیجهٔ بازدید ثبت نشده'));
  else if (f.stage === 'visit' && c.visitAt) bits.push(h('span', { class: 'cond info' }, icon('calendar'), `بازدید ${whenFa(c.visitAt)}`));
  if (c.nextCallAt && !['bought', 'rejected'].includes(f.stage)) {
    bits.push(h('span', { class: `cond ${f.callDue ? 'warn' : 'info'}` }, icon('phone'), f.callDue ? `وقت تماس است (${whenFa(c.nextCallAt)})` : `تماس ${whenFa(c.nextCallAt)}`));
  }
  if (f.missed) bits.push(h('span', { class: 'cond' }, `${fa(f.missed)} بار جواب نداد`));
  if (c.phone) bits.push(h('span', { class: 'cond num', dir: 'ltr' }, faDigits(c.phone)));
  if (f.stage === 'rejected' && c.rejectReason) bits.push(h('span', { class: 'cond' }, `دلیل حذف: ${c.rejectReason}`));
  return bits;
}

function renderRow(p, d) {
  const img = safeImg((p.images || [])[0]);
  const f = p._f;
  const cmp = B.compare.has(p.token);
  const shortlisted = f.stage === 'shortlist';
  const cond = (label, value) => {
    if (!value) return null;
    const c = conditionClass(value);
    return h('span', { class: `cond${c ? ` ${c}` : ''}`, title: `${label}: ${value}` }, c === 'bad' ? icon('alert') : c === 'good' ? icon('check') : null, `${label}: ${value}`);
  };
  const follow = followLine(p);
  return h('article', { class: `row${f.sold ? ' sold' : ''}${f.callDue ? ' due' : ''}`, tabindex: '0', 'aria-label': p.title, 'data-token': p.token,
    onclick: () => openDrawer(p.token), onkeydown: (e) => { if (e.key === 'Enter') openDrawer(p.token); } },
    h('div', { class: 'thumb' },
      img ? h('img', { src: img, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : icon('image', 'lg'),
      p.images && p.images.length > 1 ? h('span', { class: 'count' }, icon('image', 'sm'), fa(p.images.length)) : null),
    h('div', { class: 'row-main' },
      h('div', { class: 'row-top' }, f.stage !== 'new' ? stageChip(f.stage) : null, p.isNew ? h('span', { class: 'new-pill' }, 'جدید') : null),
      h('h3', null, p.title || 'بدون عنوان'),
      publishedLine(p),
      h('div', { class: 'facts' },
        p.year || p.yearText ? h('span', null, icon('calendar'), p.year ? faYear(p.year) : p.yearText) : null,
        p.mileage != null || p.mileageText ? h('span', { class: 'num' }, icon('gauge'), p.mileage != null ? `${fa(p.mileage)} کیلومتر` : p.mileageText) : null,
        p.gearbox ? h('span', null, icon('gear'), p.gearbox) : null,
        p.color ? h('span', null, icon('palette'), p.color) : null),
      h('div', { class: 'conds' }, follow.length ? follow : [cond('بدنه', p.body), cond('موتور', p.engine), conditionClass(p.chassis) === 'bad' ? cond('شاسی', p.chassis) : null, ...valueChips(p, 3)])),
    h('div', { class: 'row-side' },
      p.price ? h('div', { class: 'price num' }, formatPrice(p.price), ' ', h('small', null, 'تومان')) : h('div', { class: 'price none' }, p.priceText || 'بدون قیمت'),
      dealBadge(p._deal),
      d ? h('span', { class: `delta ${d.cls}` }, icon('trend', 'sm'), d.text) : null,
      priceChangeBadge(p),
      sellerBadge(p),
      h('div', { class: 'row-actions' },
        ['new', 'shortlist'].includes(f.stage) ? h('button', { class: 'btn ghost icon-only sm star', type: 'button', 'aria-pressed': String(shortlisted),
          'aria-label': shortlisted ? 'برداشتن از فهرست کوتاه' : 'افزودن به فهرست کوتاه', title: shortlisted ? 'برداشتن از فهرست کوتاه' : 'افزودن به فهرست کوتاه',
          onclick: (e) => { e.stopPropagation(); App.crm(p.token, { action: 'stage', stage: shortlisted ? 'new' : 'shortlist' }); } }, icon('star')) : null,
        h('button', { class: 'btn ghost icon-only sm cmp-toggle', type: 'button', 'aria-pressed': String(cmp), 'aria-label': 'افزودن به مقایسه', title: 'افزودن به مقایسه',
          onclick: (e) => { e.stopPropagation(); toggleCompare(p.token); } }, icon('compare')),
        safeDivarUrl(p.url) ? h('a', { class: 'btn ghost icon-only sm', href: safeDivarUrl(p.url), target: '_blank', rel: 'noopener', 'aria-label': 'باز کردن در دیوار', title: 'باز کردن در دیوار',
          onclick: (e) => e.stopPropagation() }, icon('external')) : null)));
}

function renderTable(list, med) {
  const cols = [['', null], ['عنوان', null], ['مرحله', null], ['فروشنده', null], ['قیمت', 'price'], ['مدل', 'year'], ['کارکرد', 'km'],
    ['رنگ', null], ['گیربکس', null], ['بدنه', null], ['تماس بعدی', null], ['محل', null]];
  const sortFor = { price: 'price-asc', year: 'year-desc', km: 'km-asc' };
  const head = h('tr', null, cols.map(([t, k]) => h('th', null, k
    ? h('button', { type: 'button', onclick: () => { B.sort = k === 'price' && B.sort === 'price-asc' ? 'price-desc' : sortFor[k]; prefs.set('noja.sort', B.sort); renderResults(); } }, t, icon('sort', 'sm'))
    : t)));
  const rows = list.map((p) => {
    const img = safeImg((p.images || [])[0]);
    const d = delta(p, med);
    const c = (p._ad && p._ad.crm) || {};
    const cell = (v, cls) => h('td', cls ? { class: cls } : null, v || '—');
    return h('tr', { onclick: () => openDrawer(p.token), class: p._f.sold ? 'sold' : null },
      h('td', null, img ? h('img', { src: img, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : ''),
      h('td', { class: 't' }, p.title),
      h('td', null, stageChip(p._f.stage)),
      h('td', null, sellerBadge(p)),
      h('td', { class: 'num' }, p.price ? formatPrice(p.price) : (p.priceText || '—'), d ? h('div', null, h('span', { class: `delta ${d.cls}` }, d.text)) : null),
      cell(p.year ? faYear(p.year) : p.yearText),
      cell(p.mileage != null ? fa(p.mileage) : p.mileageText, 'num'),
      cell(p.color), cell(p.gearbox), cell(p.body, conditionClass(p.body)),
      cell(c.nextCallAt ? whenFa(c.nextCallAt) : '', p._f.callDue ? 'bad' : null),
      cell([P.placeOf(p.subtitle), p.publishedAt ? `انتشار ${p.publishedApprox ? roughAgoFa(p.publishedAt) : agoFa(p.publishedAt)}` : ''].filter(Boolean).join(' · ')));
  });
  return h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, head), h('tbody', null, rows)));
}

function toggleCompare(token) {
  if (B.compare.has(token)) B.compare.delete(token);
  else if (B.compare.size >= 4) { toast('حداکثر ۴ آگهی را می‌شود با هم مقایسه کرد.', 'err'); return; } else B.compare.add(token);
  renderResults();
  if (overlay && overlay.token === token) openDrawer(token, true);
}

function renderTray() {
  const box = $('#trayBox');
  if (!box) return;
  if (!B.compare.size) { box.replaceChildren(); return; }
  box.replaceChildren(h('div', { class: 'tray', role: 'region', 'aria-label': 'مقایسه' },
    icon('compare'), `${fa(B.compare.size)} آگهی برای مقایسه`,
    h('button', { class: 'btn primary sm', type: 'button', disabled: B.compare.size < 2, onclick: openCompare }, 'مقایسه کن'),
    h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { B.compare.clear(); renderResults(); } }, 'پاک کردن')));
}

// ---------- overlays ----------
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

function openOverlay(nodes, onKey, extra) {
  const returnFocus = overlay ? overlay.returnFocus : document.activeElement;
  if (overlay) { overlay.nodes.forEach((n) => n.remove()); document.removeEventListener('keydown', overlay.onKey); }
  const keyHandler = (e) => { if (e.key === 'Escape') closeOverlay(); else if (onKey) onKey(e); };
  document.addEventListener('keydown', keyHandler);
  document.body.style.overflow = 'hidden';
  nodes.forEach((n) => document.body.append(n));
  overlay = { nodes, onKey: keyHandler, returnFocus, ...extra };
}

/** Small dialog (used for «حذف با دلیل»). */
function openDialog(title, body, actions) {
  const prev = overlay;
  const back = h('div', { class: 'scrim top', onclick: () => close() });
  const dlg = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('h3', null, title), body, h('div', { class: 'dialog-actions' }, actions(close)));
  function close() { back.remove(); dlg.remove(); document.removeEventListener('keydown', esc, true); }
  function esc(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
  document.addEventListener('keydown', esc, true);
  document.body.append(back, dlg);
  const first = $('button, input, textarea', dlg);
  if (first) first.focus();
  void prev;
  return close;
}

function rejectDialog(token) {
  let reason = '';
  const note = h('textarea', { rows: 2, placeholder: 'توضیح (اختیاری)' });
  const chips = h('div', { class: 'chips' }, App.meta.rejectReasons.map((r) => h('button', {
    class: 'chip-btn', type: 'button', 'aria-pressed': 'false',
    onclick: (e) => { reason = r; $$('button', chips).forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); },
  }, r)));
  openDialog('چرا این آگهی حذف شود؟', h('div', null, chips, note), (close) => [
    h('button', { class: 'btn ghost', type: 'button', onclick: close }, 'انصراف'),
    h('button', { class: 'btn danger', type: 'button', onclick: async () => {
      if (!reason) { toast('یک دلیل انتخاب کنید.', 'err'); return; }
      const full = note.value.trim() ? `${reason} — ${note.value.trim()}` : reason;
      await App.crm(token, { action: 'reject', reason: full });
      close();
      toast('به «حذف‌شده‌ها» رفت. هر وقت خواستید برمی‌گردد.');
    } }, icon('trash', 'sm'), 'حذف'),
  ]);
}

// ---------- drawer (ad details + follow-up) ----------
function quickTimes() {
  const now = new Date();
  const at = (days, hour) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d.getTime(); };
  const list = [['۱ ساعت بعد', Date.now() + 60 * 60 * 1000]];
  if (now.getHours() < 17) list.push(['امروز ساعت ۱۸', at(0, 18)]);
  list.push(['فردا ۱۰ صبح', at(1, 10)], ['فردا ۱۸', at(1, 18)], ['پس‌فردا ۱۰ صبح', at(2, 10)]);
  return list;
}

function crmSection(p) {
  const ad = p._ad;
  if (!ad) return h('div', { class: 'crm muted' }, 'این آگهی هنوز در حافظه نیست.');
  const c = ad.crm || {};
  const f = p._f;
  const act = (body) => App.crm(p.token, body);

  if (f.stage === 'rejected') {
    return h('div', { class: 'crm' }, h('div', { class: 'crm-rejected' }, icon('trash'),
      h('div', { class: 'grow' }, h('b', null, 'حذف شده'), h('div', null, c.rejectReason || '')),
      h('button', { class: 'btn sm', type: 'button', onclick: () => act({ action: 'restore' }) }, icon('undo', 'sm'), 'برگرداندن')),
    timeline(c));
  }

  const stageSel = h('select', { 'aria-label': 'مرحلهٔ پیگیری', onchange: (e) => act({ action: 'stage', stage: e.target.value }) },
    Object.entries(App.meta.stages).filter(([k]) => k !== 'rejected').map(([k, v]) => h('option', { value: k, selected: f.stage === k }, v)));

  const phone = h('input', { type: 'tel', dir: 'ltr', placeholder: 'شمارهٔ فروشنده', value: c.phone || '', 'aria-label': 'شمارهٔ فروشنده',
    onchange: (e) => act({ action: 'set', phone: e.target.value }) });
  const tel = c.phone ? `tel:${P.toEnDigits(c.phone).replace(/[^\d+]/g, '')}` : null;

  const offer = h('input', { inputmode: 'numeric', placeholder: 'میلیون تومان', value: c.offer ? String(Math.round(c.offer / 1e6)) : '', 'aria-label': 'قیمت پیشنهادی من',
    onchange: (e) => { const n = numIn(e.target.value); act({ action: 'set', offer: n == null ? null : n * 1e6 }); } });

  const noteBox = h('textarea', { rows: 2, placeholder: 'یادداشت: چه گفت؟ چه چیزی را باید بپرسم؟' });

  // visit picker
  let visitDay = 1;
  const hourSel = h('select', { 'aria-label': 'ساعت بازدید' }, Array.from({ length: 14 }, (_, i) => i + 8).map((hr) => h('option', { value: hr, selected: hr === 17 }, `ساعت ${faDigits(hr)}`)));
  const dayChips = h('div', { class: 'chips' }, [[0, 'امروز'], [1, 'فردا'], [2, 'پس‌فردا'], [3, dateFa(Date.now() + 3 * DAY).split(' ')[0]]].map(([d, label]) =>
    h('button', { class: 'chip-btn', type: 'button', 'aria-pressed': String(d === visitDay), onclick: (e) => {
      visitDay = d; $$('button', dayChips).forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
    } }, label)));

  return h('div', { class: 'crm' },
    h('div', { class: 'crm-row' },
      h('label', { class: 'field grow' }, h('span', null, 'مرحلهٔ پیگیری'), stageSel),
      h('button', { class: 'btn danger-ghost sm', type: 'button', onclick: () => rejectDialog(p.token), style: 'align-self:end' }, icon('trash', 'sm'), 'حذف با دلیل')),
    f.sold ? h('div', { class: 'crm-alert' }, icon('alert'), 'این آگهی از دیوار حذف شده؛ احتمالاً فروخته شده است.') : null,
    f.visitOverdue ? h('div', { class: 'crm-alert' }, icon('alert'), 'زمان بازدید گذشته؛ نتیجه را ثبت کنید.') : null,

    h('div', { class: 'crm-block' },
      h('div', { class: 'crm-h' }, icon('phone', 'sm'), 'تماس'),
      h('div', { class: 'crm-row' }, phone,
        tel ? h('a', { class: 'btn sm', href: tel }, icon('phone', 'sm'), 'زنگ بزن') : null),
      h('div', { class: 'crm-row wrap' },
        h('button', { class: 'btn sm good', type: 'button', onclick: () => act({ action: 'call', result: 'answered', note: noteBox.value }) }, icon('check', 'sm'), 'جواب داد'),
        h('button', { class: 'btn sm', type: 'button', onclick: async () => { await act({ action: 'call', result: 'no-answer', note: noteBox.value }); toast('ثبت شد؛ تماس بعدی خودکار زمان‌بندی شد.'); } }, icon('phone-off', 'sm'), 'جواب نداد'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => act({ action: 'call', result: 'off', note: noteBox.value }) }, 'خاموش / در دسترس نیست'),
        f.missed ? h('span', { class: 'muted', style: 'font-size:13px' }, `${fa(f.missed)} بار پشت سر هم جواب نداده`) : null),
      h('div', { class: 'crm-sub' }, c.nextCallAt ? [`تماس بعدی: `, h('b', { class: f.callDue ? 'bad' : null }, whenFa(c.nextCallAt))] : 'یادآوری تماس ندارد'),
      h('div', { class: 'chips' }, quickTimes().map(([label, t]) => h('button', { class: 'chip-btn', type: 'button', onclick: () => act({ action: 'schedule', at: t }) }, label)),
        c.nextCallAt ? h('button', { class: 'chip-btn', type: 'button', onclick: () => act({ action: 'schedule', at: null }) }, icon('x', 'sm'), 'برداشتن') : null)),

    h('div', { class: 'crm-block' },
      h('div', { class: 'crm-h' }, icon('calendar', 'sm'), 'بازدید'),
      f.stage === 'visit' && c.visitAt
        ? h('div', { class: 'crm-row wrap' }, h('span', null, 'قرار: ', h('b', { class: f.visitOverdue ? 'bad' : null }, whenFa(c.visitAt))),
          h('button', { class: 'btn sm good', type: 'button', onclick: () => act({ action: 'visited', note: noteBox.value }) }, icon('check', 'sm'), 'بازدید انجام شد'))
        : null,
      dayChips,
      h('div', { class: 'crm-row' }, hourSel,
        h('button', { class: 'btn sm', type: 'button', onclick: () => {
          const d = new Date(); d.setDate(d.getDate() + visitDay); d.setHours(Number(hourSel.value), 0, 0, 0);
          act({ action: 'visit', at: d.getTime() }).then(() => toast(`قرار بازدید ${whenFa(d.getTime())} ثبت شد.`));
        } }, f.stage === 'visit' ? 'تغییر قرار' : 'ثبت قرار بازدید'))),

    h('div', { class: 'crm-block' },
      h('div', { class: 'crm-h' }, 'قیمت پیشنهادی من'),
      h('div', { class: 'crm-row' }, offer, p.price && c.offer ? h('span', { class: 'muted', style: 'font-size:13px' },
        `${formatPrice(Math.abs(p.price - c.offer))} ${c.offer < p.price ? 'کمتر' : 'بیشتر'} از قیمت آگهی`) : null)),

    h('div', { class: 'crm-block' },
      h('div', { class: 'crm-h' }, icon('note', 'sm'), 'یادداشت‌ها'),
      noteBox,
      h('div', { class: 'crm-row' }, h('button', { class: 'btn sm', type: 'button', onclick: async () => {
        if (!noteBox.value.trim()) return;
        await act({ action: 'note', text: noteBox.value });
        noteBox.value = '';
      } }, 'ثبت یادداشت')),
      timeline(c)));
}

/** Green chips for recent repairs and extras (red for bad signs), from the ad text. */
function valueChips(p, max = 99) {
  const tags = P.valueTags(p);
  const good = tags.filter((t) => !t.bad).slice(0, max);
  const bad = tags.filter((t) => t.bad);
  return [...bad.map((t) => h('span', { class: 'vtag bad' }, icon('alert', 'sm'), t.label)),
    ...good.map((t) => h('span', { class: 'vtag' }, icon('check', 'sm'), t.label))];
}

/** Drawer: «امکانات و تعمیرات» with roughly how much they are worth. */
function valueBlock(p) {
  const tags = P.valueTags(p);
  if (!tags.length) return null;
  const b = P.valueBoost(tags);
  const worth = Math.abs(b) < 0.002 ? '' : b > 0 ? `حدود ${fa(Math.round(b * 1000) / 10)}٪ ارزش بیشتر` : `حدود ${fa(Math.round(-b * 1000) / 10)}٪ ارزش کمتر`;
  return h('div', { class: 'd-values' }, h('div', { class: 'd-values-h' }, h('b', null, 'امکانات و تعمیرات'), worth ? h('small', null, worth) : null),
    h('div', { class: 'conds' }, valueChips(p)));
}

/** Drawer: where this ad's price sits against «قیمت‌یاب» for the same model, trim and year. */
function guideLine(p) {
  const g = typeof guideOf === 'function' && p.price ? guideOf(p) : null;
  if (!g) return null;
  const diff = (p.price - g.market) / g.market;
  const pct = fa(Math.abs(Math.round(diff * 100)));
  const where = Math.abs(diff) < 0.01 ? 'هم‌قیمت بازار' : diff < 0 ? `${pct}٪ زیر قیمت بازار` : `${pct}٪ بالای قیمت بازار`;
  const boost = P.valueBoost(P.valueTags(p));
  const why = diff > 0.01 && boost > 0.002
    ? `ولی امکانات و تعمیرات تازه‌اش حدود ${fa(Math.round(Math.min(boost, diff) * 100))}٪ از این اختلاف را توجیه می‌کند`
    : null;
  return h('div', { class: 'd-guide' },
    h('span', null, 'قیمت بازار ', h('b', { class: 'num' }, formatPrice(g.market)), ` · ${where}`),
    why ? h('span', { class: 'why' }, why) : null,
    h('span', null, 'خرید خوب تا ', h('b', { class: 'num' }, formatPrice(g.buyGood))),
    h('a', { href: `#/prices?model=${encodeURIComponent(g.modelKey)}` }, 'قیمت‌یاب'));
}

function dealBox(deal) {
  if (!deal || (!deal.level && !deal.reasons.length)) return null;
  const title = deal.level === 'caution' ? 'با احتیاط' : deal.deal ? 'چرا پیشنهاد ویژه است؟' : 'مقایسه با آگهی‌های مشابه';
  return h('div', { class: `deal-box ${deal.level || 'plain'}` },
    h('div', { class: 'deal-box-h' }, icon(deal.level === 'caution' ? 'alert' : 'flame', 'sm'), title),
    h('ul', null,
      deal.reasons.map((r) => h('li', { class: 'ok' }, icon('check', 'sm'), r)),
      deal.warnings.map((w) => h('li', { class: 'warn' }, icon('alert', 'sm'), w))),
    h('small', null, `قیمت معمول این مدل و سال با این کارکرد: ${formatPrice(deal.expected)} تومان`));
}

function timeline(c) {
  const items = (c.notes || []).slice().reverse();
  if (!items.length) return null;
  return h('ol', { class: 'timeline' }, items.slice(0, 40).map((n) => h('li', { class: `tl-${n.kind}` },
    h('span', { class: 'tl-dot' }), h('div', null, h('div', { class: 'tl-text' }, n.text), h('small', null, agoFa(n.t))))));
}

function openDrawer(token, keepScroll) {
  if (!B) return;
  const p = B.posts.find((x) => x.token === token);
  if (!p) return;
  const prevScroll = keepScroll && overlay && overlay.kind === 'drawer' && overlay.token === token ? $('.drawer-body') && $('.drawer-body').scrollTop : 0;
  const list = B.list || [];
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
    $$('button', thumbs).forEach((b, j) => b.setAttribute('aria-current', String(j === gi)));
  };
  imgs.forEach((src, i) => thumbs.append(h('button', { type: 'button', 'aria-current': String(i === 0), 'aria-label': `عکس ${fa(i + 1)}`, onclick: () => show(i) },
    h('img', { src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }))));
  const d = delta(p, B.median);
  const url = safeDivarUrl(p.url);
  const cmp = B.compare.has(p.token);

  const specRows = [
    ['مدل', p.year ? faYear(p.year) : p.yearText], ['کارکرد', p.mileage != null ? `${fa(p.mileage)} کیلومتر` : p.mileageText],
    ['رنگ', p.color], ['گیربکس', p.gearbox], ['سوخت', p.fuel], ['برند و تیپ', p.brand],
    ['بدنه', p.body], ['موتور', p.engine], ['شاسی', p.chassis], ['بیمهٔ شخص ثالث', p.insurance], ['معاوضه', p.exchange],
  ].filter(([, v]) => v);
  const shown = new Set(['کارکرد', 'مدل (سال تولید)', 'رنگ', 'برند و تیپ', 'نوع سوخت', 'موتور', 'شاسی جلو', 'شاسی عقب', 'بدنه', 'مهلت بیمهٔ شخص ثالث', 'گیربکس', 'قیمت پایه', 'معاوضه']);
  const extra = Object.entries(p.fields || {}).filter(([k]) => !shown.has(k) && !/قیمت/.test(k));
  const ph = (p._ad && p._ad.priceHistory) || [];

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
        publishedLine(p, 'where d-where'),
        p.publishedAt ? h('div', { class: 'muted', style: 'font-size:12.5px;margin-top:2px' }, `انتشار آگهی: ${dateTimeFa(p.publishedAt)}${p.publishedApprox ? ' (تقریبی)' : ''}`) : null,
        h('div', { class: 'd-price' },
          p.price ? h('div', { class: 'price num' }, formatPrice(p.price), ' ', h('small', null, 'تومان')) : h('div', { class: 'price none' }, p.priceText || 'بدون قیمت'),
          d ? h('span', { class: `delta ${d.cls}` }, d.text) : null,
          priceChangeBadge(p),
          sellerBadge(p)),
        guideLine(p),
        valueBlock(p),
        ph.length > 1 ? h('div', { class: 'where', style: 'margin-top:6px' }, icon('trend', 'sm'),
          `تاریخچهٔ قیمت: ${ph.map((x) => formatPrice(x.price)).join(' ← ')}`) : null,
        p._ad && p._ad.firstSeenAt ? h('div', { class: 'where', style: 'margin-top:4px' }, icon('clock', 'sm'), `اولین بار ${agoFa(p._ad.firstSeenAt)} دیده شد`) : null,
        dealBox(p._deal),
        h('h3', { class: 'd-h' }, 'پیگیری'),
        crmSection(p),
        h('div', { class: 'why' }, h('b', null, `چرا «${sellerLabel(p)}»؟ `), (p.sellerReasons || []).join('، ')),
        h('h3', { class: 'd-h' }, 'مشخصات'),
        h('div', { class: 'specs' }, specRows.map(([k, v]) => {
          const c = ['بدنه', 'موتور', 'شاسی'].includes(k) ? conditionClass(v) : null;
          return h('div', { class: 'spec' }, h('div', { class: 'k' }, k), h('div', { class: `v${c ? ` ${c}` : ''}` }, v));
        }), extra.map(([k, v]) => h('div', { class: 'spec' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)))),
        p.description ? [h('h3', { class: 'd-h' }, 'توضیحات فروشنده'), h('p', { class: 'desc' }, p.description)] : null)),
    h('div', { class: 'drawer-foot' },
      url ? h('a', { class: 'btn primary', href: url, target: '_blank', rel: 'noopener' }, icon('external'), 'دیدن آگهی در دیوار') : null,
      h('button', { class: 'btn cmp-toggle', type: 'button', 'aria-pressed': String(cmp), onclick: () => toggleCompare(p.token) }, icon('compare'), cmp ? 'در مقایسه' : 'مقایسه')));

  openOverlay([scrim, panel], (e) => {
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === 'ArrowLeft') go(1);
    else if (e.key === 'ArrowRight') go(-1);
  }, { kind: 'drawer', token });
  if (prevScroll) $('.drawer-body', panel).scrollTop = prevScroll;
  else $('.drawer-head button', panel).focus();
}

function openCompare() {
  const items = Array.from(B.compare).map((t) => B.posts.find((p) => p.token === t)).filter(Boolean);
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
    ['مرحله', (p) => stageChip(p._f.stage)],
    ['قیمت', (p) => h('span', { class: p.price != null && p.price === minPrice ? 'best' : null }, p.price ? `${formatPrice(p.price)} تومان` : (p.priceText || '—'))],
    ['مدل', (p) => h('span', { class: p.year != null && p.year === maxYear ? 'best' : null }, p.year ? faYear(p.year) : '—')],
    ['کارکرد', (p) => h('span', { class: p.mileage != null && p.mileage === minKm ? 'best' : null }, p.mileage != null ? `${fa(p.mileage)} کیلومتر` : '—')],
    ['فروشنده', (p) => sellerBadge(p)],
    ['رنگ', (p) => p.color || '—'], ['گیربکس', (p) => p.gearbox || '—'],
    ['بدنه', (p) => h('span', { class: conditionClass(p.body) === 'bad' ? 'cond bad' : null }, p.body || '—')],
    ['موتور', (p) => h('span', { class: conditionClass(p.engine) === 'bad' ? 'cond bad' : null }, p.engine || '—')],
    ['شاسی', (p) => p.chassis || '—'], ['بیمه', (p) => p.insurance || '—'], ['محل', (p) => P.placeOf(p.subtitle) || '—'], ['انتشار', (p) => (p.publishedAt ? (p.publishedApprox ? roughAgoFa(p.publishedAt) : agoFa(p.publishedAt)) : '—')],
    ['', (p) => (safeDivarUrl(p.url) ? h('a', { class: 'btn sm', href: safeDivarUrl(p.url), target: '_blank', rel: 'noopener' }, icon('external', 'sm'), 'دیوار') : '')],
  ];
  const scrim = h('div', { class: 'scrim', onclick: closeOverlay });
  const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'مقایسهٔ آگهی‌ها' },
    h('div', { class: 'modal-head' }, h('h2', null, 'مقایسهٔ آگهی‌ها'),
      h('button', { class: 'btn ghost icon-only', type: 'button', 'aria-label': 'بستن', onclick: closeOverlay }, icon('x'))),
    h('div', { class: 'modal-body' }, h('table', { class: 'compare' },
      h('tbody', null, rows.map(([label, fn]) => h('tr', null, h('th', { scope: 'row' }, label), items.map((p) => h('td', null, fn(p)))))))));
  openOverlay([scrim, modal], null, { kind: 'compare' });
  $('.modal-head button', modal).focus();
}

function exportCsv() {
  const posts = B.list || [];
  const cols = [
    ['عنوان', (p) => p.title], ['مرحله', (p) => stageLabel(p._f.stage)], ['شمارهٔ فروشنده', (p) => (p._ad && p._ad.crm && p._ad.crm.phone) || ''],
    ['نوع فروشنده', sellerLabel], ['قیمت (تومان)', (p) => p.price ?? p.priceText],
    ['مدل', (p) => p.year ?? p.yearText], ['کارکرد', (p) => p.mileage ?? p.mileageText], ['رنگ', (p) => p.color],
    ['گیربکس', (p) => p.gearbox], ['سوخت', (p) => p.fuel], ['بدنه', (p) => p.body], ['موتور', (p) => p.engine],
    ['شاسی', (p) => p.chassis], ['بیمه', (p) => p.insurance], ['برند و تیپ', (p) => p.brand], ['معاوضه', (p) => p.exchange],
    ['محل', (p) => P.placeOf(p.subtitle)], ['انتشار آگهی', (p) => (p.publishedAt ? `${dateTimeFa(p.publishedAt)}${p.publishedApprox ? ' (تقریبی)' : ''}` : '')], ['لینک', (p) => p.url], ['توضیحات', (p) => p.description],
  ];
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [cols.map(([k]) => esc(k)).join(','), ...posts.map((p) => cols.map(([, fn]) => esc(fn(p))).join(','))];
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `radyab-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
