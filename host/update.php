<?php
/*
 * Radyab online panel — update from inside the panel (like Noja's self-update).
 *
 *   GET  update.php?action=info      current version, recent updates, backups, a form token
 *   POST update.php action=apply     upload radyab-update.zip: checked, the files it replaces are
 *                                    backed up to data/update_backups/backup_…, then installed
 *   POST update.php action=rollback  put back the files of one backup
 *
 * Deliberately self-contained (it does not load lib/), so it keeps working even if an update
 * breaks the rest of the panel: the owner can always roll back from here.
 * Never touches config.php or data/. Only signed-in users; every POST needs the form token.
 */
declare(strict_types=1);

const UPD_ROOT = __DIR__;
const UPD_BACKUPS = __DIR__ . '/data/update_backups';
const UPD_KEEP = 10;
const UPD_EXT = ['php', 'js', 'css', 'html', 'json', 'png', 'svg', 'ico', 'woff2', 'txt', 'md', 'htaccess'];
const UPD_BLOCKED_NAMES = ['config.php'];
const UPD_BLOCKED_DIRS = ['data'];

function upd_out(int $code, array $body): void {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

// ---- signed in? (same session as the panel) ----
session_name('radyab_s');
session_set_cookie_params(['path' => '/', 'httponly' => true, 'samesite' => 'Lax', 'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off']);
session_start();
if (empty($_SESSION['radyab_user'])) upd_out(401, ['error' => 'وارد نشده‌اید']);
if (empty($_SESSION['radyab_csrf'])) $_SESSION['radyab_csrf'] = bin2hex(random_bytes(16));
$token = $_SESSION['radyab_csrf'];
$user = (string) $_SESSION['radyab_user'];
session_write_close();

$action = (string) ($_REQUEST['action'] ?? 'info');
if ($_SERVER['REQUEST_METHOD'] === 'POST' && !hash_equals($token, (string) ($_POST['token'] ?? ''))) {
    upd_out(403, ['error' => 'صفحه را تازه کنید و دوباره امتحان کنید.']);
}

function upd_version(): array {
    $v = @json_decode((string) @file_get_contents(UPD_ROOT . '/version.json'), true);
    return is_array($v) ? $v : ['version' => 'نامشخص'];
}

function upd_log(): array {
    $l = @json_decode((string) @file_get_contents(UPD_BACKUPS . '/log.json'), true);
    return is_array($l) ? $l : [];
}

function upd_log_add(array $entry): void {
    $log = upd_log();
    $log[] = $entry;
    @file_put_contents(UPD_BACKUPS . '/log.json', json_encode(array_slice($log, -50), JSON_UNESCAPED_UNICODE));
}

/** A path from the package, cleaned; null when it must not be installed. */
function upd_path_ok(string $name): ?string {
    $p = str_replace('\\', '/', $name);
    $p = preg_replace('#^\./#', '', $p);
    if ($p === '' || substr($p, -1) === '/') return null;                // directories
    if ($p[0] === '/' || strpos($p, '..') !== false || strpos($p, ':') !== false) return null;
    $parts = explode('/', $p);
    if (in_array($parts[0], UPD_BLOCKED_DIRS, true)) return null;        // data/ is yours
    if (in_array(basename($p), UPD_BLOCKED_NAMES, true)) return null;     // config.php is yours
    $base = basename($p);
    $ext = $base === '.htaccess' ? 'htaccess' : strtolower(pathinfo($base, PATHINFO_EXTENSION));
    if (!in_array($ext, UPD_EXT, true)) return null;
    return $p;
}

function upd_backups(): array {
    $out = [];
    foreach (glob(UPD_BACKUPS . '/backup_*', GLOB_ONLYDIR) ?: [] as $d) {
        $meta = @json_decode((string) @file_get_contents($d . '/.meta.json'), true) ?: [];
        $out[] = ['id' => basename($d), 'at' => $meta['at'] ?? null, 'from' => $meta['from'] ?? null, 'to' => $meta['to'] ?? null, 'files' => $meta['files'] ?? null];
    }
    usort($out, function ($a, $b) { return strcmp($b['id'], $a['id']); });
    return $out;
}

if ($action === 'info') {
    upd_out(200, ['version' => upd_version(), 'token' => $token, 'backups' => upd_backups(), 'log' => array_slice(array_reverse(upd_log()), 0, 10), 'zip' => class_exists('ZipArchive'),
        'maxUpload' => ini_get('upload_max_filesize')]);
}

if (!is_dir(UPD_BACKUPS)) @mkdir(UPD_BACKUPS, 0750, true);

// ---------- install an update ----------
if ($action === 'apply' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    if (!class_exists('ZipArchive')) upd_out(500, ['error' => 'افزونهٔ Zip روی این هاست فعال نیست؛ از پشتیبانی هاست بخواهید فعالش کنند.']);
    $f = $_FILES['pkg'] ?? null;
    if (!$f || ($f['error'] ?? 1) !== UPLOAD_ERR_OK || !is_uploaded_file($f['tmp_name'])) upd_out(400, ['error' => 'فایل به‌روزرسانی نرسید (شاید حجمش زیاد است).']);
    $zip = new ZipArchive();
    if ($zip->open($f['tmp_name']) !== true) upd_out(400, ['error' => 'این فایل zip سالم نیست.']);
    // It must be a Radyab update: version.json inside, with app = radyab.
    $manifest = json_decode((string) $zip->getFromName('version.json'), true);
    if (!is_array($manifest) || ($manifest['app'] ?? '') !== 'radyab') { $zip->close(); upd_out(400, ['error' => 'این فایل بستهٔ به‌روزرسانی ردیاب نیست.']); }
    foreach (['api.php', 'index.html', 'lib/boot.php'] as $must) {
        if ($zip->locateName($must) === false) { $zip->close(); upd_out(400, ['error' => "بسته ناقص است ($must ندارد)."]); }
    }
    $files = [];
    $skipped = 0;
    for ($i = 0; $i < $zip->numFiles; $i++) {
        $name = (string) $zip->getNameIndex($i);
        $p = upd_path_ok($name);
        if ($p === null) { if (substr($name, -1) !== '/') $skipped++; continue; }
        $files[$p] = $i;
    }
    // 1) back up every file this update replaces (and list the new ones, so rollback removes them)
    $from = upd_version()['version'] ?? '';
    $id = 'backup_' . date('Ymd_His');
    $dir = UPD_BACKUPS . '/' . $id;
    @mkdir($dir, 0750, true);
    $added = [];
    foreach (array_keys($files) as $p) {
        $cur = UPD_ROOT . '/' . $p;
        if (is_file($cur)) {
            @mkdir(dirname($dir . '/' . $p), 0750, true);
            if (!copy($cur, $dir . '/' . $p)) { $zip->close(); upd_out(500, ['error' => "پشتیبان‌گیری از $p ممکن نشد؛ چیزی نصب نشد."]); }
        } else {
            $added[] = $p;
        }
    }
    file_put_contents($dir . '/.meta.json', json_encode(['at' => date('c'), 'from' => $from, 'to' => $manifest['version'] ?? '', 'files' => count($files), 'added' => $added, 'by' => $user], JSON_UNESCAPED_UNICODE));
    // 2) write the new files (each to a temp file first, then renamed into place)
    $applied = 0;
    $failed = [];
    foreach ($files as $p => $i) {
        $data = $zip->getFromIndex($i);
        $dest = UPD_ROOT . '/' . $p;
        if ($data === false) { $failed[] = $p; continue; }
        if (!is_dir(dirname($dest))) @mkdir(dirname($dest), 0755, true);
        $tmp = $dest . '.upd-' . bin2hex(random_bytes(3));
        if (file_put_contents($tmp, $data) === false) { @unlink($tmp); $failed[] = $p; continue; }
        // Rename into place; where the file is in use (Windows), copy its content over instead.
        if (!@rename($tmp, $dest)) {
            $ok = @copy($tmp, $dest);
            @unlink($tmp);
            if (!$ok) { $failed[] = $p; continue; }
        }
        $applied++;
    }
    $zip->close();
    // 3) keep the last few backups
    $all = glob(UPD_BACKUPS . '/backup_*', GLOB_ONLYDIR) ?: [];
    sort($all);
    while (count($all) > UPD_KEEP) {
        $old = array_shift($all);
        $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($old, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($it as $x) $x->isDir() ? @rmdir($x->getPathname()) : @unlink($x->getPathname());
        @rmdir($old);
    }
    upd_log_add(['type' => 'apply', 'at' => date('c'), 'from' => $from, 'to' => $manifest['version'] ?? '', 'applied' => $applied, 'failed' => $failed, 'skipped' => $skipped, 'backup' => $id, 'by' => $user]);
    upd_out($failed ? 500 : 200, ['ok' => !$failed, 'applied' => $applied, 'failed' => $failed, 'skipped' => $skipped, 'backup' => $id, 'version' => $manifest['version'] ?? '',
        'error' => $failed ? 'بعضی فایل‌ها نوشته نشدند؛ با «بازگشت» نسخهٔ قبل را برگردانید.' : null]);
}

// ---------- put an earlier version back ----------
if ($action === 'rollback' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $id = preg_replace('/[^a-zA-Z0-9_]/', '', (string) ($_POST['backup'] ?? ''));
    $dir = UPD_BACKUPS . '/' . $id;
    if ($id === '' || strpos($id, 'backup_') !== 0 || !is_dir($dir)) upd_out(404, ['error' => 'این پشتیبان پیدا نشد.']);
    $meta = @json_decode((string) @file_get_contents($dir . '/.meta.json'), true) ?: [];
    $restored = 0;
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS));
    foreach ($it as $file) {
        $rel = str_replace('\\', '/', substr($file->getPathname(), strlen($dir) + 1));
        if ($rel === '.meta.json' || upd_path_ok($rel) === null) continue;
        $dest = UPD_ROOT . '/' . $rel;
        if (!is_dir(dirname($dest))) @mkdir(dirname($dest), 0755, true);
        if (copy($file->getPathname(), $dest)) $restored++;
    }
    // files that update added are removed again
    foreach ((array) ($meta['added'] ?? []) as $p) if (upd_path_ok((string) $p) !== null) @unlink(UPD_ROOT . '/' . $p);
    upd_log_add(['type' => 'rollback', 'at' => date('c'), 'to' => $meta['from'] ?? '', 'backup' => $id, 'restored' => $restored, 'by' => $user]);
    upd_out(200, ['ok' => true, 'restored' => $restored, 'version' => $meta['from'] ?? '']);
}

upd_out(404, ['error' => 'not found']);
