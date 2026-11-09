#!/usr/bin/env node
/*
 * Build public/divar-models.json: Divar's makes and models for the «خرید با بودجه» picker.
 * Reads Divar's public car pages (the same pages a visitor sees): the car page lists every
 * make, and each make's page lists its models with their address (/s/tehran/car/<make>/<model>).
 * Slow on purpose (one page every ~2 s). Run again now and then to pick up new models:
 *   node tools/divar-models.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'public', 'divar-models.json');
const BASE = 'https://divar.ir/s/tehran/car';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (t) => t.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').replace(/^خودرو\s*/, '').replace(/\s*در تهران$/, '').trim();

// Pages are opened in a hidden Chrome window (plain requests get a cut-down page).
let browserPage = null;
async function page(url) {
  if (!browserPage) {
    const { chromium } = require('playwright-core');
    const b = await chromium.launch({ channel: 'chrome', headless: true });
    browserPage = await b.newPage({ locale: 'fa-IR' });
    process.on('exit', () => { b.close().catch(() => {}); });
  }
  for (let i = 1; i <= 3; i++) {
    try {
      await browserPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await browserPage.waitForSelector('a[href^="/s/tehran/car"]', { timeout: 15000 }).catch(() => {});
      return await browserPage.content();
    } catch (_) { await sleep(3000 * i); }
  }
  throw new Error(`could not read ${url}`);
}

/** Links «<a href="/s/tehran/car/<x>">text</a>» → Map(slug → name). */
function links(html, re) {
  const out = new Map();
  for (const m of html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const h = m[1].replace(/&amp;/g, '&');
    const mm = h.match(re);
    if (mm && !out.has(mm[1])) out.set(mm[1], clean(m[2]));
  }
  return out;
}

(async () => {
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { brands: [] };
  const known = new Map((prev.brands || []).filter((b) => b.models && b.models.length).map((b) => [b.slug, b]));
  const brands = links(await page(BASE), /^\/s\/tehran\/car\/([^/?]+)$/);
  console.log(`${brands.size} makes`);
  // (Iranian / imported is not per make on Divar: the «داخلی/خارجی» filter is applied on Divar itself,
  //  and saved ads are told apart by their model year — Persian for Iranian-made, Western for imported.)
  const origin = new Map();
  const out = [];
  let n = 0;
  for (const [slug, fa] of brands) {
    n++;
    let models;
    if (known.has(slug) && process.argv[2] !== '--all') {
      models = known.get(slug).models;
    } else {
      await sleep(1800 + Math.random() * 800);
      const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      try {
        models = [...links(await page(`${BASE}/${slug}`), new RegExp(`^/s/tehran/car/${esc}/([^/?]+)$`))].map(([s, f]) => ({ slug: s, fa: f }));
      } catch (e) { console.log(`  ${slug}: ${e.message}`); models = known.has(slug) ? known.get(slug).models : []; }
      process.stdout.write(`${n}/${brands.size} ${fa} (${models.length})\n`);
    }
    out.push({ slug, fa, origin: origin.get(slug) || '', models });
    // save as we go, so a stop halfway keeps what was read
    if (n % 10 === 0) fs.writeFileSync(OUT, JSON.stringify({ builtAt: Date.now(), brands: [...out, ...(prev.brands || []).filter((b) => !out.some((x) => x.slug === b.slug))] }));
  }
  fs.writeFileSync(OUT, JSON.stringify({ builtAt: Date.now(), brands: out }));
  console.log(`done: ${out.length} makes, ${out.reduce((s, b) => s + b.models.length, 0)} models → ${path.relative(process.cwd(), OUT)}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
