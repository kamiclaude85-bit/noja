/* Small local web server (127.0.0.1 only) that serves the control panel and talks to the bot. */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const P = require('./parser');
const { isLoggedIn, DEFAULT_DAILY_LIMIT } = require('./scanner');
const CRM = require('./crm');

const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, code, body, type) {
  res.writeHead(code, { 'content-type': type || 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function cleanCriteria(b) {
  const num = (v) => { const n = P.parseNumber(v); return n == null ? null : n; };
  const year = (v) => { const n = num(v); return n == null ? null : P.normalizeYear(n); };
  let searchUrl = String(b.searchUrl || '').trim();
  if (searchUrl) {
    try {
      const u = new URL(searchUrl);
      if (u.protocol !== 'https:' || !/(^|\.)divar\.ir$/.test(u.hostname) || !u.pathname.startsWith('/s/')) searchUrl = '';
      else searchUrl = u.href;
    } catch (_) { searchUrl = ''; }
  }
  return {
    query: String(b.query || '').trim().slice(0, 100),
    city: /^[a-z-]{2,30}$/.test(b.city || '') ? b.city : 'tehran',
    keyword: String(b.keyword || '').trim().slice(0, 50),
    yearMin: year(b.yearMin),
    yearMax: year(b.yearMax),
    priceMin: num(b.priceMin),
    priceMax: num(b.priceMax),
    mileageMax: num(b.mileageMax),
    maxAds: Math.min(Math.max(num(b.maxAds) || 150, 1), 1000),
    // «آگهی‌های تا چه مدت پیش؟» in days; 0 = all. Default: one month.
    maxAgeDays: b.maxAgeDays === undefined || b.maxAgeDays === null || b.maxAgeDays === '' ? 30 : Math.min(Math.max(Number(b.maxAgeDays) || 0, 0), 3650),
    strictYear: !!b.strictYear,
    speed: ['slow', 'normal', 'fast', 'test'].includes(b.speed) ? b.speed : 'normal',
    dailyLimit: Math.min(Math.max(num(b.dailyLimit) || DEFAULT_DAILY_LIMIT, 1), 2000),
    requireLogin: b.requireLogin !== false,
    recheckAll: !!b.recheckAll,
    trackRecheckHours: b.trackRecheckHours != null && Number(b.trackRecheckHours) >= 0 ? Number(b.trackRecheckHours) : 20,
    searchUrl,
    // Searches started together («خرید با بودجه»): one id, so «پایان» can stop all of them.
    batch: /^[a-z0-9]{4,16}$/.test(b.batch || '') ? b.batch : '',
    // «خرید با بودجه»: after this price-range search, gather the same-model ads of what it found.
    budget: b.budget && Number(b.budget.max) > 0 ? { min: Number(b.budget.min) || 0, max: Number(b.budget.max), personalOnly: !!b.budget.personalOnly } : null,
  };
}

/**
 * A saved search keeps its own copy of each ad from the day it ran. Show the ad as it is
 * remembered now (re-read later, or with a newer seller rule), keeping what belongs to
 * that search: its order, «جدید», the price change it saw, and «removed».
 */
function latestPost(post, store) {
  const rec = store && store.knownAd(post.token);
  if (!rec || !rec.post) return post;
  const { order, isNew, priceChange, removed, firstSeenAt } = post;
  return { ...rec.post, order, isNew, priceChange, removed, firstSeenAt };
}

function publicRun(run, store) {
  if (!run) return null;
  return {
    id: run.id,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    criteria: run.criteria,
    status: run.status,
    message: run.message,
    activity: run.activity || '',
    waitUntil: run.waitUntil || null,
    stats: run.stats || null,
    toVisit: run.toVisit != null ? run.toVisit : null,
    collectStop: run.collectStop || null,
    sourceUrl: run.sourceUrl,
    items: run.items,
    posts: Object.values(run.posts).map((p) => latestPost(p, store)),
    errors: run.errors,
  };
}

function createServer({ scanner, store, context, notifier, cloud }) {
  return http.createServer(async (req, res) => {
    try {
      // Only accept requests from the panel itself (blocks other websites poking the local API).
      const origin = req.headers.origin;
      if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return send(res, 403, { error: 'forbidden' });

      const url = new URL(req.url, 'http://127.0.0.1');
      const p = url.pathname;

      if (p === '/api/state' && req.method === 'GET') {
        return send(res, 200, {
          busy: scanner.busy ? scanner.current.id : null,
          loggedIn: await isLoggedIn(context).catch(() => false),
          today: store.dailyCount(),
          dailyLimit: DEFAULT_DAILY_LIMIT,
          runs: store.listRuns(),
          // Searches waiting their turn (phone, «خرید با بودجه»)
          queue: cloud ? cloud.pending.map((c) => ({ id: c.qid, createdAt: c.queuedAt, criteria: c })) : [],
        });
      }
      // Several searches, one after another (they wait their turn; the daily cap is respected).
      if (p === '/api/scan-batch' && req.method === 'POST' && cloud) {
        const items = (await readBody(req)).items;
        if (!Array.isArray(items) || !items.length || items.length > 20) return send(res, 400, { error: 'فهرست جستجو نامعتبر است.' });
        const n = cloud.enqueue(items.map(cleanCriteria));
        return send(res, 200, { queued: true, count: n });
      }
      const qm = p.match(/^\/api\/queue\/([a-z0-9]+)$/);
      if (qm && req.method === 'DELETE' && cloud) { cloud.dequeue(qm[1]); return send(res, 200, { ok: true }); }
      if (p === '/api/scan' && req.method === 'POST') {
        const criteria = cleanCriteria(await readBody(req));
        if (!criteria.query && !criteria.searchUrl && !criteria.priceMin && !criteria.priceMax) {
          return send(res, 400, { error: 'نام خودرو یا محدودهٔ قیمت (یا لینک جستجوی دیوار) را وارد کنید.' });
        }
        if (scanner.busy) return send(res, 409, { error: 'یک جستجو در حال انجام است.', id: scanner.current.id });
        const run = scanner.start(criteria);
        return send(res, 200, { id: run.id });
      }
      if (p === '/api/login' && req.method === 'POST') {
        const page = await context.newPage();
        await page.goto('https://divar.ir/', { waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.bringToFront().catch(() => {});
        return send(res, 200, { ok: true });
      }
      let m = p.match(/^\/api\/runs\/([A-Za-z0-9_-]+)$/);
      if (m && req.method === 'GET') {
        const run = scanner.current && scanner.current.id === m[1] ? scanner.current : store.loadRun(m[1]);
        return run ? send(res, 200, publicRun(run, store)) : send(res, 404, { error: 'not found' });
      }
      m = p.match(/^\/api\/runs\/([A-Za-z0-9_-]+)\/(continue|pause|resume|stop|cancel|focus)$/);
      if (m && req.method === 'POST') {
        if (!scanner.current || scanner.current.id !== m[1]) return send(res, 409, { error: 'این جستجو فعال نیست.' });
        scanner[m[2]]();
        return send(res, 200, { ok: true });
      }

      // ---- ads + follow-up ----
      if (p === '/api/ads' && req.method === 'GET') {
        const since = Number(url.searchParams.get('since'));
        if (since && since === store.version) return send(res, 200, { unchanged: true, version: since });
        return send(res, 200, {
          ...store.exportAds(),
          stages: CRM.STAGES,
          activeStages: CRM.ACTIVE_STAGES,
          rejectReasons: CRM.REJECT_REASONS,
          callResults: CRM.CALL_RESULTS,
        });
      }
      m = p.match(/^\/api\/ads\/([A-Za-z0-9_-]+)\/crm$/);
      if (m && req.method === 'POST') {
        try {
          const rec = store.applyCrm(m[1], await readBody(req));
          return send(res, 200, { ok: true, version: store.version, crm: rec.crm });
        } catch (e) {
          return send(res, 400, { error: e.message });
        }
      }

      // ---- captcha / «درخواست زیاد» log ----
      if (p === '/api/blocks' && req.method === 'GET') return send(res, 200, { blocks: store.listBlocks() });

      // ---- online panel connection ----
      if (p === '/api/cloud' && req.method === 'GET') return send(res, 200, cloud ? cloud.publicSettings() : { url: '' });
      if (p === '/api/cloud' && req.method === 'POST' && cloud) {
        try { return send(res, 200, await cloud.configure(await readBody(req))); } catch (e) { return send(res, 400, { error: e.message }); }
      }

      // ---- phone reminders ----
      if (p === '/api/settings/notify' && req.method === 'GET') return send(res, 200, notifier.publicSettings());
      if (p === '/api/settings/notify' && req.method === 'POST') {
        try { return send(res, 200, notifier.update(await readBody(req))); } catch (e) { return send(res, 400, { error: e.message }); }
      }
      if (p === '/api/notify/find-chat' && req.method === 'POST') {
        try { return send(res, 200, await notifier.findChat()); } catch (e) { return send(res, 400, { error: e.message }); }
      }
      if (p === '/api/notify/test' && req.method === 'POST') {
        try { await notifier.test(); return send(res, 200, { ok: true }); } catch (e) { return send(res, 400, { error: e.message }); }
      }

      // ---- backups ----
      if (p === '/api/backups' && req.method === 'GET') return send(res, 200, { backups: store.listBackups() });
      if (p === '/api/backups' && req.method === 'POST') {
        const name = store.backupNow(true);
        return send(res, 200, { ok: true, name, backups: store.listBackups() });
      }
      if (p === '/api/backups/restore' && req.method === 'POST') {
        if (scanner.busy) return send(res, 409, { error: 'وقتی ربات در حال کار است نمی‌شود پشتیبان را برگرداند.' });
        try {
          const count = store.restore(await readBody(req, 200e6));
          return send(res, 200, { ok: true, count });
        } catch (e) {
          return send(res, 400, { error: e.message });
        }
      }
      m = p.match(/^\/api\/backups\/([A-Za-z0-9._-]+)$/);
      if (m && req.method === 'GET') {
        let file;
        try { file = store.backupPath(m[1]); } catch (e) { return send(res, 400, { error: e.message }); }
        return fs.readFile(file, (err, buf) => {
          if (err) return send(res, 404, { error: 'not found' });
          res.writeHead(200, { 'content-type': 'application/gzip', 'content-disposition': `attachment; filename="${m[1]}"`, 'cache-control': 'no-store' });
          res.end(buf);
        });
      }

      // Static files
      let file;
      if (p === '/' || p === '/index.html') file = path.join(PUBLIC, 'index.html');
      else if (p === '/parser.js') file = path.join(__dirname, 'parser.js');
      else if (p === '/deals.js') file = path.join(__dirname, 'deals.js');
      else file = path.join(PUBLIC, path.normalize(decodeURIComponent(p)).replace(/^([/\\])+/, ''));
      if (!file.startsWith(PUBLIC) && ![path.join(__dirname, 'parser.js'), path.join(__dirname, 'deals.js')].includes(file)) return send(res, 403, 'forbidden', 'text/plain');
      fs.readFile(file, (err, buf) => {
        if (err) return send(res, 404, 'not found', 'text/plain');
        send(res, 200, buf, TYPES[path.extname(file)] || 'application/octet-stream');
      });
    } catch (err) {
      send(res, 500, { error: String(err && err.message ? err.message : err) });
    }
  });
}

module.exports = { createServer, cleanCriteria };
