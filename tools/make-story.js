/*
 * Instagram story / reel sample: «today's price of a new car vs a used one» for a few Iran Khodro
 * and Saipa models, from the bot's own ads (used: the usual market price of the trim and year) and
 * Bama's daily new-car list (market price of the newest year, same gearbox and engine).
 *
 * Output (media/stories/<day>/): frame-1.png … one 1080×1920 image per car, and story.mp4 where
 * each car's bars grow and then hold (about 3.5 s a car).
 * Photos: the makers' own product photos in media/makers/<car>/.
 *
 *   node tools/make-story.js            (reads data/ads.json; read-only)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright-core');
const P = require('../src/parser');
const D = require('../src/deals');
const { cutPhoto } = require('./cut-photo');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');

// the cars of the story: name on the frame, how the ads write it, model year, maker. The photo is
// found by the model's name in media/cars (see photoFor).
const CARS = [
  { name: 'دنا پلاس توربو اتوماتیک', maker: 'ایران‌خودرو', brand: 'دنا پلاس EF7 اتوماتیک توربو آپشنال', gearbox: 'اتوماتیک', year: 1403 },
  { name: 'پژو ۲۰۷ دنده‌ای', maker: 'ایران‌خودرو', brand: 'پژو 207i دنده‌ای TU5', gearbox: 'دنده‌ای', year: 1402 },
  { name: 'شاهین G', maker: 'سایپا', brand: 'شاهین G', gearbox: 'دنده‌ای', year: 1401 },
  { name: 'ساینا S', maker: 'سایپا', brand: 'ساینا دنده‌ای S', gearbox: 'دنده‌ای', year: 1404 },
  { name: 'رانا پلاس', maker: 'ایران‌خودرو', brand: 'رانا پلاس TU5P', gearbox: 'دنده‌ای', year: 1402 },
  { name: 'سمند سورن پلاس', maker: 'ایران‌خودرو', brand: 'سمند سورن پلاس XU7P بنزینی', gearbox: 'دنده‌ای', year: 1401 },
];

// ---------- photos: media/cars/<model name>.jpg|png — the makers' own photos ----------
const CARS_DIR = path.join(ROOT, 'media', 'cars');
/** The photo of a model: the file named as the model (or as the longest start of its name). */
function photoFor(modelKey) {
  let best = null;
  for (const f of fs.existsSync(CARS_DIR) ? fs.readdirSync(CARS_DIR) : []) {
    if (/\.cut\.png$/.test(f) || !/\.(jpe?g|png|webp|img)$/i.test(f)) continue;
    const k = P.normalizeText(f.replace(/\.[^.]+$/, ''));
    if ((modelKey === k || modelKey.startsWith(`${k} `)) && (!best || k.length > best.k.length)) best = { k, file: path.join(CARS_DIR, f) };
  }
  return best && best.file;
}

const fa = (n) => Number(n).toLocaleString('fa-IR');
const faYear = (y) => Number(y).toLocaleString('fa-IR', { useGrouping: false });
const price = (n) => (n >= 1e9 ? `${(n / 1e9).toLocaleString('fa-IR', { maximumFractionDigits: 2 })} میلیارد` : `${fa(Math.round(n / 1e6))} میلیون`);

function load() {
  const j = JSON.parse(fs.readFileSync(path.join(DATA, 'ads.json'), 'utf8'));
  const posts = Object.values(j.ads).filter((r) => r.post).map((r) => ({ ...r.post, removed: r.removed }));
  // Bama's new-car list: today's if read in full, else the latest full one in the backups
  let bp = j.searches.__bama_prices && j.searches.__bama_prices.criteria.bamaPrices;
  if (!bp || bp.partial || bp.items.length < 400) {
    const dir = path.join(DATA, 'backups');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json.gz')).sort().reverse()) {
      const b = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, f))));
      const s = (b.searches || (b.db && b.db.searches) || {}).__bama_prices;
      const it = s && s.criteria && s.criteria.bamaPrices;
      if (it && it.items.length >= 400) { bp = it; break; }
    }
  }
  return { posts, newItems: bp ? bp.items : [], newAt: bp ? bp.at : null };
}

function figures({ posts, newItems }) {
  const guide = D.priceGuide(posts);
  return CARS.map((c) => {
    const ref = { brand: c.brand, gearbox: c.gearbox, year: c.year, title: c.brand };
    const key = `${P.modelOf(ref).key}|${D.trimOf(ref)}|${c.year}`;
    const g = guide.find((x) => x.key === key && x.enough);
    const nc = D.newCarFor(ref, newItems);
    if (!g || !nc) return { ...c, missing: !g ? 'آگهی کافی نیست' : 'قیمت صفر نیست' };
    return { ...c, used: g.market, n: g.n, fresh: nc.max, freshYear: nc.year, off: Math.round((1 - g.market / nc.max) * 100) };
  });
}

function html(car, p, day) {
  const max = Math.max(car.used, car.fresh);
  const h = (v) => Math.round((v / max) * 380 * p);
  const photo = car.photoFile ? `file:///${car.photoFile.replace(/\\/g, '/')}` : '';
  const logo = `file:///${path.join(ROOT, 'media', 'brand', 'cargozin-logo-crop.png').replace(/\\/g, '/')}`;
  const fonts = `file:///${path.join(ROOT, 'public', 'fonts').replace(/\\/g, '/')}`;
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><style>
@font-face { font-family: V; src: url('${fonts}/Vazirmatn-UI-FD-Regular.woff2'); font-weight: 400; }
@font-face { font-family: V; src: url('${fonts}/Vazirmatn-UI-FD-Bold.woff2'); font-weight: 700; }
* { box-sizing: border-box; margin: 0; }
body { width: 1080px; height: 1920px; background: #fff; font-family: V; color: #111; display: flex; flex-direction: column; align-items: center; padding: 100px 80px 70px; overflow: hidden; }
.logo { height: 150px; margin: -30px 0 16px; }
.kicker { font-size: 38px; color: #555; }
h1 { font-size: 74px; font-weight: 700; color: #111; margin-top: 10px; text-align: center; line-height: 1.3; }
.photo { height: 470px; width: 100%; display: flex; align-items: center; justify-content: center; margin-top: 30px; }
.photo img { max-width: 100%; max-height: 100%; object-fit: contain; }
.photo.card img { width: 860px; height: 450px; object-fit: cover; border-radius: 36px; }
.photo.none { height: 100px; }
.name { font-size: 62px; font-weight: 700; margin-top: 10px; }
.maker { font-size: 34px; color: #5c6b84; margin-top: 4px; }
.badge { margin-top: 26px; font-size: 40px; font-weight: 700; color: #d94f00; background: #fff0e6; border-radius: 999px; padding: 10px 34px; opacity: ${p}; }
.bars { flex: 1; width: 100%; display: flex; align-items: flex-end; justify-content: center; gap: 130px; padding-bottom: 0; }
.bar { display: flex; flex-direction: column; align-items: center; width: 250px; }
.val { font-size: 46px; font-weight: 700; white-space: nowrap; opacity: ${p}; }
.unit { font-size: 28px; color: #5c6b84; margin-bottom: 16px; opacity: ${p}; }
.col { width: 190px; border-radius: 22px 22px 0 0; }
.used .col { background: #ff6200; }
.new .col { background: #1c1c1c; }
.base { width: 100%; border-top: 3px solid #c9d1de; }
.labels { width: 100%; display: flex; justify-content: center; gap: 130px; }
.lab { width: 250px; text-align: center; font-size: 36px; font-weight: 700; margin-top: 18px; }
.foot { font-size: 27px; color: #7a879c; text-align: center; margin-top: 40px; line-height: 1.6; }
</style></head><body>
<img class="logo" src="${logo}">
<div class="kicker">قیمت روز خودرو — ${day}</div>
<h1>صفر یا کارکرده؟</h1>
${photo ? `<div class="photo ${car.photoStyle}"><img src="${photo}"></div>` : '<div class="photo none"></div>'}
<div class="name">${car.name}</div>
<div class="maker">${car.maker}</div>
<div class="badge">کارکردهٔ ${faYear(car.year)} حدود ${fa(car.off)}٪ ارزان‌تر از صفر</div>
<div class="bars">
  <div class="bar used"><div class="val">${price(car.used)}</div><div class="unit">تومان</div><div class="col" style="height:${h(car.used)}px"></div></div>
  <div class="bar new"><div class="val">${price(car.fresh)}</div><div class="unit">تومان</div><div class="col" style="height:${h(car.fresh)}px"></div></div>
</div>
<div class="base"></div>
<div class="labels"><div class="lab">کارکردهٔ ${faYear(car.year)}</div><div class="lab">صفر ${faYear(car.freshYear)}</div></div>
<div class="foot">کارکرده: قیمت معمول بازار از روی ${fa(car.n)} آگهی، بدنهٔ سالم<br>صفر: قیمت روز بازار (باما) — قیمت‌ها پیشنهادی است، نه معامله</div>
</body></html>`;
}

(async () => {
  const data = load();
  const cars = figures(data);
  for (const c of cars) console.log(c.missing ? `${c.name}: ${c.missing}` : `${c.name} ${c.year}: used ${Math.round(c.used / 1e6)} (n=${c.n}) · new ${Math.round(c.fresh / 1e6)} (${c.freshYear}) · −${c.off}%`);
  const ok = cars.filter((c) => !c.missing);
  if (!ok.length) { console.log('done: no car had enough ads today'); return; }
  const now = new Date();
  const day = now.toLocaleDateString('fa-IR', { day: 'numeric', month: 'long', year: 'numeric' });
  const out = path.join(ROOT, 'media', 'stories', now.toLocaleDateString('en-CA'));
  const tmp = path.join(out, 'frames');
  fs.mkdirSync(tmp, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  // each car's photo: cut out when its background is a plain studio one, else shown as a card
  const noPhoto = [];
  for (const car of ok) {
    const src = photoFor(P.modelOf({ brand: car.brand }).key);
    if (!src) { noPhoto.push(car.name); continue; }
    const r = await cutPhoto(page, src);
    car.photoFile = r.clean ? r.file : src;
    car.photoStyle = r.clean ? 'cut' : 'card';
  }
  if (noPhoto.length) console.log('no photo in media/cars for:', noPhoto.join('، '));
  const list = [];
  const FPS = 30;
  const GROW = 24; // frames of the bars growing
  const HOLD = 2.6; // seconds a car stays
  for (const [i, car] of ok.entries()) {
    for (let f = 0; f <= GROW; f++) {
      const t = f / GROW;
      const ease = 1 - (1 - t) ** 3;
      const file = path.join(tmp, `c${i + 1}-${String(f).padStart(3, '0')}.png`);
      const hf = path.join(tmp, 'frame.html');
      fs.writeFileSync(hf, html(car, ease, day));
      await page.goto(`file:///${hf.replace(/\\/g, '/')}`);
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: file });
      list.push(`file '${file.replace(/\\/g, '/')}'\nduration ${f === GROW ? HOLD : 1 / FPS}`);
      if (f === GROW) fs.copyFileSync(file, path.join(out, `frame-${i + 1}.png`));
    }
  }
  await browser.close();
  list.push(list[list.length - 1].split('\n')[0]); // the concat list repeats the last file once
  const listFile = path.join(tmp, 'list.txt');
  fs.writeFileSync(listFile, list.join('\n'));
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-movflags', '+faststart', path.join(out, 'story.mp4')]);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`done: ${out}`);
})().catch((e) => { console.error(e); process.exit(1); });
