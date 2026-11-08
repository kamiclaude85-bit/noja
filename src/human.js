/*
 * Human-paced browsing helpers: curved mouse movement, uneven scrolling,
 * typing with natural delays, and reading time that depends on the page.
 *
 * Goal: browse Divar the way one person would — one tab, a few seconds per
 * ad, breaks, a daily cap — so the bot never puts more load on the site than
 * a normal visitor. It does NOT hide or spoof anything about the browser.
 */
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const chance = (p) => Math.random() < p;

/** Gaussian-ish random (sum of uniforms), clamped to [min, max]. */
function natural(min, max) {
  const mid = (min + max) / 2;
  const spread = (max - min) / 2;
  const g = (Math.random() + Math.random() + Math.random()) / 1.5 - 1; // ~[-1, 1], peaks at 0
  return Math.min(max, Math.max(min, mid + g * spread));
}

const positions = new WeakMap();

/** Move the mouse to (x, y) along a slightly curved, eased path. */
async function moveMouse(page, x, y) {
  const vp = page.viewportSize() || { width: 1280, height: 800 };
  const from = positions.get(page) || { x: rand(vp.width * 0.3, vp.width * 0.7), y: rand(vp.height * 0.2, vp.height * 0.6) };
  const dist = Math.hypot(x - from.x, y - from.y);
  const steps = Math.max(8, Math.min(45, Math.round(dist / rand(18, 30))));
  // Control point off the straight line gives a natural arc.
  const cx = (from.x + x) / 2 + rand(-0.25, 0.25) * dist;
  const cy = (from.y + y) / 2 + rand(-0.25, 0.25) * dist;
  for (let i = 1; i <= steps; i++) {
    const t0 = i / steps;
    const t = t0 < 0.5 ? 2 * t0 * t0 : 1 - (-2 * t0 + 2) ** 2 / 2; // ease in-out
    const px = (1 - t) ** 2 * from.x + 2 * (1 - t) * t * cx + t * t * x + rand(-0.8, 0.8);
    const py = (1 - t) ** 2 * from.y + 2 * (1 - t) * t * cy + t * t * y + rand(-0.8, 0.8);
    await page.mouse.move(px, py);
    await sleep(rand(4, 14));
  }
  await page.mouse.move(x, y);
  positions.set(page, { x, y });
}

/** Scroll by roughly `total` pixels in a few uneven wheel ticks. */
async function scrollBy(page, total) {
  let left = Math.abs(total);
  const dir = Math.sign(total) || 1;
  while (left > 0) {
    const step = Math.min(left, rand(90, 260));
    await page.mouse.wheel(0, dir * step);
    left -= step;
    await sleep(rand(30, 110));
  }
}

/** Bring an element into view by scrolling with the wheel (not jumping). */
async function scrollIntoView(page, handle) {
  const vp = page.viewportSize() || { width: 1280, height: 800 };
  for (let i = 0; i < 25; i++) {
    const box = await handle.boundingBox();
    if (!box) return false;
    const target = vp.height * rand(0.3, 0.6);
    const delta = box.y + box.height / 2 - target;
    if (Math.abs(delta) < vp.height * 0.25) return true;
    await scrollBy(page, Math.sign(delta) * Math.min(Math.abs(delta), rand(500, 900)));
    await sleep(rand(120, 380));
  }
  return true;
}

/** Move to a random point inside the element, hesitate, and click. */
async function clickElement(page, handle, options = {}) {
  await scrollIntoView(page, handle);
  const box = await handle.boundingBox();
  if (!box) throw new Error('element not visible');
  const x = box.x + box.width * rand(0.25, 0.75);
  const y = box.y + box.height * rand(0.25, 0.7);
  await moveMouse(page, x, y);
  await sleep(rand(120, 450)); // look before clicking
  await page.mouse.down({ button: options.button || 'left' });
  await sleep(rand(40, 130));
  await page.mouse.up({ button: options.button || 'left' });
}

/** Type like a person: uneven key delays, a short pause now and then. */
async function typeText(page, text) {
  for (const ch of text) {
    await page.keyboard.type(ch);
    await sleep(ch === ' ' ? rand(120, 320) : rand(70, 210));
    if (chance(0.06)) await sleep(rand(250, 700));
  }
}

/**
 * "Read" the current page for about `ms` milliseconds: scroll down in
 * uneven steps, pause, sometimes scroll back up a little.
 */
async function readPage(page, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = Math.random();
    if (r < 0.62) await scrollBy(page, rand(150, 520));
    else if (r < 0.75) await scrollBy(page, -rand(100, 300));
    else {
      const vp = page.viewportSize() || { width: 1280, height: 800 };
      await moveMouse(page, rand(vp.width * 0.15, vp.width * 0.85), rand(vp.height * 0.15, vp.height * 0.85));
    }
    await sleep(Math.min(end - Date.now(), natural(500, 2600)));
  }
}

/** Shuffle lightly: items stay roughly in order, but not strictly. */
function looseOrder(items, window = 4) {
  const out = items.slice();
  for (let i = 0; i < out.length; i++) {
    const j = Math.min(out.length - 1, i + randInt(0, window - 1));
    if (chance(0.35)) [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

module.exports = { sleep, rand, randInt, chance, natural, moveMouse, scrollBy, scrollIntoView, clickElement, typeText, readPage, looseOrder };
