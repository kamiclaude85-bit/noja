<?php
/*
 * Phone reminders from the host (same rules as src/notify.js): Bale, Telegram or SMS (sms.ir).
 * Due calls, a visit within the hour, a visit without a result, plus messages the PC bot
 * hands over (run summary, «the bot needs you»). Quiet hours hold messages until morning.
 * Runs every minute from cron.php, and also on panel/bot requests (at most once a minute).
 */
declare(strict_types=1);

if (!defined('RADYAB')) { http_response_code(403); exit('Forbidden'); }

const NOTIFY_DEFAULTS = [
    'channel' => '',
    'bale' => ['token' => '', 'chatId' => '', 'chatName' => ''],
    'telegram' => ['token' => '', 'chatId' => '', 'chatName' => ''],
    'sms' => ['apiKey' => '', 'line' => '', 'mobile' => ''],
    'events' => ['calls' => true, 'visits' => true, 'runs' => true, 'needsYou' => true],
    'quiet' => ['enabled' => true, 'from' => 23, 'to' => 8],
];
const NOTIFY_BASES = ['bale' => 'https://tapi.bale.ai', 'telegram' => 'https://api.telegram.org', 'sms' => 'https://api.sms.ir'];

function fa_digits(string $s): string { return strtr($s, ['0' => '۰', '1' => '۱', '2' => '۲', '3' => '۳', '4' => '۴', '5' => '۵', '6' => '۶', '7' => '۷', '8' => '۸', '9' => '۹']); }
function fa_num($n): string { return fa_digits(number_format((float) $n, 0, '.', '٬')); }
function fa_price($n): string {
    if ($n === null) return 'بدون قیمت';
    $n = (float) $n;
    if ($n >= 1e9) return fa_digits(rtrim(rtrim(number_format($n / 1e9, 2, '٫', ''), '0'), '٫')) . ' میلیارد';
    if ($n >= 1e6) return fa_digits(rtrim(rtrim(number_format($n / 1e6, 1, '٫', ''), '0'), '٫')) . ' میلیون';
    return fa_num($n);
}
function fa_time(int $ms): string { return fa_digits(date('H:i', intdiv($ms, 1000))); }

function notify_merge(array $base, $patch): array {
    foreach ((array) $patch as $k => $v) {
        $base[$k] = is_array($v) && isset($base[$k]) && is_array($base[$k]) && array_keys($base[$k]) !== range(0, count($base[$k]) - 1) ? notify_merge($base[$k], $v) : $v;
    }
    return $base;
}

function notify_settings(): array { return notify_merge(NOTIFY_DEFAULTS, kv_get('notify', [])); }

function notify_ready(?array $s = null): bool {
    $s = $s ?? notify_settings();
    $ch = $s['channel'];
    if ($ch === 'bale' || $ch === 'telegram') return $s[$ch]['token'] !== '' && $s[$ch]['chatId'] !== '';
    if ($ch === 'sms') return $s['sms']['apiKey'] !== '' && $s['sms']['line'] !== '' && $s['sms']['mobile'] !== '';
    return false;
}

/** Settings for the panel: secrets are never sent back, only whether they are set. */
function notify_public(): array {
    $s = notify_settings();
    $mask = function ($v) { return $v ? '••••' . mb_substr((string) $v, -4) : ''; };
    return [
        'channel' => $s['channel'],
        'bale' => ['hasToken' => $s['bale']['token'] !== '', 'token' => $mask($s['bale']['token']), 'chatId' => $s['bale']['chatId'], 'chatName' => $s['bale']['chatName']],
        'telegram' => ['hasToken' => $s['telegram']['token'] !== '', 'token' => $mask($s['telegram']['token']), 'chatId' => $s['telegram']['chatId'], 'chatName' => $s['telegram']['chatName']],
        'sms' => ['hasKey' => $s['sms']['apiKey'] !== '', 'apiKey' => $mask($s['sms']['apiKey']), 'line' => $s['sms']['line'], 'mobile' => $s['sms']['mobile']],
        'events' => $s['events'],
        'quiet' => $s['quiet'],
        'ready' => notify_ready($s),
        'lastError' => kv_get('notify_error'),
    ];
}

function en_digits(string $s): string {
    return strtr($s, ['۰' => '0', '۱' => '1', '۲' => '2', '۳' => '3', '۴' => '4', '۵' => '5', '۶' => '6', '۷' => '7', '۸' => '8', '۹' => '9',
        '٠' => '0', '١' => '1', '٢' => '2', '٣' => '3', '٤' => '4', '٥' => '5', '٦' => '6', '٧' => '7', '٨' => '8', '٩' => '9']);
}

function notify_update(array $p): array {
    $s = notify_settings();
    if (array_key_exists('channel', $p)) {
        if (!in_array($p['channel'], ['', 'bale', 'telegram', 'sms'], true)) throw new CrmError('روش ارسال نامعتبر');
        $s['channel'] = $p['channel'];
    }
    foreach (['bale', 'telegram'] as $ch) {
        if (empty($p[$ch]) || !is_array($p[$ch])) continue;
        $tok = trim((string) ($p[$ch]['token'] ?? ''));
        if ($tok !== '') {
            if (!preg_match('/^\d{4,}:[A-Za-z0-9_-]{10,}$/', $tok)) throw new CrmError('توکن بات درست نیست؛ باید شبیه 123456789:ABC… باشد.');
            if ($tok !== $s[$ch]['token']) $s[$ch] = ['token' => $tok, 'chatId' => '', 'chatName' => ''];
        }
    }
    if (!empty($p['sms']) && is_array($p['sms'])) {
        if (trim((string) ($p['sms']['apiKey'] ?? '')) !== '') $s['sms']['apiKey'] = trim((string) $p['sms']['apiKey']);
        if (array_key_exists('line', $p['sms'])) $s['sms']['line'] = preg_replace('/\D/', '', en_digits((string) $p['sms']['line']));
        if (array_key_exists('mobile', $p['sms'])) $s['sms']['mobile'] = preg_replace('/\D/', '', en_digits((string) $p['sms']['mobile']));
    }
    if (!empty($p['events']) && is_array($p['events'])) {
        foreach (array_keys(NOTIFY_DEFAULTS['events']) as $k) if (array_key_exists($k, $p['events'])) $s['events'][$k] = (bool) $p['events'][$k];
    }
    if (!empty($p['quiet']) && is_array($p['quiet'])) {
        if (array_key_exists('enabled', $p['quiet'])) $s['quiet']['enabled'] = (bool) $p['quiet']['enabled'];
        foreach (['from', 'to'] as $k) if (array_key_exists($k, $p['quiet']) && is_numeric($p['quiet'][$k]) && $p['quiet'][$k] >= 0 && $p['quiet'][$k] <= 23) $s['quiet'][$k] = (int) $p['quiet'][$k];
    }
    kv_set('notify', $s);
    return notify_public();
}

// ---------- transport ----------
function http_post_json(string $url, array $body, array $headers = []): array {
    $payload = jenc($body);
    $headers = array_merge(['Content-Type: application/json', 'Accept: application/json'], $headers);
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $payload, CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20, CURLOPT_CONNECTTIMEOUT => 10]);
        $raw = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        curl_close($ch);
        if ($raw === false) throw new CrmError("ارتباط برقرار نشد: $err");
    } else {
        $ctx = stream_context_create(['http' => ['method' => 'POST', 'header' => implode("\r\n", $headers), 'content' => $payload, 'timeout' => 20, 'ignore_errors' => true]]);
        $raw = @file_get_contents($url, false, $ctx);
        $code = 0;
        foreach ($http_response_header ?? [] as $h) if (preg_match('#^HTTP/\S+\s+(\d+)#', $h, $m)) $code = (int) $m[1];
        if ($raw === false) throw new CrmError('ارتباط برقرار نشد.');
    }
    return [$code, json_decode((string) $raw, true) ?: []];
}

function notify_bot_call(array $s, string $ch, string $method, array $body) {
    $tok = $s[$ch]['token'];
    if ($tok === '') throw new CrmError('اول توکن بات را وارد کنید.');
    [$code, $data] = http_post_json(NOTIFY_BASES[$ch] . "/bot$tok/$method", $body);
    if ($code >= 400 || ($data['ok'] ?? null) === false) {
        throw new CrmError('پاسخ ' . ($ch === 'bale' ? 'بله' : 'تلگرام') . ': ' . ($data['description'] ?? $code));
    }
    return $data['result'] ?? null;
}

function notify_deliver(string $text, ?array $s = null): void {
    $s = $s ?? notify_settings();
    $ch = $s['channel'];
    if ($ch === 'bale' || $ch === 'telegram') {
        notify_bot_call($s, $ch, 'sendMessage', ['chat_id' => $s[$ch]['chatId'], 'text' => $text]);
    } elseif ($ch === 'sms') {
        [$code, $data] = http_post_json(NOTIFY_BASES['sms'] . '/v1/send/bulk',
            ['lineNumber' => (int) $s['sms']['line'], 'messageText' => mb_substr($text, 0, 600), 'mobiles' => [$s['sms']['mobile']], 'sendDateTime' => null],
            ['x-api-key: ' . $s['sms']['apiKey']]);
        if ($code >= 400 || ($data['status'] ?? 0) !== 1) throw new CrmError('پاسخ sms.ir: ' . ($data['message'] ?? $code));
    } else {
        throw new CrmError('روش ارسال انتخاب نشده است.');
    }
}

function notify_find_chat(): array {
    $s = notify_settings();
    $ch = $s['channel'];
    if ($ch !== 'bale' && $ch !== 'telegram') throw new CrmError('این کار فقط برای بله و تلگرام است.');
    $updates = notify_bot_call($s, $ch, 'getUpdates', []);
    $chat = null;
    foreach ((array) $updates as $u) { $m = $u['message'] ?? $u['edited_message'] ?? null; if ($m && isset($m['chat'])) $chat = $m['chat']; }
    if (!$chat) throw new CrmError('پیامی پیدا نشد. اول در خود پیام‌رسان به بات‌تان یک پیام (مثلاً «سلام») بدهید و دوباره بزنید.');
    $s[$ch]['chatId'] = (string) $chat['id'];
    $s[$ch]['chatName'] = trim(($chat['first_name'] ?? '') . ' ' . ($chat['last_name'] ?? '')) ?: ($chat['username'] ?? $chat['title'] ?? '');
    kv_set('notify', $s);
    return notify_public();
}

function notify_test(): void {
    notify_deliver('✅ ردیاب وصل شد. یادآوری‌های تماس، بازدید و آگهی‌های جدید اینجا می‌آیند.');
    kv_set('notify_error', null);
}

// ---------- sending with dedupe + quiet hours ----------
function notify_is_quiet(array $s, ?int $t = null): bool {
    $q = $s['quiet'];
    if (!$q['enabled']) return false;
    $h = (int) date('G', intdiv($t ?? now_ms(), 1000));
    return $q['from'] > $q['to'] ? ($h >= $q['from'] || $h < $q['to']) : ($h >= $q['from'] && $h < $q['to']);
}

/** Send once per key; during quiet hours non-urgent messages wait. Returns true if sent. */
function notify_send(string $key, string $text, bool $urgent = false): bool {
    $s = notify_settings();
    if (!notify_ready($s)) return false;
    $sent = kv_get('notify_sent', []);
    if (isset($sent[$key])) return false;
    if (!$urgent && notify_is_quiet($s)) {
        $held = kv_get('notify_held', []);
        $held[$key] = $text;
        kv_set('notify_held', $held);
        return false;
    }
    try {
        notify_deliver($text, $s);
    } catch (Throwable $e) {
        kv_set('notify_error', $e->getMessage());
        return false;
    }
    $now = now_ms();
    $sent[$key] = $now;
    foreach ($sent as $k => $t) if ($t < $now - 14 * 24 * CRM_HOUR) unset($sent[$k]);
    kv_set('notify_sent', $sent);
    kv_set('notify_error', null);
    return true;
}

/** Due calls, visits soon, visits without a result. At most once a minute unless forced. */
function notify_tick(bool $force = false): int {
    $now = now_ms();
    if (!$force && $now - (int) kv_get('tick_at', 0) < 55000) return 0;
    kv_set('tick_at', $now);
    $s = notify_settings();
    if (!notify_ready($s)) return 0;
    $n = 0;
    if (!notify_is_quiet($s)) {
        $held = kv_get('notify_held', []);
        if ($held) {
            kv_set('notify_held', []);
            foreach ($held as $k => $text) if (notify_send((string) $k, $text)) $n++;
        }
    }
    $ev = $s['events'];
    $rows = db()->query('SELECT token, rec FROM radyab_ads')->fetchAll();
    foreach ($rows as $row) {
        $rec = jdec($row['rec']);
        $c = $rec['crm'] ?? null;
        $p = $rec['post'] ?? null;
        if (!$c || !$p || !empty($rec['removed']) || in_array($c['stage'] ?? 'new', ['bought', 'rejected'], true)) continue;
        $token = $row['token'];
        $phone = !empty($c['phone']) ? "\nشماره: {$c['phone']}" : '';
        $link = !empty($p['url']) ? "\n{$p['url']}" : '';
        $next = $c['nextCallAt'] ?? null;
        if ($ev['calls'] && $next && $next <= $now && $now - $next < 12 * CRM_HOUR) {
            $missed = !empty($c['missed']) ? "\n(" . fa_num($c['missed']) . ' بار جواب نداده)' : '';
            if (notify_send("call:$token:$next", "📞 وقت تماس: {$p['title']}\n" . fa_price($p['price'] ?? null) . " تومان$phone$missed$link")) $n++;
        }
        $visitAt = $c['visitAt'] ?? null;
        if ($ev['visits'] && ($c['stage'] ?? '') === 'visit' && $visitAt) {
            $until = $visitAt - $now;
            if ($until > 0 && $until <= CRM_HOUR) {
                $sub = !empty($p['subtitle']) ? "\n{$p['subtitle']}" : '';
                if (notify_send("visit1h:$token:$visitAt", '🚗 بازدید ساعت ' . fa_time((int) $visitAt) . ": {$p['title']}$sub$phone$link", true)) $n++;
            } elseif ($until < -2 * CRM_HOUR && $until > -36 * CRM_HOUR) {
                if (notify_send("visitover:$token:$visitAt", "📝 نتیجهٔ بازدید «{$p['title']}» را در ردیاب ثبت کنید.")) $n++;
            }
        }
    }
    return $n;
}

/** Messages the PC bot hands over (run summary, login/captcha needed). */
function notify_bot_events(array $events): void {
    $s = notify_settings();
    foreach ($events as $e) {
        $kind = (string) ($e['kind'] ?? '');
        if ($kind === 'runs' && !$s['events']['runs']) continue;
        if ($kind === 'needsYou' && !$s['events']['needsYou']) continue;
        if (!empty($e['key']) && !empty($e['text'])) notify_send((string) $e['key'], (string) $e['text'], !empty($e['urgent']));
    }
}
