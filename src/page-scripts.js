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

  // The ad's own column: smallest ancestor of the title that also holds the spec rows.
  // Keeps the site header/footer (which link to "businesses" etc.) out of the analysis.
  let root = h1;
  if (root && firstRow) {
    while (root.parentElement && !root.contains(firstRow)) root = root.parentElement;
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

  // 2) Title/value rows identified by class names.
  for (const t of root.querySelectorAll('[class*="row__title"], [class*="item__title"]')) {
    if (t.closest('table')) continue;
    let v = null;
    for (let el = t.parentElement, depth = 0; el && el !== root && depth < 4 && !v; el = el.parentElement, depth++) {
      v = el.querySelector('[class*="row__value"], [class*="item__value"]');
    }
    if (v && v !== t && !v.contains(t)) {
      widgets.push({ widget_type: 'UNEXPANDABLE_ROW', data: { title: clean(t.textContent), value: clean(v.textContent) } });
    }
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

  // Description: longest description-like block, else the text after the «توضیحات» heading.
  let description = '';
  for (const el of root.querySelectorAll('[class*="description"]')) {
    const txt = (el.innerText || '').trim();
    if (txt.length > description.length) description = txt;
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
  const subEl = root.querySelector('[class*="subtitle"]');
  if (subEl) subtitle = clean(subEl.textContent);
  else if (title) {
    const i = lines.indexOf(title);
    if (i >= 0 && lines[i + 1] && lines[i + 1].length < 90) subtitle = lines[i + 1];
  }
  if (title) widgets.push({ widget_type: 'LEGEND_TITLE_ROW', data: { title, subtitle } });

  const images = [];
  for (const img of root.querySelectorAll('img')) {
    const src = img.currentSrc || img.getAttribute('src') || '';
    if (/divarcdn/.test(src) && !/\.svg(\?|$)|\/icons?\//i.test(src) && !images.includes(src)) images.push(src);
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
  return result;
}

module.exports = { collectListItems, clickLoadMore, detectBlock, extractAdPage };
