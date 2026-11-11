/*
 * End-to-end test of the online panel (host/) with the PC side (src/cloud.js).
 *
 *  - builds the host package, runs it with PHP's built-in server and SQLite,
 *  - sets it up through setup.php like the owner would,
 *  - connects a bot (Store + Cloud with a stand-in scanner) and checks:
 *      first upload of every ad, sign-in, follow-up from the panel reaching the PC and back,
 *      the newer follow-up change winning, a search asked for on the phone reaching the bot,
 *      run commands, the bot's online/offline state, runs, backups, the follow-up rules
 *      giving the same result in PHP and in JS, and that private files are not served.
 *
 *   node tests/host.e2e.js        (needs PHP; set PHP_BIN if php is not on the PATH)
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { Store } = require('../src/store');
const { Cloud } = require('../src/cloud');
const P = require('../src/parser');
const CRM = require('../src/crm');
const { buildDataset, postJson } = require('./fixtures/mock-divar.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8131;
const BASE = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findPhp() {
  for (const c of [process.env.PHP_BIN, 'php', 'C:\\xampp\\php\\php.exe'].filter(Boolean)) {
    try { execFileSync(c, ['-v'], { stdio: 'ignore' }); return c; } catch (_) { /* next */ }
  }
  return null;
}

async function main() {
  const php = findPhp();
  if (!php) { console.log('host e2e skipped: PHP not found (set PHP_BIN)'); return; }

  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build-host.js')], { stdio: 'ignore' });
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'radyab-host-'));
  fs.cpSync(path.join(ROOT, 'dist', 'radyab-host'), site, { recursive: true });
  const server = spawn(php, ['-d', 'display_errors=1', '-S', `127.0.0.1:${PORT}`, '-t', site, path.join(ROOT, 'host', 'dev-router.php')], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(BASE); break; } catch (_) { await sleep(100); } }

    // ---- setup, like the owner ----
    const form = new URLSearchParams({ user: 'owner', pass: 'test-pass-123', pass2: 'test-pass-123' });
    const setupHtml = await (await fetch(`${BASE}setup.php`, { method: 'POST', body: form })).text();
    const key = (setupHtml.match(/rk_[a-f0-9]{40}/) || [])[0];
    assert.ok(key, 'setup shows the bot key');
    assert.match(await (await fetch(`${BASE}setup.php`)).text(), /قبلاً راه‌اندازی شده/, 'setup runs only once');
    for (const p of ['config.php', 'lib/boot.php', 'data/radyab.sqlite', 'cron.php']) {
      assert.equal((await fetch(BASE + p)).status, 403, `${p} is private`);
    }

    // ---- sign-in ----
    assert.equal((await fetch(`${BASE}api/state`)).status, 401, 'panel needs sign-in');
    const bad = await fetch(`${BASE}api/session`, { method: 'POST', body: JSON.stringify({ user: 'owner', pass: 'wrong' }) });
    assert.equal(bad.status, 401);
    const ok = await fetch(`${BASE}api/session`, { method: 'POST', body: JSON.stringify({ user: 'owner', pass: 'test-pass-123' }) });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    const api = async (p, opts = {}) => {
      const r = await fetch(BASE + p.replace(/^\//, ''), { method: opts.method || 'GET', headers: { cookie }, body: opts.body ? JSON.stringify(opts.body) : undefined });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`${p}: ${r.status} ${b.error || ''}`);
      return b;
    };
    let st = await api('/api/state');
    assert.equal(st.mode, 'host');
    assert.equal(st.bot.online, false, 'bot not connected yet');

    // ---- a PC with some ads (one already followed up) ----
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radyab-pc-'));
    const store = new Store(dataDir);
    const { posts } = buildDataset(30);
    const tokens = Object.keys(posts).slice(0, 30);
    for (const t of tokens) store.rememberAd(P.extractPost(posts[t] || postJson({ title: t }), t), 'q|tehran|206');
    store.touchSearch('q|tehran|206', { query: 'پژو ۲۰۶', city: 'tehran' });
    store.applyCrm(tokens[0], { action: 'stage', stage: 'shortlist' });
    store.saveRun({ id: '20261101100000_test', createdAt: Date.now(), criteria: { query: 'پژو ۲۰۶' }, status: 'done', message: 'تمام شد', items: tokens.map((token, order) => ({ token, order })), posts: Object.fromEntries(tokens.slice(0, 3).map((t, i) => [t, { ...store.db.ads[t].post, order: i, isNew: true }])), errors: {}, stats: { newAds: 3 } }, true);
    store.flush();

    const started = [];
    const actions = [];
    const scanner = { busy: false, current: null, start: (c) => { started.push(c); return { id: 'x' }; } };
    for (const a of ['stop', 'cancel', 'pause', 'resume', 'continue']) scanner[a] = () => actions.push(a);
    const cloud = new Cloud({ store, scanner, dataDir });

    // Wrong key is refused and shown.
    await assert.rejects(cloud.configure({ url: BASE, key: 'nope' }), /کلید ربات درست نیست/);
    const pub = await cloud.configure({ url: BASE, key: key.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')) });
    assert.match(pub.lastError, /کلید ربات/, 'host refuses a wrong key');
    cloud.stop();

    // ---- first connection: everything goes up (in parts of 150 — here one part) ----
    let r = await cloud.configure({ url: BASE, key });
    cloud.stop();
    assert.equal(r.lastError, null, `connected (${r.lastError})`);
    await sleep(800);
    let ads = await api('/api/ads');
    assert.equal(ads.ads.length, 30, 'all ads uploaded');
    const a0 = ads.ads.find((a) => a.token === tokens[0]);
    assert.equal(a0.crm.stage, 'shortlist', 'follow-up uploaded');
    assert.equal(a0.searches[0], 'q|tehran|206', 'saved search uploaded');
    assert.equal(a0.post.title, store.db.ads[tokens[0]].post.title);
    st = await api('/api/state');
    assert.equal(st.bot.online, true, 'bot shows as online');
    assert.equal(st.runs[0].id, '20261101100000_test', 'run uploaded');
    const run = await api('/api/runs/20261101100000_test');
    assert.equal(run.posts.length, 3);
    assert.equal(run.posts[0].title, store.db.ads[tokens[0]].post.title, 'run shows the ad from the ad list');
    assert.equal(cloud.st.uploaded, true);

    // ---- follow-up on the phone reaches the PC ----
    await api(`/api/ads/${tokens[1]}/crm`, { method: 'POST', body: { action: 'call', result: 'no-answer' } });
    await api(`/api/ads/${tokens[1]}/crm`, { method: 'POST', body: { action: 'set', phone: '0912 000 0000' } });
    await cloud.sync();
    assert.equal(store.db.ads[tokens[1]].crm.stage, 'calling', 'phone follow-up reached the PC');
    assert.equal(store.db.ads[tokens[1]].crm.missed, 1);
    assert.ok(store.db.ads[tokens[1]].crm.nextCallAt > Date.now() + 50 * 60000, 'next call scheduled by PHP');

    // ---- follow-up on the PC reaches the phone; the newer one wins ----
    await sleep(5);
    store.applyCrm(tokens[1], { action: 'note', text: 'از کامپیوتر' });
    await cloud.sync();
    ads = await api('/api/ads');
    const a1 = ads.ads.find((a) => a.token === tokens[1]);
    assert.equal(a1.crm.notes.at(-1).text, 'از کامپیوتر', 'PC follow-up reached the host');
    assert.equal(a1.crm.phone, '0912 000 0000', 'and kept the phone set on the phone');
    // an older change from the PC does not overwrite a newer one on the host
    const old = { ...store.db.ads[tokens[2]], crm: { stage: 'talking', notes: [], calls: [], updatedAt: 1 } };
    await api(`/api/ads/${tokens[2]}/crm`, { method: 'POST', body: { action: 'stage', stage: 'visit' } }).catch(() => {});
    await api(`/api/ads/${tokens[2]}/crm`, { method: 'POST', body: { action: 'stage', stage: 'shortlist' } });
    store.db.ads[tokens[2]] = old;
    store.changes.crm.add(tokens[2]);
    await cloud.sync();
    ads = await api('/api/ads');
    assert.equal(ads.ads.find((a) => a.token === tokens[2]).crm.stage, 'shortlist', 'older PC change lost to the newer phone change');
    assert.equal(store.db.ads[tokens[2]].crm.stage, 'shortlist', 'and the PC took the newer one');

    // ---- the same follow-up rules in PHP and JS ----
    const seq = [
      { action: 'stage', stage: 'shortlist' }, { action: 'call', result: 'no-answer' }, { action: 'call', result: 'off' },
      { action: 'call', result: 'answered', note: 'فردا' }, { action: 'visit', at: Date.now() + 86400000 }, { action: 'visited', note: 'خوب بود' },
      { action: 'set', offer: 500000000 }, { action: 'reject', reason: 'گران است' }, { action: 'restore' },
    ];
    const js = { post: {} };
    for (const s of seq) CRM.applyAction(js, s);
    for (const s of seq) await api(`/api/ads/${tokens[5]}/crm`, { method: 'POST', body: s });
    const phpCrm = (await api('/api/ads')).ads.find((a) => a.token === tokens[5]).crm;
    for (const k of ['stage', 'prevStage', 'missed', 'offer', 'visitAt']) assert.deepEqual(phpCrm[k], js.crm[k], `same ${k} in PHP and JS`);
    assert.deepEqual(phpCrm.notes.map((n) => n.text), js.crm.notes.map((n) => n.text), 'same history in PHP and JS');
    assert.deepEqual(phpCrm.calls.map((c) => c.result), js.crm.calls.map((c) => c.result));
    await assert.rejects(api(`/api/ads/${tokens[5]}/crm`, { method: 'POST', body: { action: 'reject' } }), /400/);

    // ---- a search asked for on the phone reaches the bot ----
    const q = await api('/api/scan', { method: 'POST', body: { query: 'دنا پلاس', city: 'tehran', yearMin: 1400 } });
    assert.equal(q.queued, true);
    assert.equal((await api('/api/state')).queue.length, 1, 'shown as queued');
    scanner.busy = true; // busy: the search waits on the PC
    await cloud.sync();
    assert.equal(started.length, 0);
    assert.equal(cloud.pending.length, 1);
    assert.equal((await api('/api/state')).queue.length, 0, 'handed over once');
    scanner.busy = false;
    await cloud.sync();
    assert.equal(started.length, 1, 'search started when the bot was free');
    assert.equal(started[0].query, 'دنا پلاس');
    assert.equal(started[0].yearMin, 1400);
    // cancel before the bot takes it
    const q2 = await api('/api/scan', { method: 'POST', body: { query: 'تیبا' } });
    await api(`/api/queue/${q2.id}`, { method: 'DELETE' });
    await cloud.sync();
    assert.equal(started.length, 1, 'cancelled search never reached the bot');
    await assert.rejects(api('/api/scan', { method: 'POST', body: {} }), /400/);

    // ---- run commands ----
    scanner.current = { id: 'run_live', status: 'reading', posts: {}, items: [] };
    scanner.busy = true;
    await api('/api/runs/run_live/stop', { method: 'POST' });
    await cloud.sync();
    assert.deepEqual(actions, ['stop'], 'stop from the phone reached the bot');
    await api('/api/runs/run_live/cancel', { method: 'POST' });
    await cloud.sync();
    assert.deepEqual(actions, ['stop', 'cancel'], '«پایان» while collecting reached the bot');
    assert.equal((await api('/api/state')).busy, 'run_live');
    scanner.busy = false;

    // ---- daily automatic check switched on from the phone ----
    const au = await api('/api/search-auto', { method: 'POST', body: { key: 'q|tehran|206', on: true, hour: 7, full: true } });
    assert.deepEqual(au.auto, { on: true, hour: 7, full: true });
    assert.deepEqual((await api('/api/ads')).searches.find((s) => s.key === 'q|tehran|206').auto, au.auto, 'shown on the phone at once');
    await cloud.sync();
    assert.deepEqual(store.db.searches['q|tehran|206'].auto, { on: true, hour: 7, full: true }, 'the bot got the setting');
    await cloud.sync();
    assert.deepEqual((await api('/api/ads')).searches.find((s) => s.key === 'q|tehran|206').auto.hour, 7, 'still set after the bot reports back');
    await assert.rejects(api('/api/search-auto', { method: 'POST', body: { key: 'nope', on: true } }), /404/);

    // ---- messages for the phone are handed to the host ----
    assert.equal(cloud.forward({ kind: 'runs', key: 'run:x:done', text: 'تست' }), true);
    await cloud.sync();
    assert.equal(cloud.events.length, 0, 'messages handed over');

    // ---- backups ----
    const b = await api('/api/backups', { method: 'POST' });
    assert.match(b.name, /^radyab-\d{4}-\d{2}-\d{2}/);
    const gz = await fetch(`${BASE}api/backups/${b.name}`, { headers: { cookie } });
    assert.equal(gz.status, 200);
    const restored = JSON.parse(require('node:zlib').gunzipSync(Buffer.from(await gz.arrayBuffer())).toString());
    assert.equal(Object.keys(restored.db.ads).length, 30);
    const count = (await api('/api/backups/restore', { method: 'POST', body: restored })).count;
    assert.equal(count, 30);

    // ---- delete a saved search: on the PC, then from the phone ----
    const { searchKey } = require('../src/scanner');
    const tiba = { query: 'تیبا', city: 'tehran' };
    const tibaKey = searchKey(tiba);
    const extra = ['XtraAd01', 'XtraAd02', 'XtraAd03'];
    for (const t of extra) store.rememberAd(P.extractPost(posts[tokens[2]], t), tibaKey);
    store.rememberAd(store.db.ads[tokens[1]].post, tibaKey); // also found by the other search: must stay
    store.touchSearch(tibaKey, tiba);
    store.applyCrm(extra[2], { action: 'stage', stage: 'shortlist' }); // followed up: must stay
    store.saveRun({ id: '20261102100000_tiba', createdAt: Date.now(), criteria: tiba, status: 'done', items: [], posts: {}, errors: {}, stats: {} }, true);
    await cloud.sync();
    await cloud.sync();
    assert.equal((await api('/api/ads')).ads.length, 33);
    assert.ok((await api('/api/state')).runs.some((x) => x.id === '20261102100000_tiba'));
    // Not while that very search is running.
    scanner.busy = true;
    scanner.current = { id: 'run_tiba', status: 'reading', criteria: tiba, posts: {}, items: [] };
    await cloud.sync();
    await assert.rejects(api('/api/search-delete', { method: 'POST', body: { key: tibaKey } }), /409/);
    scanner.busy = false;
    scanner.current = null;
    // Deleted on the PC: gone from the online panel too (search, its own ads, its run).
    assert.deepEqual(store.deleteSearch(tibaKey, searchKey), { removedAds: 2, keptAds: 1, removedRuns: 1 });
    await cloud.sync();
    ads = await api('/api/ads');
    assert.equal(ads.ads.length, 31, 'only the two ads of that search are gone');
    assert.ok(ads.ads.some((a) => a.token === extra[2]), 'the followed-up ad stays');
    assert.ok(ads.ads.some((a) => a.token === tokens[1]), 'the ad of another search stays');
    assert.ok(!ads.searches.some((s) => s.key === tibaKey));
    assert.ok(!(await api('/api/state')).runs.some((x) => x.id === '20261102100000_tiba'), 'its run is gone');
    assert.deepEqual(store.gone(), { ads: [], runs: [] }, 'nothing left to report');
    // Deleted from the phone: gone there at once, then on the PC.
    const del = await api('/api/search-delete', { method: 'POST', body: { key: 'q|tehran|206' } });
    assert.equal(del.removedAds + del.keptAds, 30);
    assert.ok(del.keptAds >= 2 && del.removedAds >= 20, JSON.stringify(del));
    ads = await api('/api/ads');
    assert.equal(ads.ads.length, del.keptAds + 1);
    assert.equal(ads.searches.length, 0);
    await cloud.sync();
    await cloud.sync();
    assert.deepEqual(Object.keys(store.db.searches), [], 'the bot deleted it too');
    assert.equal(Object.keys(store.db.ads).length, del.keptAds + 1, 'same ads left on the PC');
    assert.equal((await api('/api/ads')).ads.length, del.keptAds + 1, 'and nothing came back');
    await assert.rejects(api('/api/search-delete', { method: 'POST', body: { key: 'nope' } }), /404/);

    // ---- update from inside the panel (update.php) ----
    const upd = async (fields, withCookie = true) => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      const r = await fetch(`${BASE}update.php`, { method: 'POST', headers: withCookie ? { cookie } : {}, body: fd });
      const text = await r.text();
      let body = {};
      try { body = JSON.parse(text); } catch (_) { body = { raw: text.slice(0, 600) }; }
      return { status: r.status, body };
    };
    assert.equal((await fetch(`${BASE}update.php?action=info`)).status, 401, 'update needs sign-in');
    const info = await (await fetch(`${BASE}update.php?action=info`, { headers: { cookie } })).json();
    assert.equal(info.version.app, 'radyab');
    assert.equal(info.zip, true);
    // A newer package: changed version.json and app.css, plus things that must never be installed.
    const pkgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radyab-upd-'));
    fs.cpSync(path.join(ROOT, 'dist', 'radyab-host'), pkgDir, { recursive: true });
    fs.rmSync(path.join(pkgDir, 'data'), { recursive: true, force: true });
    fs.writeFileSync(path.join(pkgDir, 'version.json'), JSON.stringify({ app: 'radyab', version: '9.9.9-test', builtAt: Date.now() }));
    fs.appendFileSync(path.join(pkgDir, 'app.css'), '\n/* update-test-marker */\n');
    fs.writeFileSync(path.join(pkgDir, 'config.php'), '<?php // must not replace the real one');
    fs.writeFileSync(path.join(pkgDir, 'new-file.js'), '// added by the update');
    const zipOf = (dir, name) => {
      const out = path.join(os.tmpdir(), `${name}-${Date.now()}.zip`);
      const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : null;
      if (tar) execFileSync(tar, ['-a', '-c', '-f', out, '-C', dir, ...fs.readdirSync(dir)]);
      else execFileSync('zip', ['-qr', out, ...fs.readdirSync(dir)], { cwd: dir });
      return new Blob([fs.readFileSync(out)], { type: 'application/zip' });
    };
    const configBefore = fs.readFileSync(path.join(site, 'config.php'), 'utf8');
    const cssBefore = fs.readFileSync(path.join(site, 'app.css'), 'utf8');
    assert.equal((await upd({ action: 'apply', pkg: zipOf(pkgDir, 'u1') })).status, 403, 'needs the form token');
    let u = await upd({ action: 'apply', token: info.token, pkg: zipOf(pkgDir, 'u1') });
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.ok(u.body.applied > 20);
    assert.match(fs.readFileSync(path.join(site, 'app.css'), 'utf8'), /update-test-marker/, 'new files installed');
    assert.equal(fs.readFileSync(path.join(site, 'config.php'), 'utf8'), configBefore, 'config.php untouched');
    assert.ok(fs.existsSync(path.join(site, 'data', 'radyab.sqlite')), 'data untouched');
    assert.equal((await (await fetch(`${BASE}update.php?action=info`, { headers: { cookie } })).json()).version.version, '9.9.9-test');
    assert.equal((await fetch(`${BASE}api/state`, { headers: { cookie } })).status, 200, 'panel still works after the update');
    // Not a Radyab package: refused, nothing changed.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'radyab-other-'));
    fs.writeFileSync(path.join(other, 'index.html'), 'x');
    u = await upd({ action: 'apply', token: info.token, pkg: zipOf(other, 'u2') });
    assert.equal(u.status, 400);
    assert.match(u.body.error, /ردیاب نیست/);
    // Roll back: the old files return, the added file goes.
    const backups = (await (await fetch(`${BASE}update.php?action=info`, { headers: { cookie } })).json()).backups;
    u = await upd({ action: 'rollback', token: info.token, backup: backups[0].id });
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.equal(fs.readFileSync(path.join(site, 'app.css'), 'utf8'), cssBefore, 'rolled back');
    assert.ok(!fs.existsSync(path.join(site, 'new-file.js')), 'file added by the update removed');
    assert.notEqual((await (await fetch(`${BASE}update.php?action=info`, { headers: { cookie } })).json()).version.version, '9.9.9-test');

    // ---- sign out ----
    await api('/api/session', { method: 'DELETE' });
    assert.equal((await fetch(`${BASE}api/state`, { headers: { cookie } })).status, 401);

    console.log('host e2e OK — setup, sign-in, upload, two-way follow-up, newer change wins, PHP = JS rules, phone search queue, run commands, daily check setting, messages, backups, update + rollback');
  } finally {
    server.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
