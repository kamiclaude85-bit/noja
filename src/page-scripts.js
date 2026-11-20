/*
 * Functions that run INSIDE the Divar tab (via page.evaluate).
 * They only read what is rendered on the page: no Divar API is used.
 * Each function must be self-contained (it is serialized into the page).
 */
'use strict';

/** Collect ad cards currently present on a Divar search page. */
function collectListItems() {
  const out = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href*="/v/"]')) {
    const href = a.getAttribute('href') || '';
    let path = href;
    try { path = new URL(href, location.origin).pathname; } catch (_) { /* keep */ }
    const m = path.match(/\/v\/(?:[^/]*\/)?([A-Za-z0-9_-]{5,})\/?$/);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    const card = a.closest('article') || a.closest('[class*="post-card"]') || a;
    const img = card.querySelector('img');
    const lines = (card.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const heading = card.querySelector('h2, h3');
    out.push({
      token: m[1],
      href: new URL(href, location.origin).href,
      title: ((heading && heading.innerText) || lines[0] || '').trim(),
      lines: lines.slice(0, 10),
      image: (img && (img.currentSrc || img.src || img.getAttribute('data-src'))) || '',
    });
  }
  return out;
}

/** Click Divar's "more ads" button if it is visible. Returns true when clicked. */
function clickLoadMore() {
  for (const b of document.querySelectorAll('button, a[role="button"]')) {
    const t = (b.innerText || '').trim();
    if (t && t.length < 40 && /آگهی.{0,3}های بیشتر|نمایش بیشتر|بارگذاری بیشتر/.test(t) && b.offsetParent !== null) {
      b.click();
      return true;
    }
  }
  return false;
}

/**
 * Divar's result list ends with a «بعدی» link to the next page (24 ads per page).
 * Returns { href, visible } or null when there is no next page.
 */
function nextPageLink() {
  const links = Array.from(document.querySelectorAll('a[rel="next"], a[href*="page="]'));
  const a = links.find((x) => (x.innerText || x.textContent || '').trim() === 'بعدی') || document.querySelector('a[rel="next"]');
  if (!a || !a.href) return null;
  const r = a.getBoundingClientRect();
  return { href: a.href, visible: !!(a.offsetParent && r.width > 0 && r.height > 0) };
}

/** True when Divar shows a captcha / "too many requests" page instead of content. */
function detectBlock() {
  if (document.querySelector('iframe[src*="captcha"], iframe[src*="recaptcha"], [class*="captcha"]')) return true;
  const text = ((document.body && document.body.innerText) || '').slice(0, 4000);
  return /من ربات نیستم|ربات نیستید|تعداد درخواست.{0,20}زیاد|درخواست‌های زیادی|too many requests|captcha/i.test(text);
}

/**
 * Read a rendered Divar ad page and return widget-like rows that
 * NojaParser.extractPost understands.
 */
function extractAdPage() {
  const clean = (s) => String(s || '').replace(/[\s ]+/g, ' ').trim();
  const KNOWN_LABELS = [
    'کارکرد', 'مدل (سال تولید)', 'سال تولید', 'رنگ', 'برند و تیپ', 'نوع سوخت', 'سوخت', 'موتور', 'وضعیت موتور',
    'شاسی جلو', 'شاسی عقب', 'وضعیت شاسی‌ها', 'بدنه', 'وضعیت بدنه', 'مهلت بیمهٔ شخص ثالث', 'مهلت بیمه شخص ثالث',
    'بیمه شخص ثالث', 'گیربکس', 'قیمت پایه', 'قیمت', 'قیمت کل', 'معاوضه', 'نوع آگهی', 'آگهی‌دهنده',
  ];
  const h1 = document.querySelector('h1');
  const firstRow = document.querySelector('table, [class*="row__title"], [class*="item__title"]');

  // The ad itself. On real Divar it is the <article> around the title: it holds the spec rows,
  // the description and the photo gallery, but not the site header/footer or "similar ads".
  // Otherwise: smallest ancestor of the title that also holds the spec rows.
  let root = h1 && h1.closest('article');
  if (!root) {
    root = h1;
    if (root && firstRow) {
      while (root.parentElement && !root.contains(firstRow)) root = root.parentElement;
    }
  }
  if (!root || root === document.documentElement) root = document.querySelector('main') || document.body;

  const widgets = [];

  // 1) Group rows rendered as tables: header cells are labels, body cells are values.
  for (const table of root.querySelectorAll('table')) {
    const ths = Array.from(table.querySelectorAll('th')).map((e) => clean(e.textContent));
    const tds = Array.from(table.querySelectorAll('td')).map((e) => clean(e.textContent));
    if (ths.length && ths.length === tds.length) {
      widgets.push({ widget_type: 'GROUP_INFO_ROW', data: { items: ths.map((t, i) => ({ title: t, value: tds[i] })) } });
    }
  }

  // 2) Title/value rows identified by class names. The value is looked up only inside the
  //    title's own row box (e.g. `kt-base-row`), never in a neighbouring row. Real Divar shows
  //    the seller's assessment (موتور، بدنه، شاسی…) as `kt-score-row` with the value in
  //    `kt-score-row__score`.
  const VALUE_SEL = '[class*="row__value"], [class*="item__value"], [class*="row__score"]';
  const isRowBox = (el) => Array.from(el.classList || []).some((c) => /-row$/.test(c) && !c.includes('__'));
  const seenTitles = new Set();
  for (const t of root.querySelectorAll('[class*="row__title"], [class*="item__title"]')) {
    if (t.closest('table')) continue;
    let v = null;
    for (let el = t.parentElement, depth = 0; el && el !== root && depth < 4 && !v; el = el.parentElement, depth++) {
      v = Array.from(el.querySelectorAll(VALUE_SEL)).find((x) => x !== t && !x.contains(t) && !t.contains(x)) || null;
      if (isRowBox(el)) break; // reached the row's own box: do not look any further up
    }
    const title = clean(t.textContent);
    const value = v ? clean(v.textContent) : '';
    if (!title || !value) continue;
    // The assessment repeats a spec label («گیربکس»: دنده‌ای, then «گیربکس»: سالم و پلمپ).
    const isScore = !!t.closest('[class*="score-row"]');
    const label = isScore && seenTitles.has(title) && !/^وضعیت/.test(title) ? `وضعیت ${title}` : title;
    seenTitles.add(title);
    widgets.push({ widget_type: 'UNEXPANDABLE_ROW', data: { title: label, value } });
  }

  // 3) Plain-text fallback, independent of class names.
  const rawLines = (root.innerText || '').split('\n').map((l) => l.replace(/ /g, ' ')).filter((l) => l.trim());
  for (let i = 0; i < rawLines.length - 1; i++) {
    const cells = rawLines[i].split('\t').map(clean).filter(Boolean);
    const next = rawLines[i + 1].split('\t').map(clean).filter(Boolean);
    if (cells.length > 1 && cells.length === next.length && cells.some((c) => KNOWN_LABELS.includes(c))) {
      widgets.push({ widget_type: 'TEXT_GROUP', data: { items: cells.map((c, j) => ({ title: c, value: next[j] })) } });
      i++;
      continue;
    }
    const label = clean(rawLines[i]);
    const value = clean(rawLines[i + 1]);
    if (KNOWN_LABELS.includes(label) && value && !KNOWN_LABELS.includes(value)) {
      widgets.push({ widget_type: 'TEXT_ROW', data: { title: label, value } });
    }
  }
  const lines = rawLines.map(clean);

  // Description: the block under the «توضیحات» heading; else the longest description-like
  // block (but not the hidden «انتشار آگهی: …» dates inside the time/place row);
  // else the plain text after the heading.
  let description = '';
  const descHeading = Array.from(root.querySelectorAll('h2, h3, [class*="title-row__title"]'))
    .find((el) => clean(el.textContent) === 'توضیحات');
  for (let el = descHeading && descHeading.parentElement, depth = 0; el && el !== root && depth < 5 && !description; el = el.parentElement, depth++) {
    const box = el.querySelector('[class*="description-row__text"], [class*="description"] p');
    if (box && !box.closest('[class*="info-row"]')) {
      // Divar keeps line breaks as "\n" in the text (shown with CSS); keep them either way.
      const shown = box.innerText || '';
      const raw = box.textContent || '';
      description = (shown.includes('\n') || !raw.includes('\n') ? shown : raw).trim();
    }
  }
  if (!description) {
    for (const el of root.querySelectorAll('[class*="description"]')) {
      if (el.closest('[class*="info-row"]')) continue;
      const txt = (el.innerText || '').trim();
      if (txt.length > description.length) description = txt;
    }
  }
  if (!description) {
    const i = lines.findIndex((l) => l === 'توضیحات');
    if (i >= 0) {
      const stop = /^(یادداشت|اطلاعات تماس|گزارش|هشدار|آگهی‌های مشابه|بازدید|ثبت یادداشت)/;
      const out = [];
      for (let j = i + 1; j < lines.length && !stop.test(lines[j]) && !KNOWN_LABELS.includes(lines[j]); j++) out.push(lines[j]);
      description = out.join('\n');
    }
  }
  description = description.replace(/^توضیحات\s*/, '').trim();
  if (description) widgets.push({ widget_type: 'DESCRIPTION_ROW', data: { text: description } });

  const title = clean(h1 && h1.textContent);
  let subtitle = '';
  // «۲ ساعت پیش در تهران، شهرری» is the first info row on real Divar.
  const subEl = root.querySelector('[class*="subtitle"], [class*="info-row__title"]');
  if (subEl) subtitle = clean(subEl.textContent);
  else if (title) {
    const i = lines.indexOf(title);
    if (i >= 0 && lines[i + 1] && lines[i + 1].length < 90) subtitle = lines[i + 1];
  }
  if (title) widgets.push({ widget_type: 'LEGEND_TITLE_ROW', data: { title, subtitle } });

  // Photos: the gallery shows each photo large (webp_post) and as a thumbnail (webp_thumbnail),
  // both ending in the same file name. Large photos load lazily, so a thumbnail stands in until
  // its large version is there. The map snapshot (mapimage…) and icons are not photos.
  const images = [];
  const byFile = new Map();
  for (const img of root.querySelectorAll('img')) {
    const src = img.currentSrc || img.getAttribute('src') || '';
    if (!/divarcdn/.test(src) || /\.svg(\?|$)|\/icons?\/|mapimage|\/static\/imgs\//i.test(src)) continue;
    const file = src.split('?')[0].split('/').pop();
    const thumb = /thumbnail/i.test(src);
    if (!byFile.has(file)) {
      byFile.set(file, images.length);
      images.push(src);
    } else if (!thumb && /thumbnail/i.test(images[byFile.get(file)])) {
      images[byFile.get(file)] = src;
    }
  }

  // Short labels near the ad (badges like «نمایشگاه …»), excluding description text.
  const descLines = new Set(description.split('\n').map(clean));
  const badges = lines
    .filter((l) => l.length <= 60 && !descLines.has(l) && !description.includes(l))
    .map((label) => ({ label }));

  const result = {
    widgets,
    images,
    badges,
    seo: { title, description },
    page_url: location.href,
  };
  const bizLink = root.querySelector('a[href*="/business"], a[href*="dealership"], a[href*="/shop/"]');
  if (bizLink) result.business_ref = bizLink.getAttribute('href');

  // Breadcrumbs: … › خودرو سواری و وانت › پژو › 206 › تیپ ۲ › <title>. The part after the
  // vehicle category is make › model › trim.
  const crumbs = Array.from(document.querySelectorAll('nav[aria-label="breadcrumbs"] li, [class*="breadcrumbs__item"]'))
    .map((li) => clean(li.textContent)).filter(Boolean);
  const cat = crumbs.findIndex((c) => /سواری|وانت/.test(c));
  if (cat >= 0) {
    const rest = crumbs.slice(cat + 1).filter((c) => c !== title);
    if (rest.length >= 2) result.crumbs = rest.slice(0, 4);
  }

  // «انتشار آگهی: ۱۷ آبان ۱۴۰۵، ۲۲:۵۶» / «آخرین نردبان: …» — inside the (folded) time/place row.
  const info = {};
  for (const el of root.querySelectorAll('[class*="info-row"] [class*="description-row__text"], [class*="info-row__content"]')) {
    for (const line of String(el.textContent || '').split(/\n|(?=آخرین)/)) {
      const m = line.match(/^\s*(انتشار آگهی|آخرین نردبان|آخرین به[‌\s]*روز[‌\s]*رسانی)\s*[:：]\s*(.+?)\s*$/);
      if (!m) continue;
      if (/انتشار/.test(m[1])) info.published = info.published || m[2];
      else if (/نردبان/.test(m[1])) info.bumped = info.bumped || m[2];
      else info.updated = info.updated || m[2];
    }
  }
  if (info.published) result.publishInfo = info;
  return result;
}

// ---------------------------------------------------------------------------
// باما (bama.ir). Runs inside its pages; the sellers' phone numbers are never read.
// ---------------------------------------------------------------------------

/** Ad cards on a Bama list page: [{ token, href, title, lines, image }]. */
function collectBamaList() {
  const out = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href*="/car/detail-"]')) {
    const href = new URL(a.getAttribute('href'), location.origin).href;
    const m = href.match(/\/car\/detail-([a-z0-9]{5,20})-/i);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    const lines = (a.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const img = a.querySelector('img');
    out.push({
      token: `bm-${m[1]}`,
      href,
      title: lines.filter((l) => !/^\d+$/.test(l)).slice(0, 3).join(' '),
      lines: lines.slice(0, 14),
      image: (img && (img.currentSrc || img.src)) || '',
    });
  }
  return out;
}

/** Links to a make or model page: [{ href, text }] («خرید و فروش پژو 207»). */
function collectBamaLinks() {
  const out = [];
  for (const a of document.querySelectorAll('a[href^="/car/"]')) {
    const href = a.getAttribute('href');
    const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
    if (/^\/car\/[a-z0-9-]+$/.test(href) && /خرید\s*و\s*فروش/.test(text)) out.push({ href: new URL(href, location.origin).href, text });
  }
  return out;
}

/** What one Bama ad page says (see bama.toPost). Never the phone number. */
function extractBamaAd() {
  let ld = null;
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const j = JSON.parse(s.textContent);
      if ([].concat(j['@type'] || []).includes('Car')) { ld = j; break; }
    } catch (_) { /* skip */ }
  }
  const lines = (document.body.innerText || '').split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const back = lines.indexOf('بازگشت');
  const end = lines.indexOf('توضیحات') > 0 ? lines.indexOf('توضیحات') : lines.length;
  const head = back >= 0 ? lines.slice(back + 1, end) : [];
  const rows = {};
  for (const label of ['وضعیت بدنه', 'رنگ بدنه', 'رنگ داخل', 'گیربکس', 'نوع سوخت', 'وضعیت موتور', 'وضعیت شاسی']) {
    const i = head.indexOf(label);
    if (i >= 0 && head[i + 1]) rows[label] = head[i + 1];
  }
  // the line under «make، model» is the trim, unless it is the year
  const nameAt = head.findIndex((l) => /،/.test(l));
  const trim = nameAt >= 0 && head[nameAt + 1] && !/^\d{4}$/.test(head[nameAt + 1]) ? head[nameAt + 1] : '';
  const agoAt = head.findIndex((l) => /پیش$|دیروز|لحظاتی|^امروز/.test(l));
  // a dealership shows its name and «… فعالیت مداوم در باما» under the phone row
  const phoneAt = head.indexOf('شماره تماس');
  let dealer = '';
  if (phoneAt >= 0) {
    const after = head.slice(phoneAt + 2);
    if (after.some((l) => /فعالیت مداوم در باما|نمایشگاه|نمایندگی|اتوگالری/.test(l))) dealer = after[0] || 'نمایشگاه';
  }
  const imgs = [...document.querySelectorAll('img')].map((i) => i.getAttribute('src') || '').filter((s) => /VehicleCarImages\//.test(s));
  const folder = imgs.length ? imgs[0].split('/VehicleCarImages/')[1].split('/')[0] : '';
  const images = Array.from(new Set(imgs.filter((s) => folder && s.includes(`/VehicleCarImages/${folder}/`))
    .map((s) => s.replace(/\?x-img=.*$/, '?x-img=v1%2Fformat,type_webp%2Fresize,w_1200'))));
  const text = lines.slice(0, 40).join(' ');
  return {
    ld,
    rows,
    trim,
    ago: agoAt >= 0 ? head[agoAt] : '',
    place: agoAt >= 0 ? head[agoAt + 1] || '' : '',
    dealer,
    images,
    title: document.title,
    removed: !ld && /حذف شده|منقضی|یافت نشد|وجود ندارد|404/.test(text),
  };
}

/**
 * Bama's «قیمت روز خودرو» page: one row per make/model/trim/year and kind of price.
 * [{ make, model, trim, year, note, kind: 'بازار'|'کارخانه'|'نمایندگی', price, change }]
 */
function extractBamaPrices() {
  const out = [];
  for (const a of document.querySelectorAll('a[href^="/price/"]')) {
    const nameBox = a.querySelector('span.direction-ltr');
    const names = nameBox ? [...nameBox.children].map((s) => s.textContent.replace(/,/g, '').trim()).filter(Boolean) : [];
    const leaves = [...a.querySelectorAll('span')].filter((s) => !s.children.length).map((s) => s.textContent.trim()).filter((t) => t && t !== ',');
    const yAt = leaves.findIndex((t) => /^(1[34]\d\d|20\d\d)$/.test(t));
    const kind = (leaves.find((t) => /^قیمت (بازار|کارخانه|نمایندگی)$/.test(t)) || '').replace('قیمت ', '');
    const priceText = leaves.find((t) => /^\d{1,3}(,\d{3}){2,}$/.test(t));
    if (names.length < 2 || yAt < 0 || !kind || !priceText) continue;
    const next = leaves[yAt + 1] || '';
    out.push({
      make: names[0],
      model: names[1],
      trim: names.slice(2).join(' '),
      year: Number(leaves[yAt]),
      note: /^(دیروز|امروز|قیمت|\d)/.test(next) ? '' : next,
      kind,
      price: Number(priceText.replace(/,/g, '')),
      change: leaves.find((t) => /%$/.test(t)) || '',
    });
  }
  return out;
}

module.exports = { collectListItems, clickLoadMore, nextPageLink, detectBlock, extractAdPage, collectBamaList, collectBamaLinks, extractBamaAd, extractBamaPrices };
