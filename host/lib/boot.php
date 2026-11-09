<?php
/*
 * Radyab online panel — shared setup: config, database, JSON helpers, sign-in.
 * Works on PHP 7.4+ with MySQL/MariaDB (host) or SQLite (local tests).
 * Separate database/tables from Noja: nothing here touches Noja's data.
 */
declare(strict_types=1);

if (!defined('RADYAB')) { http_response_code(403); exit('Forbidden'); }

const RADYAB_ROOT = __DIR__ . '/..';
const BOT_ONLINE_SECONDS = 75;          // bot syncs every ~20 s; offline after this long
const RUNS_KEEP = 30;

date_default_timezone_set('Asia/Tehran');

function radyab_configured(): bool { return is_file(RADYAB_ROOT . '/config.php'); }

function radyab_config(): void {
    static $loaded = false;
    if ($loaded) return;
    if (!radyab_configured()) { json_out(503, ['error' => 'ردیاب هنوز راه‌اندازی نشده است.', 'setup' => true]); }
    require RADYAB_ROOT . '/config.php';
    $loaded = true;
}

function db(): PDO {
    static $pdo = null;
    if ($pdo) return $pdo;
    radyab_config();
    if (RADYAB_DB_DRIVER === 'sqlite') {
        $pdo = new PDO('sqlite:' . RADYAB_DB_SQLITE);
        // The panel and the bot's check-ins can write at the same moment: wait instead of failing.
        $pdo->exec('PRAGMA busy_timeout = 8000');
        $pdo->exec('PRAGMA journal_mode = WAL');
    } else {
        $pdo = new PDO('mysql:host=' . RADYAB_DB_HOST . ';dbname=' . RADYAB_DB_NAME . ';charset=utf8mb4', RADYAB_DB_USER, RADYAB_DB_PASS);
    }
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    return $pdo;
}

/** Create the tables (safe to run again). */
function radyab_schema(PDO $pdo, string $driver): void {
    $text = $driver === 'sqlite' ? 'TEXT' : 'LONGTEXT';
    $engine = $driver === 'sqlite' ? '' : ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4';
    $pdo->exec("CREATE TABLE IF NOT EXISTS radyab_kv (k VARCHAR(64) PRIMARY KEY, v $text NOT NULL)$engine");
    // One row per ad: the whole record as JSON; seq = last change (any), crm_seq = last follow-up change.
    $pdo->exec("CREATE TABLE IF NOT EXISTS radyab_ads (token VARCHAR(32) PRIMARY KEY, rec $text NOT NULL, seq BIGINT NOT NULL DEFAULT 0, crm_seq BIGINT NOT NULL DEFAULT 0)$engine");
    $pdo->exec("CREATE TABLE IF NOT EXISTS radyab_runs (id VARCHAR(64) PRIMARY KEY, data $text NOT NULL, summary $text NOT NULL, created BIGINT NOT NULL)$engine");
    $pdo->exec("CREATE TABLE IF NOT EXISTS radyab_queue (id VARCHAR(16) PRIMARY KEY, kind VARCHAR(16) NOT NULL, body $text NOT NULL, created BIGINT NOT NULL, taken BIGINT NOT NULL DEFAULT 0)$engine");
}

// ---------- small helpers ----------
function now_ms(): int { return (int) round(microtime(true) * 1000); }

function json_out(int $code, $body): void {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function body_json(int $limit = 50000000) {
    $raw = file_get_contents('php://input', false, null, 0, $limit);
    if ($raw === '' || $raw === false) return [];
    $j = json_decode($raw, true);
    if (!is_array($j)) json_out(400, ['error' => 'درخواست نامعتبر']);
    return $j;
}

function jenc($v): string { return json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES); }
function jdec(?string $s) { return $s === null ? null : json_decode($s, true); }

function kv_get(string $k, $default = null) {
    $st = db()->prepare('SELECT v FROM radyab_kv WHERE k = ?');
    $st->execute([$k]);
    $v = $st->fetchColumn();
    return $v === false ? $default : jdec($v);
}

function kv_set(string $k, $v): void {
    db()->prepare('REPLACE INTO radyab_kv (k, v) VALUES (?, ?)')->execute([$k, jenc($v)]);
}

/** Global change counter (the panel asks «anything new since version X?»). */
function next_seq(): int {
    $n = (int) kv_get('seq', 0) + 1;
    kv_set('seq', $n);
    return $n;
}

function rand_id(int $bytes = 6): string { return bin2hex(random_bytes($bytes)); }

// ---------- sign-in (one user; password chosen by the owner in setup.php) ----------
function session_start_safe(): void {
    if (session_status() === PHP_SESSION_ACTIVE) return;
    session_name('radyab_s');
    session_set_cookie_params([
        'lifetime' => 60 * 60 * 24 * 60, 'path' => '/', 'httponly' => true, 'samesite' => 'Lax',
        'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
    ]);
    ini_set('session.gc_maxlifetime', (string) (60 * 60 * 24 * 60));
    session_start();
}

function require_user(): void {
    session_start_safe();
    if (empty($_SESSION['radyab_user'])) json_out(401, ['error' => 'وارد نشده‌اید']);
    session_write_close();
}

/** The PC bot authenticates with the key shown at setup (header X-Radyab-Key). */
function require_bot(): void {
    radyab_config();
    $key = $_SERVER['HTTP_X_RADYAB_KEY'] ?? '';
    if (!is_string($key) || $key === '' || !hash_equals(RADYAB_BOT_KEY, $key)) json_out(403, ['error' => 'کلید ربات درست نیست.']);
}
