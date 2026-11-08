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
    posts[token] = postJson({
      title, subtitle, km, year, color: COLORS[i % COLORS.length], price: i % 13 === 12 ? null : price,
      description, businessType, extraWidgets, body, seed: token,
      brand: i % 9 === 8 ? 'پژو 207 دنده‌ای' : 'پژو 206 تیپ ۲', gearbox: i % 8 === 7 ? 'اتوماتیک' : 'دنده‌ای',
      engine: i % 10 === 6 ? 'نیاز به تعمیر' : 'سالم', images: (i % 4) + 1,
    });
    list.push({ token, title, price, km, year, area, image: PHOTO(`${token}-0`) });
  }
  return { posts, list };
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

module.exports = { postJson, buildDataset, searchPageHtml, fa, faNum };
