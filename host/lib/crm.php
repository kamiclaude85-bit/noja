<?php
/*
 * Follow-up rules — the same as src/crm.js (keep the two in step; tests/host.test.js checks
 * that both give the same result for the same actions).
 */
declare(strict_types=1);

if (!defined('RADYAB')) { http_response_code(403); exit('Forbidden'); }

const CRM_STAGES = [
    'new' => 'جدید',
    'shortlist' => 'فهرست کوتاه',
    'calling' => 'در حال تماس',
    'waiting' => 'منتظر تماس فروشنده',
    'talking' => 'صحبت شد / مذاکره',
    'visit' => 'قرار بازدید',
    'visited' => 'بازدید شد',
    'bought' => 'خریدم',
    'rejected' => 'حذف شده',
];
const CRM_ACTIVE_STAGES = ['shortlist', 'calling', 'waiting', 'talking', 'visit', 'visited'];
const CRM_REJECT_REASONS = ['گران است', 'تصادفی / رنگ دارد', 'کارکرد زیاد', 'نمایشگاهی است', 'فروخته شد', 'دور است', 'فروشنده جواب نمی‌دهد', 'دلیل دیگر'];
const CRM_CALL_RESULTS = ['answered' => 'جواب داد', 'no-answer' => 'جواب نداد', 'off' => 'خاموش / در دسترس نیست'];
const CRM_HOUR = 3600000;

class CrmError extends Exception {}

function crm_next_call_after_miss(int $attempt, int $now): int {
    if ($attempt <= 1) return $now + CRM_HOUR;
    if ($attempt === 2) return $now + 3 * CRM_HOUR;
    $d = new DateTime('@' . intdiv($now, 1000));
    $d->setTimezone(new DateTimeZone(date_default_timezone_get()));
    $d->modify('+1 day')->setTime(10, 0, 0);
    return $d->getTimestamp() * 1000;
}

function crm_clean($v, int $max): string {
    $s = preg_replace('/[\x00-\x08\x0b\x0c\x0e-\x1f]/u', '', (string) ($v ?? ''));
    return mb_substr(trim($s), 0, $max);
}

/** Apply one follow-up action to an ad record (array, by reference). Throws CrmError. */
function crm_apply(array &$rec, array $body, ?int $now = null): void {
    $now = $now ?? now_ms();
    if (empty($rec['crm']) || !is_array($rec['crm'])) $rec['crm'] = ['stage' => 'new', 'notes' => [], 'calls' => [], 'createdAt' => $now];
    $c = &$rec['crm'];
    $c['notes'] = $c['notes'] ?? [];
    $c['calls'] = $c['calls'] ?? [];
    $log = function (string $text, string $kind = 'event') use (&$c, $now) { $c['notes'][] = ['t' => $now, 'text' => $text, 'kind' => $kind]; };
    $setStage = function (string $stage) use (&$c, $log) {
        if (($c['stage'] ?? 'new') === $stage) return;
        if ($stage !== 'rejected') unset($c['rejectReason']);
        $c['prevStage'] = $c['stage'] ?? 'new';
        $c['stage'] = $stage;
        $log('مرحله: ' . CRM_STAGES[$stage], 'stage');
    };
    $stage = $c['stage'] ?? 'new';

    switch ($body['action'] ?? '') {
        case 'stage':
            $s = (string) ($body['stage'] ?? '');
            if (!isset(CRM_STAGES[$s]) || $s === 'rejected') throw new CrmError('مرحلهٔ نامعتبر');
            $setStage($s);
            if ($s === 'bought') $c['nextCallAt'] = null;
            break;
        case 'note':
            $text = crm_clean($body['text'] ?? '', 2000);
            if ($text === '') throw new CrmError('متن یادداشت خالی است');
            $c['notes'][] = ['t' => $now, 'text' => $text, 'kind' => 'note'];
            break;
        case 'call':
            $result = (string) ($body['result'] ?? '');
            if (!isset(CRM_CALL_RESULTS[$result])) throw new CrmError('نتیجهٔ تماس نامعتبر');
            $note = crm_clean($body['note'] ?? '', 1000);
            $c['calls'][] = ['t' => $now, 'result' => $result, 'note' => $note];
            if ($result === 'answered') {
                $c['missed'] = 0;
                $c['nextCallAt'] = null;
                if (in_array($stage, ['new', 'shortlist', 'calling'], true)) $setStage('talking');
            } else {
                $c['missed'] = (int) ($c['missed'] ?? 0) + 1;
                $c['nextCallAt'] = crm_next_call_after_miss($c['missed'], $now);
                if (in_array($stage, ['new', 'shortlist'], true)) $setStage('calling');
            }
            $log('تماس: ' . CRM_CALL_RESULTS[$result] . ($note !== '' ? " — $note" : ''), 'call');
            break;
        case 'schedule':
            $at = array_key_exists('at', $body) && $body['at'] !== null ? (float) $body['at'] : null;
            if ($at !== null && !($at > 0)) throw new CrmError('زمان نامعتبر');
            $c['nextCallAt'] = $at === null ? null : (int) $at;
            if ($at && in_array($stage, ['new', 'shortlist'], true)) $setStage('waiting');
            $log($at ? 'یادآوری تماس تنظیم شد' : 'یادآوری تماس برداشته شد');
            break;
        case 'visit':
            $at = (float) ($body['at'] ?? 0);
            if (!($at > 0)) throw new CrmError('زمان بازدید نامعتبر');
            $c['visitAt'] = (int) $at;
            $setStage('visit');
            $log('قرار بازدید گذاشته شد');
            break;
        case 'visited':
            $setStage('visited');
            $note = crm_clean($body['note'] ?? '', 2000);
            if ($note !== '') $c['notes'][] = ['t' => $now, 'text' => $note, 'kind' => 'note'];
            break;
        case 'set':
            if (array_key_exists('phone', $body)) $c['phone'] = preg_replace('/[^\d+۰-۹٠-٩ -]/u', '', crm_clean($body['phone'], 30));
            if (array_key_exists('offer', $body)) {
                $o = $body['offer'];
                $n = ($o === null || $o === '') ? null : (is_numeric($o) ? (float) $o : -1);
                if ($n !== null && !($n >= 0)) throw new CrmError('مبلغ نامعتبر');
                $c['offer'] = $n === null ? null : (floor($n) == $n ? (int) $n : $n);
            }
            break;
        case 'reject':
            $reason = crm_clean($body['reason'] ?? '', 200);
            if ($reason === '') throw new CrmError('دلیل حذف را انتخاب کنید');
            $c['prevStage'] = $stage === 'rejected' ? ($c['prevStage'] ?? null) : $stage;
            $c['stage'] = 'rejected';
            $c['rejectReason'] = $reason;
            $c['rejectedAt'] = $now;
            $c['nextCallAt'] = null;
            $log("حذف شد: $reason", 'stage');
            break;
        case 'restore':
            if ($stage !== 'rejected') break;
            $prev = $c['prevStage'] ?? null;
            $c['stage'] = $prev && $prev !== 'rejected' ? $prev : 'new';
            unset($c['rejectReason'], $c['rejectedAt']);
            $log('برگردانده شد به «' . CRM_STAGES[$c['stage']] . '»', 'stage');
            break;
        default:
            throw new CrmError('عمل نامعتبر');
    }
    $c['updatedAt'] = $now;
}
