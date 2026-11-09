#!/usr/bin/env node
/*
 * Build the online-panel packages for the host:
 *   dist/radyab-host/        the files to put on radyab.nojakasht.com
 *   dist/radyab-host.zip     first install (cPanel → File Manager → Extract)
 *   dist/ردیاب-آپدیت.zip      later updates, from inside the panel («پشتیبان» → «به‌روزرسانی ردیاب»)
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
for (const f of ['api.php', 'setup.php', 'cron.php', 'update.php', '.htaccess']) fs.copyFileSync(path.join(ROOT, 'host', f), path.join(OUT, f));
fs.cpSync(path.join(ROOT, 'host', 'lib'), path.join(OUT, 'lib'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'data'));
fs.copyFileSync(path.join(ROOT, 'host', 'lib', '.htaccess'), path.join(OUT, 'data', '.htaccess'));

// Version: shown in the panel («به‌روزرسانی ردیاب») and checked by update.php.
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
let commit = '';
try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim(); } catch (_) { /* no git */ }
const now = new Date();
const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
const version = `${pkg.version}-${stamp}`;
fs.writeFileSync(path.join(OUT, 'version.json'), JSON.stringify({ app: 'radyab', version, commit, builtAt: now.getTime() }, null, 2));

/** Zip a folder with plain names (api.php, lib/boot.php …), not «./api.php». */
function zipDir(dir, zipFile, skip = []) {
  const entries = fs.readdirSync(dir).filter((n) => !skip.includes(n));
  if (process.platform === 'win32') {
    // Windows' own tar writes .zip files (-a picks the format from the name).
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tar, ['-a', '-c', '-f', zipFile, '-C', dir, ...entries], { stdio: 'inherit' });
  } else {
    execFileSync('zip', ['-qr', zipFile, ...entries], { cwd: dir, stdio: 'inherit' });
  }
}

const zip = path.join(ROOT, 'dist', 'radyab-host.zip');
const upd = path.join(ROOT, 'dist', 'ردیاب-آپدیت.zip');
zipDir(OUT, zip);
// Windows' tar cannot write a Persian file name: build under a plain name, then rename.
const updTmp = path.join(ROOT, 'dist', 'radyab-update.zip');
zipDir(OUT, updTmp, ['data']);
fs.renameSync(updTmp, upd);
console.log(`built ${path.relative(ROOT, OUT)}, ${path.relative(ROOT, zip)} and ${path.relative(ROOT, upd)} (version ${version})`);
