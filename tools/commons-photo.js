/*
 * A photo for a car model that has none in media/cars, from Wikimedia Commons — only files in the
 * public domain (or CC0), so they can be used on Instagram with no credit or licence trouble.
 * The model's English name comes from Divar's catalog (its address: «hyundai/sonata-yf» →
 * "hyundai sonata yf"). The best match is a large landscape photo of the outside of the car
 * (not the interior, the engine or a detail). It is saved as media/cars/<model>.jpg and noted in
 * media/cars/sources.txt, so it can be checked and replaced.
 *
 *   node tools/commons-photo.js "هیوندای سوناتا YF"
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const P = require('../src/parser');

const ROOT = path.join(__dirname, '..');
const CARS_DIR = path.join(ROOT, 'media', 'cars');
const UA = 'RadyabBot/1.0 (car price stories; photo lookup)';
const API = 'https://commons.wikimedia.org/w/api.php';

/** The catalog's English address of a model: "hyundai sonata yf", or null. */
function englishName(modelKey) {
  const cat = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'divar-models.json'), 'utf8'));
  let best = null;
  for (const b of cat.brands || []) {
    for (const m of [{ slug: '', fa: b.fa }, ...(b.models || [])]) {
      const fa = P.normalizeText(m.fa);
      if (fa === modelKey || fa.startsWith(`${modelKey} `)) {
        const name = `${b.slug} ${m.slug}`.replace(/[-_./]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (!best || fa.length < best.len) best = { name, len: fa.length };
      }
    }
  }
  if (!best) return null;
  // as many words as the model's own name («saipa atlas e» → «saipa atlas»)
  return best.name.split(' ').slice(0, Math.max(2, modelKey.split(' ').length)).join(' ');
}

const SKIP = /interior|inside|cockpit|dashboard|dash|engine|motor|seat|wheel|rim|badge|logo|emblem|light|lamp|grille|detail|trunk|boot|rear|back|side|crash|accident|police|taxi|model|toy|drawing|sketch|interior/i;

async function api(params) {
  const u = `${API}?${new URLSearchParams({ format: 'json', origin: '*', ...params })}`;
  const r = await fetch(u, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error(`Commons ${r.status}`);
  return r.json();
}

/** Finds, downloads and saves a public-domain photo. Returns { file, title, url } or null. */
async function commonsPhoto(modelLabel) {
  const key = P.modelOf({ brand: modelLabel }).key || P.normalizeText(modelLabel);
  const name = englishName(key);
  if (!name) return null;
  const j = await api({
    action: 'query', generator: 'search', gsrsearch: `${name} car`, gsrnamespace: '6', gsrlimit: '40',
    prop: 'imageinfo', iiprop: 'url|size|extmetadata|mime', iiurlwidth: '1600',
  });
  const words = name.split(' ').filter((w) => w.length > 1);
  const cands = [];
  for (const p of Object.values((j.query && j.query.pages) || {})) {
    const ii = p.imageinfo && p.imageinfo[0];
    if (!ii || !/jpeg/.test(ii.mime)) continue;
    const lic = String(((ii.extmetadata || {}).LicenseShortName || {}).value || '');
    if (!/public domain|cc0|pd/i.test(lic)) continue; // only free to use with no credit
    const title = p.title.replace(/^File:/, '');
    const t = title.toLowerCase().replace(/[_-]+/g, ' ');
    if (SKIP.test(t)) continue;
    const hits = words.filter((w) => t.includes(w.toLowerCase())).length;
    if (hits < Math.min(words.length, 2)) continue;
    const ratio = ii.width / ii.height;
    if (ii.width < 1000 || ratio < 1.2 || ratio > 2.2) continue;
    // more of the model's words, a «front» shot, a bigger photo
    const score = hits * 10 + (/front|vorne|frontal/.test(t) ? 5 : 0) + Math.min(ii.width, 3000) / 1000;
    cands.push({ title, url: ii.thumburl || ii.url, score });
  }
  cands.sort((a, b) => b.score - a.score);
  const best = cands[0];
  if (!best) return null;
  const r = await fetch(best.url, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error(`download ${r.status}: ${best.title}`);
  fs.mkdirSync(CARS_DIR, { recursive: true });
  const file = path.join(CARS_DIR, `${modelLabel}.jpg`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  fs.appendFileSync(path.join(CARS_DIR, 'sources.txt'),
    `${modelLabel}.jpg — Wikimedia Commons «${best.title}», public domain (found by the bot, check before posting)\nhttps://commons.wikimedia.org/wiki/File:${encodeURIComponent(best.title.replace(/ /g, '_'))}\n`);
  return { file, title: best.title, url: best.url };
}

module.exports = { commonsPhoto, englishName };

if (require.main === module) {
  commonsPhoto(process.argv[2] || '').then((r) => console.log(r || 'no public-domain photo found')).catch((e) => { console.error(e.message); process.exit(1); });
}
