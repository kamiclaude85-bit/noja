<?php
/*
 * Run every minute from the host's cron (cPanel → Cron Jobs):
 *   php /home/USER/radyab.nojakasht.com/cron.php
 * Sends due phone reminders even when nobody has the panel open and the PC is off,
 * and takes the daily backup.
 */
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(403); exit('Forbidden'); }
define('RADYAB', true);
require __DIR__ . '/lib/boot.php';
require __DIR__ . '/lib/crm.php';
require __DIR__ . '/lib/notify.php';
require __DIR__ . '/lib/store.php';

radyab_config();
$sent = notify_tick(true);
backup_now(false);
echo "ok, sent $sent\n";
