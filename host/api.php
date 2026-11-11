<?php
/*
 * Radyab online panel — API. Every /api/... address comes here (see .htaccess).
 * The panel (public/) talks to the same addresses as on the PC, so it works unchanged;
 * the PC bot talks to /api/bot/sync with its key.
 */
declare(strict_types=1);
define('RADYAB', true);
require __DIR__ . '/lib/boot.php';
require __DIR__ . '/lib/crm.php';
require __DIR__ . '/lib/notify.php';
require __DIR__ . '/lib/store.php';

$path = '/' . ltrim((string) ($_GET['p'] ?? ''), '/');
if ($path === '/') $path = '/' . ltrim(preg_replace('#^.*?/api/#', '', parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH) ?: ''), '/');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

try {
    radyab_config();

    // ---------- the PC bot ----------
    if ($path === '/bot/sync' && $method === 'POST') {
        require_bot();
        json_out(200, bot_sync(body_json()));
    }

    // ---------- sign-in ----------
    if ($path === '/session') {
        session_start_safe();
        if ($method === 'DELETE') { $_SESSION = []; session_destroy(); json_out(200, ['ok' => true]); }
        if ($method === 'POST') {
            $fail = kv_get('login_fail', ['n' => 0, 'until' => 0]);
            if ($fail['until'] > now_ms()) json_out(429, ['error' => 'چند بار رمز اشتباه وارد شد. چند دقیقه بعد دوباره امتحان کنید.']);
            $b = body_json(10000);
            $auth = kv_get('auth');
            $ok = $auth && hash_equals((string) $auth['user'], (string) ($b['user'] ?? '')) && password_verify((string) ($b['pass'] ?? ''), (string) $auth['hash']);
            if (!$ok) {
                $fail['n']++;
                if ($fail['n'] >= 5) $fail = ['n' => 0, 'until' => now_ms() + 5 * 60000];
                kv_set('login_fail', $fail);
                json_out(401, ['error' => 'نام کاربری یا رمز درست نیست.']);
            }
            kv_set('login_fail', ['n' => 0, 'until' => 0]);
            session_regenerate_id(true);
            $_SESSION['radyab_user'] = $auth['user'];
            json_out(200, ['ok' => true]);
        }
    }

    require_user();
    notify_tick(); // reminders also go out while the panel is open (cron.php does it every minute)
    backup_now(false); // one backup a day

    // ---------- state ----------
    if ($path === '/state' && $method === 'GET') json_out(200, panel_state());

    // ---------- ads + follow-up ----------
    if ($path === '/ads' && $method === 'GET') {
        $since = (int) ($_GET['since'] ?? 0);
        $ver = (int) kv_get('seq', 0);
        if ($since && $since === $ver) json_out(200, ['unchanged' => true, 'version' => $ver]);
        if (function_exists('ob_gzhandler') && !ini_get('zlib.output_compression')) ob_start('ob_gzhandler');
        json_out(200, export_ads() + [
            'stages' => CRM_STAGES, 'activeStages' => CRM_ACTIVE_STAGES, 'rejectReasons' => CRM_REJECT_REASONS, 'callResults' => CRM_CALL_RESULTS,
        ]);
    }
    if (preg_match('#^/ads/([A-Za-z0-9_-]+)/crm$#', $path, $m) && $method === 'POST') {
        $crm = apply_crm($m[1], body_json(100000));
        json_out(200, ['ok' => true, 'version' => (int) kv_get('seq', 0), 'crm' => $crm]);
    }

    // ---------- searches go to the bot through a queue ----------
    if ($path === '/scan' && $method === 'POST') {
        $c = body_json(100000);
        if (trim((string) ($c['query'] ?? '')) === '' && trim((string) ($c['searchUrl'] ?? '')) === '' && empty($c['priceMin']) && empty($c['priceMax'])) {
            json_out(400, ['error' => 'نام خودرو یا محدودهٔ قیمت (یا لینک جستجوی دیوار) را وارد کنید.']);
        }
        $id = queue_add('scan', $c);
        json_out(200, ['queued' => true, 'id' => $id]);
    }
    if ($path === '/scan-batch' && $method === 'POST') {
        $items = body_json(200000)['items'] ?? null;
        if (!is_array($items) || !$items || count($items) > 20) json_out(400, ['error' => 'فهرست جستجو نامعتبر است.']);
        foreach ($items as $c) if (is_array($c)) queue_add('scan', $c);
        json_out(200, ['queued' => true, 'count' => count($items)]);
    }
    // Daily automatic check of a saved search: shown here at once, applied by the bot at its next check-in.
    if ($path === '/search-auto' && $method === 'POST') {
        $b = body_json(10000);
        $key = (string) ($b['key'] ?? '');
        $searches = kv_get('searches', []) ?: [];
        if ($key === '' || !isset($searches[$key])) json_out(404, ['error' => 'این جستجو پیدا نشد']);
        $hour = (int) ($b['hour'] ?? 9);
        $auto = ['on' => !empty($b['on']), 'hour' => ($hour >= 0 && $hour <= 23) ? $hour : 9, 'full' => !empty($b['full'])];
        $searches[$key]['auto'] = $auto;
        kv_set('searches', $searches);
        next_seq();
        queue_add('auto', ['key' => $key] + $auto);
        json_out(200, ['ok' => true, 'auto' => $auto]);
    }
    // Delete a saved search for good: gone here at once, and the bot does the same on the PC.
    if ($path === '/search-delete' && $method === 'POST') {
        $key = (string) (body_json(10000)['key'] ?? '');
        $searches = kv_get('searches', []) ?: [];
        if ($key === '' || !isset($searches[$key])) json_out(404, ['error' => 'این جستجو پیدا نشد']);
        $bot = bot_status();
        if ($bot['online'] && ($bot['state']['busy'] ?? null) && ($bot['state']['busyKey'] ?? null) === $key) {
            json_out(409, ['error' => 'این جستجو الان در حال اجراست؛ اول «پایان» را بزنید.']);
        }
        backup_now(true);
        $r = delete_search($key);
        queue_add('del', ['key' => $key]);
        json_out(200, ['ok' => true] + $r);
    }
    if (preg_match('#^/queue/([a-f0-9]+)$#', $path, $m) && $method === 'DELETE') {
        db()->prepare('DELETE FROM radyab_queue WHERE id = ? AND taken = 0')->execute([$m[1]]);
        json_out(200, ['ok' => true]);
    }
    if (preg_match('#^/runs/([A-Za-z0-9_-]+)$#', $path, $m) && $method === 'GET') {
        $run = load_run($m[1]);
        if (!$run) json_out(404, ['error' => 'not found']);
        json_out(200, public_run($run));
    }
    if (preg_match('#^/runs/([A-Za-z0-9_-]+)/(continue|pause|resume|stop|cancel|focus)$#', $path, $m) && $method === 'POST') {
        if ($m[2] !== 'focus') queue_add('cmd', ['runId' => $m[1], 'action' => $m[2]]);
        json_out(200, ['ok' => true]);
    }
    if ($path === '/login' && $method === 'POST') json_out(200, ['ok' => true]); // Divar sign-in happens on the PC

    // ---------- phone reminders ----------
    if ($path === '/settings/notify' && $method === 'GET') json_out(200, notify_public());
    if ($path === '/settings/notify' && $method === 'POST') json_out(200, notify_update(body_json(100000)));
    if ($path === '/notify/find-chat' && $method === 'POST') json_out(200, notify_find_chat());
    if ($path === '/notify/test' && $method === 'POST') { notify_test(); json_out(200, ['ok' => true]); }

    // ---------- backups ----------
    if ($path === '/backups' && $method === 'GET') json_out(200, ['backups' => backups_list()]);
    if ($path === '/backups' && $method === 'POST') { $name = backup_now(true); json_out(200, ['ok' => true, 'name' => $name, 'backups' => backups_list()]); }
    if ($path === '/backups/restore' && $method === 'POST') json_out(200, ['ok' => true, 'count' => backup_restore(body_json())]);
    if (preg_match('#^/backups/([A-Za-z0-9._-]+)$#', $path, $m) && $method === 'GET') {
        $file = backup_path($m[1]);
        if (!is_file($file)) json_out(404, ['error' => 'not found']);
        header('Content-Type: application/gzip');
        header('Content-Disposition: attachment; filename="' . $m[1] . '"');
        header('Cache-Control: no-store');
        readfile($file);
        exit;
    }

    json_out(404, ['error' => 'not found']);
} catch (CrmError $e) {
    json_out(400, ['error' => $e->getMessage()]);
} catch (Throwable $e) {
    error_log('radyab: ' . $e->getMessage() . ' @' . $e->getFile() . ':' . $e->getLine());
    json_out(500, ['error' => 'خطای سرور. اگر تکرار شد، خبر بدهید.']);
}
