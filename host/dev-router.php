<?php
// Local testing only (PHP's built-in server ignores .htaccess). Not part of the host package.
//   php -S 127.0.0.1:8130 -t dist/radyab-host host/dev-router.php
$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (preg_match('#^/api/(.*)$#', $uri, $m)) { $_GET['p'] = $m[1]; require $_SERVER['DOCUMENT_ROOT'] . '/api.php'; return true; }
if (preg_match('#^/(lib|data)(/|$)|^/(config|cron)\.php$#', $uri)) { http_response_code(403); echo 'Forbidden'; return true; }
return false;
