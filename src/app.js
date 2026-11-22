/* Wires Chrome, the bot and the local control panel together. */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { Store } = require('./store');
const { ScannerPool } = require('./pool');
const { createServer, cleanCriteria } = require('./server');
const { followUpSearches } = require('./budget');
const { Notifier } = require('./notify');
const { Cloud } = require('./cloud');
const { PriceHistory } = require('./history');
const { dueSearches, localDay, planPriceCheck, dailyCheckDue } = require('./daily');
const CRM = require('./crm');
const { searchKey } = require('./scanner');

const ROOT = path.join(__dirname, '..');

/**
 * Open Google Chrome with Radyab's own profile. Logging in to Divar once in this
 * window is remembered for next time (the profile is kept in ./chrome-profile).
 */
async function launchChrome({ profileDir, executablePath }) {
  const { chromium } = require('playwright-core');
  fs.mkdirSync(profileDir, { recursive: true });
  // The window starts out of sight at a normal size (see window.js); a window out of sight is still
  // drawn and timed like a visible one (Chrome would otherwise slow it down).
  const base = {
    headless: false, viewport: null, locale: 'fa-IR',
    args: ['--window-position=-32000,-32000', '--window-size=1366,900', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  };
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
  const onFinish = (run, kind) => {
    if (!cloud) return;
    // «پایان» on a batch search («خرید با بودجه») stops the rest of the batch too.
    if (kind === 'stopped' && run.criteria && run.criteria.batch) cloud.dropBatch(run.criteria.batch);
    // A budget price-range search: line up the same-model searches it needs.
    if (kind === 'done' && run.criteria && run.criteria.budget) {
      try {
        const more = followUpSearches(store, run).map((c) => cleanCriteria(c));
        if (more.length) cloud.enqueue(more);
      } catch (e) { log(e); }
    }
    setTimeout(() => cloud.startPending(), 3000); // next search in line
  };
  // One bot for Divar and one for Bama, side by side (see pool.js).
  const scanner = new ScannerPool({ context, store, log, onEvent: (run, kind) => {
    if (cloud) cloud.syncSoon();
    if (['done', 'stopped', 'error'].includes(kind)) onFinish(run, kind);
    return notifier.runEvent(run, kind);
  } });
  // Online panel (optional): set up from «پنل آنلاین» in the PC panel.
  cloud = new Cloud({ store, scanner, context, dataDir, log, fetchImpl: opts.fetchImpl });
  Object.defineProperty(notifier, 'forward', { get: () => (cloud.enabled ? (m) => cloud.forward(m) : null) });
  cloud.start();
  if (cloud.enabled) cloud.sync().catch(() => {});
  const server = createServer({ scanner, store, context, notifier, cloud, quit: opts.onQuit });
  const port = await listen(server, opts.port || 4777);
  const panelUrl = `http://127.0.0.1:${port}/`;

  // every window Chrome opens for the bot stays out of sight too
  if (!opts.context) {
    const { hideWindow, enable } = require('./window');
    enable();
    context.on('page', (p) => { hideWindow(p).catch(() => {}); });
    for (const p of context.pages()) hideWindow(p).catch(() => {});
  }
  // The panel opens in your own browser (http://127.0.0.1:4777), not in the bot's Chrome.
  if (opts.openPanel === true) {
    const [first] = context.pages();
    const page = first || await context.newPage();
    await page.goto(panelUrl);
  }

  // Daily backup of the ad memory and follow-up notes (like Noja's daily backup).
  try { store.backupNow(false); } catch (e) { (opts.log || console.error)(e); }
  // Daily price history (history.js): today's market prices, renewed every hour (the last one counts).
  const history = new PriceHistory(dataDir);
  const snapshot = () => {
    try { history.snapshot(Object.values(store.db.ads).filter((r) => r.post).map((r) => ({ ...r.post, removed: r.removed }))); } catch (e) { log(e); }
  };
  setTimeout(snapshot, 30 * 1000).unref();
  const backupTimer = setInterval(() => { try { store.backupNow(false); } catch (_) { /* retry next hour */ } snapshot(); }, 60 * 60 * 1000);
  backupTimer.unref();

  // Daily Instagram story (tools/make-story.js): once a day from 11:00 (after the morning price
  // check), built on this PC into media/stories/<day>/ — frames and story.mp4. Only for the real
  // data folder (not for tests).
  const STORY_HOUR = 11;
  let storyBusy = false;
  const storyDue = () => {
    const now = new Date();
    if (storyBusy || now.getHours() < STORY_HOUR || dataDir !== path.join(ROOT, 'data')) return;
    const out = path.join(ROOT, 'media', 'stories', localDay(now.getTime()), 'story.mp4');
    if (fs.existsSync(out)) return;
    storyBusy = true;
    const { execFile } = require('node:child_process');
    execFile(process.execPath, [path.join(ROOT, 'tools', 'make-story.js')], { cwd: ROOT, timeout: 15 * 60 * 1000 }, (err, stdout) => {
      storyBusy = false;
      if (err) log(err); else log(`story: ${String(stdout).trim().split('\n').pop()}`);
    });
  };
  const storyTimer = setInterval(storyDue, 30 * 60 * 1000);
  storyTimer.unref();
  setTimeout(storyDue, 2 * 60 * 1000).unref();

  // Phone reminders: check every minute for due calls and visits.
  const notifyTimer = setInterval(() => { notifier.tick().catch(log); }, 60 * 1000);
  // Waiting searches held by the daily cap start again after midnight.
  const queueTimer = setInterval(() => { try { cloud.startPending(); } catch (_) { /* next time */ } }, 30 * 60 * 1000);
  queueTimer.unref();

  const busyKeys = () => {
    const busy = new Set(cloud.pending.map((c) => searchKey(c)));
    for (const r of scanner.runs) busy.add(searchKey(r.criteria));
    return busy;
  };
  // Daily price check of all saved searches (daily.js): by its hour, or now from the panel.
  const dailyNow = (by = 'auto') => {
    const now = Date.now();
    const plan = planPriceCheck(store.db.searches, store.db.ads, CRM.ACTIVE_STAGES, now, busyKeys());
    store.markDailyCheck({ day: localDay(now), at: now, keys: plan.items.map((x) => x.key), idle: plan.idle, merged: plan.merged, by });
    // one batch for the whole check: «توقف» on any of its searches stops the rest of it too
    const batch = `d${localDay(now).replace(/-/g, '')}${by === 'hand' ? 'h' : ''}`;
    if (plan.items.length) cloud.enqueue(plan.items.map((x) => cleanCriteria({ ...x.criteria, batch })));
    cloud.syncSoon();
    return { queued: plan.items.length, idle: plan.idle, merged: plan.merged };
  };
  cloud.dailyNow = dailyNow;

  // Daily automatic check of saved searches: every 10 minutes, line up the ones whose time has come.
  const autoCheck = () => {
    try {
      if (dailyCheckDue(store.dailyCheck(), Date.now())) dailyNow('auto');
      const busy = busyKeys();
      const due = dueSearches(store.db.searches, Date.now(), busy);
      if (!due.length) return;
      const today = localDay(Date.now());
      for (const d of due) store.markAutoRan(d.key, today);
      cloud.enqueue(due.map((d) => cleanCriteria(d.criteria)));
    } catch (e) { log(e); }
  };
  const autoTimer = setInterval(autoCheck, opts.autoCheckMs || 10 * 60 * 1000);
  autoTimer.unref();
  setTimeout(autoCheck, opts.autoFirstMs || 60 * 1000).unref();
  notifyTimer.unref();

  const close = async () => {
    clearInterval(backupTimer);
    clearInterval(storyTimer);
    clearInterval(notifyTimer);
    clearInterval(queueTimer);
    clearInterval(autoTimer);
    cloud.stop();
    server.close();
    store.flush();
  };
  return { context, scanner, store, notifier, cloud, server, port, panelUrl, close, autoCheck };
}

module.exports = { startApp, launchChrome };
