/*
 * Removes the plain studio background (white or grey gradient) of a maker's product photo, in
 * Chrome: the background is grown from the photo's edges over smooth, colourless, not-dark pixels
 * and made transparent, with a soft edge (tyres and the shadow under the car stay).
 * Writes <name>.cut.png next to the photo and tells how much was cleared: a photo shot outdoors
 * clears little (its background is not plain), so it is better shown as it is.
 *
 *   node tools/cut-photo.js media/cars/دنا.jpg [more photos…]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const STEP = 7; // largest colour change between two neighbouring background pixels
const GREY = 26; // a background pixel is nearly colourless (max − min channel)
const DARK = 80; // … and not dark (tyres and shadows stay)

/** Cuts one photo in an open Chrome page. Returns { file, cleared } (share made transparent). */
async function cutPhoto(page, f) {
  const abs = path.resolve(f);
  const b64 = fs.readFileSync(abs).toString('base64');
  const out = await page.evaluate(async ({ b64, STEP, GREY, DARK }) => {
    const img = new Image();
    img.src = `data:image;base64,${b64}`;
    await img.decode();
    const w = img.naturalWidth; const h = img.naturalHeight;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, w, h); const px = d.data;
    const bg = new Uint8Array(w * h);
    // a photo that comes already cut (transparent edge) is used as it is
    let tEdge = 0;
    for (let i = 0; i < w; i++) tEdge += (px[i * 4 + 3] < 30) + (px[((h - 1) * w + i) * 4 + 3] < 30);
    for (let j = 0; j < h; j++) tEdge += (px[j * w * 4 + 3] < 30) + (px[(j * w + w - 1) * 4 + 3] < 30);
    if (tEdge / (2 * (w + h)) >= 0.95) return { png: c.toDataURL('image/png').split(',')[1], cleared: 0, edge: 1, holes: 0, ready: true };
    const plain = (i) => {
      if (px[i * 4 + 3] < 30) return true; // already transparent
      const r = px[i * 4]; const g = px[i * 4 + 1]; const b = px[i * 4 + 2];
      return Math.max(r, g, b) - Math.min(r, g, b) <= GREY && (r + g + b) / 3 >= DARK;
    };
    const near = (i, k) => px[i * 4 + 3] < 30 || px[k * 4 + 3] < 30 || Math.abs(px[i * 4] - px[k * 4]) + Math.abs(px[i * 4 + 1] - px[k * 4 + 1]) + Math.abs(px[i * 4 + 2] - px[k * 4 + 2]) <= STEP * 3;
    const q = [];
    for (let i = 0; i < w; i++) q.push(i, (h - 1) * w + i);
    for (let j = 0; j < h; j++) q.push(j * w, j * w + w - 1);
    for (const i of q) bg[i] = plain(i) ? 1 : 0;
    for (let n = 0; n < q.length; n++) {
      const i = q[n];
      if (!bg[i]) continue;
      const cx = i % w; const cy = (i / w) | 0;
      for (const k of [cx > 0 ? i - 1 : -1, cx < w - 1 ? i + 1 : -1, cy > 0 ? i - w : -1, cy < h - 1 ? i + w : -1]) {
        if (k < 0 || bg[k]) continue;
        if (plain(k) && near(i, k)) { bg[k] = 1; q.push(k); }
      }
    }
    let cleared = 0;
    for (let i = 0; i < w * h; i++) {
      if (bg[i]) { px[i * 4 + 3] = 0; cleared++; continue; }
      const cx = i % w; const cy = (i / w) | 0; let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = cx + dx; const yy = cy + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && bg[yy * w + xx]) n++;
      }
      if (n) px[i * 4 + 3] = Math.round(255 * (1 - n / 12));
    }
    x.putImageData(d, 0, 0);
    // quality: how much of the photo's edge is plain background, and holes inside the car's outline
    let edge = 0; let edgeN = 0;
    for (let i = 0; i < w; i++) { edgeN += 2; edge += bg[i] + bg[(h - 1) * w + i]; }
    for (let j = 0; j < h; j++) { edgeN += 2; edge += bg[j * w] + bg[j * w + w - 1]; }
    let holes = 0; let solid = 0;
    for (let j = 0; j < h; j++) {
      let a = -1; let b = -1;
      for (let i = 0; i < w; i++) if (!bg[j * w + i]) { if (a < 0) a = i; b = i; }
      if (a < 0) continue;
      for (let i = a; i <= b; i++) { if (bg[j * w + i]) holes++; else solid++; }
    }
    return { png: c.toDataURL('image/png').split(',')[1], cleared: cleared / (w * h), edge: edge / edgeN, holes: holes / Math.max(1, solid) };
  }, { b64, STEP, GREY, DARK });
  const dest = abs.replace(/\.[^.]+$/, '') + '.cut.png';
  fs.writeFileSync(dest, Buffer.from(out.png, 'base64'));
  // a clean cut: the edge is (nearly) all plain background and the car has no real holes
  const clean = !!out.ready || (out.edge >= 0.95 && out.holes <= 0.06);
  return { file: dest, cleared: out.cleared, edge: out.edge, holes: out.holes, clean };
}

module.exports = { cutPhoto };

if (require.main === module) {
  (async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage();
    for (const f of process.argv.slice(2)) {
      const r = await cutPhoto(page, f);
      console.log(path.basename(r.file), `edge ${Math.round(r.edge * 100)}% holes ${Math.round(r.holes * 100)}% → ${r.clean ? 'cut' : 'card'}`);
    }
    await browser.close();
  })().catch((e) => { console.error(e); process.exit(1); });
}
