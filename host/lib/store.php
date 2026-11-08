<?php
/*
 * Storage on the host: ads with their follow-up, saved searches, bot runs, the queue of
 * searches/commands for the bot, the bot's heartbeat, and daily backups.
 *
 * Who owns what: the PC bot owns what it reads on Divar (post, removed, price history…).
 * Follow-up (crm) can be changed on both sides; the newer change wins (crm.updatedAt).
 */
declare(strict_types=1);

if (!defined('RADYAB')) { http_response_code(403); exit('Forbidden'); }

const BOT_FIELDS = ['post', 'removed', 'firstSeenAt', 'lastReadAt', 'priceHistory'];

function load_ad(string $token): ?array {
    $st = db()->prepare('SELECT rec FROM radyab_ads WHERE token = ?');
    $st->execute([$token]);
    $v = $st->fetchColumn();
    return $v === false ? null : jdec($v);
}

function save_ad(string $token, array $rec, int $seq, bool $crmChanged): void {
    if ($crmChanged) {
        db()->prepare('REPLACE INTO radyab_ads (token, rec, seq, crm_seq) VALUES (?, ?, ?, ?)')->execute([$token, jenc($rec), $seq, $seq]);
        return;
    }
    $st = db()->prepare('UPDATE radyab_ads SET rec = ?, seq = ? WHERE token = ?');
    $st->execute([jenc($rec), $seq, $token]);
    if ($st->rowCount() === 0) db()->prepare('INSERT INTO radyab_ads (token, rec, seq, crm_seq) VALUES (?, ?, ?, 0)')->execute([$token, jenc($rec), $seq]);
}

function apply_crm(string $token, array $body): array {
    $rec = load_ad($token);
    if (!$rec || empty($rec['post'])) throw new CrmError('آگهی پیدا نشد');
    crm_apply($rec, $body);
    save_ad($token, $rec, next_seq(), true);
    return $rec['crm'];
}

/** Everything the panel needs, in the same shape as the PC (src/store.js exportAds). */
function export_ads(): array {
    $searches = kv_get('searches', []) ?: [];
    $bySearch = [];
    foreach ($searches as $key => $s) foreach (($s['tokens'] ?? []) as $t) $bySearch[$t][] = (string) $key;
    $ads = [];
    foreach (db()->query('SELECT token, rec FROM radyab_ads')->fetchAll() as $row) {
        $rec = jdec($row['rec']);
        if (empty($rec['post'])) continue;
        $t = $row['token'];
        $ads[] = [
            'token' => $t, 'post' => $rec['post'], 'crm' => $rec['crm'] ?? null, 'removed' => $rec['removed'] ?? null,
            'firstSeenAt' => $rec['firstSeenAt'] ?? null, 'lastReadAt' => $rec['lastReadAt'] ?? null,
            'priceHistory' => $rec['priceHistory'] ?? [], 'searches' => $bySearch[$t] ?? [],
        ];
    }
    $list = [];
    foreach ($searches as $key => $s) {
        $list[] = ['key' => (string) $key, 'criteria' => $s['criteria'] ?? null, 'lastRunAt' => $s['lastRunAt'] ?? null,
            'createdAt' => $s['createdAt'] ?? null, 'count' => count($s['tokens'] ?? [])];
    }
    return ['version' => (int) kv_get('seq', 0), 'ads' => $ads, 'searches' => $list];
}

// ---------- bot runs ----------
function save_run(array $run): void {
    if (empty($run['id']) || !preg_match('/^[A-Za-z0-9_-]{1,64}$/', (string) $run['id'])) return;
    $summary = [
        'id' => $run['id'], 'createdAt' => $run['createdAt'] ?? 0, 'status' => $run['status'] ?? '', 'criteria' => $run['criteria'] ?? null,
        'found' => count($run['items'] ?? []), 'read' => count($run['posts'] ?? []),
        'newCount' => isset($run['stats']['newAds']) ? $run['stats']['newAds'] : null,
    ];
    db()->prepare('REPLACE INTO radyab_runs (id, data, summary, created) VALUES (?, ?, ?, ?)')
        ->execute([$run['id'], jenc($run), jenc($summary), (int) ($run['createdAt'] ?? 0)]);
}

function list_runs(): array {
    $rows = db()->query('SELECT id, summary FROM radyab_runs ORDER BY created DESC')->fetchAll();
    $out = [];
    foreach ($rows as $i => $r) {
        if ($i >= RUNS_KEEP) { db()->prepare('DELETE FROM radyab_runs WHERE id = ?')->execute([$r['id']]); continue; }
        $out[] = jdec($r['summary']);
    }
    return $out;
}

function load_run(string $id): ?array {
    $st = db()->prepare('SELECT data FROM radyab_runs WHERE id = ?');
    $st->execute([$id]);
    $v = $st->fetchColumn();
    return $v === false ? null : jdec($v);
}

/** A saved run shows each ad as it is remembered now, keeping that run's own order/«جدید»/price change. */
function public_run(array $run): array {
    $posts = array_values((array) ($run['posts'] ?? []));
    $tokens = array_values(array_filter(array_map(function ($p) { return $p['token'] ?? null; }, $posts)));
    $latest = [];
    if ($tokens) {
        $st = db()->prepare('SELECT token, rec FROM radyab_ads WHERE token IN (' . implode(',', array_fill(0, count($tokens), '?')) . ')');
        $st->execute($tokens);
        foreach ($st->fetchAll() as $r) { $rec = jdec($r['rec']); if (!empty($rec['post'])) $latest[$r['token']] = $rec['post']; }
    }
    $out = [];
    foreach ($posts as $p) {
        $t = $p['token'] ?? null;
        if ($t && isset($latest[$t])) {
            $keep = [];
            foreach (['order', 'isNew', 'priceChange', 'removed', 'firstSeenAt'] as $k) $keep[$k] = $p[$k] ?? null;
            $p = array_merge($latest[$t], $keep);
        }
        $out[] = $p;
    }
    $f = function ($k, $d = null) use ($run) { return $run[$k] ?? $d; };
    return [
        'id' => $run['id'], 'createdAt' => $f('createdAt'), 'finishedAt' => $f('finishedAt'), 'criteria' => $f('criteria'),
        'status' => $f('status'), 'message' => $f('message'), 'activity' => $f('activity', ''), 'waitUntil' => $f('waitUntil'),
        'stats' => $f('stats'), 'toVisit' => $f('toVisit'), 'collectStop' => $f('collectStop'), 'sourceUrl' => $f('sourceUrl'),
        'items' => $f('items', []), 'posts' => $out, 'errors' => $f('errors', new stdClass()),
    ];
}

// ---------- queue for the bot ----------
function queue_add(string $kind, array $body): string {
    $id = rand_id(4);
    db()->prepare('INSERT INTO radyab_queue (id, kind, body, created, taken) VALUES (?, ?, ?, ?, 0)')->execute([$id, $kind, jenc($body), now_ms()]);
    return $id;
}

function bot_status(): array {
    $bot = kv_get('bot', []) ?: [];
    $last = (int) ($bot['lastSeenAt'] ?? 0);
    return ['online' => $last && now_ms() - $last < BOT_ONLINE_SECONDS * 1000, 'lastSeenAt' => $last ?: null, 'state' => $bot['state'] ?? []];
}

function panel_state(): array {
    $b = bot_status();
    $st = $b['state'];
    $queue = [];
    foreach (db()->query("SELECT id, body, created FROM radyab_queue WHERE kind = 'scan' AND taken = 0 ORDER BY created")->fetchAll() as $q) {
        $queue[] = ['id' => $q['id'], 'createdAt' => (int) $q['created'], 'criteria' => jdec($q['body'])];
    }
    return [
        'mode' => 'host',
        'bot' => ['online' => $b['online'], 'lastSeenAt' => $b['lastSeenAt']],
        'queue' => $queue,
        'busy' => $b['online'] ? ($st['busy'] ?? null) : null,
        'loggedIn' => $st['loggedIn'] ?? null,
        'today' => (int) ($st['today'] ?? 0),
        'dailyLimit' => (int) ($st['dailyLimit'] ?? 300),
        'runs' => list_runs(),
    ];
}

/**
 * The PC bot checks in (every ~20 s): it sends what changed on its side and gets back
 * follow-up changes made in the online panel, plus queued searches and run commands.
 */
function bot_sync(array $in): array {
    $pdo = db();
    $now = now_ms();
    kv_set('bot', ['lastSeenAt' => $now, 'state' => is_array($in['state'] ?? null) ? $in['state'] : []]);

    $accepted = 0;
    if (!empty($in['ads']) && is_array($in['ads'])) {
        $pdo->beginTransaction();
        $seq = next_seq();
        foreach ($in['ads'] as $a) {
            $t = (string) ($a['token'] ?? '');
            if (!preg_match('/^[A-Za-z0-9_-]{4,32}$/', $t)) continue;
            $rec = load_ad($t) ?? [];
            foreach (BOT_FIELDS as $k) {
                if (!array_key_exists($k, $a)) continue;
                if ($a[$k] === null) unset($rec[$k]); else $rec[$k] = $a[$k];
            }
            $crmChanged = false;
            if (!empty($a['crm']) && is_array($a['crm'])) {
                $mine = (int) ($rec['crm']['updatedAt'] ?? 0);
                $theirs = (int) ($a['crm']['updatedAt'] ?? 0);
                if (empty($rec['crm']) || $theirs > $mine) { $rec['crm'] = $a['crm']; $crmChanged = true; }
            }
            save_ad($t, $rec, $seq, $crmChanged);
            $accepted++;
        }
        $pdo->commit();
    }
    if (isset($in['searches']) && is_array($in['searches'])) { kv_set('searches', $in['searches']); next_seq(); }
    foreach ((array) ($in['runs'] ?? []) as $run) if (is_array($run)) save_run($run);
    if (!empty($in['events']) && is_array($in['events'])) notify_bot_events($in['events']);

    // Follow-up changes since the bot's last check.
    $since = (int) ($in['since'] ?? 0);
    $crm = [];
    $st = $pdo->prepare('SELECT token, rec FROM radyab_ads WHERE crm_seq > ?');
    $st->execute([$since]);
    foreach ($st->fetchAll() as $r) { $rec = jdec($r['rec']); if (!empty($rec['crm'])) $crm[] = ['token' => $r['token'], 'crm' => $rec['crm']]; }

    // Hand over queued searches and commands (each one only once).
    $queue = [];
    foreach ($pdo->query('SELECT id, kind, body, created FROM radyab_queue WHERE taken = 0 ORDER BY created')->fetchAll() as $q) {
        $queue[] = ['id' => $q['id'], 'kind' => $q['kind'], 'body' => jdec($q['body']), 'createdAt' => (int) $q['created']];
    }
    if ($queue) $pdo->prepare('UPDATE radyab_queue SET taken = ? WHERE taken = 0')->execute([$now]);
    $pdo->prepare('DELETE FROM radyab_queue WHERE taken > 0 AND taken < ?')->execute([$now - 7 * 24 * CRM_HOUR]);

    notify_tick();
    backup_now(false);
    return ['ok' => true, 'accepted' => $accepted, 'cursor' => (int) kv_get('seq', 0), 'crm' => $crm, 'queue' => $queue];
}

// ---------- backups (one per day, kept 30 days; outside the web via .htaccess) ----------
function backup_dir(): string {
    $d = RADYAB_ROOT . '/data/backups';
    if (!is_dir($d)) @mkdir($d, 0750, true);
    return $d;
}

function backup_path(string $name): string {
    if (!preg_match('/^radyab-\d{4}-\d{2}-\d{2}(-\d+)?\.json\.gz$/', $name)) throw new CrmError('نام پشتیبان نامعتبر');
    return backup_dir() . '/' . $name;
}

function backups_list(): array {
    $out = [];
    foreach (glob(backup_dir() . '/radyab-*.json.gz') ?: [] as $f) $out[] = ['name' => basename($f), 'size' => filesize($f), 't' => filemtime($f) * 1000];
    usort($out, function ($a, $b) { return $b['t'] <=> $a['t'] ?: strcmp($b['name'], $a['name']); });
    return $out;
}

function backup_now(bool $force): ?string {
    $name = 'radyab-' . date('Y-m-d') . '.json.gz';
    if (is_file(backup_dir() . "/$name")) {
        if (!$force) return null;
        $name = 'radyab-' . date('Y-m-d') . '-' . (now_ms() % 100000) . '.json.gz';
    }
    $ads = [];
    foreach (db()->query('SELECT token, rec FROM radyab_ads')->fetchAll() as $r) $ads[$r['token']] = jdec($r['rec']);
    $payload = ['app' => 'radyab', 'kind' => 'backup', 'createdAt' => now_ms(), 'db' => ['ads' => $ads ?: new stdClass(), 'searches' => kv_get('searches', []) ?: new stdClass()]];
    file_put_contents(backup_dir() . "/$name", gzencode(jenc($payload), 6));
    foreach (array_slice(backups_list(), 30) as $old) @unlink(backup_dir() . '/' . $old['name']);
    return $name;
}

function backup_restore(array $obj): int {
    $db = $obj['db'] ?? null;
    if (!is_array($db) || !isset($db['ads']) || !is_array($db['ads']) || !isset($db['searches']) || !is_array($db['searches'])) {
        throw new CrmError('این فایل پشتیبان ردیاب نیست');
    }
    backup_now(true);
    $pdo = db();
    $pdo->beginTransaction();
    $pdo->exec('DELETE FROM radyab_ads');
    $seq = next_seq();
    $n = 0;
    foreach ($db['ads'] as $t => $rec) {
        if (!preg_match('/^[A-Za-z0-9_-]{4,32}$/', (string) $t) || !is_array($rec)) continue;
        save_ad((string) $t, $rec, $seq, true);
        $n++;
    }
    kv_set('searches', $db['searches']);
    $pdo->commit();
    return $n;
}
