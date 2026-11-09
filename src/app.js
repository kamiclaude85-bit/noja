/* Wires Chrome, the bot and the local control panel together. */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { Store } = require('./store');
const { Scanner } = require('./scanner');
const { createServer } = require('./server');
const { Notifier } = require('./notify');
const { Cloud } = require('./cloud');

const ROOT = path.join(__dirname, '..');

/**
 * Open Google Chrome with Radyab's own profile. Logging in to Divar once in this
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
  const log = opts.log || ((e) => console.error(e));
  const store = new Store(dataDir);
  // A search that was still running when the bot was closed last time: mark it as stopped.
  for (const r of store.listRuns()) {
    if (['done', 'stopped', 'error'].includes(r.status)) continue;
    const run = store.loadRun(r.id);
    if (!run) continue;
    run.status = 'stopped';
    run.finishedAt = run.finishedAt || Date.now();
    run.waitUntil = null;
    run.activity = '';
    run.message = `ربات وسط کار بسته شد؛ ${Object.keys(run.posts || {}).length.toLocaleString('fa-IR')} آگهی خوانده و ذخیره شد. برای ادامه، «بررسی جدیدها» را بزنید.`;
    store.saveRunNow(run);
  }
  const notifier = new Notifier({ store, dataDir, log, apiBases: opts.notifyApiBases });
  let cloud = null;
  const scanner = new Scanner({ context, store, log, onEvent: (run, kind) => { if (cloud) cloud.syncSoon(); return notifier.runEvent(run, kind); } });
  // Online panel (optional): set up from «پنل آنلاین» in the PC panel.
  cloud = new Cloud({ store, scanner, context, dataDir, log, fetchImpl: opts.fetchImpl });
  Object.defineProperty(notifier, 'forward', { get: () => (cloud.enabled ? (m) => cloud.forward(m) : null) });
  cloud.start();
  if (cloud.enabled) cloud.sync().catch(() => {});
  const server = createServer({ scanner, store, context, notifier, cloud });
  const port = await listen(server, opts.port || 4777);
  const panelUrl = `http://127.0.0.1:${port}/`;

  if (opts.openPanel !== false) {
    const [first] = context.pages();
    const page = first || await context.newPage();
    await page.goto(panelUrl);
  }

  // Daily backup of the ad memory and follow-up notes (like Noja's daily backup).
  try { store.backupNow(false); } catch (e) { (opts.log || console.error)(e); }
  const backupTimer = setInterval(() => { try { store.backupNow(false); } catch (_) { /* retry next hour */ } }, 60 * 60 * 1000);
  backupTimer.unref();

  // Phone reminders: check every minute for due calls and visits.
  const notifyTimer = setInterval(() => { notifier.tick().catch(log); }, 60 * 1000);
  notifyTimer.unref();

  const close = async () => {
    clearInterval(backupTimer);
    clearInterval(notifyTimer);
    cloud.stop();
    server.close();
    store.flush();
  };
  return { context, scanner, store, notifier, cloud, server, port, panelUrl, close };
}

module.exports = { startApp, launchChrome };
