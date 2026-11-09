'use strict';
/* =========================================================
   Shell: side menu with counters, notifications, mobile bottom bar, router
   ========================================================= */

let PAGE = { name: '', update: null };

function setTitle(text) { $('#pageTitle').textContent = text; document.title = text === 'پیشخوان' ? 'ردیاب' : `ردیاب — ${text}`; }

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
  let dealCount = 0;
  for (const [token, d] of App.deals) { const a = App.ads.get(token); if (d.deal && a && !a.removed && stageOf(a) === 'new') dealCount++; }
  badge('deals', dealCount, 'deal');
  badge('calls', due, 'red');
  const al = alerts();
  const bellN = $('#bellCount');
  bellN.textContent = al.length ? fa(al.length) : '';
  bellN.hidden = !al.length;
  for (const el of $$('[data-live]')) el.hidden = !App.state.busy;

  const acc = $('#account');
  if (App.host) {
    // Online panel: is the bot on the PC connected right now?
    acc.classList.toggle('on', !!App.bot.online);
    acc.classList.add('host');
    $('.label', acc).textContent = App.offline ? 'اینترنت قطع است'
      : App.bot.online ? (App.state.busy ? 'ربات در حال جستجو' : 'ربات روشن است')
        : `ربات خاموش · ${App.bot.lastSeenAt ? agoFa(App.bot.lastSeenAt) : 'هنوز وصل نشده'}`;
    $('#todayCount').textContent = '';
    $('#logoutBtn').hidden = false;
    const chip = $('#botChip');
    chip.hidden = false;
    chip.classList.toggle('on', !!App.bot.online && !App.offline);
    $('.label', chip).textContent = App.offline ? 'بدون اینترنت' : App.bot.online ? (App.state.busy ? 'در حال جستجو' : 'ربات روشن') : 'ربات خاموش';
    chip.title = $('.label', acc).textContent;
    return;
  }
  acc.classList.toggle('on', !!App.state.loggedIn);
  $('.label', acc).textContent = App.offline ? 'ربات در دسترس نیست' : App.state.loggedIn ? 'به دیوار وصل هستید' : 'ورود به دیوار';
  $('#todayCount').textContent = App.offline ? '' : `امروز ${fa(App.state.today || 0)} آگهی باز شد`;
}

$('#account').addEventListener('click', () => { if (!App.host && !App.state.loggedIn) api('/api/login', { method: 'POST' }).catch(() => {}); });
$('#logoutBtn').addEventListener('click', async () => {
  await api('/api/session', { method: 'DELETE' }).catch(() => {});
  showLogin();
});

// ---------- online panel: sign in ----------
let LOGIN_SHOWN = false;
function showLogin() {
  if (LOGIN_SHOWN) return;
  LOGIN_SHOWN = true;
  document.body.classList.add('signed-out');
  const err = h('p', { class: 'form-error', role: 'alert' });
  const btn = h('button', { class: 'btn primary lg', type: 'submit' }, 'ورود');
  const form = h('form', { class: 'login-card', autocomplete: 'on' },
    h('img', { src: 'icons/icon48.png', alt: '', width: 48, height: 48 }),
    h('h1', null, 'ردیاب'),
    h('label', { class: 'field' }, h('span', null, 'نام کاربری'), h('input', { name: 'user', autocomplete: 'username', dir: 'ltr', required: true })),
    h('label', { class: 'field' }, h('span', null, 'رمز'), h('input', { name: 'pass', type: 'password', autocomplete: 'current-password', dir: 'ltr', required: true })),
    err, btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    btn.disabled = true;
    try {
      await api('/api/session', { method: 'POST', body: { user: form.elements.user.value.trim(), pass: form.elements.pass.value } });
      location.reload();
    } catch (ex) {
      err.textContent = ex.status === 401 || ex.status === 403 ? 'نام کاربری یا رمز درست نیست.' : ex.message;
      btn.disabled = false;
    }
  });
  document.body.append(h('div', { class: 'login-screen' }, form));
  form.elements.user.focus();
}

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
  const name = { '/': 'dash', '': 'dash', '/ads': 'ads', '/search': 'search', '/runs': 'runs', '/backup': 'backup', '/settings': 'settings', '/deals': 'deals', '/prices': 'prices' }[path] || 'dash';
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
  refreshModelStrip = null;
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
    case 'prices': setTitle('قیمت‌یاب'); renderPrices(view, route.params); PAGE.update = () => renderPrices(view, parseRoute().params); break;
    case 'deals':
      setTitle('پیشنهاد ویژه');
      renderDeals(view, route.params);
      PAGE.update = () => refreshBrowser();
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
    const ads = allAds().filter((a) => (!searchKey || a.searches.includes(searchKey)) && inPeriod(a));
    $$('button', tabs).forEach((b, i) => { $('small', b).textContent = fa(ads.filter((a) => adTabMatch(adFlags(a), AD_TABS[i][0])).length); });
    $$('.quick:not(.trims) button').forEach((b, i) => { $('small', b).textContent = fa(ads.filter((a) => adTabMatch(adFlags(a), null, Object.keys(AD_VIEWS)[i])).length); });
  }
  if (refreshModelStrip) refreshModelStrip();
  refreshBrowser();
}

function userIsTyping() {
  const el = document.activeElement;
  return el && /INPUT|TEXTAREA/.test(el.tagName) && el.type !== 'checkbox' && el.type !== 'button';
}

App.onChange((what) => {
  updateShell();
  if (!PAGE.update) return;
  if (what === 'ads' && (PAGE.name === 'ads' || PAGE.name === 'deals')) { PAGE.update(); return; }
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
