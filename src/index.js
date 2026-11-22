#!/usr/bin/env node
/* Entry point: `node src/index.js` (or start.bat / radyab.vbs, which runs it out of sight). */
'use strict';

const { startApp } = require('./app');

// A stray error in one background step must not close the bot in the middle of a search.
process.on('unhandledRejection', (err) => {
  console.error(`Radyab: an error was ignored — ${err && err.message ? err.message.split('\n')[0] : err}`);
});

/** Is a Radyab already answering on this PC (started at Windows start-up, say)? */
async function alreadyRunning() {
  try {
    const r = await fetch('http://127.0.0.1:4777/api/state', { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch (_) { return false; }
}

(async () => {
  if (await alreadyRunning()) {
    console.log('Radyab is already running. Control panel: http://127.0.0.1:4777/');
    process.exit(0);
  }
  console.log('Radyab: starting (Chrome stays out of sight)…');
  let app = null;
  const quit = async () => {
    if (app) {
      await app.close().catch(() => {});
      await app.context.close().catch(() => {});
    }
    process.exit(0);
  };
  app = await startApp({ onQuit: quit });
  console.log(`${new Date().toISOString()} Radyab is running. Control panel: ${app.panelUrl}`);
  console.log('To quit: «خاموش کردن ربات» in the panel\'s settings (or Ctrl+C here).');
  app.context.on('close', () => { app.close().finally(() => process.exit(0)); });
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
})().catch((err) => {
  console.error(`\n${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
