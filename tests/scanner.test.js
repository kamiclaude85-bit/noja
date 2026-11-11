/* The bot must not be closed by a late "no new tab opened" error (it used to crash mid-search). */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const H = require('../src/human');
const { Scanner } = require('../src/scanner');

test('a failed new-tab click leaves no unhandled error behind', async () => {
  const saved = { chance: H.chance, clickElement: H.clickElement, sleep: H.sleep };
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  let closedLateTab = false;
  try {
    H.chance = () => true; // always take the "open in a new tab" path
    H.clickElement = async () => { throw new Error('element not visible'); };
    H.sleep = async () => {};
    const context = {
      // Like Chrome when no tab opens: rejects a little later.
      waitForEvent: () => new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout exceeded')), 30)),
    };
    const scanner = new Scanner({ context, store: {} });
    scanner.control = { stop: false };
    scanner.ensureList = async () => {};
    scanner.findCard = async () => ({});
    const page = { goto: async () => { throw new Error('offline'); } };
    const item = { token: 'AbCd', href: 'https://divar.ir/v/AbCd' };
    await assert.rejects(() => scanner.readAd({}, page, item, { read: [0, 0] }, 'https://divar.ir/s/tehran/car'), /offline/);
    await new Promise((r) => setTimeout(r, 80)); // let the late timeout fire
    assert.deepStrictEqual(unhandled, []);

    // A tab that opens after the click already failed is closed, not left behind.
    context.waitForEvent = () => new Promise((resolve) => setTimeout(() => resolve({ close: async () => { closedLateTab = true; } }), 30));
    await assert.rejects(() => scanner.readAd({}, page, item, { read: [0, 0] }, 'https://divar.ir/s/tehran/car'), /offline/);
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(closedLateTab, true);
    assert.deepStrictEqual(unhandled, []);
  } finally {
    Object.assign(H, saved);
    process.off('unhandledRejection', onUnhandled);
  }
});
