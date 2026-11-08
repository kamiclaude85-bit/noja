'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { Notifier } = require('../src/notify');

/** A fake Bale/Telegram bot API + sms.ir, recording what was sent. */
function fakeServer() {
  const sent = [];
  let updates = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const data = body ? JSON.parse(body) : {};
      res.setHeader('content-type', 'application/json');
      if (/\/bot[^/]+\/sendMessage$/.test(req.url)) { sent.push({ via: 'bot', ...data }); return res.end(JSON.stringify({ ok: true, result: {} })); }
      if (/\/bot[^/]+\/getUpdates$/.test(req.url)) return res.end(JSON.stringify({ ok: true, result: updates }));
      if (req.url === '/v1/send/bulk') {
        if (req.headers['x-api-key'] !== 'KEY') return res.end(JSON.stringify({ status: 0, message: 'کلید نامعتبر' }));
        sent.push({ via: 'sms', ...data }); return res.end(JSON.stringify({ status: 1, message: 'موفق' }));
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server, sent, base: `http://127.0.0.1:${server.address().port}`, setUpdates: (u) => { updates = u; },
  })));
}

function setup(base, now) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noja-notify-'));
  const store = new Store(dir);
  const n = new Notifier({ store, dataDir: dir, apiBases: { bale: base, telegram: base, sms: base }, now: () => now.t });
  return { dir, store, n };
}

test('bale: connect, test message, due call reminder sent once', async () => {
  const f = await fakeServer();
  const now = { t: new Date(2026, 10, 8, 12, 0).getTime() };
  const { store, n } = setup(f.base, now);
  assert.throws(() => n.update({ channel: 'bale', bale: { token: 'not-a-token' } }), /توکن/);
  n.update({ channel: 'bale', bale: { token: '123456789:AAbbCCddEEffGGhh' } });
  assert.equal(n.ready(), false);
  await assert.rejects(n.findChat(), /پیامی پیدا نشد/);
  f.setUpdates([{ update_id: 1, message: { chat: { id: 777, first_name: 'کامران' }, text: 'سلام' } }]);
  const s = await n.findChat();
  assert.equal(s.bale.chatId, '777');
  assert.equal(s.bale.chatName, 'کامران');
  assert.ok(!JSON.stringify(s).includes('AAbbCCddEEffGGhh'), 'token is never sent back to the UI');
  assert.equal(n.ready(), true);
  await n.test();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].chat_id, '777');

  store.rememberAd({ token: 'A1', title: 'پژو ۲۰۶ مدل ۹۷', price: 485e6, url: 'https://divar.ir/v/A1', fields: { a: 1 } }, 'k');
  store.db.ads.A1.crm = { stage: 'calling', notes: [], calls: [], phone: '09121234567', missed: 2, nextCallAt: now.t - 60e3 };
  assert.equal(await n.tick(), 1);
  assert.match(f.sent[1].text, /وقت تماس: پژو ۲۰۶ مدل ۹۷/);
  assert.match(f.sent[1].text, /09121234567/);
  assert.match(f.sent[1].text, /۲ بار جواب نداده/);
  assert.equal(await n.tick(), 0, 'not sent twice');
  f.server.close();
});

test('quiet hours hold reminders until morning; visits remind one hour before', async () => {
  const f = await fakeServer();
  const now = { t: new Date(2026, 10, 8, 23, 30).getTime() };
  const { store, n } = setup(f.base, now);
  n.update({ channel: 'telegram', telegram: { token: '123456789:AAbbCCddEEffGGhh' } });
  f.setUpdates([{ update_id: 1, message: { chat: { id: 5 } } }]);
  await n.findChat();
  store.rememberAd({ token: 'B1', title: 'پژو ۲۰۶', price: 450e6, url: 'https://divar.ir/v/B1', fields: { a: 1 } }, 'k');
  store.db.ads.B1.crm = { stage: 'calling', notes: [], calls: [], nextCallAt: now.t - 1000 };
  assert.equal(await n.tick(), 0, 'night: held');
  assert.equal(f.sent.length, 0);
  now.t = new Date(2026, 10, 9, 8, 5).getTime();
  assert.ok(await n.tick() >= 1, 'morning: delivered');
  assert.match(f.sent[0].text, /وقت تماس/);

  store.db.ads.B1.crm = { stage: 'visit', notes: [], calls: [], visitAt: now.t + 40 * 60e3 };
  await n.tick();
  assert.match(f.sent[f.sent.length - 1].text, /بازدید ساعت/);
  f.server.close();
});

test('run summary lists the cheapest new ads; login prompt is urgent', async () => {
  const f = await fakeServer();
  const now = { t: new Date(2026, 10, 8, 23, 50).getTime() }; // quiet hours
  const { n } = setup(f.base, now);
  n.update({ channel: 'sms', sms: { apiKey: 'KEY', line: '۳۰۰۰۱۲۳۴', mobile: '0912 123 4567' } });
  assert.equal(n.ready(), true);
  const run = {
    id: 'r1', criteria: { query: 'پژو ۲۰۶', yearMin: 1397, yearMax: 1397 },
    stats: { newAds: 2, priceChanged: 1, sold: 0 },
    posts: {
      a: { token: 'a', isNew: true, title: 'پژو ۲۰۶ ارزان', price: 430e6, year: 1397, url: 'https://divar.ir/v/a', seller: 'personal' },
      b: { token: 'b', isNew: true, title: 'پژو ۲۰۶ گران', price: 520e6, year: 1397, url: 'https://divar.ir/v/b', seller: 'dealer' },
      c: { token: 'c', isNew: false, title: 'پژو ۲۰۶ قدیمی', price: 470e6, year: 1397, url: 'https://divar.ir/v/c', priceChange: { from: 495e6, to: 470e6 } },
    },
  };
  assert.equal(await n.runEvent(run, 'waiting-login'), true, 'urgent even at night');
  assert.equal(f.sent[0].via, 'sms');
  assert.equal(f.sent[0].lineNumber, 30001234);
  assert.deepEqual(f.sent[0].mobiles, ['09121234567']);
  now.t = new Date(2026, 10, 9, 10, 0).getTime();
  await n.runEvent(run, 'done');
  const text = f.sent[1].messageText;
  assert.match(text, /۲ آگهی جدید، ۱ تغییر قیمت/);
  assert.ok(text.indexOf('ارزان') < text.indexOf('گران'), 'cheapest first');
  assert.match(text, /\(نمایشگاهی\)/);
  assert.match(text, /۴۹۵ میلیون ← ۴۷۰ میلیون/);
  assert.equal(await n.runEvent({ ...run, id: 'r2', stats: { newAds: 0 } }, 'done'), false, 'no message when nothing new');
  f.server.close();
});
