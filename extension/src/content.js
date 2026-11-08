/*
 * Noja content script — runs on divar.ir.
 * Scrolls the search result list, collects every ad link, then hands the list
 * to the background worker which opens the results page.
 */
(() => {
  'use strict';
  if (window.__nojaContentLoaded) return;
  window.__nojaContentLoaded = true;

  const P = globalThis.NojaParser;
  let running = false;
  let stopRequested = false;
  let overlay = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isSearchPage = () => /^\/s\//.test(location.pathname);

  function collectVisible(map) {
    const anchors = document.querySelectorAll('a[href*="/v/"]');
    for (const a of anchors) {
      const href = a.getAttribute('href');
      const token = P.extractTokenFromHref(href);
      if (!token || map.has(token)) continue;
      const card = a.closest('article') || a.closest('[class*="post-card"]') || a;
      const img = card.querySelector('img');
      const lines = (card.innerText || '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const heading = card.querySelector('h2, h3');
      map.set(token, {
        token,
        href: new URL(href, location.origin).href,
        title: ((heading && heading.innerText) || lines[0] || '').trim(),
        lines: lines.slice(0, 10),
        image: (img && (img.currentSrc || img.src || img.getAttribute('data-src'))) || '',
      });
    }
  }

  function clickLoadMore() {
    const buttons = document.querySelectorAll('button, a[role="button"]');
    for (const b of buttons) {
      const t = (b.innerText || '').trim();
      if (t && t.length < 40 && /آگهی.{0,3}های بیشتر|نمایش بیشتر|بارگذاری بیشتر/.test(t) && b.offsetParent !== null) {
        b.click();
        return true;
      }
    }
    return false;
  }

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'noja-overlay';
    overlay.setAttribute('dir', 'rtl');
    overlay.style.cssText = [
      'position:fixed', 'bottom:20px', 'left:20px', 'z-index:2147483647',
      'background:#14213d', 'color:#fff', 'padding:14px 16px', 'border-radius:14px',
      'font:14px/1.7 Vazirmatn,Tahoma,sans-serif', 'box-shadow:0 10px 30px rgba(0,0,0,.3)',
      'min-width:260px', 'max-width:320px',
    ].join(';');
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:700;margin-bottom:4px';
    title.textContent = 'نوجا · در حال جمع‌آوری آگهی‌ها';
    const status = document.createElement('div');
    status.className = 'noja-status';
    const btn = document.createElement('button');
    btn.textContent = 'کافیه، نتایج را نشان بده';
    btn.style.cssText = 'margin-top:8px;background:#fca311;color:#14213d;border:0;border-radius:8px;padding:6px 12px;font:inherit;font-weight:700;cursor:pointer';
    btn.addEventListener('click', () => { stopRequested = true; });
    overlay.append(title, status, btn);
    document.documentElement.appendChild(overlay);
    return overlay;
  }

  function setStatus(text) {
    ensureOverlay().querySelector('.noja-status').textContent = text;
  }

  async function run(job) {
    if (running) return { ok: false, error: 'busy' };
    if (!isSearchPage()) {
      alert('نوجا: لطفاً اول وارد صفحهٔ نتایج جستجوی دیوار شوید (آدرسی که با divar.ir/s/ شروع می‌شود).');
      return { ok: false, error: 'not-search-page' };
    }
    running = true;
    stopRequested = false;
    const maxAds = Math.max(1, Number(job.criteria && job.criteria.maxAds) || 300);
    const map = new Map();
    let idleRounds = 0;
    setStatus('شروع اسکرول صفحه…');

    try {
      collectVisible(map);
      while (!stopRequested && map.size < maxAds && idleRounds < 6) {
        const before = map.size;
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
        await sleep(1100 + Math.random() * 700);
        if (clickLoadMore()) await sleep(1500);
        collectVisible(map);
        idleRounds = map.size === before ? idleRounds + 1 : 0;
        setStatus(`${map.size.toLocaleString('fa-IR')} آگهی پیدا شد${idleRounds ? ' · منتظر آگهی‌های بیشتر…' : ''}`);
      }
      const items = Array.from(map.values()).slice(0, maxAds);
      setStatus(`${items.length.toLocaleString('fa-IR')} آگهی جمع شد. در حال باز کردن صفحهٔ نتایج…`);
      await chrome.runtime.sendMessage({
        type: 'NOJA_COLLECTED',
        job: { ...job, sourceUrl: location.href, items },
      });
      setTimeout(() => { if (overlay) { overlay.remove(); overlay = null; } }, 2500);
      return { ok: true, count: items.length };
    } catch (err) {
      setStatus(`خطا: ${err && err.message ? err.message : err}`);
      return { ok: false, error: String(err) };
    } finally {
      running = false;
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return false;
    if (msg.type === 'NOJA_PING') {
      sendResponse({ ok: true, isSearchPage: isSearchPage(), running });
      return false;
    }
    if (msg.type === 'NOJA_SCAN') {
      sendResponse({ ok: true, started: !running });
      run(msg.job);
      return false;
    }
    return false;
  });

  // Auto-start when the popup opened this tab with a pending job.
  chrome.storage.local.get('pendingJob').then(({ pendingJob }) => {
    if (!pendingJob || !isSearchPage()) return;
    if (Date.now() - (pendingJob.createdAt || 0) > 3 * 60 * 1000) {
      chrome.storage.local.remove('pendingJob');
      return;
    }
    chrome.storage.local.remove('pendingJob');
    setTimeout(() => run(pendingJob), 2000);
  });
})();
