#!/usr/bin/env node
/* Entry point: `node src/index.js` (or start.bat / start.sh). */
'use strict';

const { startApp } = require('./app');

(async () => {
  console.log('Noja: opening Google Chrome…');
  const app = await startApp();
  console.log(`Noja is running. Control panel: ${app.panelUrl}`);
  console.log('Close the Chrome window (or press Ctrl+C here) to quit.');
  const quit = async () => {
    await app.close().catch(() => {});
    await app.context.close().catch(() => {});
    process.exit(0);
  };
  app.context.on('close', () => { app.close().finally(() => process.exit(0)); });
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
})().catch((err) => {
  console.error(`\n${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
