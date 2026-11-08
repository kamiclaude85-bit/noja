#!/usr/bin/env node
/*
 * Build the online-panel package for the host:
 *   dist/radyab-host/        the files to put on radyab.nojakasht.com
 *   dist/radyab-host.zip     the same, zipped for upload in the host's File Manager
 * The panel files (public/) are the same ones the PC uses.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'radyab-host');

fs.rmSync(path.join(ROOT, 'dist'), { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// Panel
fs.cpSync(path.join(ROOT, 'public'), OUT, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'src', 'parser.js'), path.join(OUT, 'parser.js'));
fs.copyFileSync(path.join(ROOT, 'src', 'deals.js'), path.join(OUT, 'deals.js'));
// Server side
for (const f of ['api.php', 'setup.php', 'cron.php', '.htaccess']) fs.copyFileSync(path.join(ROOT, 'host', f), path.join(OUT, f));
fs.cpSync(path.join(ROOT, 'host', 'lib'), path.join(OUT, 'lib'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'data'));
fs.copyFileSync(path.join(ROOT, 'host', 'lib', '.htaccess'), path.join(OUT, 'data', '.htaccess'));

const zip = path.join(ROOT, 'dist', 'radyab-host.zip');
if (process.platform === 'win32') {
  // Windows' own tar writes .zip files (-a picks the format from the name).
  execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', zip, '-C', OUT, '.'], { stdio: 'inherit' });
} else {
  execFileSync('zip', ['-qr', zip, '.'], { cwd: OUT, stdio: 'inherit' });
}
console.log(`built ${path.relative(ROOT, OUT)} and ${path.relative(ROOT, zip)}`);
