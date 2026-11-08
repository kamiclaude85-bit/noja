'use strict';

const P = globalThis.NojaParser;
const form = document.getElementById('form');
const msg = document.getElementById('msg');

function readCriteria() {
  const fd = new FormData(form);
  const num = (name) => {
    const n = P.parseNumber(fd.get(name));
    return n == null ? null : n;
  };
  return {
    query: String(fd.get('query') || '').trim(),
    city: String(fd.get('city') || 'tehran'),
    keyword: String(fd.get('keyword') || '').trim(),
    yearMin: num('yearMin') == null ? null : P.normalizeYear(num('yearMin')),
    yearMax: num('yearMax') == null ? null : P.normalizeYear(num('yearMax')),
    priceMax: num('priceMax'),
    mileageMax: num('mileageMax'),
    maxAds: Math.min(Math.max(num('maxAds') || 300, 1), 2000),
    strictYear: fd.get('strictYear') === 'on',
  };
}

function fillForm(c) {
  if (!c) return;
  for (const [k, v] of Object.entries(c)) {
    const el = form.elements.namedItem(k);
    if (!el || v == null) continue;
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  }
}

function newJob(criteria) {
  return { criteria, createdAt: Date.now() };
}

chrome.storage.local.get('lastCriteria').then(({ lastCriteria }) => fillForm(lastCriteria));

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const criteria = readCriteria();
  if (!criteria.query) return;
  await chrome.storage.local.set({ lastCriteria: criteria, pendingJob: newJob(criteria) });
  await chrome.tabs.create({ url: P.buildSearchUrl(criteria) });
  window.close();
});

document.getElementById('scanHere').addEventListener('click', async () => {
  msg.textContent = '';
  const criteria = readCriteria();
  await chrome.storage.local.set({ lastCriteria: criteria });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !/^https:\/\/divar\.ir\/s\//.test(tab.url)) {
    msg.textContent = 'تب فعلی صفحهٔ جستجوی دیوار نیست. اول در دیوار جستجو کنید (آدرس با divar.ir/s/ شروع می‌شود).';
    return;
  }
  const job = newJob(criteria);
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'NOJA_PING' });
  } catch (_) {
    // The tab was open before the extension was installed: inject now.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/parser.js', 'src/content.js'] });
  }
  await chrome.tabs.sendMessage(tab.id, { type: 'NOJA_SCAN', job });
  window.close();
});

document.getElementById('lastResults').addEventListener('click', async () => {
  const { lastJobId } = await chrome.storage.local.get('lastJobId');
  if (!lastJobId) {
    msg.textContent = 'هنوز جستجویی انجام نشده است.';
    return;
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL(`results/results.html?job=${encodeURIComponent(lastJobId)}`) });
  window.close();
});
