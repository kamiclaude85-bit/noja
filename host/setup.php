<?php
/*
 * One-time setup of the Radyab online panel.
 * You enter the database you made in the host's control panel and choose the panel's
 * username and password. This writes config.php, creates the tables, and shows the key
 * the PC bot needs. Once config.php exists this page does nothing.
 */
declare(strict_types=1);
define('RADYAB', true);
require __DIR__ . '/lib/boot.php';

$done = radyab_configured();
$error = '';
$botKey = '';
$isLocal = in_array($_SERVER['REMOTE_ADDR'] ?? '', ['127.0.0.1', '::1'], true);

if (!$done && ($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    $f = function ($k) { return trim((string) ($_POST[$k] ?? '')); };
    // Built-in database (a file in the protected data/ folder) unless a MySQL database is given.
    $driver = $f('db_name') !== '' ? 'mysql' : 'sqlite';
    try {
        if ($f('user') === '' || mb_strlen($_POST['pass'] ?? '') < 8) throw new Exception('نام کاربری را بنویسید و رمزی با دست‌کم ۸ حرف انتخاب کنید.');
        if (($_POST['pass'] ?? '') !== ($_POST['pass2'] ?? '')) throw new Exception('دو رمز یکی نیستند.');
        if ($driver === 'mysql') {
            if ($f('db_name') === '' || $f('db_user') === '') throw new Exception('نام دیتابیس و کاربر دیتابیس را بنویسید.');
            $pdo = new PDO('mysql:host=localhost;dbname=' . $f('db_name') . ';charset=utf8mb4', $f('db_user'), (string) ($_POST['db_pass'] ?? ''));
        } else {
            @mkdir(__DIR__ . '/data', 0750, true);
            $pdo = new PDO('sqlite:' . __DIR__ . '/data/radyab.sqlite');
        }
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        radyab_schema($pdo, $driver);

        $botKey = 'rk_' . bin2hex(random_bytes(20));
        $q = function ($s) { return var_export((string) $s, true); };
        $cfg = "<?php\n// Radyab online panel settings — written by setup.php. Keep this file private.\n"
            . 'const RADYAB_DB_DRIVER = ' . $q($driver) . ";\n"
            . "const RADYAB_DB_HOST = 'localhost';\n"
            . 'const RADYAB_DB_NAME = ' . $q($f('db_name')) . ";\n"
            . 'const RADYAB_DB_USER = ' . $q($f('db_user')) . ";\n"
            . 'const RADYAB_DB_PASS = ' . $q($_POST['db_pass'] ?? '') . ";\n"
            . "const RADYAB_DB_SQLITE = __DIR__ . '/data/radyab.sqlite';\n"
            . '// The PC bot uses this key to connect (Radyab on the PC → «پنل آنلاین»).' . "\n"
            . 'const RADYAB_BOT_KEY = ' . $q($botKey) . ";\n";
        $st = $pdo->prepare('REPLACE INTO radyab_kv (k, v) VALUES (?, ?)');
        $st->execute(['auth', jenc(['user' => $f('user'), 'hash' => password_hash((string) $_POST['pass'], PASSWORD_DEFAULT)])]);
        if (file_put_contents(__DIR__ . '/config.php', $cfg) === false) throw new Exception('نوشتن config.php ممکن نشد (اجازهٔ نوشتن در پوشه را بررسی کنید).');
        @chmod(__DIR__ . '/config.php', 0640);
        $done = true;
    } catch (Throwable $e) {
        $error = $e instanceof PDOException ? 'اتصال به دیتابیس نشد: نام دیتابیس، کاربر یا رمز را بررسی کنید.' : $e->getMessage();
        $botKey = '';
    }
}
$h = function ($s) { return htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8'); };
$url = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off' ? 'https' : 'http') . '://' . ($_SERVER['HTTP_HOST'] ?? '') . rtrim(dirname($_SERVER['SCRIPT_NAME'] ?? '/'), '/\\') . '/';
?><!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>راه‌اندازی ردیاب</title><link rel="stylesheet" href="fonts/fonts.css"><link rel="stylesheet" href="app.css">
<style>
body{background:var(--surface)} .wrap{max-width:420px;margin:0 auto;padding:32px 16px 48px;display:flex;flex-direction:column;gap:14px}
h1{margin:0;text-align:center;color:var(--primary);font-size:24px} h2{font-size:15px;margin:12px 0 0;color:var(--text-2)}
.key{direction:ltr;font-family:monospace;background:var(--surface-2);border-radius:10px;padding:12px;word-break:break-all;user-select:all}
.muted{color:var(--text-3);font-size:13.5px;line-height:1.8} .center{text-align:center}
</style></head><body><div class="wrap">
<img class="center" src="icons/icon48.png" alt="" width="48" height="48" style="align-self:center;border-radius:12px">
<h1>راه‌اندازی ردیاب</h1>
<?php if ($botKey): ?>
  <p class="center">راه‌اندازی تمام شد.</p>
  <h2>این دو را در ردیابِ روی کامپیوتر بگذارید («پنل آنلاین»):</h2>
  <div class="field"><span>نشانی</span><div class="key"><?= $h($url) ?></div></div>
  <div class="field"><span>کلید ربات</span><div class="key"><?= $h($botKey) ?></div></div>
  <p class="muted">کلید را جایی نفرستید. این صفحه دیگر نشان داده نمی‌شود؛ اگر کلید گم شد، در فایل config.php روی هاست هست.</p>
  <a class="btn primary lg" href="./">رفتن به پنل</a>
<?php elseif ($done): ?>
  <p class="center muted">ردیاب قبلاً راه‌اندازی شده است.</p>
  <a class="btn primary lg" href="./">رفتن به پنل</a>
<?php else: ?>
  <form method="post" style="display:flex;flex-direction:column;gap:14px" autocomplete="off">
    <h2>نام کاربری و رمز پنل را انتخاب کنید</h2>
    <label class="field"><span>نام کاربری</span><input name="user" dir="ltr" autocomplete="username" value="<?= $h($_POST['user'] ?? '') ?>"></label>
    <label class="field"><span>رمز (دست‌کم ۸ حرف)</span><input name="pass" type="password" dir="ltr" autocomplete="new-password"></label>
    <label class="field"><span>تکرار رمز</span><input name="pass2" type="password" dir="ltr" autocomplete="new-password"></label>
    <details>
      <summary class="muted">دیتابیس MySQL جدا (اختیاری)</summary>
      <div style="display:flex;flex-direction:column;gap:14px;margin-top:12px">
        <label class="field"><span>نام دیتابیس</span><input name="db_name" dir="ltr" value="<?= $h($_POST['db_name'] ?? '') ?>"></label>
        <label class="field"><span>کاربر دیتابیس</span><input name="db_user" dir="ltr" value="<?= $h($_POST['db_user'] ?? '') ?>"></label>
        <label class="field"><span>رمز دیتابیس</span><input name="db_pass" type="password" dir="ltr"></label>
      </div>
    </details>
    <?php if ($error): ?><p class="form-error" role="alert"><?= $h($error) ?></p><?php endif; ?>
    <button class="btn primary lg" type="submit">راه‌اندازی</button>
  </form>
<?php endif; ?>
</div></body></html>
