/* Wires Chrome, the bot and the local control panel together. */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { Store } = require('./store');
const { Scanner } = require('./scanner');
const { createServer } = require('./server');

const ROOT = path.join(__dirname, '..');

/**
 * Open Google Chrome with Noja's own profile. Logging in to Divar once in this
 * window is remembered for next time (the profile is kept in ./chrome-profile).
 */
async function launchChrome({ profileDir, executablePath }) {
  const { chromium } = require('playwright-core');
  fs.mkdirSync(profileDir, { recursive: true });
  const base = { headless: false, viewport: null, locale: 'fa-IR', args: ['--start-maximized'] };
  const attempts = executablePath
    ? [{ executablePath }]
    : [{ channel: 'chrome' }, { channel: 'msedge' }];
  let lastErr;
  for (const extra of attempts) {
    try {
      return await chromium.launchPersistentContext(profileDir, { ...base, ...extra });
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    'گوگل کروم پیدا نشد. لطفاً Google Chrome را نصب کنید، یا مسیر آن را در متغیر NOJA_CHROME_PATH بگذارید.\n'
    + `(${lastErr && lastErr.message ? lastErr.message.split('\n')[0] : lastErr})`,
  );
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const tryPort = (p, left) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && left > 0) tryPort(p + 1, left - 1);
        else reject(err);
      });
      server.listen(p, '127.0.0.1', () => resolve(server.address().port));
    };
    tryPort(port, 10);
  });
}

/**
 * Start everything. `context` can be injected (tests); otherwise Chrome is launched.
 */
async function startApp(opts = {}) {
  const dataDir = opts.dataDir || path.join(ROOT, 'data');
  const context = opts.context || await launchChrome({
    profileDir: opts.profileDir || process.env.NOJA_PROFILE_DIR || path.join(ROOT, 'chrome-profile'),
    executablePath: opts.executablePath || process.env.NOJA_CHROME_PATH,
  });
  const store = new Store(dataDir);
  const scanner = new Scanner({ context, store, log: opts.log || ((e) => console.error(e)) });
  const server = createServer({ scanner, store, context });
  const port = await listen(server, opts.port || 4777);
  const panelUrl = `http://127.0.0.1:${port}/`;

  if (opts.openPanel !== false) {
    const [first] = context.pages();
    const page = first || await context.newPage();
    await page.goto(panelUrl);
  }

  const close = async () => {
    server.close();
    store.flush();
  };
  return { context, scanner, store, server, port, panelUrl, close };
}

module.exports = { startApp, launchChrome };
