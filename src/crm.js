/*
 * Follow-up (CRM) rules for car ads, in the style of Noja's lead follow-up:
 * stages, call results with automatic next-call scheduling, notes,
 * removal with a reason (restorable), and visit appointments.
 */
'use strict';

const STAGES = {
  new: 'جدید',
  shortlist: 'فهرست کوتاه',
  calling: 'در حال تماس',
  waiting: 'منتظر تماس فروشنده',
  talking: 'صحبت شد / مذاکره',
  visit: 'قرار بازدید',
  visited: 'بازدید شد',
  bought: 'خریدم',
  rejected: 'حذف شده',
};
/** Stages that mean "I am still working on this ad". */
const ACTIVE_STAGES = ['shortlist', 'calling', 'waiting', 'talking', 'visit', 'visited'];
const REJECT_REASONS = ['گران است', 'تصادفی / رنگ دارد', 'کارکرد زیاد', 'نمایشگاهی است', 'فروخته شد', 'دور است', 'فروشنده جواب نمی‌دهد', 'دلیل دیگر'];
const CALL_RESULTS = { answered: 'جواب داد', 'no-answer': 'جواب نداد', off: 'خاموش / در دسترس نیست' };

const HOUR = 60 * 60 * 1000;

function emptyCrm(now) {
  return { stage: 'new', notes: [], calls: [], createdAt: now };
}

/** Next call time after an unanswered call: +1h, then +3h, then tomorrow 10:00. */
function nextCallAfterMiss(attempt, now) {
  if (attempt <= 1) return now + HOUR;
  if (attempt === 2) return now + 3 * HOUR;
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  return d.getTime();
}

function cleanText(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
}

/**
 * Apply one follow-up action to an ad record (mutates `rec`). Returns rec.
 * Throws an Error with a Persian message on invalid input.
 */
function applyAction(rec, body, now = Date.now()) {
  const c = rec.crm || (rec.crm = emptyCrm(now));
  const log = (text, kind = 'event') => c.notes.push({ t: now, text, kind });
  const setStage = (stage) => {
    if (c.stage === stage) return;
    if (stage !== 'rejected') delete c.rejectReason;
    c.prevStage = c.stage;
    c.stage = stage;
    log(`مرحله: ${STAGES[stage]}`, 'stage');
  };

  switch (body.action) {
    case 'stage': {
      if (!STAGES[body.stage] || body.stage === 'rejected') throw new Error('مرحلهٔ نامعتبر');
      setStage(body.stage);
      if (['bought'].includes(body.stage)) c.nextCallAt = null;
      break;
    }
    case 'note': {
      const text = cleanText(body.text, 2000);
      if (!text) throw new Error('متن یادداشت خالی است');
      c.notes.push({ t: now, text, kind: 'note' });
      break;
    }
    case 'call': {
      if (!CALL_RESULTS[body.result]) throw new Error('نتیجهٔ تماس نامعتبر');
      const note = cleanText(body.note, 1000);
      c.calls.push({ t: now, result: body.result, note });
      if (body.result === 'answered') {
        c.missed = 0;
        c.nextCallAt = null;
        if (['new', 'shortlist', 'calling'].includes(c.stage)) setStage('talking');
      } else {
        c.missed = (c.missed || 0) + 1;
        c.nextCallAt = nextCallAfterMiss(c.missed, now);
        if (['new', 'shortlist'].includes(c.stage)) setStage('calling');
      }
      log(`تماس: ${CALL_RESULTS[body.result]}${note ? ` — ${note}` : ''}`, 'call');
      break;
    }
    case 'schedule': {
      const at = body.at == null ? null : Number(body.at);
      if (at != null && !(at > 0)) throw new Error('زمان نامعتبر');
      c.nextCallAt = at;
      if (at && ['new', 'shortlist'].includes(c.stage)) setStage('waiting');
      log(at ? 'یادآوری تماس تنظیم شد' : 'یادآوری تماس برداشته شد');
      break;
    }
    case 'visit': {
      const at = Number(body.at);
      if (!(at > 0)) throw new Error('زمان بازدید نامعتبر');
      c.visitAt = at;
      setStage('visit');
      log('قرار بازدید گذاشته شد');
      break;
    }
    case 'visited': {
      setStage('visited');
      const note = cleanText(body.note, 2000);
      if (note) c.notes.push({ t: now, text: note, kind: 'note' });
      break;
    }
    case 'set': {
      if ('phone' in body) c.phone = cleanText(body.phone, 30).replace(/[^\d+۰-۹٠-٩ -]/g, '');
      if ('offer' in body) {
        const n = body.offer == null || body.offer === '' ? null : Number(body.offer);
        if (n != null && !(n >= 0)) throw new Error('مبلغ نامعتبر');
        c.offer = n;
      }
      break;
    }
    case 'reject': {
      const reason = cleanText(body.reason, 200);
      if (!reason) throw new Error('دلیل حذف را انتخاب کنید');
      c.prevStage = c.stage === 'rejected' ? c.prevStage : c.stage;
      c.stage = 'rejected';
      c.rejectReason = reason;
      c.rejectedAt = now;
      c.nextCallAt = null;
      log(`حذف شد: ${reason}`, 'stage');
      break;
    }
    case 'restore': {
      if (c.stage !== 'rejected') break;
      c.stage = c.prevStage && c.prevStage !== 'rejected' ? c.prevStage : 'new';
      delete c.rejectReason;
      delete c.rejectedAt;
      log(`برگردانده شد به «${STAGES[c.stage]}»`, 'stage');
      break;
    }
    default:
      throw new Error('عمل نامعتبر');
  }
  c.updatedAt = now;
  return rec;
}

module.exports = { STAGES, ACTIVE_STAGES, REJECT_REASONS, CALL_RESULTS, applyAction, nextCallAfterMiss, emptyCrm };
