'use strict';

const P = globalThis.NojaParser;
const form = document.getElementById('form');
const formMsg = document.getElementById('formMsg');
const STATUS_FA = {
  starting: 'در حال شروع', 'waiting-login': 'منتظر ورود', collecting: 'جمع‌آوری آگهی‌ها', reading: 'در حال خواندن',
  blocked: 'منتظر تأیید دیوار', paused: 'متوقف', done: 'تمام شده', stopped: 'متوقف شده', error: 'خطا',
};

function saveForm() {
  const data = Object.fromEntries(new FormData(form).entries());
  data.strictYear = form.elements.strictYear.checked;
  try { localStorage.setItem('noja.form', JSON.stringify(data)); } catch (_) { /* ignore */ }
  return data;
}

function restoreForm() {
  let data = null;
  try { data = JSON.parse(localStorage.getItem('noja.form') || 'null'); } catch (_) { /* ignore */ }
  if (!data) return;
  for (const [k, v] of Object.entries(data)) {
    const el = form.elements.namedItem(k);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  }
}

function describe(c) {
  const parts = [c.query || 'لینک دیوار'];
  if (c.yearMin || c.yearMax) parts.push(c.yearMin === c.yearMax ? `مدل ${c.yearMin}` : `مدل ${c.yearMin || '…'} تا ${c.yearMax || '…'}`);
  return P.toEnDigits(parts.join('، ')).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
}

async function refresh() {
  let state;
  try {
    state = await (await fetch('/api/state')).json();
  } catch (_) {
    document.getElementById('loginState').textContent = 'ارتباط با ربات قطع است. برنامهٔ نوجا را دوباره اجرا کنید.';
    return;
  }
  const ls = document.getElementById('loginState');
  ls.replaceChildren();
  const dot = document.createElement('span');
  dot.className = `dot${state.loggedIn ? ' on' : ''}`;
  ls.append(dot, state.loggedIn ? 'وارد حساب دیوار هستید' : 'هنوز وارد حساب دیوار نشده‌اید');
  document.getElementById('loginBtn').hidden = state.loggedIn;

  const busy = document.getElementById('busy');
  busy.hidden = !state.busy;
  if (state.busy) document.getElementById('busyLink').href = `results.html?run=${encodeURIComponent(state.busy)}`;
  form.querySelector('.go').disabled = !!state.busy;

  const list = document.getElementById('runs');
  if (state.runs.length) {
    list.replaceChildren(...state.runs.map((r) => {
      const li = document.createElement('li');
      const left = document.createElement('div');
      const a = document.createElement('a');
      a.href = `results.html?run=${encodeURIComponent(r.id)}`;
      a.textContent = describe(r.criteria);
      const small = document.createElement('small');
      small.textContent = `${new Date(r.createdAt).toLocaleString('fa-IR', { dateStyle: 'medium', timeStyle: 'short' })} — ${r.read.toLocaleString('fa-IR')} آگهی`;
      left.append(a, small);
      const st = document.createElement('small');
      st.textContent = STATUS_FA[r.status] || r.status;
      li.append(left, st);
      return li;
    }));
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  formMsg.textContent = '';
  const data = saveForm();
  if (!data.query.trim() && !data.searchUrl.trim()) {
    formMsg.textContent = 'نام خودرو را بنویسید یا لینک جستجوی دیوار را بچسبانید.';
    return;
  }
  form.querySelector('.go').disabled = true;
  try {
    const res = await fetch('/api/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    const body = await res.json();
    if (body.id) location.href = `results.html?run=${encodeURIComponent(body.id)}`;
    else formMsg.textContent = body.error || 'خطای ناشناخته';
  } catch (err) {
    formMsg.textContent = `ارتباط با ربات برقرار نشد: ${err.message}`;
  } finally {
    form.querySelector('.go').disabled = false;
  }
});

document.getElementById('loginBtn').addEventListener('click', () => fetch('/api/login', { method: 'POST' }));

restoreForm();
refresh();
setInterval(refresh, 4000);
