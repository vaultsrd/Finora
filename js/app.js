/* ============================================================
   Finora — Frontend App (Vanilla JS, PWA)
   Layer: API Apps Script + IndexedDB (cache & antrean offline)
   ============================================================ */
'use strict';

const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));

const S = {
  API: localStorage.getItem('finora_api') || '',
  TOKEN: localStorage.getItem('finora_token') || '',
  CATS: [], ACCS: [], PERSONS: [],
  view: '', txPage: 1, txFilter: {}, debtTab: 'debt',
  repPeriod: { period: 'monthly' }
};

/* ============================ Helpers ============================ */

const rp = (n) => 'Rp ' + (Number(n) || 0).toLocaleString('id-ID');
const rpS = (n) => (Number(n) < 0 ? '−Rp ' : 'Rp ') + Math.abs(Number(n) || 0).toLocaleString('id-ID');
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const today = () => new Date().toISOString().slice(0, 10);
const rid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'r-' + Date.now() + '-' + Math.random().toString(16).slice(2, 10));

function toast(msg, ms) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => { t.hidden = true; }, ms || 2600);
}

function modal(title, bodyHtml) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml;
  $('#modal').hidden = false;
  return $('#modalBody');
}
function closeModal() { $('#modal').hidden = true; }

/* ============================ IndexedDB ============================ */

let _dbP = null;
function idb() {
  if (_dbP) return _dbP;
  _dbP = new Promise((resolve, reject) => {
    const r = indexedDB.open('finora', 1);
    r.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('cache')) d.createObjectStore('cache');
      if (!d.objectStoreNames.contains('queue')) d.createObjectStore('queue');
    };
    r.onsuccess = (e) => resolve(e.target.result);
    r.onerror = () => reject(r.error);
  });
  return _dbP;
}
function idbPut(store, key, val) {
  return idb().then((db) => new Promise((ok, no) => {
    const t = db.transaction(store, 'readwrite');
    t.objectStore(store).put(val, key);
    t.oncomplete = ok; t.onerror = () => no(t.error);
  }));
}
function idbGet(store, key) {
  return idb().then((db) => new Promise((ok) => {
    const t = db.transaction(store, 'readonly').objectStore(store).get(key);
    t.onsuccess = () => ok(t.result);
    t.onerror = () => ok(undefined);
  }));
}
function idbDel(store, key) {
  return idb().then((db) => new Promise((ok) => {
    const t = db.transaction(store, 'readwrite');
    t.objectStore(store).delete(key);
    t.oncomplete = ok;
  }));
}
function queuePeek() {
  return idb().then((db) => new Promise((ok) => {
    const res = [];
    const t = db.transaction('queue', 'readonly').objectStore('queue').openCursor();
    t.onsuccess = (e) => { const c = e.target.result; if (c) { res.push({ key: c.key, val: c.value }); c.continue(); } };
    t.onerror = () => ok(res); t.oncomplete = () => ok(res);
  }));
}
function queueCount() {
  return idb().then((db) => new Promise((ok) => {
    const t = db.transaction('queue', 'readonly').objectStore('queue').count();
    t.onsuccess = () => ok(t.result);
    t.onerror = () => ok(0);
  }));
}

const QUEUABLE = new Set(['tx.income', 'tx.expense', 'tx.transfer', 'account.create']);

/* ============================ API ============================ */

/**
 * api('x.y', payload) → data.  api(action, p, {raw:true}) → envelope penuh.
 * Offline + action QUEUABLE → masuk antrean IndexedDB (FR-025).
 */
async function api(action, payload, opts) {
  opts = opts || {};
  const full = Object.assign({ action, token: S.TOKEN, request_id: rid() }, payload);

  if (!S.API) { location.hash = '#/set'; throw new Error('Web App URL belum diatur'); }

  if (!navigator.onLine && QUEUABLE.has(action)) {
    await idbPut('queue', full.request_id, { action, payload });
    toast('📴 Offline — transaksi masuk antrean, sinkron otomatis nanti');
    return { queued: true, request_id: full.request_id };
  }

  const res = await fetch(S.API, {
    method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(full)
  });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch (e) {
    throw new Error('Respons bukan JSON: ' + text.slice(0, 140));
  }

  if (j && j.ok === false) {
    if (j.code === 'UNAUTHORIZED' && S.TOKEN) {
      S.TOKEN = ''; localStorage.removeItem('finora_token');
      showLogin(); throw new Error('Sesi kedaluwarsa — login ulang');
    }
    if (j.code === 'NEGATIVE_BALANCE' && !opts.raw) {
      const sure = window.confirm(
        '⚠️ Proyeksi saldo negatif!\n\n' +
        (j.error || '') + '\n\n' +
        'Saldo sekarang: ' + rp(j.current_balance) + '\n' +
        'Proyeksi: ' + rp(j.projected_balance) + '\n\n' +
        'Lanjutkan transaksi (saldo boleh negatif)?'
      );
      if (sure) return api(action, Object.assign({}, payload, { allow_negative_balance: true }), opts);
      throw new Error('Transaksi dibatalkan');
    }
    if (!opts.raw) throw new Error(j.error || 'Terjadi kesalahan');
    return j;
  }
  return opts.raw ? j : j.data;
}

/* Kirim antrean offline (idempotent — request_id disimpan saat antre). */
async function flushQueue() {
  if (!S.TOKEN || !navigator.onLine) return;
  const items = await queuePeek();
  if (!items.length) return;
  if (items.length) toast('⇄ Sinkron ' + items.length + ' transaksi…', 5000);
  let ok = 0, fail = 0;
  for (const it of items) {
    try {
      const body = JSON.stringify(Object.assign(
        { action: it.val.action, token: S.TOKEN, request_id: it.key },
        it.val.payload || {}
      ));
      const res = await fetch(S.API, {
        method: 'POST', redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body
      });
      const j = await res.json();
      if (j.ok) { await idbDel('queue', it.key); ok++; }
      else if (j.code && j.code !== 'BUSY' && !/VALIDASI/.test(j.error || '')) {
        await idbDel('queue', it.key); fail++; // error struktural → jangan retry abadi
      } else { fail++; }
    } catch (e) { fail++; }
  }
  if (ok || fail) {
    toast(ok ? '✅ ' + ok + ' transaksi tersinkron' + (fail ? ' • ' + fail + ' gagal' : '')
             : '❌ sinkron gagal, dicoba ulang nanti');
    await refreshBadges();
    if (S.view === 'tx' || S.view === 'dash') render();
  }
}

async function refreshBadges() {
  const n = await queueCount();
  $('#offlineChip').hidden = !!navigator.onLine && !n;
  if (navigator.onLine) $('#offlineChip').textContent = n ? '⇄ ' + n + ' menunggu' : '';
}

/* ============================ Cache dashboard ============================ */

async function cacheSet(k, v) { return idbPut('cache', k, v); }
async function cacheGet(k) { return idbGet('cache', k); }

/* ============================ Referensi ============================ */

async function loadRefs() {
  try {
    const [cats, accs] = await Promise.all([api('category.list'), api('account.list')]);
    S.CATS = cats.items || [];
    S.ACCS = accs.accounts || [];
  } catch (e) { console.warn(e); }
}
const catById = (id) => S.CATS.find((c) => c.category_id === id) || {};
const accById = (id) => S.ACCS.find((a) => a.account_id === id) || {};
const accName = (id) => (accById(id).account_name || id || '—');
const catName = (id) => { const c = catById(id); return (c.icon || '') + ' ' + (c.name || '—'); };
const pctColor = (p) => (p >= 100 ? 'over' : p >= 80 ? 'near' : '');

/* ============================ Auth & boot ============================ */

function showLogin() {
  $('#app').hidden = true; $('#loginView').hidden = false; $('#fab').hidden = true;
  $('#apiHint').textContent = S.API ? 'Backend: ' + S.API.slice(0, 38) + '…' : 'Web App URL belum diatur';
  $('#pinInput').focus();
}

async function doLogin() {
  const pin = $('#pinInput').value.trim();
  const errEl = $('#loginError');
  errEl.hidden = true;
  if (!S.API) { location.hash = '#/set'; return; }
  try {
    const res = await api('auth.login', { pin, device: 'PWA' });
    localStorage.setItem('finora_token', res.token);
    S.TOKEN = res.token;
    await bootApp();
  } catch (e) {
    errEl.textContent = e.message || 'Login gagal';
    errEl.hidden = false;
  }
}

async function bootApp() {
  $('#loginView').hidden = true;
  $('#app').hidden = false;
  await loadRefs();
  await refreshBadges();
  if (!location.hash || location.hash === '#/') location.hash = '#/dash';
  route();
  flushQueue();
}

function doLogout() {
  api('auth.logout').catch(() => { });
  S.TOKEN = ''; localStorage.removeItem('finora_token');
  showLogin();
}

/* Event wiring umum */
$('#btnLogin').addEventListener('click', doLogin);
$('#pinInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
$('#modalClose').addEventListener('click', closeModal);
// Klik di luar modal TIDAK menutup (interaksi salah klik sering terjadi).
$('#btnMore').addEventListener('click', () => { location.hash = '#/more'; });
$('#fabBtn').addEventListener('click', txAddModal);
$$('.bn').forEach((b) => b.addEventListener('click', () => { location.hash = '#/' + b.dataset.go; }));
window.addEventListener('hashchange', route);
window.addEventListener('online', () => { refreshBadges(); flushQueue(); if (S.view) render(); });
window.addEventListener('offline', () => { refreshBadges(); });

/** Perbarui halaman aktif (dipanggil setelah data berubah). */
function render() { route(); }

/* Router */
const ROUTES = {
  dash: viewDash, tx: viewTx, acc: viewAcc, debt: viewDebt, rep: viewRep,
  more: viewMore, budget: viewBudget, cats: viewCats, rec: viewRec,
  backup: viewBackup, set: viewSet
};
function route() {
  const v = (location.hash.replace('#/', '') || 'dash').split('?')[0];
  // Halaman 'set' boleh diakses TANPA login (Web App URL perlu diatur dulu)
  if (!S.TOKEN && v !== 'set') { showLogin(); return; }
  if (!S.TOKEN) {
    // Shell dibuka langan tanpa login, hanya tampil kartu pengaturan
    $('#loginView').hidden = true;
    $('#app').hidden = false;
    $('#app').classList.add('navless');
    $('#fab').hidden = true;
    $$('.bn').forEach((b) => b.classList.remove('active'));
    S.view = 'set'; viewSet(); return;
  }
  $('#app').classList.remove('navless');
  if ($('#app').hidden) { bootApp(); return; }
  const fn = ROUTES[v] || viewDash;
  S.view = v;
  $$('.bn').forEach((b) => b.classList.toggle('active', b.dataset.go === v));
  $('#fab').hidden = v !== 'tx';
  fn().catch((e) => { errorView(e); });
}
function errorView(e) {
  $('#view').innerHTML = '<div class="card"><h3>Terjadi kesalahan</h3><p class="muted">' +
    esc(e.message || e) + '</p></div>';
  console.error(e);
}

function setActiveNav(v) {
  $$('.bn').forEach((b) => b.classList.toggle('active', b.dataset.go === v));
}

/* ============================ VIEW: Dashboard ============================ */

async function viewDash() {
  const v = $('#view');
  v.innerHTML = '<div class="card center">Memuat…</div>';
  let d;
  try {
    d = await api('dashboard.get');
    await cacheSet('dash', d);
  } catch (e) {
    d = await cacheGet('dash');
    if (!d) { errorView(e); return; }
    v.innerHTML = '<div class="card tight" style="margin-bottom:12px">📴 Data cache ' +
      esc(d.generated_at || '') + ' (offline)</div>';
  }

  const accs = d.accounts.map((a) => {
    const b = Number(a.balance);
    return '<div class="li"><div class="emoji-bubble">' +
      (a.account_type === 'BANK' ? '🏦' : a.account_type === 'EWALLET' ? '📱' : '💵') +
      '</div><div class="li-main"><div class="li-title">' + esc(a.account_name) +
      '</div><div class="li-sub">' + esc(a.account_type) + '</div></div>' +
      '<div class="amt ' + (b < 0 ? 'neg' : '') + '">' + rp(b) + '</div>' +
      '<span class="badge ' + (b < 0 ? 'bad' : 'active') + '">' + (b < 0 ? 'MINUS' : 'ACTIVE') + '</span></div>';
  }).join('');

  const budget = (d.budget_status || []).map((b) => {
    return '<div class="progress-row"><div class="rowline"><span class="li-title">' +
      esc(b.category_name) + '</span><span class="muted">' + b.percent_used + '%' +
      ' — sisa ' + rp(b.remaining) + '</span></div>' +
      '<div class="bar"><i class="' + pctColor(b.percent_used) + '" style="width:' +
      Math.min(100, b.percent_used) + '%"></i></div></div>';
  }).join('');

  const recent = (d.recent_transactions || []).map((t) => {
    const dir = (t.type === 'INCOME') ? 1 : (t.type === 'EXPENSE') ? -1 : 0;
    const cls = dir > 0 ? 'pos' : dir < 0 ? 'neg' : '';
    return '<div class="li"><div class="li-main"><div class="li-title">' +
      esc(t.description) + '</div><div class="li-sub">' + esc(t.transaction_date) + ' • ' +
      esc(accName(t.account_id)) + '</div></div>' +
      '<div class="amt ' + cls + '">' + (dir ? rpS(dir * Number(t.amount)) : rp(t.amount)) +
      ' <span class="badge">' + esc(t.type) + '</span></div></div>';
  }).join('') || '<p class="muted">Belum ada transaksi.</p>';

  v.innerHTML = '' +
    '<div class="card">' +
    '  <h3>Total Saldo <span class="muted">' + esc(d.generated_at || '') + '</span></h3>' +
    '  <div class="big-number ' + (Number(d.total_balance) < 0 ? 'neg' : '') + '">' + rp(d.total_balance) + '</div>' +
    '  <div class="muted">Nilai bersih (aset − utang): ' + rp(d.net_worth) + '</div>' +
    '</div>' +
    '<div class="grid grid2" style="margin-top:12px">' +
    '  <div class="card tight"><div class="muted">Pemasukan (bulan ini)</div><div class="amt pos">' + rp(d.total_income_mtd) + '</div></div>' +
    '  <div class="card tight"><div class="muted">Pengeluaran (bulan ini)</div><div class="amt neg">' + rp(d.total_expense_mtd) + '</div></div>' +
    '  <div class="card tight"><div class="muted">Total utang</div><div class="amt neg">' + rp(d.total_debt) + '</div></div>' +
    '  <div class="card tight"><div class="muted">Total piutang</div><div class="amt pos">' + rp(d.total_receivable) + '</div></div>' +
    '</div>' +
    '<div class="sect">Rekening</div><div class="card">' + accs + '</div>' +
    (budget ? '<div class="sect">Anggaran Bulan Ini</div><div class="card">' + budget + '</div>' : '') +
    '<div class="sect">Transaksi Terbaru</div><div class="card">' + recent + '</div>';
}

/* ============================ VIEW: Transaksi ============================ */

async function viewTx() {
  const v = $('#view');
  v.innerHTML =
    '<div class="card">' +
    '<div class="toolrow">' +
    '  <select id="fType"><option value="">Semua jenis</option>' +
    '    <option>INCOME</option><option>EXPENSE</option><option>TRANSFER</option></select>' +
    '  <select id="fAcc"><option value="">Semua rekening</option>' +
    S.ACCS.map((a) => '<option value="' + a.account_id + '">' + esc(a.account_name) + '</option>').join('') +
    '  </select>' +
    '  <input id="fSearch" type="search" placeholder="Cari deskripsi…" />' +
    '</div></div>' +
    '<div id="txList" style="margin-top:12px"></div>' +
    '<div class="center" style="margin-top:10px">' +
    '  <button id="txPrev" class="btn sm ghost">◀ Sebelumnya</button>' +
    '  <span id="txInfo" class="muted"></span>' +
    '  <button id="txNext" class="btn sm ghost">Berikutnya ▶</button>' +
    '</div>';

  const load = async (page) => {
    S.txPage = Math.max(1, page);
    const list = $('#txList');
    list.innerHTML = '<div class="card center">Memuat…</div>';
    const d = await api('tx.list', {
      page: S.txPage, per_page: 20,
      type: $('#fType').value || undefined,
      account_id: $('#fAcc').value || undefined,
      search: $('#fSearch').value || undefined
    });
    S.txPage = d.page; S.txFilter = {};
    // Halaman mungkin sudah berganti saat await — jangan macet tulis elemen mati
    if (!document.contains(list)) return;
    const info = $('#txInfo');
    if (info) info.textContent = d.total + ' transaksi';
    $('#txPrev').disabled = d.page <= 1;
    $('#txNext').disabled = d.page * d.per_page >= d.total;

    list.innerHTML = d.items.map((t) => {
      let cls = '', sign = '';
      if (t.type === 'INCOME') { cls = 'pos'; sign = '+'; }
      else if (t.type === 'EXPENSE') { cls = 'neg'; sign = '−'; }
      else if (t.type === 'TRANSFER') sign = '↔';
      const rev = t.status !== 'ACTIVE';
      return '<div class="card tight" style="margin-bottom:8px">' +
        '<div class="li" style="border:none;padding:0">' +
        '<div class="li-main"><div class="li-title">' + esc(t.description) +
        (rev ? ' <span class="badge bad">DIBATALKAN</span>' : '') + '</div>' +
        '<div class="li-sub">' + esc(t.transaction_date) + ' • ' + esc(accName(t.account_id)) +
        (t.to_account_id ? ' → ' + esc(accName(t.to_account_id)) : '') +
        (t.category_id ? ' • ' + esc(catName(t.category_id)) : '') + '</div></div>' +
        '<div class="amt ' + cls + '">' + sign + rp(t.amount) + '</div>' +
        (rev ? '' : '<button class="btn sm danger nv" data-rev="' + t.transaction_id + '">Batalkan</button>') +
        '</div></div>';
    }).join('') || '<div class="card center muted">Tidak ada transaksi.</div>';

    $$('[data-rev]', list).forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Batalkan transaksi ini? Riwayat asli tetap tersimpan (reversal).')) return;
      try {
        await api('tx.reverse', { transaction_id: b.dataset.rev });
        toast('✅ Dibatalkan (reversal)'); load(S.txPage);
      } catch (e) { toast('❌ ' + e.message); }
    }));
  };

  ['fType', 'fAcc'].forEach((id) => $('#' + id).addEventListener('change', load.bind(null, 1)));
  let timer; $('#fSearch').addEventListener('input', () => {
    clearTimeout(timer); timer = setTimeout(load.bind(null, 1), 400);
  });
  $('#txPrev').addEventListener('click', load.bind(null, S.txPage - 1));
  $('#txNext').addEventListener('click', load.bind(null, S.txPage + 1));

  await load(1);
}

/* Form tambah transaksi */
async function txAddModal() {
  if (!S.CATS.length) await loadRefs();
  const body = modal('Transaksi Baru',
    '<div class="seg" id="tSeg">' +
    '  <button data-t="expense" class="on">− Pengeluaran</button>' +
    '  <button data-t="income">+ Pemasukan</button>' +
    '  <button data-t="transfer">↔ Transfer</button>' +
    '</div>' +
    '<label>Tanggal</label><input id="tDate" type="date" value="' + today() + '" />' +
    '<div id="tFields"></div>' +
    '<label>Nominal (IDR)</label><input id="tAmt" type="number" min="1" inputmode="numeric" placeholder="0" />' +
    '<label>Keterangan</label><input id="tDesc" placeholder="Keterangan singkat" />' +
    '<button id="tSave" class="btn primary" style="margin-top:14px">Simpan</button>'
  );
  let type = 'expense';
  const fields = () => {
    const accOpts = S.ACCS.map((a) =>
      '<option value="' + a.account_id + '">' + esc(a.account_name) + ' (' + rp(a.balance) + ')</option>').join('');
    const catOpts = S.CATS.filter((c) =>
      c.type === (type === 'income' ? 'INCOME' : 'EXPENSE') && String(c.is_active).toUpperCase() !== 'FALSE' &&
      c.type === (type === 'income' ? 'INCOME' : 'EXPENSE'))
      .map((c) => '<option value="' + c.category_id + '">' + esc((c.icon || '') + ' ' + c.name) + '</option>').join('');
    $('#tFields').innerHTML = type === 'transfer'
      ? '<label>Dari rekening</label><select id="tAcc">' + accOpts + '</select>' +
        '<label>Ke rekening</label><select id="tAccTo">' + accOpts + '</select>'
      : '<label>Rekening</label><select id="tAcc">' + accOpts + '</select>' +
        (type === 'expense' || type === 'income'
          ? '<label>Kategori</label><select id="tCat"><option value="">Tanpa kategori</option>' + catOpts + '</select>' : '');
  };
  fields();

  $$('#tSeg button').forEach((b) => b.addEventListener('click', () => {
    type = b.dataset.t;
    $$('#tSeg button').forEach((x) => x.classList.toggle('on', x === b));
    fields();
  }));

  $('#tSave').addEventListener('click', async () => {
    const amount = Number($('#tAmt').value);
    if (!(amount > 0)) { toast('Nominal harus > 0'); return; }
    const p = {
      transaction_date: $('#tDate').value || today(),
      amount, description: $('#tDesc').value ||
        (type === 'income' ? 'Pemasukan' : type === 'transfer' ? 'Transfer' : 'Pengeluaran'),
      account_id: $('#tAcc').value
    };
    try {
      if (type === 'income') {
        p.category_id = ($('#tCat') || {}).value || '';
        await api('tx.income', p);
      } else if (type === 'expense') {
        p.category_id = ($('#tCat') || {}).value || '';
        await api('tx.expense', p);
      } else {
        p.to_account_id = $('#tAccTo').value;
        if (p.to_account_id === p.account_id) { toast('Rekening asal & tujuan sama'); return; }
        await api('tx.transfer', p);
      }
      closeModal(); toast('✅ Transaksi tersimpan');
      await loadRefs(); render();
    } catch (e) { toast('❌ ' + e.message); }
  });
}

/* ============================ VIEW: Rekening ============================ */

async function viewAcc() {
  const v = $('#view');
  v.innerHTML = '<div class="card center">Memuat…</div>';
  const d = await api('account.list');
  const accs = d.accounts.map((a) => {
    const b = Number(a.balance);
    return '<div class="card tight" style="margin-bottom:10px"><div class="rowline" style="align-items:center;gap:10px">' +
      '<div style="min-width:0"><div class="li-title">' + esc(a.account_name) + '</div>' +
      '<div class="li-sub">' + esc(a.account_type) + ' • buku mulai ' + esc(String(a.opening_date || '').slice(0, 10)) + '</div>' +
      '<div class="amt ' + (b < 0 ? 'neg' : 'pos') + '" style="margin-top:4px">' + rp(b) + '</div></div>' +
      (a.status === 'ARCHIVED'
      ? '<span class="badge bad" style="flex-shrink:0">ARSIP</span>'
      : '<div style="display:flex;gap:8px;flex-shrink:0">' +
        '<button class="btn sm nv" data-edit="' + a.account_id + '">Edit</button>' +
        '<button class="btn sm danger nv" data-arch="' + a.account_id + '">Arsipkan</button></div>') +
      '</div></div>';
  }).join('');

  v.innerHTML =
    '<div class="card"><h3>Rekening <button id="accAdd" class="btn sm primary">+ Rekening</button></h3>' +
    '<div class="muted">Total saldo seluruh rekening: <b>' +
    rp(d.accounts.reduce((s, a) => s + (a.status === 'ACTIVE' ? Number(a.balance) : 0), 0)) + '</b></div></div>' +
    '<div style="margin-top:12px">' + accs + '</div>';

  $('#accAdd').addEventListener('click', () => {
    const m = modal('Rekening Baru',
      '<label>Nama rekening</label><input id="aName" placeholder="mis. BCA" />' +
      '<label>Jenis</label><select id="aType"><option>BANK</option><option>CASH</option><option>EWALLET</option><option>OTHER</option></select>' +
      '<label>Saldo awal (IDR)</label><input id="aBal" type="number" value="0" inputmode="numeric" />' +
      '<label>Tanggal mulai pembukuan</label><input id="aDate" type="date" value="' + today() + '" />' +
      '<button id="aSave" class="btn primary" style="margin-top:14px">Simpan</button>');
    $('#aSave').addEventListener('click', async () => {
      if (!$('#aName').value.trim()) { toast('Nama wajib diisi'); return; }
      try {
        await api('account.create', {
          account_name: $('#aName').value.trim(), account_type: $('#aType').value,
          opening_balance: Number($('#aBal').value) || 0, opening_date: $('#aDate').value
        });
        closeModal(); toast('✅ Rekening dibuat');
        await loadRefs(); render();
      } catch (e) { toast('❌ ' + e.message); }
    });
  });

  $$('[data-edit]').forEach((b) => b.addEventListener('click', () => {
    const a = accById(b.dataset.edit);
    const m = modal('Edit Rekening',
      '<label>Nama</label><input id="aName" value="' + esc(a.account_name) + '" />' +
      '<label>Jenis</label><select id="aType">' +
      ['BANK', 'CASH', 'EWALLET', 'OTHER'].map((t) =>
        '<option ' + (t === a.account_type ? 'selected' : '') + '>' + t + '</option>').join('') + '</select>' +
      '<button id="aSave" class="btn primary" style="margin-top:14px">Simpan</button>');
    $('#aSave').addEventListener('click', async () => {
      try {
        await api('account.update', { account_id: a.account_id, account_name: $('#aName').value.trim(), account_type: $('#aType').value });
        closeModal(); toast('✅ Tersimpan'); await loadRefs(); render();
      } catch (e) { toast('❌ ' + e.message); }
    });
  }));

  $$('[data-arch]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Arsipkan rekening ini? Riwayat tetap tersedia.')) return;
    try { await api('account.archive', { account_id: b.dataset.arch }); toast('📦 Diarsipkan'); render(); }
    catch (e) { toast('❌ ' + e.message); }
  }));
}

/* ============================ VIEW: Utang / Piutang ============================ */

async function viewDebt() {
  const v = $('#view');
  v.innerHTML = '<div class="card center">Memuat…</div>';
  if (!S.PERSONS.length) {
    try { S.PERSONS = (await api('person.list')).items; } catch (e) { }
  }
  const [bal, debts, recs] = await Promise.all([
    api('person.balances'), api('debt.list'), api('receivable.list')
  ]);
  S.PERSONS = bal.items;

  const tab = S.debtTab;
  const rows = tab === 'debt' ? debts.items : recs.items;
  const listHtml = rows.length ? rows.map((x) => {
    const settled = x.status === 'SETTLED';
    const pct = x.principal_amount ? Math.round(((x.principal_amount - x.remaining_amount) / x.principal_amount) * 100) : 0;
    return '<div class="card tight" style="margin-bottom:10px">' +
      '<div class="rowline"><div>' +
      '<div class="li-title">👤 ' + esc(x.person_name || '') + ' — ' + esc(x.description || '') + '</div>' +
      '<div class="li-sub">' + esc(x.debt_date || x.receivable_date || '') +
      ' • jatuh tempo ' + esc(x.due_date || '—') + '</div>' +
      '<div class="amt" style="margin:6px 0 2px">' + rp(x.remaining_amount) + ' <span class="muted">sisa dari ' + rp(x.principal_amount) + '</span></div>' +
      '</div><span class="badge ' + (settled ? 'active' : 'warn') + '">' + (settled ? 'LUNAS' : 'AKTIF') + '</span></div>' +
      '<div class="bar"><i class="' + pctColor(100 - pct) + '" style="width:' + pct + '%"></i></div>' +
      '<div class="rowline" style="margin-top:8px">' +
      '<span class="muted">' + pct + '% terbayar</span>' +
      '<div style="display:flex;gap:6px">' +
      (settled ? '' : '<button class="btn sm primary nv" data-pay="' + x[tab === 'debt' ? 'debt_id' : 'receivable_id'] + '">Bayar</button>') +
      '<button class="btn sm nv" data-rem="' + x[tab === 'debt' ? 'debt_id' : 'receivable_id'] + '" data-rt="' + (tab === 'debt' ? 'DEBT' : 'RECEIVABLE') + '">⏰</button>' +
      '</div></div></div>';
  }).join('') : '<div class="card center muted">Belum ada data.</div>';

  const personsHtml = bal.items.map((p) =>
    '<div class="li"><div class="emoji-bubble">👤</div><div class="li-main">' +
    '<div class="li-title">' + esc(p.name) + '</div>' +
    '<div class="li-sub">utang <b class="neg">' + rp(p.total_debt) + '</b> • piutang <b class="pos">' + rp(p.total_receivable) + '</b></div>' +
    '</div><button class="btn sm nv" data-person="' + p.person_id + '">Riwayat</button></div>').join('');

  v.innerHTML =
    '<div class="seg" id="dSeg">' +
    '  <button data-t="debt" class="' + (tab === 'debt' ? 'on' : '') + '">Utang (saya berutang)</button>' +
    '  <button data-t="receivable" class="' + (tab === 'receivable' ? 'on' : '') + '">Piutang (dipinjam)</button>' +
    '</div>' +
    '<div class="card" style="margin-top:12px"><h3>' + (tab === 'debt' ? 'Daftar Utang' : 'Daftar Piutang') +
    ' <button id="dAdd" class="btn sm primary">+ Catat</button></h3>' + listHtml + '</div>' +
    '<div class="sect">Per Orang</div><div class="card">' + (personsHtml || '<p class="muted">—</p>') + '</div>';

  $$('#dSeg button').forEach((b) => b.addEventListener('click', () => {
    S.debtTab = b.dataset.t; render();
  }));

  $('#dAdd').addEventListener('click', () => {
    const isDebt = tab === 'debt';
    const accOpts = S.ACCS.map((a) => '<option value="' + a.account_id + '">' + esc(a.account_name) + '</option>').join('');
    const perOpts = S.PERSONS.map((p) => '<option value="' + p.person_id + '">' + esc(p.name) + '</option>').join('');
    modal(isDebt ? 'Catat Utang (terima pinjaman)' : 'Catat Piutang (pinjam uang)',
      '<label>Orang</label><select id="wPer"><option value="">— pilih / buat baru —</option>' + perOpts + '</select>' +
      '<label id="wPerLabel">Nama orang</label><input id="wPerName" placeholder="mis. Budi" />' +
      '<label>Nominal (IDR)</label><input id="wAmt" type="number" inputmode="numeric" placeholder="0" />' +
      '<label>Rekening ' + (isDebt ? 'penerima dana' : 'asal dana') + '</label><select id="wAcc">' + accOpts + '</select>' +
      '<label>Tanggal</label><input id="wDate" type="date" value="' + today() + '" />' +
      '<label>Jatuh tempo</label><input id="wDue" type="date" />' +
      '<label>Keterangan</label><input id="wDesc" placeholder="mis. modal usaha" />' +
      '<button id="wSave" class="btn primary" style="margin-top:14px">Simpan</button>');
    $('#wPer').addEventListener('change', () => {
      const p = S.PERSONS.find((x) => x.person_id === $('#wPer').value);
      $('#wPerName').value = p ? p.name : '';
    });
    $('#wSave').addEventListener('click', async () => {
      const amount = Number($('#wAmt').value);
      if (!(amount > 0)) { toast('Nominal > 0'); return; }
      if (!$('#wPer').value && !$('#wPerName').value.trim()) { toast('Nama orang wajib diisi / piilih'); return; }
      const payload = {
        amount, account_id: $('#wAcc').value,
        person_id: $('#wPer').value || undefined,
        person_name: $('#wPer').value ? undefined : $('#wPerName').value.trim(),
        [isDebt ? 'debt_date' : 'receivable_date']: $('#wDate').value,
        due_date: $('#wDue').value || undefined,
        description: $('#wDesc').value || ''
      };
      try {
        await api(isDebt ? 'debt.create' : 'receivable.create', payload);
        closeModal(); toast('✅ Tercatat (bukan income/expense)'); render();
      } catch (e) { toast('❌ ' + e.message); }
    });
  });

  $$('[data-pay]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.pay;
    const accOpts = S.ACCS.map((a) => '<option value="' + a.account_id + '">' + esc(a.account_name) + '</option>').join('');
    modal('Pembayaran (nominal bebas)',
      '<label>Nominal (IDR)</label><input id="pAmt" type="number" inputmode="numeric" placeholder="0" />' +
      '<label>Rekening</label><select id="pAcc">' + accOpts + '</select>' +
      '<label>Tanggal</label><input id="pDate" type="date" value="' + today() + '" />' +
      '<label>Catatan</label><input id="pNotes" placeholder="mis. cicilan ke-2" />' +
      '<button id="pSave" class="btn primary" style="margin-top:14px">Simpan Pembayaran</button>');
    $('#pSave').addEventListener('click', async () => {
      const amount = Number($('#pAmt').value);
      if (!(amount > 0)) { toast('Nominal > 0'); return; }
      try {
        const r = await api('payment.record', {
          kind: S.debtTab, id, amount,
          account_id: $('#pAcc').value, payment_date: $('#pDate').value,
          notes: $('#pNotes').value || ''
        });
        closeModal();
        toast(r.settled ? '🎉 LUNAS!' : '✅ Sisa: ' + rp(r.new_remaining));
        render();
      } catch (e) { toast('❌ ' + e.message); }
    });
  }));

  $$('[data-rem]').forEach((b) => b.addEventListener('click', () => {
    modal('Pengingat Telegram',
      '<label>Hari sebelum jatuh tempo</label><input id="rBefore" type="number" value="3" min="0" />' +
      '<label>Kirim di hari jatuh tempo</label><select id="rOnDue"><option value="true">Ya</option><option value="false">Tidak</option></select>' +
      '<label>Kirim tiap N hari setelah telat</label><input id="rAfter" type="number" value="1" min="0" />' +
      '<button id="rSave" class="btn primary" style="margin-top:14px">Simpan Pengingat</button>');
    $('#rSave').addEventListener('click', async () => {
      try {
        await api('telegram.reminder.set', {
          ref_type: b.dataset.rt, ref_id: b.dataset.rem,
          days_before: Number($('#rBefore').value) || 0,
          send_on_due: $('#rOnDue').value === 'true',
          send_after_days: Number($('#rAfter').value) || 0
        });
        closeModal(); toast('✅ Pengingat diatur');
      } catch (e) { toast('❌ ' + e.message); }
    });
  }));

  $$('[data-person]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const d = await api('person.detail', { person_id: b.dataset.person });
      const hist = d.payment_history.map((h) =>
        '<div class="li"><div class="li-main"><div class="li-title">' + rp(h.amount) + '</div>' +
        '<div class="li-sub">' + esc(h.payment_date) + (h.notes ? ' • ' + esc(h.notes) : '') + '</div></div></div>').join('')
        || '<p class="muted">—</p>';
      modal('Riwayat: ' + (d.person.name || ''),
        '<div class="rowline" style="margin-bottom:8px"><span>Utang aktif</span><b>' + rp(d.total_debt) + '</b></div>' +
        '<div class="rowline" style="margin-bottom:8px"><span>Piutang aktif</span><b>' + rp(d.total_receivable) + '</b></div>' +
        '<div class="sect" style="margin-top:14px">Riwayat Pembayaran</div><div class="card">' + hist + '</div>');
    } catch (e) { toast('❌ ' + e.message); }
  }));
}

/* ============================ VIEW: Laporan ============================ */

async function viewRep() {
  const v = $('#view');
  v.innerHTML =
    '<div class="card"><div class="seg">' +
    ['daily:Harian', 'weekly:Mingguan', 'monthly:Bulanan', 'yearly:Tahunan'].map((s) => {
      const [k, l] = s.split(':');
      return '<button data-p="' + k + '" class="' + (k === S.repPeriod.period ? 'on' : '') + '">' + l + '</button>';
    }).join('') + '</div>' +
    '<div class="toolrow" style="margin-top:10px">' +
    '<input id="rFrom" type="date" value="' + (S.repPeriod.from || '') + '" />' +
    '<input id="rTo" type="date" value="' + (S.repPeriod.to || '') + '" />' +
    '</div><button id="rGo" class="btn primary block">Tampilkan</button>' +
    '<button id="rCsv" class="btn ghost block" style="margin-top:8px">⬇ Ekspor CSV</button></div>' +
    '<div id="repOut" style="margin-top:12px"><div class="card center">Memuat…</div></div>';

  $$('.seg button[data-p]', v).forEach((b) => b.addEventListener('click', () => {
    S.repPeriod = { period: b.dataset.p, from: '', to: '' };
    $('#rFrom').value = ''; $('#rTo').value = '';
    $$('.seg button[data-p]', v).forEach((x) => x.classList.toggle('on', x === b));
    renderRepOut();
  }));
  $('#rGo').addEventListener('click', () => {
    S.repPeriod = { period: 'custom', from: $('#rFrom').value, to: $('#rTo').value };
    renderRepOut();
  });
  $('#rCsv').addEventListener('click', exportCsv);

  renderRepOut();
}

async function renderRepOut() {
  const out = $('#repOut');
  out.innerHTML = '<div class="card center">Memuat…</div>';
  const p = S.repPeriod.period === 'custom' && S.repPeriod.from && S.repPeriod.to
    ? { period: 'custom', from: S.repPeriod.from, to: S.repPeriod.to }
    : { period: S.repPeriod.period };
  let d;
  try { d = await api('report.get', p); } catch (e) { out.innerHTML = '<div class="card">❌ ' + esc(e.message) + '</div>'; return; }

  const maxCat = Math.max(1, ...Object.values(d.by_category));
  const catBars = Object.entries(d.by_category).sort((a, b) => b[1] - a[1]).map(([k, val]) =>
    '<div class="rep-bar"><span>' + esc(k) + '</span>' +
    '<div class="track exp"><i style="width:' + Math.round((val / maxCat) * 100) + '%"></i></div>' +
    '<b>' + rp(val) + '</b></div>').join('') || '<p class="muted">—</p>';

  const accRows = Object.entries(d.by_account).map(([k, val]) =>
    '<div class="rowline"><span>' + esc(k) + '</span><span>' +
    '<b class="pos">+' + rp(val.income) + '</b> <b class="neg">−' + rp(val.expense) + '</b></span></div>').join('') || '<p class="muted">—</p>';

  lastRepCsv = d;
  out.innerHTML =
    '<div class="card"><h3>Ringkasan <span class="muted">' + esc(d.period.from) + ' → ' + esc(d.period.to) + '</span></h3>' +
    '<div class="grid grid2">' +
    '<div><div class="muted">Pemasukan</div><div class="amt pos">+' + rp(d.totals.income) + '</div></div>' +
    '<div><div class="muted">Pengeluaran</div><div class="amt neg">−' + rp(d.totals.expense) + '</div></div>' +
    '<div><div class="muted">Saldo bersih</div><div class="amt">' + rpS(d.totals.net) + '</div></div>' +
    '<div><div class="muted">Jumlah transaksi</div><div class="amt">' + d.totals.transaction_count + '</div></div>' +
    '<div><div class="muted">Total utang</div><div class="amt neg">' + rp(d.totals.total_debt) + '</div></div>' +
    '<div><div class="muted">Total piutang</div><div class="amt pos">' + rp(d.totals.total_receivable) + '</div></div>' +
    '</div></div>' +
    '<div class="card" style="margin-top:12px"><h3>Pengeluaran per Kategori</h3>' + catBars + '</div>' +
    '<div class="card" style="margin-top:12px"><h3>Per Rekening</h3>' + accRows + '</div>' +
    '<div class="card" style="margin-top:12px"><h3>Anggaran Periode Ini</h3>' +
    ((d.budget_status || []).map((b) =>
      '<div class="rowline"><span>' + esc(b.category_name) + '</span><span>' + b.percent_used + '% (' + rp(b.actual_amount) + ' / ' + rp(b.budget_amount) + ')</span></div>').join('')
      || '<p class="muted">Tidak ada anggaran.</p>') + '</div>';
}

let lastRepCsv = null;
function exportCsv() {
  if (!lastRepCsv) { toast('Tampilkan laporan dulu'); return; }
  api('report.export', S.repPeriod.period === 'custom'
    ? { period: 'custom', from: S.repPeriod.from, to: S.repPeriod.to }
    : S.repPeriod).then((d) => {
      const blob = new Blob(['\uFEFF' + d.content], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = d.filename; a.click();
      URL.revokeObjectURL(a.href);
      toast('⬇ ' + d.filename);
    }).catch((e) => toast('❌ ' + e.message));
}

/* ============================ VIEW: More (hub) ============================ */

function viewMore() {
  const cell = (href, icon, title, sub) =>
    '<a class="card tight" style="text-decoration:none;color:inherit;margin-bottom:10px" href="#/' + href + '">' +
    '<div class="li" style="border:none;padding:0"><div class="emoji-bubble">' + icon + '</div>' +
    '<div><div class="li-title">' + title + '</div><div class="li-sub">' + sub + '</div></div></div></a>';
  $('#view').innerHTML =
    '<div class="sect">Menu</div>' +
    cell('budget', '🎯', 'Anggaran', 'Anggaran bulanan per kategori') +
    cell('cats', '🏷️', 'Kategori', 'Kategori & subkategori') +
    cell('rec', '🔁', 'Transaksi Berulang', 'Jadwal + draft menunggu konfirmasi') +
    cell('backup', '☁️', 'Backup & Restore', 'Backup harian ke Drive') +
    cell('set', '⚙️', 'Pengaturan', 'Web App URL, PIN, Telegram, keluar') +
    '<div style="height:8px"></div>';
}

/* ============================ VIEW: Anggaran ============================ */

async function viewBudget() {
  const v = $('#view');
  const ym = today().substring(0, 7);
  const d = await api('budget.status', { month: Number(ym.slice(5, 7)), year: Number(ym.slice(0, 4)) });
  const rows = d.items.map((b) =>
    '<div class="progress-row"><div class="rowline"><span class="li-title">' + esc(b.category_name) +
    '</span><span class="muted">' + rp(b.actual_amount) + ' / ' + rp(b.budget_amount) + '</span></div>' +
    '<div class="bar"><i class="' + pctColor(b.percent_used) + '" style="width:' + Math.min(100, b.percent_used) + '%"></i></div>' +
    '<span class="muted">' + b.percent_used + '% • sisa ' + rp(b.remaining) + '</span></div>').join('')
    || '<p class="muted">Belum ada anggaran bulan ini.</p>';
  $('#view').innerHTML =
    '<div class="card"><h3>Anggaran ' + ym +
    ' <button id="bAdd" class="btn sm primary">+ Anggaran</button></h3>' + rows + '</div>' +
    '<p class="tiny center" style="margin-top:10px">Banding antar bulan bisa via laporan → anggaran periode.</p>';

  $('#bAdd').addEventListener('click', () => {
    const catOpts = S.CATS.filter((c) => c.type === 'EXPENSE' && String(c.is_active).toUpperCase() !== 'FALSE')
      .map((c) => '<option value="' + c.category_id + '">' + esc(c.name) + '</option>').join('');
    modal('Anggaran Baru / Ubah',
      '<label>Bulan</label><input id="bM" type="number" min="1" max="12" value="' + Number(ym.slice(5, 7)) + '" />' +
      '<label>Tahun</label><input id="bY" type="number" value="' + Number(ym.slice(0, 4)) + '" />' +
      '<label>Kategori (pengeluaran)</label><select id="bC">' + catOpts + '</select>' +
      '<label>Nominal anggaran</label><input id="bA" type="number" inputmode="numeric" placeholder="0" />' +
      '<button id="bSave" class="btn primary" style="margin-top:14px">Simpan</button>');
    $('#bSave').addEventListener('click', async () => {
      try {
        await api('budget.save', { month: Number($('#bM').value), year: Number($('#bY').value), category_id: $('#bC').value, budget_amount: Number($('#bA').value) });
        closeModal(); toast('✅ Anggaran tersimpan'); render();
      } catch (e) { toast('❌ ' + e.message); }
    });
  });
}

/* ============================ VIEW: Kategori ============================ */

async function viewCats() {
  const d = await api('category.list');
  const rows = d.items.map((c) =>
    '<div class="li"><div class="emoji-bubble">' + esc(c.icon || (c.type === 'INCOME' ? '💰' : '🏷️')) + '</div>' +
    '<div class="li-main"><div class="li-title">' + esc(c.name) +
    (c.parent_id ? ' <span class="muted">(sub)</span>' : '') + '</div>' +
    '<div class="li-sub">' + esc(c.type) + '</div></div>' +
    '<span class="badge ' + (String(c.is_active).toUpperCase() === 'FALSE' ? 'bad' : 'active') + '">' +
    (String(c.is_active).toUpperCase() === 'FALSE' ? 'NONAKTIF' : 'AKTIF') + '</span>' +
    '<button class="btn sm nv" data-cat="' + c.category_id + '">⚙</button></div>').join('');
  $('#view').innerHTML =
    '<div class="card"><h3>Kategori <button id="cAdd" class="btn sm primary">+ Kategori</button></h3>' +
    '<div class="muted">Kategori yang sudah dipakai tidak dapat dihapus — jadikan nonaktif saja.</div>' + rows + '</div>';

  $('#cAdd').addEventListener('click', () => {
    const parents = d.items.filter((c) => !c.parent_id)
      .map((c) => '<option value="' + c.category_id + '">' + esc(c.name) + '</option>').join('');
    modal('Kategori Baru',
      '<label>Nama</label><input id="cName" />' +
      '<label>Tipe</label><select id="cType"><option>EXPENSE</option><option>INCOME</option></select>' +
      '<label>Kategori induk (opsional — jadinya subkategori)</label><select id="cPar"><option value="">—</option>' + parents + '</select>' +
      '<label>Ikon (emoji)</label><input id="cIcon" placeholder="🏷️" maxlength="4" />' +
      '<button id="cSave" class="btn primary" style="margin-top:14px">Simpan</button>');
    $('#cSave').addEventListener('click', async () => {
      try {
        await api('category.save', {
          name: $('#cName').value.trim(), type: $('#cType').value,
          parent_id: $('#cPar').value || '', icon: $('#cIcon').value || ''
        });
        closeModal(); toast('✅ Kategori dibuat'); await loadRefs(); render();
      } catch (e) { toast('❌ ' + e.message); }
    });
  });

  $$('[data-cat]').forEach((b) => b.addEventListener('click', () => {
    const c = d.items.find((x) => x.category_id === b.dataset.cat);
    modal('Ubah Kategori',
      '<label>Nama</label><input id="cName" value="' + esc(c.name) + '" />' +
      '<label>Status</label><select id="cAct"><option value="true">Aktif</option><option value="false">Nonaktif</option></select>' +
      '<label>Ikon (emoji)</label><input id="cIcon" value="' + esc(c.icon || '') + '" maxlength="4" />' +
      '<button id="cSave" class="btn primary" style="margin-top:14px">Simpan</button>');
    $('#cAct').value = String(c.is_active).toUpperCase() === 'FALSE' ? 'false' : 'true';
    $('#cSave').addEventListener('click', async () => {
      try {
        await api('category.save', {
          category_id: c.category_id, name: $('#cName').value.trim(),
          type: c.type, is_active: $('#cAct').value === 'true', icon: $('#cIcon').value || ''
        });
        closeModal(); toast('✅ Tersimpan'); await loadRefs(); render();
      } catch (e) { toast('❌ ' + e.message); }
    });
  }));
}

/* ============================ VIEW: Recurring ============================ */

async function viewRec() {
  const v = $('#view');
  const [recs, drafts] = await Promise.all([
    api('recurring.list'), api('draft.list', { status: 'PENDING' })
  ]);
  const draftRows = drafts.items.map((d) =>
    '<div class="card tight" style="margin-bottom:10px">' +
    '<div class="rowline"><div>' +
    '<div class="li-title">' + esc(d.description || '(tanpa keterangan)') + '</div>' +
    '<div class="li-sub">rencana ' + esc(d.planned_date) + ' • ' + esc(accName(d.account_id)) + '</div>' +
    '<div class="amt" style="margin-top:4px">' + rp(d.amount) + '</div></div>' +
    '<span class="badge warn">PENDING</span></div>' +
    '<div class="rowline" style="margin-top:8px"><span class="muted">Draft tidak memengaruhi saldo sampai dikonfirmasi</span>' +
    '<div style="display:flex;gap:6px">' +
    '<button class="btn sm nv" data-ed="' + d.draft_id + '">✎</button>' +
    '<button class="btn sm nv" data-sk="' + d.draft_id + '">Lewati</button>' +
    '<button class="btn sm primary nv" data-cf="' + d.draft_id + '">Konfirmasi</button>' +
    '</div></div></div>').join('')
    || '<p class="muted">Tidak ada draft menunggu. 🎉</p>';

  const recRows = recs.items.map((r) =>
    '<div class="li"><div class="emoji-bubble">' + (r.transaction_type === 'INCOME' ? '💰' : '💸') + '</div>' +
    '<div class="li-main"><div class="li-title">' + esc(r.description || r.transaction_type) + '</div>' +
    '<div class="li-sub">' + esc(r.frequency) + (r.next_run_date ? ' • berikutnya: ' + esc(r.next_run_date) : '') + '</div></div>' +
    '<span class="badge ' + (String(r.is_active).toUpperCase() === 'TRUE' ? 'active' : 'bad') + '">' +
    (String(r.is_active).toUpperCase() === 'TRUE' ? 'AKTIF' : 'MATI') + '</span>' +
    '<button class="btn sm nv" data-tg="' + r.recurring_id + '">' + (String(r.is_active).toUpperCase() === 'TRUE' ? 'Matikan' : 'Aktifkan') + '</button></div>').join('');

  $('#view').innerHTML =
    '<div class="card"><h3>Draft Menunggu Konfirmasi <button id="rcAdd" class="btn sm primary">+ Jadwal</button></h3>' +
    draftRows + '</div>' +
    '<div class="sect">Jadwal Aktif</div><div class="card">' + recRows + '</div>';

  $$('[data-tg]').forEach((b) => b.addEventListener('click', async () => {
    try { await api('recurring.toggle', { recurring_id: b.dataset.tg }); toast('✅ Diubah'); render(); }
    catch (e) { toast('❌ ' + e.message); }
  }));
  $$('[data-sk]').forEach((b) => b.addEventListener('click', async () => {
    try { await api('draft.skip', { draft_id: b.dataset.sk }); toast('⏭️ Dilewati'); render(); }
    catch (e) { toast('❌ ' + e.message); }
  }));
  $$('[data-cf]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const r = await api('draft.confirm', { draft_id: b.dataset.cf });
      toast(r.already_confirmed ? 'Sudah dikonfirmasi sebelumnya' : '✅ Transaksi dibuat');
    } catch (e) { toast('❌ ' + e.message); }
    render();
  }));
  $$('[data-ed]').forEach((b) => b.addEventListener('click', async () => {
    const d = drafts.items.find((x) => x.draft_id === b.dataset.ed);
    const accOpts = S.ACCS.map((a) => '<option ' + (a.account_id === d.account_id ? 'selected' : '') +
      ' value="' + a.account_id + '">' + esc(a.account_name) + '</option>').join('');
    modal('Edit Draft',
      '<label>Nominal</label><input id="eA" type="number" value="' + d.amount + '" />' +
      '<label>Tanggal transaksi</label><input id="eD" type="date" value="' + esc((d.transaction_date || '').slice(0, 10)) + '" />' +
      '<label>Rekening</label><select id="eAcc">' + accOpts + '</select>' +
      '<label>Keterangan</label><input id="eDesc" value="' + esc(d.description) + '" />' +
      '<button id="eSave" class="btn primary" style="margin-top:14px">Simpan</button>');
    $('#eSave').addEventListener('click', async () => {
      try {
        await api('draft.edit', {
          draft_id: d.draft_id, amount: Number($('#eA').value),
          transaction_date: $('#eD').value, account_id: $('#eAcc').value,
          description: $('#eDesc').value
        });
        closeModal(); toast('✅ Draft diubah'); render();
      } catch (e) { toast('❌ ' + e.message); }
    });
  }));

  $('#rcAdd').addEventListener('click', () => {
    const accOpts = S.ACCS.map((a) => '<option value="' + a.account_id + '">' + esc(a.account_name) + '</option>').join('');
    const catOpts = S.CATS.map((c) => '<option value="' + c.category_id + '">' + esc(c.name) + '</option>').join('');
    modal('Jadwal Berulang Baru',
      '<label>Jenis</label><select id="rT"><option>EXPENSE</option><option>INCOME</option></select>' +
      '<label>Keterangan</label><input id="rDesc" placeholder="mis. Langganan internet" />' +
      '<label>Nominal</label><input id="rA" type="number" inputmode="numeric" placeholder="0" />' +
      '<label>Rekening</label><select id="rAcc">' + accOpts + '</select>' +
      '<label>Kategori</label><select id="rC"><option value="">—</option>' + catOpts + '</select>' +
      '<label>Frekuensi</label><select id="rF"><option value="monthly">Bulanan</option><option value="weekly">Mingguan</option><option value="daily">Harian</option><option value="yearly">Tahunan</option></select>' +
      '<label>Mulai tanggal</label><input id="rS" type="date" value="' + today() + '" />' +
      '<label>Berakhir (opsional)</label><input id="rE" type="date" />' +
      '<button id="rSave" class="btn primary" style="margin-top:14px">Simpan Jadwal</button>');
    $('#rSave').addEventListener('click', async () => {
      try {
        await api('recurring.create', {
          transaction_type: $('#rT').value, description: $('#rDesc').value,
          amount: Number($('#rA').value), account_id: $('#rAcc').value,
          category_id: $('#rC').value || '', frequency: $('#rF').value,
          start_date: $('#rS').value, end_date: $('#rE').value || ''
        });
        closeModal(); toast('✅ Jadwal dibuat — draft akan muncul otomatis'); render();
      } catch (e) { toast('❌ ' + e.message); }
    });
  });
}

/* ============================ VIEW: Backup ============================ */

async function viewBackup() {
  const d = await api('backup.list');
  const rows = d.items.map((b) =>
    '<div class="li"><div class="emoji-bubble">☁️</div>' +
    '<div class="li-main"><div class="li-title">' + esc(b.file_name) + '</div>' +
    '<div class="li-sub">' + esc(b.created_at) + ' • ' + esc(b.type) + '</div></div>' +
    '<span class="badge ' + (b.status === 'SUCCESS' || b.type === 'AUTO' || b.type === 'MANUAL' ? 'active' : 'bad') + '">' +
    esc(String(b.status).slice(0, 6).toUpperCase()) + '</span>' +
    (b.status === 'SUCCESS'
      ? '<button class="btn sm nv" data-rs="' + b.backup_id + '">Restore</button>' : '') +
    '</div>').join('');
  $('#view').innerHTML =
    '<div class="card"><h3>Backup ke Google Drive <button id="bkGo" class="btn sm primary">Backup Sekarang</button></h3>' +
    '<p class="muted" style="margin-bottom:10px">Backup harian otomatis berjalan dari trigger harian backend (06:00).</p>' + rows + '</div>' +
    '<p class="tiny center" style="margin-top:10px">Restore membuat backup pengaman dulu dan butuh konfirmasi eksplisit.</p>';

  $('#bkGo').addEventListener('click', async () => {
    try { const r = await api('backup.create'); toast('☁️ ' + r.file_name); render(); }
    catch (e) { toast('❌ ' + e.message); }
  });
  $$('[data-rs]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.rs;
    try {
      const pv = await api('backup.preview', { backup_id: id });
      const rowsInfo = Object.entries(pv.rows).filter(([, n]) => n > 0)
        .map(([k, n]) => k + ': ' + n + ' baris').join(', ');
      if (!confirm('RESTORE akan MENIMPA seluruh data sekarang dengan backup ini!\n\nIsi: ' + rowsInfo +
        '\n\nBackup kondisi sekarang dibuat otomatis dulu.\n\nLanjutkan?')) return;
      const r = await api('backup.restore', { backup_id: id, restore_confirmed: true });
      toast('✅ Restore selesai'); await loadRefs(); render();
    } catch (e) { toast('❌ ' + e.message); }
  }));
}

/* ============================ VIEW: Pengaturan ============================ */

function viewSet() {
  const noLogin = !S.TOKEN;
  $('#view').innerHTML =
    '<div class="grid">' +

    '<div class="card"><h3>🔌 Backend (Apps Script)</h3>' +
    '<label>Web App URL (…/exec)</label><input id="sApi" value="' + esc(S.API) + '" placeholder="https://script.google.com/macros/s/…/exec" />' +
    '<button id="sApiSave" class="btn primary" style="margin-top:12px">Simpan URL</button>' +
    '<p class="tiny">Ambil dari Deploy ▸ Manage deployments di editor Apps Script. Wajib diakhiri <b>/exec</b>.<br>' +
    (noLogin ? '💡 Simpan dulu URL ini, baru login dengan PIN.' : '') + '</p></div>' +

    (noLogin ? '' :
    '<div class="card"><h3>🔑 Ganti PIN</h3>' +
    '<label>PIN lama</label><input id="sOld" type="password" inputmode="numeric" maxlength="8" />' +
    '<label>PIN baru (4–8 digit)</label><input id="sNew" type="password" inputmode="numeric" maxlength="8" />' +
    '<button id="sPin" class="btn primary" style="margin-top:12px">Ganti PIN</button></div>') +

    '<div class="card"><h3>📨 Telegram</h3>' +
    '<label>Bot token</label><input id="sTgT" type="password" placeholder="123456:ABC…" />' +
    '<label>Chat ID</label><input id="sTgC" inputmode="numeric" placeholder="104xxxxxxx" />' +
    '<div style="display:flex;gap:8px;margin-top:12px">' +
    '<button id="sTgSave" class="btn primary">Simpan</button>' +
    '<button id="sTgTest" class="btn ghost">Test Kirim</button></div>' +
    '<p class="tiny">Ambil chat_id: kirim 1 pesan ke bot Anda, buka api.telegram.org/bot&lt;TOKEN&gt;/getUpdates.</p></div>' +

    (noLogin ? '' :
    '<div class="card"><h3>🚪 Sesi</h3><button id="sOut" class="btn danger block">Keluar (Logout)</button></div>') +

    '</div>' +
    '<p class="tiny center" style="margin-top:16px">Finora v1.1 • Backend Google Apps Script • PRD v1.1</p>';

  $('#sApiSave').addEventListener('click', () => {
    S.API = $('#sApi').value.trim().replace(/\?.*$/, '');
    if (!/^https:\/\/script\.google\.com\/macros\/s\//.test(S.API)) {
      toast('⚠️ URL harus bentuk https://script.google.com/macros/s/…/exec'); return;
    }
    localStorage.setItem('finora_api', S.API);
    toast('✅ URL disimpan' + (S.TOKEN ? '' : ' — silakan login'));
    if (S.TOKEN) bootApp(); else route();
  });

  $('#sPin').addEventListener('click', async () => {
    try {
      await api('auth.change_pin', { old_pin: $('#sOld').value.trim(), new_pin: $('#sNew').value.trim() });
      toast('✅ PIN diganti'); $('#sOld').value = ''; $('#sNew').value = '';
    } catch (e) { toast('❌ ' + e.message); }
  });

  $('#sTgSave').addEventListener('click', async () => {
    try {
      await api('telegram.set', { bot_token: $('#sTgT').value.trim(), chat_id: $('#sTgC').value.trim() });
      toast('✅ Telegram disimpan (backend)');
    } catch (e) { toast('❌ ' + e.message); }
  });
  $('#sTgTest').addEventListener('click', async () => {
    try {
      await api('telegram.set', { bot_token: $('#sTgT').value.trim(), chat_id: $('#sTgC').value.trim() });
      await api('telegram.test');
      toast('📨 Terkirim — cek Telegram Anda');
    } catch (e) { toast('❌ ' + e.message); }
  });

  $('#sOut').addEventListener('click', doLogout);
}

/* ============================ Start ============================ */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.register('./sw.js').catch(() => { }));
}

(async function init() {
  if (!S.TOKEN) { showLogin(); return; }
  try {
    await api('auth.check');
    await bootApp();
  } catch (e) {
    showLogin(); // sesi kedaluwarsa / belum ada API
  }
})();
