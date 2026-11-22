/*
 * One-off: the official product photos of Iran Khodro and the Saipa group (Saipa, Pars Khodro,
 * Zamyad) from the makers' own sites, into media/makers-all/<maker>/<product>/1.jpg …
 * Slow (a pause between pages), only product and gallery pages. Re-running skips what is there.
 *
 *   node tools/fetch-maker-photos.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const OUT = path.join(__dirname, '..', 'media', 'makers-all');
const wait = (ms) => new Promise((r) => setTimeout(r, ms + Math.random() * ms * 0.5));
const safe = (s) => String(s).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

async function save(page, url, file) {
  if (fs.existsSync(file)) return true;
  const b64 = await page.evaluate(async (u) => {
    const r = await fetch(u);
    if (!r.ok) return null;
    const b = new Uint8Array(await r.arrayBuffer());
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s);
  }, url).catch(() => null);
  if (!b64) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  return true;
}

async function ikco(page) {
  await page.goto('https://www.ikco.ir/fa/', { waitUntil: 'domcontentloaded' });
  await wait(2000);
  const products = await page.evaluate(() => {
    const seen = new Map();
    for (const a of document.querySelectorAll('a[href*="Product.aspx?ID="]')) {
      const id = (a.getAttribute('href').match(/ID=(\d+)/) || [])[1];
      const name = (new URL(a.href).searchParams.get('Series') || a.textContent || '').trim();
      if (id && !seen.has(id)) seen.set(id, name);
    }
    return Array.from(seen.entries());
  });
  console.log('Iran Khodro products:', products.length);
  for (const [id, name] of products) {
    const dir = path.join(OUT, 'ikco', `${id} ${safe(name || id)}`);
    if (fs.existsSync(path.join(dir, '1.jpg'))) continue;
    const urls = await page.evaluate(async (pid) => {
      const base = `https://www.ikco.ir/fa/Product.aspx?ID=${pid}&Section=1`;
      const h = await (await fetch(base)).text();
      const d = new DOMParser().parseFromString(h, 'text/html');
      const title = (d.querySelector('title') || {}).textContent || '';
      const gl = Array.from(d.querySelectorAll('a')).find((a) => /گالری|تصاویر/.test(a.textContent));
      if (!gl) return { title, urls: [] };
      const g = await (await fetch(new URL(gl.getAttribute('href'), base))).text();
      const dd = new DOMParser().parseFromString(g, 'text/html');
      return { title, urls: [...new Set(Array.from(dd.querySelectorAll('a[href*="Download"]')).map((e) => new URL(e.getAttribute('href'), 'https://www.ikco.ir/').href))].slice(0, 8) };
    }, id).catch(() => ({ urls: [] }));
    let n = 0;
    for (const u of urls.urls) { n++; await save(page, u, path.join(dir, `${n}.jpg`)); await wait(600); }
    if (n) fs.writeFileSync(path.join(dir, 'title.txt'), `${urls.title}\n${name}`);
    console.log(`ikco ${id} ${name}: ${n}`);
    await wait(1500);
  }
}

async function saipa(page) {
  const lists = ['https://www.saipacorp.com/fa/products/producing', 'https://www.saipacorp.com/fa/products/expired'];
  const products = new Map();
  for (const l of lists) {
    let ok = false;
    for (let t = 0; t < 3 && !ok; t++) { ok = await page.goto(l, { waitUntil: 'domcontentloaded', timeout: 45000 }).then(() => true).catch(() => false); if (!ok) await wait(5000); }
    if (!ok) { console.log('could not open', l); continue; }
    await wait(2000);
    for (const [href, name] of await page.evaluate(() => Array.from(document.querySelectorAll('a[href*="/products/producing/"], a[href*="/products/expired/"], a[href^="producing/"], a[href^="expired/"]'))
      .map((a) => [a.href, (a.textContent || '').trim()]))) {
      if (!products.has(href)) products.set(href, name);
    }
  }
  console.log('Saipa group products:', products.size);
  for (const [href, name] of products) {
    const slug = href.split('/').slice(-2).join(' ');
    const dir = path.join(OUT, 'saipa', safe(slug));
    if (fs.existsSync(path.join(dir, '1.jpg'))) continue;
    await page.goto(href, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await wait(1500);
    const info = await page.evaluate(() => ({
      title: document.title,
      urls: [...new Set(Array.from(document.querySelectorAll('img')).map((i) => i.currentSrc || i.src).filter((s) => /\/Images\/Products\//i.test(s) && /\.(jpe?g|png|webp)/i.test(s)))].slice(0, 10),
    })).catch(() => ({ urls: [] }));
    let n = 0;
    for (const u of info.urls) { n++; await save(page, u, path.join(dir, `${n}.jpg`)); await wait(500); }
    if (n) fs.writeFileSync(path.join(dir, 'title.txt'), `${info.title}\n${name}\n${href}`);
    console.log(`saipa ${slug}: ${n}`);
    await wait(1200);
  }
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ locale: 'fa-IR' });
  await ikco(page).catch((e) => console.error('ikco', e.message));
  await saipa(page).catch((e) => console.error('saipa', e.message));
  await browser.close();
})();
