/*
 * Radyab — Divar car-ad parser.
 *
 * Divar changes its JSON shape from time to time, so instead of depending on
 * exact paths this parser walks the whole response and picks up anything that
 * looks like a `{title, value}` row (that is how Divar renders the spec rows:
 * کارکرد، مدل، رنگ، گیربکس، ...). Seller type (personal vs. dealer) is decided
 * from Divar's own business markers first and from description keywords last.
 *
 * Works both in the browser (attaches `NojaParser` to globalThis) and in Node
 * (module.exports) so it can be unit-tested.
 */
(function (root) {
  'use strict';

  const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
  const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

  function toEnDigits(input) {
    return String(input == null ? '' : input)
      .replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)))
      .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));
  }

  /** Lower-cased, Persian-normalized text used for matching. */
  function normalizeText(input) {
    return toEnDigits(input)
      .replace(/ي/g, 'ی')
      .replace(/ك/g, 'ک')
      .replace(/[‌‏‎]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /**
   * "۶۵۰٬۰۰۰٬۰۰۰ تومان" -> 650000000, "۱٫۲ میلیارد" -> 1200000000,
   * "توافقی" -> null.
   */
  function parseNumber(input) {
    if (typeof input === 'number') return Number.isFinite(input) ? input : null;
    let s = toEnDigits(input);
    if (!s) return null;
    s = s.replace(/[٬،,\s]/g, '').replace(/٫/g, '.');
    const m = s.match(/\d+(?:\.\d+)?/);
    if (!m) return null;
    let n = parseFloat(m[0]);
    if (/میلیارد/.test(s)) n *= 1e9;
    else if (/میلیون/.test(s)) n *= 1e6;
    else if (/هزار/.test(s) && n < 1e5) n *= 1e3;
    return Math.round(n);
  }

  /** "97" -> 1397, "02" -> 1402, "1397" -> 1397, "2018" -> 2018. */
  function normalizeYear(input) {
    const n = parseNumber(input);
    if (n == null) return null;
    if (n < 100) return n <= 20 ? 1400 + n : 1300 + n;
    return n;
  }

  /** Extract the post token from a Divar post link (/v/<slug>/<token>). */
  function extractTokenFromHref(href) {
    if (!href) return null;
    let path = String(href);
    try {
      path = new URL(path, 'https://divar.ir').pathname;
    } catch (_) { /* keep raw */ }
    const m = path.match(/\/v\/(?:[^/]*\/)?([A-Za-z0-9_-]{5,})\/?$/);
    return m ? m[1] : null;
  }

  function walk(node, visit, depth, key) {
    if (node == null || depth > 80) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, visit, depth + 1, key);
      return;
    }
    if (typeof node === 'object') {
      visit(node, key);
      for (const k of Object.keys(node)) walk(node[k], visit, depth + 1, k);
    }
  }

  // Spec labels -> normalized field names. Order matters: first match wins.
  const FIELD_RULES = [
    { key: 'mileage', test: (l) => l.includes('کارکرد') },
    { key: 'year', test: (l) => l.includes('سال تولید') || l === 'مدل' || l.startsWith('مدل (') || l === 'سال' },
    { key: 'color', test: (l) => l.startsWith('رنگ') },
    { key: 'brand', test: (l) => l.includes('برند') || l.includes('تیپ') },
    { key: 'fuel', test: (l) => l.includes('سوخت') },
    { key: 'engine', test: (l) => l.includes('موتور') },
    { key: 'chassis', test: (l) => l.includes('شاسی') },
    { key: 'body', test: (l) => l.includes('بدنه') },
    { key: 'insurance', test: (l) => l.includes('بیمه') },
    { key: 'gearbox', test: (l) => l.includes('گیربکس') },
    { key: 'exchange', test: (l) => l.includes('معاوضه') },
    { key: 'price', test: (l) => l.includes('قیمت') },
  ];

  // Words that, in a short label/badge (not the free-text description),
  // mean the ad belongs to a car dealership.
  const STRONG_DEALER_RE = /نمایشگاه|اتو\s?گالری|گالری\s?(خودرو|اتومبیل)|فروشگاه خودرو|خودرو\s?سرا|اتو\s?سرویس/;

  // Weak signals in the description. Score >= DEALER_SCORE_THRESHOLD => "likely dealer".
  const DESCRIPTION_KEYWORDS = [
    ['نمایشگاه', 2], ['اتوگالری', 2], ['اتو گالری', 2], ['گالری', 1],
    ['خرید و فروش', 2], ['انواع خودرو', 2], ['انواع خودروهای', 2], ['ساعات کاری', 2],
    ['همکار', 1], ['لیزینگ', 1], ['اقساط', 1], ['اقساطی', 1], ['تحویل فوری', 1],
    ['کارشناسی رایگان', 1], ['سالن', 1], ['مشاوره رایگان', 1], ['امانی', 2],
    ['تعویض پلاک', 1], ['پذیرش', 1],
  ];
  const DEALER_SCORE_THRESHOLD = 3;

  const BUSINESS_KEY_RE = /(^|_|-)(business|seller|user|owner|poster|advertiser)[_-]?(type|kind|role)$/i;
  const BUSINESS_REF_KEY_RE = /(shop|dealer|dealership|business|store|agency)[_-]?(name|ref|id|token|slug|title|uuid)$/i;
  const PERSONAL_VALUE_RE = /^(personal|individual|private|person|شخصی)$/i;
  const IMAGE_RE = /^https?:\/\/[^\s"']*divarcdn[^\s"']*\.(jpe?g|webp|png)(\?[^\s"']*)?$/i;

  function asText(v) {
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    return '';
  }

  /**
   * Turn a Divar post JSON (API `posts-v2/web/<token>` response, or synthetic
   * rows built from the HTML page) into a flat car object.
   */
  function extractPost(json, token, listInfo) {
    const rows = []; // [{label, value}]
    const images = [];
    const imageSet = new Set();
    let title = '';
    let subtitle = '';
    let description = '';
    const strongDealer = [];
    const personalMarks = [];
    const shortTexts = [];

    walk(json, (obj) => {
      const wt = typeof obj.widget_type === 'string' ? obj.widget_type : '';
      const data = obj.data && typeof obj.data === 'object' ? obj.data : null;

      if (wt === 'LEGEND_TITLE_ROW' && data) {
        if (!title && asText(data.title)) title = asText(data.title);
        if (!subtitle && asText(data.subtitle)) subtitle = asText(data.subtitle);
      }
      if (wt === 'DESCRIPTION_ROW' && data && !description) description = asText(data.text);
      if (wt && /BUSINESS|DEALERSHIP|SHOP_|STORE_/i.test(wt)) strongDealer.push(`ویجت فروشگاهی دیوار (${wt})`);

      const label = asText(obj.title);
      const value = asText(obj.value);
      if (label && value && label.length <= 50 && value.length <= 150) rows.push({ label, value });

      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (Array.isArray(v)) {
          for (const s of v) {
            if (typeof s === 'string' && IMAGE_RE.test(s.trim()) && !imageSet.has(s.trim())) {
              imageSet.add(s.trim());
              images.push(s.trim());
            }
          }
          continue;
        }
        if (typeof v !== 'string') continue;
        const val = v.trim();
        if (!val) continue;
        if (BUSINESS_KEY_RE.test(k)) {
          if (PERSONAL_VALUE_RE.test(val)) personalMarks.push(`${k}=${val}`);
          else if (!/^(none|null|unknown|undefined)$/i.test(val)) strongDealer.push(`نوع آگهی‌دهنده در دیوار: ${val}`);
        } else if (BUSINESS_REF_KEY_RE.test(k)) {
          strongDealer.push(`آگهی متصل به کسب‌وکار (${k})`);
        }
        if (IMAGE_RE.test(val) && !imageSet.has(val)) {
          imageSet.add(val);
          images.push(val);
        }
        if (/^(title|subtitle|label|text|value|badge|tag|caption|name)$/i.test(k) && val.length <= 80) shortTexts.push(val);
      }
    }, 0, '');

    if (json && typeof json === 'object') {
      const seo = json.seo && typeof json.seo === 'object' ? json.seo : {};
      const share = json.share && typeof json.share === 'object' ? json.share : {};
      if (!title) title = asText(seo.title) || asText(share.title);
      if (!description) description = asText(seo.description);
    }

    const post = {
      token,
      url: `https://divar.ir/v/${token}`,
      title,
      subtitle,
      description,
      images: images.slice(0, 12),
      fields: {},
      price: null,
      priceText: '',
      mileage: null,
      mileageText: '',
      year: null,
      yearText: '',
      color: '',
      brand: '',
      fuel: '',
      engine: '',
      chassis: '',
      body: '',
      insurance: '',
      gearbox: '',
      exchange: '',
    };

    const chassisParts = [];
    for (const { label, value } of rows) {
      if (!(label in post.fields)) post.fields[label] = value;
      const l = normalizeText(label);
      const rule = FIELD_RULES.find((r) => r.test(l));
      if (!rule) continue;
      switch (rule.key) {
        case 'mileage':
          if (!post.mileageText) { post.mileageText = value; post.mileage = parseNumber(value); }
          break;
        case 'year':
          if (!post.yearText) { post.yearText = value; post.year = normalizeYear(value); }
          break;
        case 'price': {
          // Prefer "قیمت پایه"/"قیمت کل"; ignore per-installment prices.
          if (/قسط|پیش/.test(l)) break;
          if (!post.priceText || /پایه|کل/.test(l)) {
            post.priceText = value;
            post.price = parseNumber(value);
          }
          break;
        }
        case 'chassis': {
          const part = l === 'وضعیت شاسی ها' || l === 'شاسی' ? value : `${label.replace(/وضعیت\s*/, '')}: ${value}`;
          if (!chassisParts.includes(part)) chassisParts.push(part);
          break;
        }
        default:
          if (!post[rule.key]) post[rule.key] = value;
      }
    }
    post.chassis = chassisParts.join('، ');

    // Fallbacks from the search-list card the content script saw.
    if (listInfo) {
      if (!post.title && listInfo.title) post.title = listInfo.title;
      if (!post.images.length && listInfo.image) post.images.push(listInfo.image);
      const lines = Array.isArray(listInfo.lines) ? listInfo.lines : [];
      if (post.price == null && !post.priceText) {
        const priceLine = lines.find((x) => /تومان/.test(x));
        if (priceLine) { post.priceText = priceLine; post.price = parseNumber(priceLine); }
      }
      if (post.mileage == null) {
        const kmLine = lines.find((x) => /کارکرد|کیلومتر/.test(x));
        if (kmLine) { post.mileageText = kmLine; post.mileage = parseNumber(kmLine); }
      }
      if (!post.subtitle) {
        const when = lines.find((x) => /پیش|لحظاتی|دقایقی|دیروز/.test(x));
        if (when) post.subtitle = when;
      }
      lines.forEach((x) => { if (x.length <= 80) shortTexts.push(x); });
    }
    if (!post.priceText && /توافقی/.test(JSON.stringify(rows))) post.priceText = 'توافقی';

    // ---- Seller classification ----
    const descNorm = normalizeText(post.description);
    for (const t of shortTexts) {
      if (descNorm && descNorm.includes(normalizeText(t)) && t.length > 15) continue; // part of the description
      if (STRONG_DEALER_RE.test(t)) strongDealer.push(`برچسب «${t}»`);
    }
    classifySeller(post, { strongDealer, personalMarks });
    return post;
  }

  // Selling on installments / with financing terms (اقساط، بدون ضامن، شرایطی…) is what car
  // dealerships do: an ad that offers it is a dealer's ad, even without a dealership badge.
  const INSTALLMENT_RE = /(نقد\s*و\s*)?(اقساط(ی)?|قسطی|ضامن|شرایطی|لیزینگ|پیش\s*پرداخت|تسهیلات|چک\s*صیادی|بدون\s*چک)/g;
  // «اقساط نداریم»، «قسطی نمی‌فروشم»… mean the opposite.
  const NEGATION_RE = /^\s*(هم\s*)?(ن(داریم|دارد|دارم|یست|میشه|می\s*شود|می\s*فروشم|می\s*دهم|میدم)|ممنوع)/;
  // Divar's own spec row for it («امکان خرید قسطی: دارد»).
  const INSTALLMENT_FIELD_RE = /قسط|اقساط/;

  /** Installment / financing words in the title and description, ignoring negated ones. */
  function installmentWords(text) {
    const s = normalizeText(text);
    const found = [];
    let m;
    INSTALLMENT_RE.lastIndex = 0;
    while ((m = INSTALLMENT_RE.exec(s))) {
      if (NEGATION_RE.test(s.slice(m.index + m[0].length, m.index + m[0].length + 20))) continue;
      if (!found.includes(m[0])) found.push(m[0]);
    }
    return found;
  }

  /**
   * Decide personal vs. dealer from what is in the post. Also used on ads saved earlier, so a
   * new rule applies to them too (`known`: dealer marks seen when the page was read).
   */
  function classifySeller(post, known = {}) {
    const strongDealer = known.strongDealer || [];
    const personalMarks = known.personalMarks || [];
    const descNorm = normalizeText(post.description);

    let score = 0;
    const weak = [];
    for (const [word, weight] of DESCRIPTION_KEYWORDS) {
      if (descNorm.includes(normalizeText(word))) { score += weight; weak.push(word); }
    }
    const installment = installmentWords(`${post.title || ''}\n${post.description || ''}`);
    const fields = post.fields || {};
    const installmentField = Object.keys(fields).find((k) => INSTALLMENT_FIELD_RE.test(k) && /^\s*(دارد|بله)\s*$/.test(fields[k]));

    let seller;
    let confidence;
    let reasons;
    if (strongDealer.length) {
      seller = 'dealer'; confidence = 'high'; reasons = unique(strongDealer);
    } else if (installment.length || installmentField) {
      seller = 'dealer'; confidence = 'medium';
      reasons = [];
      if (installment.length) reasons.push(`فروش اقساطی/شرایطی: ${installment.join('، ')}`);
      if (installmentField) reasons.push(`در مشخصات دیوار: «${installmentField}: ${fields[installmentField]}»`);
    } else if (personalMarks.length) {
      seller = 'personal'; confidence = 'high'; reasons = ['دیوار این آگهی را شخصی علامت زده است'];
    } else if (score >= DEALER_SCORE_THRESHOLD) {
      seller = 'dealer'; confidence = 'low';
      reasons = [`کلمات نمایشگاهی در توضیحات: ${weak.join('، ')}`];
    } else {
      seller = 'personal'; confidence = 'medium';
      reasons = ['نشانه‌ای از نمایشگاه یا کسب‌وکار پیدا نشد'];
      if (weak.length) reasons.push(`کلمات مشکوک (کم‌اهمیت): ${weak.join('، ')}`);
    }
    post.seller = seller;
    post.sellerConfidence = confidence;
    post.sellerReasons = reasons;
    post.dealerScore = score;
    return post;
  }

  /**
   * Re-apply the seller rule to an ad saved earlier. A sure dealer stays a dealer (its badge
   * is not stored); everything else is decided again from title, description and specs.
   */
  function reclassifySaved(post) {
    if (!post) return post;
    if (post.seller === 'dealer' && post.sellerConfidence === 'high') return post;
    return classifySeller(post);
  }

  function unique(arr) {
    return Array.from(new Set(arr));
  }

  /** True when the post fits the user's criteria. Unknown values are kept. */
  function matchesCriteria(post, c) {
    if (!c) return true;
    const yMin = c.yearMin ? normalizeYear(c.yearMin) : null;
    const yMax = c.yearMax ? normalizeYear(c.yearMax) : null;
    if (post.year != null) {
      if (yMin != null && post.year < yMin) return false;
      if (yMax != null && post.year > yMax) return false;
    } else if (c.strictYear && (yMin != null || yMax != null)) {
      return false;
    }
    if (c.priceMax && post.price != null && post.price > Number(c.priceMax)) return false;
    if (c.priceMin && post.price != null && post.price < Number(c.priceMin)) return false;
    if (c.mileageMax && post.mileage != null && post.mileage > Number(c.mileageMax)) return false;
    if (c.keyword) {
      const hay = normalizeText(`${post.title} ${post.brand}`);
      const words = normalizeText(c.keyword).split(' ').filter(Boolean);
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  }

  /** Build the Divar search URL for cars. */
  function buildSearchUrl(c) {
    const city = (c && c.city) || 'tehran';
    const params = new URLSearchParams();
    if (c && c.query) params.set('q', c.query);
    const yMin = c && c.yearMin ? normalizeYear(c.yearMin) : null;
    const yMax = c && c.yearMax ? normalizeYear(c.yearMax) : null;
    if (yMin || yMax) params.set('production-year', `${yMin || ''}-${yMax || ''}`);
    const pMin = c && c.priceMin ? Number(c.priceMin) : null;
    const pMax = c && c.priceMax ? Number(c.priceMax) : null;
    if (pMin || pMax) params.set('price', `${pMin || ''}-${pMax || ''}`);
    const qs = params.toString();
    return `https://divar.ir/s/${encodeURIComponent(city)}/car${qs ? `?${qs}` : ''}`;
  }

  function median(nums) {
    const a = nums.filter((n) => typeof n === 'number' && Number.isFinite(n)).sort((x, y) => x - y);
    if (!a.length) return null;
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
  }

  const api = {
    toEnDigits,
    normalizeText,
    parseNumber,
    normalizeYear,
    extractTokenFromHref,
    extractPost,
    classifySeller,
    reclassifySaved,
    installmentWords,
    matchesCriteria,
    buildSearchUrl,
    median,
  };

  root.NojaParser = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
