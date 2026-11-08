'use strict';
/* =========================================================
   Shell: side menu with counters, notifications, mobile bottom bar, router
   ========================================================= */

let PAGE = { name: '', update: null };

function setTitle(text) { $('#pageTitle').textContent = text; document.title = text === 'پیشخوان' ? 'نوجا' : `نوجا — ${text}`; }

// ---------- counters & notifications ----------
function alerts() {
  const out = [];
  for (const a of App.ads.values()) {
    const f = adFlags(a);
    const p = a.post;
    if (f.callDue) out.push({ kind: 'call', t: a.crm.nextCallAt, token: p.token, text: `وقت تماس با «${p.title}»`, sub: f.missed ? `${fa(f.missed)} بار جواب نداده` : whenFa(a.crm.nextCallAt) });
    if (f.visitOverdue) out.push({ kind: 'visit', t: a.crm.visitAt, token: p.token, text: `نتیجهٔ بازدید «${p.title}» را ثبت کنید`, sub: whenFa(a.crm.visitAt) });
    else if (f.visitToday) out.push({ kind: 'visit', t: a.crm.visitAt, token: p.token, text: `بازدید امروز: «${p.title}»`, sub: whenFa(a.crm.visitAt) });
    if (f.sold && App.meta.activeStages.includes(f.stage)) out.push({ kind: 'sold', t: a.removed, token: p.token, text: `«${p.title}» از دیوار حذف شد`, sub: 'احتمالاً فروخته شده' });
    if (f.priceDrop && Date.now() - f.priceDrop.t < DAY && f.stage !== 'rejected') out.push({ kind: 'drop', t: f.priceDrop.t, token: p.token, text: `«${p.title}» ارزان‌تر شد`, sub: `${formatPrice(f.priceDrop.from)} ← ${formatPrice(f.priceDrop.to)}` });
  }
  return out.sort((a, b) => (b.t || 0) - (a.t || 0));
}

function updateShell() {
  let newCount = 0; let due = 0;
  for (const a of App.ads.values()) {
    const f = adFlags(a);
    if (f.stage === 'new' && !f.sold) newCount++;
    if (f.callDue) due++;
  }
  const badge = (id, n, cls) => { for (const el of $$(`[data-badge="${id}"]`)) { el.textContent = n ? fa(n) : ''; el.className = `nav-badge${cls ? ` ${cls}` : ''}`; el.hidden = !n; } };
  badge('new', newCount);
  badge('calls', due, 'red');
  const al = alerts();
  const bellN = $('#bellCount');
  bellN.textContent = al.length ? fa(al.length) : '';
  bellN.hidden = !al.length;
  for (const el of $$('[data-live]')) el.hidden = !App.state.busy;

  const acc = $('#account');
  acc.classList.toggle('on', !!App.state.loggedIn);
  $('.label', acc).textContent = App.offline ? 'ربات در دسترس نیست' : App.state.loggedIn ? 'به دیوار وصل هستید' : 'ورود به دیوار';
  $('#todayCount').textContent = App.offline ? '' : `امروز ${fa(App.state.today || 0)} آگهی باز شد`;
}

$('#account').addEventListener('click', () => { if (!App.state.loggedIn) api('/api/login', { method: 'POST' }).catch(() => {}); });

const bellBtn = $('#bellBtn');
const bellPop = $('#bellPop');
bellBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = bellPop.hidden;
  if (open) {
    const al = alerts();
    const ic = { call: 'phone', visit: 'calendar', sold: 'alert', drop: 'trend' };
    bellPop.replaceChildren(h('h3', null, 'یادآوری‌ها'),
      ...(al.length ? al.slice(0, 20).map((x) => h('a', { class: `alert-item k-${x.kind}`, href: `#/ads?open=${x.token}` },
        icon(ic[x.kind]), h('div', null, h('b', null, x.text), h('small', null, x.sub))))
        : [h('p', { class: 'muted', style: 'margin:8px 12px' }, 'یادآوری‌ای نیست.')]));
  }
  bellPop.hidden = !open;
  bellBtn.setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', (e) => { if (!bellPop.hidden && !bellPop.contains(e.target)) { bellPop.hidden = true; bellBtn.setAttribute('aria-expanded', 'false'); } });

// Mobile: «بیشتر» opens the side menu as a sheet.
const side = $('#side');
function toggleSide(open) { side.classList.toggle('open', open); $('#sideScrim').hidden = !open; }
$('#moreBtn').addEventListener('click', () => toggleSide(true));
$('#menuBtn').addEventListener('click', () => toggleSide(true));
$('#sideScrim').addEventListener('click', () => toggleSide(false));

// ---------- router ----------
function parseRoute() {
  const hash = location.hash || '#/';
  const [path, query] = hash.slice(1).split('?');
  const params = new URLSearchParams(query || '');
  const m = path.match(/^\/run\/([A-Za-z0-9_-]+)/);
  if (m) return { name: 'run', id: m[1], params };
  const name = { '/': 'dash', '': 'dash', '/ads': 'ads', '/search': 'search', '/runs': 'runs', '/backup': 'backup', '/settings': 'settings' }[path] || 'dash';
  return { name, params };
}

function markNav(route) {
  const key = route.name === 'ads' && route.params.get('view') === 'calls' ? 'calls' : route.name === 'run' ? 'runs' : route.name;
  for (const a of $$('[data-nav]')) a.setAttribute('aria-current', a.dataset.nav === key ? 'page' : 'false');
}

function render() {
  const route = parseRoute();
  closeOverlay();
  unmountBrowser();
  stopRunView();
  toggleSide(false);
  bellPop.hidden = true;
  markNav(route);
  const view = $('#view');
  PAGE = { name: route.name, route, update: null };
  switch (route.name) {
    case 'ads':
      setTitle('پیگیری آگهی‌ها');
      renderAds(view, route.params);
      PAGE.update = () => refreshAdsPage(route.params);
      break;
    case 'search': setTitle('جستجوی جدید'); renderSearch(view); break;
    case 'runs': setTitle('جستجوها'); renderRuns(view); PAGE.update = () => renderRuns(view); break;
    case 'run': setTitle('جستجو'); renderRun(view, route.id); break;
    case 'backup': setTitle('پشتیبان'); renderBackup(view); break;
    case 'settings': setTitle('تنظیمات'); renderSettings(view); break;
    default:
      setTitle('پیشخوان');
      renderDashboard(view);
      PAGE.update = () => renderDashboard(view);
  }
  window.scrollTo(0, 0);
}

/** Update the ads page in place (tab counts + list) without losing scroll or open drawer. */
function refreshAdsPage(params) {
  const tabs = $('.stage-tabs');
  if (tabs) {
    const searchKey = params.get('search') || '';
    const ads = allAds().filter((a) => !searchKey || a.searches.includes(searchKey));
    $$('button', tabs).forEach((b, i) => { $('small', b).textContent = fa(ads.filter((a) => adTabMatch(adFlags(a), AD_TABS[i][0])).length); });
    $$('.quick button').forEach((b, i) => { $('small', b).textContent = fa(ads.filter((a) => adTabMatch(adFlags(a), null, Object.keys(AD_VIEWS)[i])).length); });
  }
  refreshBrowser();
}

function userIsTyping() {
  const el = document.activeElement;
  return el && /INPUT|TEXTAREA/.test(el.tagName) && el.type !== 'checkbox' && el.type !== 'button';
}

App.onChange((what) => {
  updateShell();
  if (!PAGE.update) return;
  if (what === 'ads' && PAGE.name === 'ads') { PAGE.update(); return; }
  if (overlay || userIsTyping()) return; // do not yank the page while the user works
  if (what === 'ads' || (what === 'state' && PAGE.name !== 'ads')) PAGE.update();
});
window.addEventListener('hashchange', render);

(async () => {
  await Promise.all([App.refreshState(), App.refreshAds(true)]);
  render();
  setInterval(() => { App.refreshState(); App.refreshAds(); }, 15000);
  setInterval(updateShell, 60000); // due-call times move on even without new data
})();
