/* Noja background service worker: stores collected jobs and opens the results page. */
'use strict';

const MAX_JOBS = 15;

async function saveJob(job) {
  const id = `job_${Date.now()}`;
  const record = { ...job, id, collectedAt: Date.now() };
  const { jobIndex = [] } = await chrome.storage.local.get('jobIndex');
  const index = [id, ...jobIndex];
  const removed = index.splice(MAX_JOBS);
  await chrome.storage.local.set({ [`job:${id}`]: record, jobIndex: index, lastJobId: id });
  if (removed.length) await chrome.storage.local.remove(removed.map((r) => `job:${r}`));
  return id;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'NOJA_COLLECTED') return false;
  saveJob(msg.job)
    .then((id) => {
      const url = chrome.runtime.getURL(`results/results.html?job=${encodeURIComponent(id)}`);
      const opts = { url };
      if (sender.tab && typeof sender.tab.index === 'number') opts.index = sender.tab.index + 1;
      return chrome.tabs.create(opts).then(() => sendResponse({ ok: true, id }));
    })
    .catch((err) => sendResponse({ ok: false, error: String(err) }));
  return true; // async response
});
