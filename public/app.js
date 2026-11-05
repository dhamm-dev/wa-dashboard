const $ = id => document.getElementById(id);
let accounts = [], templates = [], destinations = [], active = false, editing = null;
let accountsRequest = 0, renderedAccounts = null;
let destinationsRequest = 0, destinationAccount = '', groupError = '', contactError = '', destinationsLoading = false, sessionVersion = 0;
let eventCursor = null, eventPolling = false, notifications = [];
const statusNames = { pending: 'Diproses', success: 'Berhasil', failed: 'Gagal', missed: 'Terlewat', connected: 'Terhubung', disconnected: 'Terputus', connecting: 'Menghubungkan', qr: 'Menunggu QR', logged_out: 'Sesi keluar' };
const notice = text => { $('notice').textContent = text; };
async function api(url, options = {}) {
  const version = sessionVersion;
  const headers = { 'X-Dashboard-Request': '1', ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData)) { headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(options.body); }
  const response = await fetch(url, { ...options, headers });
  const data = await response.json();
  if (version !== sessionVersion) throw new Error('Sesi berubah');
  if (response.status === 401 && active) showDashboard(false);
  if (!response.ok) throw new Error(data.error || 'Permintaan gagal');
  return data;
}
function option(select, value, label) { const o = document.createElement('option'); o.value = value; o.textContent = label; select.append(o); }
function replaceOptions(select, items, empty) {
  const previous = select.value;
  select.replaceChildren(); option(select, '', empty);
  items.forEach(i => option(select, i.value, i.label));
  if (items.some(i => i.value === previous)) select.value = previous;
}
function row(container, title, details = []) {
  const div = document.createElement('div'); div.className = 'row';
  const strong = document.createElement('strong'); strong.textContent = title; div.append(strong);
  details.forEach(t => { const p = document.createElement('p'); p.textContent = t; div.append(p); });
  container.append(div); return div;
}
function action(parent, label, handler) {
  const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
  b.addEventListener('click', () => run(handler)); parent.append(b);
}
function run(fn) { const version = sessionVersion; return Promise.resolve().then(fn).catch(e => { if (active && version === sessionVersion) notice(e.message); }); }
const post = (url, body) => api(url, { method: 'POST', body });
const remove = url => api(url, { method: 'DELETE' });
const date = s => s ? new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(s)) + ' WIB' : '';
function applyTheme() {
  const choice = $('theme').value;
  document.documentElement.dataset.theme = choice === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : choice;
}
$('theme').value = localStorage.getItem('wa-theme') || 'system'; applyTheme();
$('theme').addEventListener('change', () => { localStorage.setItem('wa-theme', $('theme').value); applyTheme(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
function showDashboard(yes) { active = yes; sessionVersion++; eventCursor = null; eventPolling = false; notifications = []; if (!yes) { accountsRequest++; destinationsRequest++; accounts = []; templates = []; destinations = []; destinationAccount = ''; renderedAccounts = null; editing = null; for (const id of ['accounts-list', 'contacts-list', 'destination-list', 'templates-list', 'schedules-list', 'history-list', 'notification-list']) $(id).replaceChildren(); for (const id of ['message-form', 'account-form', 'contact-form', 'template-form', 'schedule-edit-form', 'filters', 'schedule-filters']) $(id).reset?.(); $('at').required = false; $('schedule-time').hidden = true; $('schedule-options').open = false; for (const id of ['account', 'filter-account', 'schedule-filter-account', 'edit-account', 'template-select']) $(id).replaceChildren(); $('destination').value = ''; $('notice').textContent = ''; $('notification-count').textContent = ''; $('destination-selected').textContent = 'Belum ada tujuan dipilih.'; $('destination-status').textContent = 'Pilih akun untuk melihat tujuan.'; $('edit-attachment').textContent = ''; $('schedule-editor').hidden = true; $('notifications').open = false; } $('login').hidden = yes; $('dashboard').hidden = !yes; $('logout').hidden = !yes; }
async function loadAccounts() {
  const request = ++accountsRequest;
  const result = await api('/api/accounts');
  if (!active || request !== accountsRequest) return;
  accounts = result;
  const snapshot = JSON.stringify(accounts);
  if (snapshot === renderedAccounts) return;
  renderedAccounts = snapshot;
  const choices = accounts.map(a => ({ value: a.id, label: `${a.name} (${statusNames[a.status] || a.status})` }));
  replaceOptions($('account'), choices, 'Pilih akun');
  replaceOptions($('filter-account'), choices, 'Semua akun');
  replaceOptions($('schedule-filter-account'), choices, 'Semua akun');
  replaceOptions($('edit-account'), choices, 'Pilih akun');
  const list = $('accounts-list'); list.replaceChildren();
  if (!accounts.length) list.textContent = 'Belum ada akun. Tambahkan akun untuk memperoleh QR.';
  for (const a of accounts) {
    const div = row(list, a.name, [statusNames[a.status] || a.status]);
    if (a.qr) { const img = document.createElement('img'); img.src = a.qr; img.width = 320; img.height = 320; img.className = 'account-qr'; img.alt = `QR untuk menghubungkan ${a.name}`; div.append(img); }
    if (a.status === 'disconnected') action(div, 'Hubungkan', async () => { await post(`/api/accounts/${a.id}/connect`, {}); await loadAccounts(); });
    if (a.status === 'logged_out') action(div, 'Tautkan ulang', async () => { await post(`/api/accounts/${a.id}/repair`, {}); await loadAccounts(); });
  }
}
async function loadDestinations() {
  const request = ++destinationsRequest;
  const id = $('account').value; const list = $('contacts-list'); list.replaceChildren(); destinations = []; groupError = ''; contactError = '';
  if (destinationAccount !== id) { $('destination').value = ''; $('destination-search').value = ''; $('destination-dropdown').open = false; destinationAccount = id; }
  destinationsLoading = Boolean(id);
  renderDestinations();
  if (!id) { list.textContent = 'Pilih akun untuk melihat kontak.'; return; }
  list.textContent = 'Memuat kontak...'; $('destination-status').textContent = 'Memuat tujuan...';
  const connected = accounts.find(a => a.id === id)?.status === 'connected';
  const [localResult, waResult, groupResult] = await Promise.allSettled([
    api(`/api/contacts?accountId=${encodeURIComponent(id)}`),
    connected ? api(`/api/accounts/${encodeURIComponent(id)}/whatsapp-contacts`) : Promise.resolve([]),
    connected ? api(`/api/accounts/${encodeURIComponent(id)}/groups`) : Promise.resolve([])
  ]);
  if (request !== destinationsRequest || !active || $('account').value !== id) return;
  destinationsLoading = false;
  const contacts = localResult.status === 'fulfilled' ? localResult.value : [];
  const waContacts = waResult.status === 'fulfilled' ? waResult.value : [];
  if (localResult.status === 'rejected' || waResult.status === 'rejected') contactError = 'Sebagian kontak gagal dimuat. Perbarui data untuk mencoba lagi.';
  if (groupResult.status === 'rejected') groupError = 'Grup gagal dimuat. Perbarui data untuk mencoba lagi.';
  list.replaceChildren();
  const merged = new Map(waContacts.map(c => [c.jid, { value: c.jid, name: c.name, type: 'contact' }]));
  for (const c of contacts) merged.set(c.jid, { value: c.jid, name: c.name, type: 'contact' });
  destinations = [...merged.values()];
  if (groupResult.status === 'fulfilled') destinations.push(...groupResult.value.map(g => ({ value: g.jid, name: g.name, type: 'group' })));
  if (!contacts.length) list.textContent = localResult.status === 'rejected' ? 'Kontak tersimpan gagal dimuat. Perbarui data untuk mencoba lagi.' : 'Belum ada kontak tersimpan untuk akun ini.';
  for (const c of contacts) { const div = row(list, c.name, [c.jid.split('@')[0]]); action(div, 'Hapus kontak', async () => { await remove(`/api/contacts/${c.id}`); await loadDestinations(); }); }
  if ($('destination').value && !destinations.some(d => d.value === $('destination').value)) $('destination').value = '';
  renderDestinations();
}
function renderDestinations() {
  const list = $('destination-list'); list.replaceChildren();
  const selected = destinations.find(d => d.value === $('destination').value);
  $('destination-selected').textContent = selected ? `Dipilih: ${selected.name} (${selected.value})` : 'Belum ada tujuan dipilih.';
  if (!destinationAccount) { $('destination-status').textContent = 'Pilih akun untuk melihat tujuan.'; return; }
  if (destinationsLoading) { $('destination-status').textContent = 'Memuat tujuan...'; return; }
  const type = $('destination-type').value;
  const query = $('destination-search').value.trim().toLocaleLowerCase();
  const items = destinations.filter(d => d.type === type && `${d.name} ${d.value}`.toLocaleLowerCase().includes(query));
  const problem = type === 'group' ? groupError : contactError;
  const result = items.length ? `${items.length} tujuan tersedia.` : type === 'group' && accounts.find(a => a.id === destinationAccount)?.status !== 'connected' ? 'Hubungkan akun untuk melihat grup.' : 'Tidak ada tujuan yang cocok.';
  $('destination-status').textContent = [result, problem, type === 'contact' ? 'Kontak WhatsApp hanya yang diterima selama sesi server.' : ''].filter(Boolean).join(' ');
  for (const item of items) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'destination-option';
    button.setAttribute('aria-pressed', String(item.value === $('destination').value));
    const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = item.type === 'group' ? 'G' : (item.name.trim()[0] || '?').toLocaleUpperCase();
    const text = document.createElement('span'); const name = document.createElement('strong'); name.textContent = item.name;
    const detail = document.createElement('small'); detail.textContent = item.type === 'group' ? 'Grup' : item.value.split('@')[0];
    text.append(name, detail); button.append(avatar, text);
    button.addEventListener('click', () => { $('destination').value = item.value; $('number').value = ''; $('destination-dropdown').open = false; renderDestinations(); $('destination-trigger').focus(); });
    list.append(button);
  }
}
function changeDestinationType() {
  $('destination').value = '';
  $('destination-search').value = '';
  $('destination-dropdown').open = false;
  renderDestinations();
  $('destination-selected').textContent = 'Pilihan tujuan dihapus. Pilih tujuan baru atau isi nomor manual.';
}
function openDestinationList() {
  if (!$('destination-dropdown').open) { $('destination-search').value = ''; renderDestinations(); }
}
function destinationKeydown(e) {
  if (e.key === 'Escape' && $('destination-dropdown').open) { e.preventDefault(); $('destination-dropdown').open = false; $('destination-trigger').focus(); }
}
function destinationFocusout(e) {
  if (e.relatedTarget && !$('destination-dropdown').contains(e.relatedTarget)) $('destination-dropdown').open = false;
}
async function loadTemplates() {
  const version = sessionVersion; const result = await api('/api/templates');
  if (!active || version !== sessionVersion) return;
  templates = result;
  replaceOptions($('template-select'), templates.map(t => ({ value: t.id, label: t.name })), 'Tanpa template');
  const list = $('templates-list'); list.replaceChildren();
  if (!templates.length) list.textContent = 'Belum ada template. Simpan teks yang sering digunakan.';
  for (const t of templates) { const div = row(list, t.name, [t.text]); action(div, 'Hapus template', async () => { await remove(`/api/templates/${t.id}`); await loadTemplates(); }); }
}
async function loadSchedules() {
  const version = sessionVersion;
  const q = new URLSearchParams();
  for (const [key, id] of [['accountId','schedule-filter-account'],['destination','schedule-filter-destination'],['status','schedule-filter-status'],['from','schedule-filter-from'],['to','schedule-filter-to']]) if ($(id).value) q.set(key, $(id).value);
  const data = await api(`/api/schedules?${q}`); if (!active || version !== sessionVersion) return; const list = $('schedules-list'); list.replaceChildren();
  if (!data.length) list.textContent = 'Tidak ada jadwal yang cocok dengan filter.';
  for (const s of data) {
    const status = !s.enabled ? 'Nonaktif' : s.next_at ? 'Aktif' : 'Selesai';
    const when = s.next_at ? date(s.next_at) : s.last_at ? `Terakhir: ${date(s.last_at)}` : 'Waktu tidak tersedia';
    const div = row(list, `${status} · ${when} · ${s.repeat === 'weekly' ? 'Mingguan' : 'Sekali'}`, [`${accounts.find(a => a.id === s.account_id)?.name || 'Akun'} · ${s.jid}`, s.text, s.attachment_id ? 'Dengan lampiran' : 'Tanpa lampiran']);
    action(div, 'Ubah jadwal', () => {
      editing = s; $('schedule-editor').hidden = false; $('edit-account').value = s.account_id; $('edit-jid').value = s.jid; $('edit-text').value = s.text;
      $('edit-repeat').value = s.repeat; $('edit-at').value = s.next_at ? new Date(Date.parse(s.next_at) + 7 * 3600000).toISOString().slice(0, 16) : '';
      $('edit-file').value = ''; $('edit-remove-file').checked = false; $('edit-attachment').textContent = s.attachment_id ? 'Jadwal memiliki lampiran tersimpan.' : 'Jadwal belum memiliki lampiran.'; $('edit-account').focus();
    });
    if (s.next_at || !s.enabled) action(div, s.enabled ? 'Nonaktifkan' : 'Aktifkan', async () => { await post(`/api/schedules/${s.id}/enabled`, { revision: s.revision, enabled: !s.enabled }); notice(s.enabled ? 'Jadwal dinonaktifkan.' : 'Jadwal diaktifkan.'); await loadSchedules(); });
    action(div, 'Hapus jadwal', async () => { if (!confirm('Hapus jadwal ini? Riwayat pengiriman tetap tersimpan.')) return; await api(`/api/schedules/${s.id}`, { method: 'DELETE', body: { revision: s.revision } }); if (editing?.id === s.id) { editing = null; $('schedule-editor').hidden = true; } notice('Jadwal dihapus.'); await loadSchedules(); });
  }
}
async function loadHistory() {
  const version = sessionVersion;
  const q = new URLSearchParams();
  for (const [key, id] of [['accountId','filter-account'],['destination','filter-destination'],['status','filter-status'],['from','filter-from'],['to','filter-to']]) if ($(id).value) q.set(key, $(id).value);
  const data = await api(`/api/history?${q}`); if (!active || version !== sessionVersion) return; const list = $('history-list'); list.replaceChildren();
  if (!data.length) list.textContent = 'Tidak ada riwayat yang cocok dengan filter.';
  for (const h of data) row(list, `${statusNames[h.status] || h.status} · ${date(h.created_at)}`, [`${accounts.find(a => a.id === h.account_id)?.name || 'Akun'} · ${h.jid}`, h.scheduled_at ? `Jadwal: ${date(h.scheduled_at)}` : 'Pengiriman langsung', h.text, h.detail].filter(Boolean));
}
async function refresh() { const version = sessionVersion; notice('Memuat data...'); await loadAccounts(); if (!active || version !== sessionVersion) return; await Promise.all([loadDestinations(), loadTemplates(), loadSchedules(), loadHistory()]); if (active && version === sessionVersion) notice('Data diperbarui.'); }
const views = ['pesan', 'jadwal', 'riwayat', 'akun', 'kontak', 'template'];
function renderView() {
  const current = views.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'pesan';
  for (const id of views) $(id).hidden = id !== current;
  document.querySelectorAll('nav[aria-label="Bagian dashboard"] a').forEach(link => {
    if (link.getAttribute('href') === `#${current}`) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
}
window.addEventListener('hashchange', renderView);
renderView();
function renderNotifications() {
  const list = $('notification-list'); list.replaceChildren();
  $('notification-count').textContent = notifications.length ? `(${notifications.length})` : '';
  if (!notifications.length) list.textContent = 'Belum ada notifikasi pada sesi ini.';
  for (const item of notifications) row(list, item.title, item.details);
}
function addNotification(title, details = []) { notifications.unshift({ title, details }); renderNotifications(); notice(title); }
async function pollEvents() {
  if (!active || eventPolling) return;
  const version = sessionVersion; eventPolling = true;
  try {
    if (eventCursor === null) {
      const initial = await api('/api/history-events');
      if (!active || version !== sessionVersion) return;
      eventCursor = initial.cursor;
      return;
    }
    let page;
    do {
      page = await api(`/api/history-events?cursor=${eventCursor}`);
      if (!active || version !== sessionVersion) return;
      for (const event of page.events) {
        const accountName = accounts.find(a => a.id === event.account_id)?.name || 'Akun';
        const label = event.status === 'success' ? 'Jadwal diproses oleh koneksi WhatsApp' : event.status === 'missed' ? 'Jadwal terlewat' : 'Jadwal gagal diproses';
        addNotification(label, [`${accountName} · ${event.jid}`, `Jadwal: ${date(event.scheduled_at)}`, event.status === 'success' ? 'Bukan bukti diterima atau dibaca penerima.' : event.detail].filter(Boolean));
      }
      eventCursor = page.cursor;
    } while (page.hasMore);
  } catch (error) { if (active && version === sessionVersion) notice('Notifikasi gagal diperbarui. Akan dicoba lagi saat dashboard terbuka.'); }
  finally { if (version === sessionVersion) eventPolling = false; }
}
$('clear-notifications').addEventListener('click', () => { notifications = []; renderNotifications(); });
$('login-form').addEventListener('submit', async e => { e.preventDefault(); try { const session = await post('/api/login', { password: $('password').value }); $('password').value = ''; $('login-error').textContent = ''; showDashboard(true); renderNotifications(); eventCursor = session.eventCursor; await pollEvents(); await refresh(); } catch (err) { if (!active) $('login-error').textContent = err.message; else notice(err.message); } });
$('logout').addEventListener('click', () => run(async () => { await post('/api/logout', {}); showDashboard(false); }));
$('refresh').addEventListener('click', () => run(refresh));
$('account').addEventListener('change', () => { $('destination').value = ''; $('destination-search').value = ''; $('destination-dropdown').open = false; run(loadDestinations); });
$('destination-type').addEventListener('change', changeDestinationType);
$('destination-trigger').addEventListener('click', openDestinationList);
$('destination-dropdown').addEventListener('keydown', destinationKeydown);
$('destination-dropdown').addEventListener('focusout', destinationFocusout);
$('destination-search').addEventListener('input', renderDestinations);
$('destination-clear').addEventListener('click', () => { $('destination').value = ''; renderDestinations(); });
$('number').addEventListener('input', () => { if ($('number').value) { $('destination').value = ''; renderDestinations(); } });
$('template-select').addEventListener('change', () => { const t = templates.find(x => x.id === $('template-select').value); if (t) $('message').value = t.text; });
$('repeat').addEventListener('change', () => { const scheduled = $('repeat').value !== 'now'; $('schedule-time').hidden = !scheduled; $('at').required = scheduled; });
$('schedule-options').addEventListener('toggle', () => { if (!$('schedule-options').open && $('repeat').value !== 'now') $('schedule-options').open = true; });
$('account-form').addEventListener('submit', e => { e.preventDefault(); run(async () => { await post('/api/accounts', { name: $('account-name').value }); e.target.reset(); await loadAccounts(); notice('Akun ditambahkan. Tunggu QR muncul secara otomatis.'); }); });
$('contact-form').addEventListener('submit', e => { e.preventDefault(); run(async () => { await post('/api/contacts', { accountId: $('account').value, name: $('contact-name').value, jid: $('contact-number').value.trim() + '@s.whatsapp.net' }); e.target.reset(); await loadDestinations(); notice('Kontak disimpan.'); }); });
$('template-form').addEventListener('submit', e => { e.preventDefault(); run(async () => { await post('/api/templates', { name: $('template-name').value, text: $('template-text').value }); e.target.reset(); await loadTemplates(); notice('Template disimpan.'); }); });
$('filters').addEventListener('submit', e => { e.preventDefault(); run(loadHistory); });
$('schedule-filters').addEventListener('submit', e => { e.preventDefault(); run(loadSchedules); });
$('edit-cancel').addEventListener('click', () => { editing = null; $('schedule-editor').hidden = true; });
$('schedule-edit-form').addEventListener('submit', e => { e.preventDefault(); run(async () => {
  if (!editing) throw new Error('Pilih jadwal untuk diubah');
  const accountId = $('edit-account').value; let attachmentId = $('edit-remove-file').checked ? null : editing.attachment_id;
  const file = $('edit-file').files[0];
  if (file) { const body = new FormData(); body.append('accountId', accountId); body.append('file', file); attachmentId = (await api('/api/attachments', { method: 'POST', body })).id; }
  await api(`/api/schedules/${editing.id}`, { method: 'PUT', body: { revision: editing.revision, accountId, jid: $('edit-jid').value.trim(), text: $('edit-text').value, attachmentId, repeat: $('edit-repeat').value, at: $('edit-at').value } });
  editing = null; $('schedule-editor').hidden = true; notice('Jadwal diubah.'); await loadSchedules();
}); });
function messageResult(title, detail, success = false) {
  $('message-result-title').textContent = title;
  $('message-result-detail').textContent = detail;
  $('message-result-check').hidden = !success;
  if (!$('message-result').open) $('message-result').showModal();
}
$('message-result-close').addEventListener('click', () => $('message-result').close());
$('message-form').addEventListener('submit', e => { e.preventDefault(); run(async () => {
  if ($('repeat').value !== 'now' && (!$('at').value || !Number.isFinite(Date.parse($('at').value + ':00+07:00')) || Date.parse($('at').value + ':00+07:00') <= Date.now())) { $('schedule-options').open = true; $('schedule-time').hidden = false; $('at').focus(); throw new Error('Pilih tanggal dan jam jadwal yang akan datang.'); }
  const accountId = $('account').value; const file = $('file').files[0]; const version = sessionVersion; let attachmentId;
  let result;
  try {
    if (file) { const body = new FormData(); body.append('accountId', accountId); body.append('file', file); attachmentId = (await api('/api/attachments', { method: 'POST', body })).id; }
    result = await post('/api/messages', { accountId, jid: $('destination').value || $('number').value.trim() + '@s.whatsapp.net', text: $('message').value, attachmentId, repeat: $('repeat').value, at: $('at').value });
  } catch (error) { if (active && version === sessionVersion) messageResult('Pesan gagal diproses', error.message); return; }
  if (result.status === 'scheduled') { addNotification('Jadwal disimpan.', [accounts.find(a => a.id === accountId)?.name || 'Akun', `Jadwal: ${$('at').value.replace('T', ' ')} WIB`]); messageResult('Jadwal disimpan', 'Pesan akan diproses sesuai jadwal.', true); }
  else if (result.status === 'success') messageResult('Pesan berhasil diproses', 'Pesan diterima oleh koneksi WhatsApp. Ini bukan bukti diterima atau dibaca penerima.', true);
  else messageResult('Pesan gagal diproses', result.detail || 'Permintaan gagal diproses.');
  if (result.status === 'success' || result.status === 'scheduled') { $('message').value = ''; $('file').value = ''; }
  await Promise.all([loadSchedules(), loadHistory()]);
}); });
run(async () => { try { const session = await api('/api/me'); showDashboard(true); renderNotifications(); eventCursor = session.eventCursor; await pollEvents(); await refresh(); } catch { if (active) showDashboard(false); } });
setInterval(() => { if (active) { run(loadAccounts); run(pollEvents); } }, 5000);
