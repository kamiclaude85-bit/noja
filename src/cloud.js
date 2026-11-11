/*
 * Connection to the online panel (e.g. https://radyab.nojakasht.com).
 *
 * Every ~20 seconds the bot on this PC checks in with the host:
 *   - sends what changed here: ads it read (and their follow-up, if changed here),
 *     saved searches, bot runs, its state (busy / today's count), messages for the phone;
 *   - gets back: follow-up changes made in the online panel (the newer change wins),
 *     searches you asked for on the phone, and run commands (stop / pause / …).
 * The Divar account and Chrome never leave this PC.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { cleanCriteria } = require('./server');

const SYNC_EVERY = 20000;
const BATCH = 150; // ads per request, so the first full upload is sent in parts

/**
 * POST JSON over a fresh connection, with up to 30 s to connect. (Node's fetch gives up
 * connecting after 10 s and reuses idle connections that the network may have dropped;
 * from Iran a new connection to the host sometimes takes ~10 s.) Returns a fetch-like response.
 */
function postJson(url, { headers = {}, body = '', timeout = 60000 } = {}) {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? require('node:https') : require('node:http');
  return new Promise((resolve, reject) => {
    const req = mod.request(u, {
      method: 'POST', agent: false, timeout: 30000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(text) });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    const all = setTimeout(() => req.destroy(new Error('timeout')), timeout);
    req.on('close', () => clearTimeout(all));
    req.on('error', reject);
    req.end(body);
  });
}

class Cloud {
  constructor({ store, scanner, context, dataDir, log = () => {}, fetchImpl }) {
    this.store = store;
    this.scanner = scanner;
    this.context = context;
    this.log = log;
    this.fetch = fetchImpl;
    this.file = path.join(dataDir, 'settings.json');
    this.stateFile = path.join(dataDir, 'cloud-state.json');
    this.cfg = { url: '', key: '' };
    try { this.cfg = { ...this.cfg, ...(JSON.parse(fs.readFileSync(this.file, 'utf8')).cloud || {}) }; } catch (_) { /* none */ }
    this.st = { cursor: 0, uploaded: false };
    try { this.st = { ...this.st, ...JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) }; } catch (_) { /* none */ }
    this.events = [];   // messages for the phone, delivered by the host
    // Searches from the phone waiting for the bot to be free (kept on disk, so a restart does not lose them).
    this.pending = Array.isArray(this.st.pending) ? this.st.pending : [];
    this.status = { lastSyncAt: null, lastError: null };
    this.timer = null;
    this.running = false;
  }

  get enabled() { return !!(this.cfg.url && this.cfg.key); }

  publicSettings() {
    return {
      url: this.cfg.url,
      hasKey: !!this.cfg.key,
      key: this.cfg.key ? `••••${this.cfg.key.slice(-4)}` : '',
      connected: this.enabled && !!this.status.lastSyncAt && !this.status.lastError,
      lastSyncAt: this.status.lastSyncAt,
      lastError: this.status.lastError,
      pending: this.pending.length,
    };
  }

  /** Save the address and key (from the PC panel), then connect right away. */
  async configure({ url, key }) {
    let u = String(url == null ? this.cfg.url : url).trim();
    if (u) {
      if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
      let parsed;
      try { parsed = new URL(u); } catch (_) { throw new Error('نشانی پنل درست نیست.'); }
      const local = /^(localhost|127\.0\.0\.1)$/.test(parsed.hostname);
      if (parsed.protocol !== 'https:' && !local) throw new Error('نشانی پنل باید با https شروع شود.');
      u = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}/`;
    }
    const k = key == null || key === '' ? this.cfg.key : String(key).trim();
    if (k && !/^rk_[a-f0-9]{40}$/.test(k)) throw new Error('کلید ربات درست نیست؛ باید با rk_ شروع شود (از صفحهٔ راه‌اندازی پنل).');
    const changedTarget = u !== this.cfg.url;
    this.cfg = { url: u, key: u ? k : '' };
    let all = {};
    try { all = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) { /* none */ }
    all.cloud = this.cfg;
    fs.writeFileSync(this.file, JSON.stringify(all, null, 2));
    if (changedTarget) { this.saveState({ cursor: 0, uploaded: false }); this.markedAll = false; }
    this.status = { lastSyncAt: null, lastError: null };
    if (this.enabled) await this.sync();
    this.start();
    return this.publicSettings();
  }

  saveState(patch) {
    this.st = { ...this.st, ...patch };
    try { fs.writeFileSync(this.stateFile, JSON.stringify(this.st)); } catch (e) { this.log(e); }
  }

  start() {
    clearInterval(this.timer);
    if (!this.enabled) return;
    this.timer = setInterval(() => { this.sync().catch(() => {}); }, SYNC_EVERY);
    this.timer.unref();
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  /** Check in again in a moment (after a command, or when a search changes state). */
  syncSoon(ms = 1500) {
    if (!this.enabled) return;
    clearTimeout(this.soon);
    this.soon = setTimeout(() => this.sync().catch(() => {}), ms);
  }

  /** A message for the phone (run finished, captcha…); the host sends it with its settings. */
  forward(msg) {
    if (!this.enabled) return false;
    this.events.push(msg);
    clearTimeout(this.soon);
    this.soon = setTimeout(() => this.sync().catch(() => {}), 1500);
    return true;
  }

  // ---------- one check-in ----------
  buildPayload() {
    const s = this.store;
    const ch = s.changes;
    if (!this.st.uploaded && !this.markedAll) { s.markAllChanged(); this.markedAll = true; }
    const tokens = Array.from(new Set([...ch.ads, ...ch.crm])).slice(0, BATCH);
    const ads = [];
    for (const t of tokens) {
      const rec = s.db.ads[t];
      if (!rec) continue;
      const a = {
        token: t, post: rec.post || null, removed: rec.removed || null,
        firstSeenAt: rec.firstSeenAt || null, lastReadAt: rec.lastReadAt || null, priceHistory: rec.priceHistory || [],
      };
      if (ch.crm.has(t) && rec.crm) a.crm = rec.crm;
      ads.push(a);
    }
    const runs = [];
    for (const id of Array.from(ch.runs).slice(0, 5)) {
      const run = this.scanner.current && this.scanner.current.id === id ? this.scanner.current : s.loadRun(id);
      if (run) runs.push(this.slimRun(run));
    }
    const busy = this.scanner.busy && this.scanner.current ? this.scanner.current.id : null;
    // Ads and runs deleted here («حذف جستجو»), so the online panel deletes them too.
    const g = s.gone();
    const gone = { ads: g.ads.filter((t) => !s.db.ads[t]).slice(0, 500), runs: g.runs.slice(0, 100) };
    const hasGone = gone.ads.length || gone.runs.length;
    return {
      payload: {
        since: this.st.cursor,
        state: { busy, busyKey: this.busyKey(), loggedIn: this.loggedIn == null ? null : this.loggedIn, today: s.dailyCount(), dailyLimit: this.dailyLimit || 300, pending: this.pending.length },
        ads,
        gone: hasGone ? gone : undefined,
        searches: ch.searches ? s.db.searches : undefined,
        runs,
        events: this.events.slice(),
      },
      sent: { tokens, runs: runs.map((r) => r.id), searches: ch.searches, events: this.events.length, gone: hasGone ? gone : null },
    };
  }

  /** The saved search being run right now (or null). */
  busyKey() {
    if (!this.scanner.busy || !this.scanner.current || !this.scanner.current.criteria) return null;
    try { return require('./scanner').searchKey(this.scanner.current.criteria); } catch (_) { return null; }
  }

  /** Take a deleted search out of the waiting line. */
  dropKey(key) {
    const { searchKey } = require('./scanner');
    this.pending = this.pending.filter((c) => { try { return searchKey(c) !== key; } catch (_) { return true; } });
    this.saveState({ pending: this.pending });
  }

  /** «حذف جستجو» asked for in the online panel; waits if that search is running right now. */
  deleteSearch(key) {
    if (this.busyKey() === key) {
      const later = new Set(this.st.delLater || []);
      later.add(key);
      this.saveState({ delLater: Array.from(later) });
      return;
    }
    try { this.store.deleteSearch(key, require('./scanner').searchKey); } catch (_) { /* already gone */ }
    this.dropKey(key);
  }

  /** Deletions that were waiting for their search to finish. */
  deleteWaiting() {
    const later = this.st.delLater || [];
    if (!later.length) return;
    this.saveState({ delLater: [] });
    for (const key of later) this.deleteSearch(key);
  }

  /** Ads in a run are sent separately; the run itself only keeps what belongs to it. */
  slimRun(run) {
    const posts = {};
    for (const [t, p] of Object.entries(run.posts || {})) {
      posts[t] = this.store.db.ads[t] && this.store.db.ads[t].post
        ? { token: t, order: p.order, isNew: p.isNew, priceChange: p.priceChange || null, removed: p.removed || null, firstSeenAt: p.firstSeenAt || null }
        : p;
    }
    return { ...run, posts };
  }

  async sync() {
    if (!this.enabled || this.running) return false;
    this.running = true;
    this.startPending(); // searches from the phone start when the bot is free, even if the host is slow to answer
    try {
      if (this.context) {
        const { isLoggedIn } = require('./scanner');
        this.loggedIn = await isLoggedIn(this.context).catch(() => null);
      }
      this.deleteWaiting();
      const { payload, sent } = this.buildPayload();
      const body1 = JSON.stringify(payload);
      // A new connection to the host sometimes times out; try again right away before giving up.
      let res;
      for (let attempt = 1; ; attempt++) {
        try {
          const url = `${this.cfg.url}api/bot/sync`;
          res = this.fetch
            ? await this.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-radyab-key': this.cfg.key }, body: body1, signal: AbortSignal.timeout(60000) })
            : await postJson(url, { headers: { 'x-radyab-key': this.cfg.key }, body: body1 });
          break;
        } catch (netErr) {
          if (attempt >= 3) throw new Error('اتصال به پنل آنلاین برقرار نشد (اینترنت یا هاست). ربات کمی بعد دوباره امتحان می‌کند.');
          await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `پاسخ پنل: ${res.status}`);

      // Only now forget what was sent (a failed request is simply sent again next time).
      const ch = this.store.changes;
      for (const t of sent.tokens) { ch.ads.delete(t); ch.crm.delete(t); }
      for (const id of sent.runs) if (!(this.scanner.busy && this.scanner.current && this.scanner.current.id === id)) ch.runs.delete(id);
      if (sent.searches) ch.searches = false;
      if (sent.gone && body.gone) this.store.clearGone(sent.gone); // an older panel does not answer: keep them for later
      this.events.splice(0, sent.events);
      if (!ch.ads.size && !ch.crm.size && !this.st.uploaded) this.saveState({ uploaded: true });

      for (const { token, crm } of body.crm || []) this.store.setCrmFromHost(token, crm);
      for (const q of body.queue || []) this.take(q);
      this.saveState({ cursor: body.cursor || this.st.cursor });
      this.status = { lastSyncAt: Date.now(), lastError: null };
      this.startPending();
      // More to upload (first connection): continue right away.
      if (ch.ads.size || ch.crm.size) setTimeout(() => this.sync().catch(() => {}), 500);
      return true;
    } catch (e) {
      this.status = { lastSyncAt: this.status.lastSyncAt, lastError: String(e && e.message ? e.message : e) };
      return false;
    } finally {
      this.running = false;
    }
  }

  /** A search or a command from the phone. */
  /** Add searches to the waiting line (phone, «خرید با بودجه»). Returns how many are waiting. */
  enqueue(list) {
    for (const c of list) this.pending.push({ ...c, qid: Math.random().toString(36).slice(2, 10), queuedAt: Date.now() });
    this.saveState({ pending: this.pending });
    setTimeout(() => this.startPending(), 500);
    return this.pending.length;
  }

  dequeue(qid) {
    this.pending = this.pending.filter((c) => c.qid !== qid);
    this.saveState({ pending: this.pending });
  }

  /** «پایان» on a search that is part of a batch stops the rest of that batch too. */
  dropBatch(batch) {
    if (!batch) return;
    this.pending = this.pending.filter((c) => c.batch !== batch);
    this.saveState({ pending: this.pending });
  }

  take(q) {
    if (q.kind === 'scan') {
      this.enqueue([cleanCriteria(q.body || {})]);
    } else if (q.kind === 'auto') {
      // Daily automatic check switched on/off in the online panel.
      const { cleanAuto } = require('./daily');
      try { this.store.setAuto(String((q.body || {}).key || ''), cleanAuto(q.body)); } catch (_) { /* search gone */ }
      this.syncSoon();
    } else if (q.kind === 'del') {
      // «حذف جستجو» in the online panel.
      this.deleteSearch(String((q.body || {}).key || ''));
      this.syncSoon();
    } else if (q.kind === 'cmd') {
      const { runId, action } = q.body || {};
      if (this.scanner.current && this.scanner.current.id === runId && ['continue', 'pause', 'resume', 'stop', 'cancel'].includes(action)) {
        this.scanner[action]();
        this.syncSoon(); // let the panel see the change right away
      }
    }
  }

  startPending() {
    if (!this.pending.length || this.scanner.busy) return;
    // Daily cap reached: the rest waits until tomorrow (checked again every hour).
    const cap = Number(this.pending[0].dailyLimit) || 300;
    if (this.store.dailyCount() >= cap) return;
    try {
      this.scanner.start(this.pending[0]);
    } catch (e) { this.log(e); return; } // not started: it stays first in line
    this.pending.shift();
    this.saveState({ pending: this.pending });
  }
}

module.exports = { Cloud };
