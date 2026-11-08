/*
 * Mock data shaped like Divar's public post API (`api.divar.ir/v8/posts-v2/web/<token>`)
 * and its search page. Used by unit tests and the browser end-to-end test.
 */
'use strict';

const fa = (n) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
const faNum = (n) => fa(Number(n).toLocaleString('en-US').replace(/,/g, '٬'));

const PHOTO = (seed) => `https://s100.divarcdn.com/static/photo/neda/post/mock-${seed}.webp`;

function postJson({
  title, subtitle, km, year, color, brand = 'پژو 206 تیپ ۲', fuel = 'بنزینی',
  price, engine = 'سالم', frontChassis = 'سالم و پلمپ', rearChassis = 'سالم و پلمپ',
  body = 'سالم و بی‌خط و خش', insurance = '۸ ماه', gearbox = 'دنده‌ای', description = '',
  businessType, extraWidgets = [], images = 3, seed = 'x',
}) {
  const json = {
    sections: [
      {
        section_name: 'BREADCRUMB',
        widgets: [{ widget_type: 'BREADCRUMB', data: { parent_items: [{ title: 'خودرو' }, { title: 'سواری و وانت' }] } }],
      },
      {
        section_name: 'TITLE',
        widgets: [{ widget_type: 'LEGEND_TITLE_ROW', data: { title, subtitle } }],
      },
      {
        section_name: 'IMAGE',
        widgets: [{
          widget_type: 'IMAGE_CAROUSEL',
          data: { items: Array.from({ length: images }, (_, i) => ({ image: { url: PHOTO(`${seed}-${i}`), alt: title } })) },
        }],
      },
      {
        section_name: 'LIST_DATA',
        widgets: [
          {
            widget_type: 'GROUP_INFO_ROW',
            data: {
              items: [
                { title: 'کارکرد', value: faNum(km) },
                { title: 'مدل (سال تولید)', value: fa(year) },
                { title: 'رنگ', value: color },
              ],
            },
          },
          { widget_type: 'UNEXPANDABLE_ROW', data: { title: 'برند و تیپ', value: brand } },
          { widget_type: 'UNEXPANDABLE_ROW', data: { title: 'نوع سوخت', value: fuel } },
          {
            widget_type: 'GROUP_INFO_ROW',
            data: {
              items: [
                { title: 'موتور', value: engine },
                { title: 'شاسی جلو', value: frontChassis },
                { title: 'شاسی عقب', value: rearChassis },
              ],
            },
          },
          { widget_type: 'UNEXPANDABLE_ROW', data: { title: 'بدنه', value: body } },
          { widget_type: 'UNEXPANDABLE_ROW', data: { title: 'مهلت بیمهٔ شخص ثالث', value: insurance } },
          { widget_type: 'UNEXPANDABLE_ROW', data: { title: 'گیربکس', value: gearbox } },
          { widget_type: 'UNEXPANDABLE_ROW', data: { title: 'قیمت پایه', value: price == null ? 'توافقی' : `${faNum(price)} تومان` } },
          ...extraWidgets,
        ],
      },
      {
        section_name: 'DESCRIPTION',
        widgets: [
          { widget_type: 'TITLE_ROW', data: { text: 'توضیحات' } },
          { widget_type: 'DESCRIPTION_ROW', data: { text: description } },
        ],
      },
    ],
    seo: { title, description: description.slice(0, 120) },
    share: { title, web_url: `https://divar.ir/v/${seed}` },
  };
  if (businessType) json.webengage = { business_type: businessType, category: 'light', price };
  return json;
}

const COLORS = ['سفید', 'نقره‌ای', 'مشکی', 'خاکستری', 'سفید', 'آبی'];
const AREAS = ['پونک', 'تهرانپارس', 'سعادت‌آباد', 'نارمک', 'جنت‌آباد', 'شهرک غرب', 'پیروزی', 'ونک'];

/** Build a deterministic set of mock ads. */
function buildDataset(count = 40) {
  const posts = {};
  const specs = {};
  const list = [];
  for (let i = 0; i < count; i++) {
    const token = `Qm${String(i).padStart(3, '0')}xYz`;
    const year = [1397, 1397, 1397, 1396, 1398, 1397][i % 6];
    const km = 60000 + ((i * 7919) % 120000);
    const price = 430000000 + ((i * 104729) % 140) * 1000000;
    const kind = i % 5; // 0,1 personal(webengage) 2 personal(no marker) 3 dealer(api) 4 dealer(desc only)
    const title = i % 9 === 8 ? `پژو 207 دنده‌ای مدل ${fa(year)}` : `پژو ۲۰۶ تیپ ۲ مدل ${fa(year)}`;
    const area = AREAS[i % AREAS.length];
    let subtitle = `${fa((i % 11) + 1)} ساعت پیش در تهران، ${area}`;
    let description = 'ماشین تمیز و بی‌رنگ، دست اول، فنی سالم. بدون واسطه. فقط تماس.';
    let businessType = kind <= 1 ? 'personal' : undefined;
    const extraWidgets = [];
    if (kind === 2) description = 'ماشین شخصی، از نمایشگاه خریده بودم، دو سال دستمه. کارشناسی آزاد.';
    if (kind === 3) {
      businessType = 'premium-panel';
      subtitle = `${fa((i % 11) + 1)} ساعت پیش در تهران، ${area} · نمایشگاه اتوگالری ستاره`;
      description = 'فروش نقد و اقساط، تحویل فوری. انواع خودرو موجود است.';
    }
    if (kind === 4) description = 'نمایشگاه خودرو آرمان\nخرید و فروش انواع خودروهای صفر و کارکرده\nساعات کاری ۹ تا ۲۱';
    const body = i % 7 === 3 ? 'دو لکه رنگ‌شدگی' : (i % 7 === 5 ? 'خط و خش جزیی' : 'سالم و بی‌خط و خش');
    const spec = {
      title, subtitle, km, year, color: COLORS[i % COLORS.length], price: i % 13 === 12 ? null : price,
      description, businessType, extraWidgets, body, seed: token,
      brand: i % 9 === 8 ? 'پژو 207 دنده‌ای' : 'پژو 206 تیپ ۲', gearbox: i % 8 === 7 ? 'اتوماتیک' : 'دنده‌ای',
      engine: i % 10 === 6 ? 'نیاز به تعمیر' : 'سالم', images: (i % 4) + 1,
      // How the rendered ad page looks: Divar-like class names, or plain markup (tests the text fallback).
      classless: i % 6 === 1,
      dealerLink: kind === 3 ? 'نمایشگاه اتوگالری ستاره' : null,
      kind,
    };
    if (kind === 3) spec.subtitle = `${fa((i % 11) + 1)} ساعت پیش در تهران، ${area}`;
    specs[token] = spec;
    posts[token] = postJson(spec);
    list.push({ token, title, price, km, year, area, image: PHOTO(`${token}-0`) });
  }
  return { posts, specs, list };
}

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A rendered Divar ad page (what Chrome shows), built from a spec.
 * The site header deliberately contains «نمایشگاه» and «/business» links,
 * which must NOT make every ad look like a dealer.
 */
function adPageHtml(spec) {
  const priceText = spec.price == null ? 'توافقی' : `${faNum(spec.price)} تومان`;
  const groups = [
    [['کارکرد', faNum(spec.km)], ['مدل (سال تولید)', fa(spec.year)], ['رنگ', spec.color]],
  ];
  const rows = [
    ['برند و تیپ', spec.brand], ['نوع سوخت', spec.fuel || 'بنزینی'], ['موتور', spec.engine || 'سالم'],
    ['شاسی جلو', 'سالم و پلمپ'], ['شاسی عقب', 'سالم و پلمپ'], ['بدنه', spec.body], ['مهلت بیمهٔ شخص ثالث', '۸ ماه'],
    ['گیربکس', spec.gearbox || 'دنده‌ای'], ['قیمت پایه', priceText],
  ];
  const imgs = Array.from({ length: spec.images }, (_, i) => `<img src="${PHOTO(`${spec.seed}-${i}`)}" alt="">`).join('');
  const header = `<header class="site-header"><a href="/">دیوار</a> <a href="/s/tehran/car-dealership">نمایشگاه‌های خودرو</a>
    <a href="https://divar.ir/business">دیوار برای کسب‌وکارها</a> <a href="/my-divar">دیوار من</a></header>`;
  const footer = '<footer>درباره دیوار — پشتیبانی — نمایشگاه‌ها و فروشگاه‌ها</footer>';
  const dealer = spec.dealerLink ? `<a class="kt-base-row business-row" href="/business/abc123">${esc(spec.dealerLink)}</a>` : '';
  let main;
  if (!spec.classless) {
    const table = groups.map((g) => `<table class="kt-group-row"><thead><tr>${g.map(([t]) => `<th class="kt-group-row-item__title">${esc(t)}</th>`).join('')}</tr></thead>
      <tbody><tr>${g.map(([, v]) => `<td class="kt-group-row-item__value">${esc(v)}</td>`).join('')}</tr></tbody></table>`).join('');
    const unexp = rows.map(([t, v]) => `<div class="kt-base-row kt-unexpandable-row"><div class="kt-base-row__start"><p class="kt-base-row__title kt-unexpandable-row__title">${esc(t)}</p></div>
      <div class="kt-base-row__end"><p class="kt-unexpandable-row__value">${esc(v)}</p></div></div>`).join('');
    main = `<div class="kt-page-title"><h1 class="kt-page-title__title">${esc(spec.title)}</h1><div class="kt-page-title__subtitle">${esc(spec.subtitle)}</div></div>
      ${dealer}<div class="kt-image-block">${imgs}</div>${table}${unexp}
      <div class="kt-description-row"><p class="kt-description-row__text">${esc(spec.description).replace(/\n/g, '<br>')}</p></div>`;
  } else {
    const table = groups.map((g) => `<table><tr>${g.map(([t]) => `<th>${esc(t)}</th>`).join('')}</tr><tr>${g.map(([, v]) => `<td>${esc(v)}</td>`).join('')}</tr></table>`).join('');
    const plain = rows.map(([t, v]) => `<div><div>${esc(t)}</div><div>${esc(v)}</div></div>`).join('');
    main = `<div><h1>${esc(spec.title)}</h1><div>${esc(spec.subtitle)}</div></div>${dealer}<div>${imgs}</div>${table}${plain}
      <div><h3>توضیحات</h3><p>${esc(spec.description).replace(/\n/g, '<br>')}</p></div><div>یادداشت شما</div>`;
  }
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>${esc(spec.title)} - دیوار</title>
<style>body{font-family:Tahoma;margin:0} main{max-width:900px;margin:auto;padding:20px} img{width:200px;height:120px} table{border-collapse:collapse} th,td{padding:4px 12px}</style>
</head><body>${header}<main><div class="post-page"><section class="post-col">${main}</section><aside>آگهی‌های مشابه</aside></div></main>${footer}</body></html>`;
}

/** Divar's page when it suspects a bot. */
function captchaPageHtml() {
  return '<!doctype html><html lang="fa"><head><meta charset="utf-8"></head><body><h2>لطفاً تأیید کنید که ربات نیستید</h2><p>من ربات نیستم</p></body></html>';
}

/** A fake Divar search page with infinite scroll (adds 12 cards per scroll). */
function searchPageHtml(list) {
  const data = JSON.stringify(list).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>دیوار</title>
<style>body{font-family:Tahoma;margin:0;padding:20px} .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
article{border:1px solid #ddd;border-radius:8px;padding:8px;height:260px} img{width:100%;height:120px;background:#eee}</style></head>
<body><h1>خرید و فروش پژو ۲۰۶ در تهران</h1><div class="grid" id="g"></div>
<script>
const ALL = ${data};
const fa = (n) => String(n).replace(/\\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
let shown = 0;
function more(){
  const g = document.getElementById('g');
  for (const p of ALL.slice(shown, shown + 12)) {
    const a = document.createElement('a');
    a.href = '/v/' + encodeURIComponent(p.title.replace(/\\s+/g,'-')) + '/' + p.token;
    a.innerHTML = '<article class="kt-post-card"><img alt=""><h2>' + p.title + '</h2><div>' + fa(p.km.toLocaleString()) + ' کیلومتر</div><div>' + fa(p.price.toLocaleString()) + ' تومان</div><span>لحظاتی پیش در ' + p.area + '</span></article>';
    g.appendChild(a);
  }
  shown += 12;
}
more();
window.addEventListener('scroll', () => {
  if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 50 && shown < ALL.length) setTimeout(more, 300);
});
</script></body></html>`;
}

module.exports = { postJson, buildDataset, searchPageHtml, adPageHtml, captchaPageHtml, fa, faNum };
