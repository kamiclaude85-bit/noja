/*
 * Reminders on your phone (like Noja's push notifications), through:
 *   - Bale messenger bot   (works in Iran without a VPN; recommended)
 *   - Telegram bot
 *   - SMS via sms.ir       (the same service Noja uses)
 *
 * What is sent: a call that is due, a visit in one hour, a visit whose result
 * was not recorded, a summary after each bot run (with the cheapest new ads),
 * and "the bot needs you" (login / captcha). Quiet hours hold messages until morning.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const P = require('./parser');
const D = require('./deals');

const HOUR = 60 * 60 * 1000;
const DEFAULT_SETTINGS = {
  channel: '', // 'bale' | 'telegram' | 'sms' | ''
  bale: { token: '', chatId: '', chatName: '' },
  telegram: { token: '', chatId: '', chatName: '' },
  sms: { apiKey: '', line: '', mobile: '' },
  events: { calls: true, visits: true, runs: true, needsYou: true },
  quiet: { enabled: true, from: 23, to: 8 },
};
const API_BASES = {
  bale: 'https://tapi.bale.ai',
  telegram: 'https://api.telegram.org',
  sms: 'https://api.sms.ir',
};

const fa = (n) => Number(n).toLocaleString('fa-IR');
function priceFa(n) {
  if (n == null) return 'بدون قیمت';
  if (n >= 1e9) return `${(n / 1e9).toLocaleString('fa-IR', { maximumFractionDigits: 2 })} میلیارد`;
  if (n >= 1e6) return `${(n / 1e6).toLocaleString('fa-IR', { maximumFractionDigits: 1 })} میلیون`;
  return fa(n);
}
function timeFa(t) { return new Date(t).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }); }
function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? merge(base[k], v) : v;
  }
  return out;
}

class Notifier {
  constructor({ store, dataDir, log = () => {}, apiBases = {}, now = () => Date.now() }) {
    this.store = store;
    this.log = log;
    this.now = now;
    this.bases = { ...API_BASES, ...apiBases };
    this.file = path.join(dataDir, 'settings.json');
    this.sentFile = path.join(dataDir, 'notify-sent.json');
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')).notify || {}; } catch (_) { /* none */ }
    this.settings = merge(DEFAULT_SETTINGS, saved);
    this.sent = {};
    try { this.sent = JSON.parse(fs.readFileSync(this.sentFile, 'utf8')); } catch (_) { /* none */ }
    this.queue = []; // messages held during quiet hours
    this.lastError = null;
  }

  // ---------- settings ----------
  save() {
    let all = {};
    try { all = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) { /* none */ }
    all.notify = this.settings;
    fs.writeFileSync(this.file, JSON.stringify(all, null, 2));
  }

  /** Settings for the UI: secrets are never sent back, only whether they are set. */
  publicSettings() {
    const s = this.settings;
    const mask = (v) => (v ? `••••${String(v).slice(-4)}` : '');
    return {
      channel: s.channel,
      bale: { hasToken: !!s.bale.token, token: mask(s.bale.token), chatId: s.bale.chatId, chatName: s.bale.chatName },
      telegram: { hasToken: !!s.telegram.token, token: mask(s.telegram.token), chatId: s.telegram.chatId, chatName: s.telegram.chatName },
      sms: { hasKey: !!s.sms.apiKey, apiKey: mask(s.sms.apiKey), line: s.sms.line, mobile: s.sms.mobile },
      events: s.events,
      quiet: s.quiet,
      ready: this.ready(),
      lastError: this.lastError,
    };
  }

  update(patch) {
    const p = patch || {};
    const s = this.settings;
    if ('channel' in p) {
      if (!['', 'bale', 'telegram', 'sms'].includes(p.channel)) throw new Error('روش ارسال نامعتبر');
      s.channel = p.channel;
    }
    for (const ch of ['bale', 'telegram']) {
      if (!p[ch]) continue;
      const tok = String(p[ch].token || '').trim();
      if (tok) {
        if (!/^\d{4,}:[A-Za-z0-9_-]{10,}$/.test(tok)) throw new Error('توکن بات درست نیست؛ باید شبیه 123456789:ABC… باشد.');
        if (tok !== s[ch].token) { s[ch].token = tok; s[ch].chatId = ''; s[ch].chatName = ''; }
      }
    }
    if (p.sms) {
      if (String(p.sms.apiKey || '').trim()) s.sms.apiKey = String(p.sms.apiKey).trim();
      if ('line' in p.sms) s.sms.line = P.toEnDigits(p.sms.line).replace(/\D/g, '');
      if ('mobile' in p.sms) s.sms.mobile = P.toEnDigits(p.sms.mobile).replace(/\D/g, '');
    }
    if (p.events) for (const k of Object.keys(DEFAULT_SETTINGS.events)) if (k in p.events) s.events[k] = !!p.events[k];
    if (p.quiet) {
      if ('enabled' in p.quiet) s.quiet.enabled = !!p.quiet.enabled;
      for (const k of ['from', 'to']) if (k in p.quiet) { const n = Number(p.quiet[k]); if (n >= 0 && n <= 23) s.quiet[k] = n; }
    }
    this.save();
    return this.publicSettings();
  }

  ready() {
    const s = this.settings;
    if (s.channel === 'bale' || s.channel === 'telegram') return !!(s[s.channel].token && s[s.channel].chatId);
    if (s.channel === 'sms') return !!(s.sms.apiKey && s.sms.line && s.sms.mobile);
    return false;
  }

  // ---------- transport ----------
  async call(channel, method, body) {
    const tok = this.settings[channel].token;
    if (!tok) throw new Error('اول توکن بات را وارد کنید.');
    const res = await fetch(`${this.bases[channel]}/bot${tok}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(`پاسخ ${channel === 'bale' ? 'بله' : 'تلگرام'}: ${data.description || res.status}`);
    return data.result;
  }

  async deliver(text) {
    const s = this.settings;
    if (s.channel === 'bale' || s.channel === 'telegram') {
      await this.call(s.channel, 'sendMessage', { chat_id: s[s.channel].chatId, text });
    } else if (s.channel === 'sms') {
      const res = await fetch(`${this.bases.sms}/v1/send/bulk`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/plain', 'x-api-key': s.sms.apiKey },
        body: JSON.stringify({ lineNumber: Number(s.sms.line), messageText: text.slice(0, 600), mobiles: [s.sms.mobile], sendDateTime: null }),
        signal: AbortSignal.timeout(20000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.status !== 1) throw new Error(`پاسخ sms.ir: ${data.message || res.status}`);
    } else {
      throw new Error('روش ارسال انتخاب نشده است.');
    }
  }

  /** Find the chat of whoever last messaged the bot (the user sends «سلام» to their bot first). */
  async findChat() {
    const ch = this.settings.channel;
    if (ch !== 'bale' && ch !== 'telegram') throw new Error('این کار فقط برای بله و تلگرام است.');
    const updates = await this.call(ch, 'getUpdates', {});
    const msgs = (updates || []).map((u) => u.message || u.edited_message).filter((m) => m && m.chat);
    if (!msgs.length) throw new Error('پیامی پیدا نشد. اول در خود پیام‌رسان به بات‌تان یک پیام (مثلاً «سلام») بدهید و دوباره بزنید.');
    const chat = msgs[msgs.length - 1].chat;
    this.settings[ch].chatId = String(chat.id);
    this.settings[ch].chatName = [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || chat.title || '';
    this.save();
    return this.publicSettings();
  }

  async test() {
    await this.deliver('✅ ردیاب وصل شد. یادآوری‌های تماس، بازدید و آگهی‌های جدید اینجا می‌آیند.');
    this.lastError = null;
    return true;
  }

  // ---------- sending with dedupe + quiet hours ----------
  isQuiet(t = this.now()) {
    const q = this.settings.quiet;
    if (!q.enabled) return false;
    const h = new Date(t).getHours();
    return q.from > q.to ? (h >= q.from || h < q.to) : (h >= q.from && h < q.to);
  }

  /** Send once per key. Returns true if sent (or queued for after quiet hours). */
  async notify(key, text, { urgent } = {}) {
    if (!this.ready() || this.sent[key]) return false;
    if (!urgent && this.isQuiet()) {
      if (!this.queue.some((m) => m.key === key)) this.queue.push({ key, text });
      return false;
    }
    try {
      await this.deliver(text);
      this.sent[key] = this.now();
      this.lastError = null;
      this.saveSent();
      return true;
    } catch (e) {
      this.lastError = e.message;
      this.log(e);
      return false;
    }
  }

  saveSent() {
    const cutoff = this.now() - 14 * 24 * HOUR;
    for (const [k, t] of Object.entries(this.sent)) if (t < cutoff) delete this.sent[k];
    try { fs.writeFileSync(this.sentFile, JSON.stringify(this.sent)); } catch (e) { this.log(e); }
  }

  /** Called every minute: due calls, visits soon, visits without a result. */
  async tick() {
    if (this.forward) return 0; // connected to the online panel: the host sends the reminders
    if (!this.ready()) return 0;
    const now = this.now();
    let n = 0;
    if (!this.isQuiet() && this.queue.length) {
      const held = this.queue.splice(0);
      for (const m of held) if (await this.notify(m.key, m.text)) n++;
    }
    const ev = this.settings.events;
    for (const [token, rec] of Object.entries(this.store.db.ads)) {
      const c = rec.crm;
      const p = rec.post;
      if (!c || !p || rec.removed || ['bought', 'rejected'].includes(c.stage)) continue;
      const phone = c.phone ? `\nشماره: ${c.phone}` : '';
      const link = p.url ? `\n${p.url}` : '';
      if (ev.calls && c.nextCallAt && c.nextCallAt <= now && now - c.nextCallAt < 12 * HOUR) {
        const missed = c.missed ? `\n(${fa(c.missed)} بار جواب نداده)` : '';
        if (await this.notify(`call:${token}:${c.nextCallAt}`, `📞 وقت تماس: ${p.title}\n${priceFa(p.price)} تومان${phone}${missed}${link}`)) n++;
      }
      if (ev.visits && c.stage === 'visit' && c.visitAt) {
        const until = c.visitAt - now;
        if (until > 0 && until <= HOUR) {
          if (await this.notify(`visit1h:${token}:${c.visitAt}`, `🚗 بازدید ساعت ${timeFa(c.visitAt)}: ${p.title}${p.subtitle ? `\n${p.subtitle}` : ''}${phone}${link}`, { urgent: true })) n++;
        } else if (until < -2 * HOUR && until > -36 * HOUR) {
          if (await this.notify(`visitover:${token}:${c.visitAt}`, `📝 نتیجهٔ بازدید «${p.title}» را در ردیاب ثبت کنید.`)) n++;
        }
      }
    }
    return n;
  }

  /** Called by the bot: needs the user, or finished a run. */
  async runEvent(run, kind) {
    // Connected to the online panel: the host sends it, with the settings saved there.
    const send = (event, key, text, opts = {}) => {
      if (this.forward) return this.forward({ kind: event, key, text, urgent: !!opts.urgent });
      return this.settings.events[event] ? this.notify(key, text, opts) : false;
    };
    if (kind === 'waiting-login') {
      return send('needsYou', `run:${run.id}:login`, '🔑 ربات ردیاب منتظر شماست: در پنجرهٔ کروم وارد حساب دیوار شوید.', { urgent: true });
    }
    if (kind === 'blocked') {
      return send('needsYou', `run:${run.id}:blocked:${Math.floor(this.now() / (10 * 60 * 1000))}`, '⚠️ دیوار تأیید (کپچا) خواسته. در پنجرهٔ کروم حلش کنید و در ردیاب «ادامه» را بزنید.', { urgent: true });
    }
    if (kind === 'done' || kind === 'stopped') {
      const st = run.stats || {};
      if (!st.newAds && !st.priceChanged && !st.sold) return false; // nothing worth a message
      return send('runs', `run:${run.id}:done`, this.runSummary(run));
    }
    return false;
  }

  runSummary(run) {
    const st = run.stats || {};
    const posts = Object.values(run.posts || {});
    const rule = P.searchRule(run.criteria, posts);
    const fresh = posts.filter((p) => p.isNew && P.matchesCriteria(p, run.criteria, rule));
    const drops = posts.filter((p) => p.priceChange && p.priceChange.to < p.priceChange.from);
    const what = run.criteria && run.criteria.query ? run.criteria.query : 'جستجو';
    const lines = [`🔎 ردیاب — بررسی «${what}» تمام شد`];
    const parts = [`${fa(st.newAds || 0)} آگهی جدید`];
    if (st.priceChanged) parts.push(`${fa(st.priceChanged)} تغییر قیمت`);
    if (st.sold) parts.push(`${fa(st.sold)} آگهی پیگیری‌شده فروخته شد`);
    lines.push(parts.join('، '));
    // Special offers among the new ads (compared with every ad of the same model+year in memory).
    const all = Object.values(this.store.db.ads).filter((r) => r.post).map((r) => ({ ...r.post, removed: r.removed }));
    const deals = D.computeDeals(all);
    const hot = fresh.filter((p) => deals.get(p.token) && deals.get(p.token).deal)
      .sort((a, b) => deals.get(b.token).score - deals.get(a.token).score).slice(0, 3);
    if (hot.length) {
      lines.push('', '🔥 پیشنهاد ویژه:');
      for (const p of hot) lines.push(`• ${p.title} — ${priceFa(p.price)} (${fa(Math.round(deals.get(p.token).discount * 100))}٪ زیر قیمت معمول)\n${p.url}`);
    }
    const cheapest = hot.length ? [] : fresh.filter((p) => p.price).sort((a, b) => a.price - b.price).slice(0, 3);
    if (cheapest.length) {
      lines.push('', 'ارزان‌ترین آگهی‌های جدید:');
      for (const p of cheapest) lines.push(`• ${p.title} — ${priceFa(p.price)}${p.seller === 'dealer' ? ' (نمایشگاهی)' : ''}\n${p.url}`);
    }
    for (const p of drops.slice(0, 3)) lines.push('', `📉 ${p.title}: ${priceFa(p.priceChange.from)} ← ${priceFa(p.priceChange.to)}\n${p.url}`);
    return lines.join('\n');
  }
}

module.exports = { Notifier, DEFAULT_SETTINGS };
