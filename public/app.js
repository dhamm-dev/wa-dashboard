const $ = id => document.getElementById(id);
let accounts = [], templates = [], destinations = [], active = false, editing = null;
let accountsRequest = 0, renderedAccounts = null;
let destinationsRequest = 0, destinationAccount = '', groupError = '', contactError = '', destinationsLoading = false, sessionVersion = 0;
let eventCursor = null, eventPolling = false, notifications = [];
let userRole = '', botKeys = [], botRequest = 0;
const pairingForms = new Map();
const statusNames = { pending: 'Diproses', success: 'Berhasil', failed: 'Gagal', missed: 'Terlewat', connected: 'Terhubung', disconnected: 'Terputus', connecting: 'Menghubungkan', qr: 'Menunggu QR', logged_out: 'Sesi keluar' };
const notice = text => { $('notice').textContent = text; };
async function api(url, options = {}) {
  const version = sessionVersion;
  const headers = { 'X-Dashboard-Request': '1', ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData)) { headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(options.body); }
  const response = await fetch(url, { ...options, headers });
  const data = await response.json();
  if (version !== sessionVersion) throw new Error('Sesi berubah');
  if (response.status === 401 && active) { clearBotSession(); showDashboard(false); }
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
const post = (url, body, options = {}) => api(url, { ...options, method: 'POST', body });
const remove = url => api(url, { method: 'DELETE' });
let signupAllowed = false, signupRequest = 0;
async function loadAuthOptions() {
  const request = ++signupRequest;
  signupAllowed = false; $('register').hidden = true; $('register').disabled = true;
  $('signup-status').textContent = 'Pendaftaran publik belum tersedia.';
  try {
    const response = await fetch('/api/auth/options', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!response.ok) return;
    const options = await response.json();
    if (request !== signupRequest || options?.publicSignup !== true) return;
    signupAllowed = true; $('register').hidden = false; $('register').disabled = !!$('google-login').disabled;
    $('signup-status').textContent = '';
  } catch {}
}
let apkRequest = 0;
async function checkApkDownload() {
  const request = ++apkRequest;
  $('apk-download').hidden = true;
  try {
    const response = await fetch('/dhexbot-dev.apk', { method: 'HEAD', credentials: 'omit', cache: 'no-store', redirect: 'error' });
    const type = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (request === apkRequest && response.status === 200 && ['application/vnd.android.package-archive', 'application/octet-stream'].includes(type)) $('apk-download').hidden = false;
  } catch {}
}
if (typeof window === 'object') {
  window.addEventListener('pagehide', () => { apkRequest++; $('apk-download').hidden = true; });
  window.addEventListener('pageshow', checkApkDownload);
  window.addEventListener('pagehide', () => { signupRequest++; signupAllowed = false; $('register').hidden = true; $('register').disabled = true; });
  window.addEventListener('pageshow', loadAuthOptions);
}
const date = s => s ? new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(s)) + ' WIB' : '';
function applyTheme() {
  const choice = $('theme').value;
  document.documentElement.dataset.theme = choice === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : choice;
}
$('theme').value = localStorage.getItem('wa-theme') || 'system'; applyTheme();
$('theme').addEventListener('change', () => { localStorage.setItem('wa-theme', $('theme').value); applyTheme(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
function showDashboard(yes) { active = yes; sessionVersion++; eventCursor = null; eventPolling = false; notifications = []; if (!yes) { for (const entry of pairingForms.values()) { entry.input.value = ''; entry.result.textContent = ''; } pairingForms.clear(); clearBotKeys(); $('message-form').submitting = null; $('schedule-edit-form').submitting = null; accountsRequest++; destinationsRequest++; accounts = []; templates = []; destinations = []; destinationAccount = ''; renderedAccounts = null; editing = null; for (const id of ['accounts-list', 'contacts-list', 'destination-list', 'templates-list', 'schedules-list', 'history-list', 'notification-list']) $(id).replaceChildren(); for (const id of ['message-form', 'account-form', 'contact-form', 'template-form', 'schedule-edit-form', 'filters', 'schedule-filters']) $(id).reset?.(); $('at').required = false; $('schedule-time').hidden = true; $('schedule-options').open = false; for (const id of ['account', 'filter-account', 'schedule-filter-account', 'edit-account', 'template-select']) $(id).replaceChildren(); $('destination').value = ''; $('notice').textContent = ''; $('notification-count').textContent = ''; $('destination-selected').textContent = 'Belum ada tujuan dipilih.'; $('destination-status').textContent = 'Pilih akun untuk melihat tujuan.'; $('edit-attachment').textContent = ''; $('schedule-editor').hidden = true; $('notifications').open = false; } $('login').hidden = yes; $('dashboard').hidden = !yes; $('logout').hidden = !yes; }
async function enterSession(session = null) {
  if (!session) session = await api('/api/me');
  userRole = session.role;
  $('user-role').textContent = userRole === 'admin' ? 'Admin / WIB' : 'Pelanggan / WIB';
  $('account-role-field').hidden = userRole !== 'admin';
  $('bot-nav').hidden = userRole !== 'admin';
  showDashboard(true); renderView(); renderNotifications(); eventCursor = session.eventCursor; await pollEvents(); await refresh();
}
function clearBotSession() {
  botRequest++; userRole = ''; botKeys = []; clearBotKeys(); $('bot-form').reset(); $('bot-account').replaceChildren(); $('bot-keys').replaceChildren(); $('bot-model-list').textContent = ''; $('bot-settings').hidden = true;
}
function clearBotKeys() { $('bot-key').value = ''; $('bot-keys').querySelectorAll?.('input[type="password"]').forEach(input => { input.value = ''; }); }
if (typeof window !== 'undefined') {
let googleFlow = null;
function googleAuthorizationUrl(value) {
  const url = new URL(value);
  const keys = ['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'nonce', 'code_challenge', 'code_challenge_method'];
  if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth' || url.username || url.password || url.hash || [...url.searchParams.keys()].length !== keys.length || keys.some(key => url.searchParams.getAll(key).length !== 1)) throw new Error('URL login Google tidak valid.');
  const p = url.searchParams;
  const callback = new URL(p.get('redirect_uri'));
  if (location.protocol !== 'https:' || callback.origin !== location.origin || callback.pathname !== '/api/google/android/callback' || callback.username || callback.password || callback.search || callback.hash || !p.get('client_id') || p.get('response_type') !== 'code' || p.get('scope') !== 'openid email' || p.get('code_challenge_method') !== 'S256' || !['state', 'nonce', 'code_challenge'].every(key => /^[A-Za-z0-9_-]{43}$/.test(p.get(key)))) throw new Error('Konfigurasi login Google tidak cocok dengan dashboard ini.');
  return url.href;
}
function finishGoogle(flow, message) {
  if (googleFlow !== flow) return;
  googleFlow = null; clearTimeout(flow.timer); flow.secret = ''; flow.id = '';
  try { flow.popup.close(); } catch {}
  $('google-login').disabled = false; $('google-cancel').hidden = true; $('google-cancel').disabled = false;
  document.querySelectorAll('#email-form button, #login-form button').forEach(button => { button.disabled = button.id === 'register' && !signupAllowed; });
  $('google-status').textContent = message;
}
async function pollGoogle(flow) {
  if (googleFlow !== flow) return;
  if (Date.now() >= flow.deadline) { finishGoogle(flow, 'Waktu login Google habis. Mulai lagi jika diperlukan.'); return; }
  $('google-cancel').disabled = true;
  try {
    const result = await post('/api/google/android/poll', { id: flow.id, secret: flow.secret }, { signal: AbortSignal.timeout(Math.min(10000, Math.max(1, flow.deadline - Date.now()))) });
    if (googleFlow !== flow) return;
    if (result.status === 'complete') {
      finishGoogle(flow, 'Login Google selesai. Memuat dashboard...');
      try { await enterSession(); } catch { $('login-error').textContent = 'Sesi tidak dapat dimuat. Perbarui halaman untuk memeriksa sesi.'; }
      return;
    }
    if (result.status !== 'pending') throw new Error();
    $('google-cancel').disabled = false;
    if (Date.now() >= flow.deadline) { finishGoogle(flow, 'Waktu login Google habis. Mulai lagi jika diperlukan.'); return; }
    flow.timer = setTimeout(() => pollGoogle(flow), Math.min(2000, flow.deadline - Date.now()));
  } catch {
    finishGoogle(flow, 'Status login Google tidak dapat dipastikan. Perbarui halaman untuk memeriksa sesi sebelum mencoba lagi.');
  }
}
$('google-login').addEventListener('click', async () => {
  if (googleFlow) return;
  if (location.protocol !== 'https:' || !window.isSecureContext || !window.crypto?.getRandomValues) { $('google-status').textContent = 'Login Google memerlukan HTTPS.'; return; }
  const popup = window.open('', '_blank', 'popup,width=520,height=700');
  if (!popup) { $('google-status').textContent = 'Jendela login diblokir. Izinkan pop-up untuk situs ini lalu coba lagi.'; return; }
  try { popup.opener = null; } catch { popup.close(); $('google-status').textContent = 'Jendela login tidak dapat dibuka dengan aman.'; return; }
  const bytes = new Uint8Array(32); window.crypto.getRandomValues(bytes);
  const flow = { popup, secret: btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), id: '', timer: null, deadline: Date.now() + 300000 };
  bytes.fill(0); googleFlow = flow;
  $('google-login').disabled = true; $('google-cancel').hidden = false; $('google-cancel').disabled = true; $('google-status').textContent = 'Menyiapkan login Google...'; $('login-error').textContent = '';
  document.querySelectorAll('#email-form button, #login-form button').forEach(button => { button.disabled = true; });
  try {
    const data = await post('/api/google/android/start', { secret: flow.secret, purpose: 'login' }, { signal: AbortSignal.timeout(10000) });
    if (googleFlow !== flow) return;
    if (!/^[A-Za-z0-9_-]{43}$/.test(data.id) || !Number.isFinite(data.expiresIn) || data.expiresIn <= 0 || data.expiresIn > 300 || data.pollInterval !== 2) throw new Error();
    const url = googleAuthorizationUrl(data.authorizationUrl);
    flow.id = data.id; flow.deadline = Math.min(flow.deadline, Date.now() + data.expiresIn * 1000);
    popup.location.replace(url);
    $('google-status').textContent = 'Selesaikan login di jendela Google, lalu kembali ke sini.';
    $('google-cancel').disabled = false;
    flow.timer = setTimeout(() => pollGoogle(flow), 2000);
  } catch { finishGoogle(flow, 'Login Google tidak tersedia atau konfigurasinya tidak cocok. Periksa HTTPS dan pengaturan server.'); }
});
$('google-cancel').addEventListener('click', () => { if (googleFlow) finishGoogle(googleFlow, 'Login Google dibatalkan.'); });
window.addEventListener('pagehide', () => { if (googleFlow) finishGoogle(googleFlow, 'Login Google dibatalkan.'); });
}
async function loadAccounts() {
  const request = ++accountsRequest;
  const result = await api('/api/accounts');
  if (!active || request !== accountsRequest) return;
  const previous = accounts;
  const selected = $('account').value;
  for (const [id, entry] of pairingForms) {
    const current = result.find(a => a.id === id);
    if (!current || current.role !== entry.role || current.status === 'connected') { entry.input.value = ''; entry.result.textContent = ''; pairingForms.delete(id); }
  }
  accounts = result;
  const snapshot = JSON.stringify(accounts);
  if (snapshot === renderedAccounts) return;
  renderedAccounts = snapshot;
  const choices = accounts.map(a => ({ value: a.id, label: `${a.name} (${statusNames[a.status] || a.status})` }));
  replaceOptions($('account'), choices, 'Pilih akun');
  replaceOptions($('filter-account'), choices, 'Semua akun');
  replaceOptions($('schedule-filter-account'), choices, 'Semua akun');
  replaceOptions($('edit-account'), choices, 'Pilih akun');
  replaceOptions($('bot-account'), accounts.filter(a => a.role === 'bot').map(a => ({ value: a.id, label: a.name })), 'Pilih akun bot');
  if (!$('bot-account').value) { botRequest++; clearBotKeys(); $('bot-keys').replaceChildren(); $('bot-settings').hidden = true; $('bot-status').textContent = 'Pilih akun bot untuk memuat pengaturan.'; }
  const list = $('accounts-list'); list.replaceChildren();
  if (!accounts.length) list.textContent = 'Belum ada akun. Tambahkan akun untuk memperoleh QR.';
  for (const a of accounts) {
    const div = row(list, a.name, [`${statusNames[a.status] || a.status} · ${a.role === 'bot' ? 'Akun bot' : 'Akun biasa'}`]);
    if (a.qr) { const img = document.createElement('img'); img.src = a.qr; img.width = 320; img.height = 320; img.className = 'account-qr'; img.alt = `QR untuk menghubungkan ${a.name}`; div.append(img); }
    if (a.status === 'disconnected') action(div, 'Hubungkan', async () => { await post(`/api/accounts/${a.id}/connect`, {}); await loadAccounts(); });
    if (a.status === 'logged_out') action(div, 'Tautkan ulang', async () => { await post(`/api/accounts/${a.id}/repair`, {}); await loadAccounts(); });
    if (userRole === 'admin') action(div, a.role === 'bot' ? 'Jadikan akun biasa' : 'Jadikan akun bot', async () => {
      const next = a.role === 'bot' ? 'ordinary' : 'bot';
      if (!confirm(next === 'bot' ? 'Jadikan akun ini bot? Jadwal aktif akun ini akan dinonaktifkan.' : 'Jadikan akun ini akun biasa?')) return;
      const result = await api(`/api/accounts/${a.id}/role`, { method: 'PUT', body: { expectedRole: a.role, role: next } });
      const pair = pairingForms.get(a.id); if (pair) { pair.input.value = ''; pair.result.textContent = ''; pairingForms.delete(a.id); }
      if (a.role === 'bot' && $('bot-account').value === a.id) { botRequest++; clearBotKeys(); $('bot-keys').replaceChildren(); $('bot-settings').hidden = true; }
      notice(next === 'bot' ? `Role diubah. Jadwal yang dinonaktifkan: ${result.pausedSchedules}.` : 'Role diubah menjadi akun biasa.');
      await loadAccounts(); await loadSchedules();
    });
    if (a.status !== 'connected') {
      const existing = pairingForms.get(a.id);
      if (existing) { div.append(existing.form); continue; }
      const form = document.createElement('form');
      const label = document.createElement('label'); const input = document.createElement('input'); const button = document.createElement('button'); const result = document.createElement('p');
      input.id = `pair-${a.id}`; input.inputMode = 'numeric'; input.required = true; input.autocomplete = 'off'; label.htmlFor = input.id; label.textContent = 'Nomor WhatsApp dengan kode negara'; button.type = 'submit'; button.textContent = 'Minta kode pairing'; result.role = 'status';
      form.append(label, input, button, result); div.append(form);
      const entry = { form, input, result, role: a.role }; pairingForms.set(a.id, entry);
      form.addEventListener('submit', async e => { e.preventDefault(); if (button.disabled) return; const version = sessionVersion; const phone = input.value.trim(); input.value = ''; button.disabled = true; result.textContent = 'Meminta kode...'; try { const data = await post(`/api/accounts/${a.id}/pairing-code`, { phone }); if (active && version === sessionVersion && pairingForms.get(a.id) === entry) result.textContent = `Kode pairing: ${data.code}`; } catch (err) { if (active && version === sessionVersion && pairingForms.get(a.id) === entry) result.textContent = err.message; } finally { button.disabled = false; } });
    }
  }
  if (selected && previous.some(a => a.id === selected && a.status !== 'connected') && accounts.some(a => a.id === selected && a.status === 'connected') && $('account').value === selected) run(loadDestinations);
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
const views = ['pesan', 'jadwal', 'riwayat', 'akun', 'kontak', 'template', 'bot'];
function renderView() {
  const requested = location.hash.slice(1);
  const current = views.includes(requested) && (requested !== 'bot' || userRole === 'admin') ? requested : 'pesan';
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
$('login-form').addEventListener('submit', async e => { e.preventDefault(); const password = $('password').value; $('password').value = ''; try { await post('/api/login', { password }); $('login-error').textContent = ''; await enterSession(); } catch (err) { if (!active) $('login-error').textContent = err.message; else notice(err.message); } });
$('email-form').addEventListener('submit', async e => { e.preventDefault(); const button = e.submitter; if (!button || (button.id === 'register' && !signupAllowed)) return; const password = $('email-password').value; $('email-password').value = ''; button.disabled = true; try { await post(button.id === 'register' ? '/api/email/register' : '/api/email/login', { email: $('email').value, password }); $('login-error').textContent = ''; await enterSession(); } catch (err) { if (!active) $('login-error').textContent = err.message; else notice(err.message); } finally { button.disabled = button.id === 'register' && !signupAllowed; } });
$('logout').addEventListener('click', () => run(async () => { await post('/api/logout', {}); clearBotSession(); showDashboard(false); }));
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
$('account-form').addEventListener('submit', e => { e.preventDefault(); run(async () => { await post('/api/accounts', { name: $('account-name').value, role: userRole === 'admin' ? $('account-role').value : 'ordinary' }); e.target.reset(); await loadAccounts(); notice('Akun ditambahkan. Tunggu QR muncul secara otomatis.'); }); });
$('contact-form').addEventListener('submit', e => { e.preventDefault(); run(async () => { await post('/api/contacts', { accountId: $('account').value, name: $('contact-name').value, jid: $('contact-number').value.trim() + '@s.whatsapp.net' }); e.target.reset(); await loadDestinations(); notice('Kontak disimpan.'); }); });
$('template-form').addEventListener('submit', e => { e.preventDefault(); run(async () => { await post('/api/templates', { name: $('template-name').value, text: $('template-text').value }); e.target.reset(); await loadTemplates(); notice('Template disimpan.'); }); });
$('filters').addEventListener('submit', e => { e.preventDefault(); run(loadHistory); });
$('schedule-filters').addEventListener('submit', e => { e.preventDefault(); run(loadSchedules); });
$('edit-cancel').addEventListener('click', () => { editing = null; $('schedule-editor').hidden = true; });
$('schedule-edit-form').addEventListener('submit', e => {
  e.preventDefault(); const form = $('schedule-edit-form'); if (form.submitting) return;
  const selected = editing, version = sessionVersion, file = $('edit-file').files[0];
  if (!selected) { run(() => { throw new Error('Pilih jadwal untuk diubah'); }); return; }
  const id = selected.id, payload = { revision: selected.revision, accountId: $('edit-account').value, jid: $('edit-jid').value.trim(), text: $('edit-text').value, attachmentId: $('edit-remove-file').checked ? null : selected.attachment_id, repeat: $('edit-repeat').value, at: $('edit-at').value };
  const operation = {}; form.submitting = operation;
  run(async () => { try {
    if (file) { const body = new FormData(); body.append('accountId', payload.accountId); body.append('file', file); payload.attachmentId = (await api('/api/attachments', { method: 'POST', body })).id; }
    if (!active || version !== sessionVersion) return;
    await api(`/api/schedules/${id}`, { method: 'PUT', body: payload });
    if (!active || version !== sessionVersion) return;
    if (editing === selected) { editing = null; $('schedule-editor').hidden = true; }
    notice('Jadwal diubah.'); await loadSchedules();
  } finally { if (form.submitting === operation) form.submitting = null; } });
});
const botUrl = id => `/api/accounts/${encodeURIComponent(id)}/bot-config`;
async function loadBot() {
  const id = $('bot-account').value, request = ++botRequest;
  clearBotKeys(); $('bot-keys').replaceChildren(); $('bot-settings').hidden = true; $('bot-model-list').textContent = '';
  if (!id) { $('bot-status').textContent = 'Pilih akun bot untuk memuat pengaturan.'; return; }
  $('bot-status').textContent = 'Memuat pengaturan bot...';
  try {
    const data = await api(botUrl(id));
    if (!active || request !== botRequest || $('bot-account').value !== id) return;
    $('bot-model').value = data.model; $('bot-instruction').value = data.systemInstruction;
    $('bot-phones').value = data.adminPhones.join('\n'); $('bot-commands').value = data.enabledCommands.join('\n'); $('bot-enabled').checked = data.enabled;
    botKeys = data.keys; renderBotKeys(id); $('bot-settings').hidden = false; $('bot-status').textContent = 'Pengaturan dimuat.';
  } catch (error) { if (request === botRequest && active) $('bot-status').textContent = `Pengaturan gagal dimuat: ${error.message}`; }
}
function renderBotKeys(id) {
  const list = $('bot-keys'); list.replaceChildren();
  if (!botKeys.length) list.textContent = 'Belum ada kunci API.';
  botKeys.forEach((key, index) => {
    const div = row(list, `Prioritas ${index + 1}`);
    const move = async direction => {
      const ids = botKeys.map(item => item.id), target = index + direction;
      [ids[index], ids[target]] = [ids[target], ids[index]];
      await api(`${botUrl(id)}/keys/order`, { method: 'PUT', body: { ids } }); await loadBot();
    };
    if (index > 0) action(div, 'Naikkan prioritas', () => move(-1));
    if (index < botKeys.length - 1) action(div, 'Turunkan prioritas', () => move(1));
    const form = document.createElement('form'), label = document.createElement('label'), input = document.createElement('input'), button = document.createElement('button');
    input.id = `key-${key.id}`; input.type = 'password'; input.autocomplete = 'off'; input.required = true; label.htmlFor = input.id; label.textContent = 'Kunci pengganti'; button.type = 'submit'; button.textContent = 'Ganti kunci';
    form.append(label, input, button); div.append(form);
    form.addEventListener('submit', e => { e.preventDefault(); const value = input.value; input.value = ''; run(async () => { await api(`${botUrl(id)}/keys/${key.id}`, { method: 'PUT', body: { key: value } }); await loadBot(); }); });
    action(div, 'Hapus kunci', async () => { if (!confirm('Hapus kunci API ini?')) return; await remove(`${botUrl(id)}/keys/${key.id}`); await loadBot(); });
  });
}
$('bot-account').addEventListener('change', loadBot);
$('bot-form').addEventListener('submit', e => { e.preventDefault(); run(async () => {
  const lines = id => $(id).value.split('\n').map(s => s.trim()).filter(Boolean);
  await api(botUrl($('bot-account').value), { method: 'PUT', body: { model: $('bot-model').value.trim(), systemInstruction: $('bot-instruction').value, enabled: $('bot-enabled').checked, adminPhones: lines('bot-phones'), enabledCommands: lines('bot-commands') } });
  $('bot-status').textContent = 'Pengaturan disimpan.';
}); });
$('bot-key-form').addEventListener('submit', e => { e.preventDefault(); const key = $('bot-key').value; $('bot-key').value = ''; const id = $('bot-account').value; run(async () => { await post(`${botUrl(id)}/keys`, { key }); await loadBot(); }); });
$('bot-models').addEventListener('click', () => { const id = $('bot-account').value, version = sessionVersion, request = botRequest; const current = () => active && version === sessionVersion && request === botRequest && $('bot-account').value === id; if (!current()) return; $('bot-model-list').textContent = 'Memuat model...'; run(async () => { try { const data = await post(`${botUrl(id)}/models`, {}); if (current()) $('bot-model-list').textContent = data.models.length ? data.models.map(m => m.name).join(', ') : 'Tidak ada model tersedia.'; } catch (error) { if (current()) $('bot-model-list').textContent = `Model gagal dimuat: ${error.message}`; } }); });
function messageResult(title, detail, success = false) {
  $('message-result-title').textContent = title;
  $('message-result-detail').textContent = detail;
  $('message-result-check').hidden = !success;
  if (!$('message-result').open) $('message-result').showModal();
}
$('message-result-close').addEventListener('click', () => $('message-result').close());
$('message-form').addEventListener('submit', e => { e.preventDefault(); const form = $('message-form'); if (form.submitting) return;
  const payload = { accountId: $('account').value, jid: $('destination').value || $('number').value.trim() + '@s.whatsapp.net', text: $('message').value, repeat: $('repeat').value, at: $('at').value };
  const file = $('file').files[0], version = typeof sessionVersion === 'undefined' ? 0 : sessionVersion, operation = {}; form.submitting = operation;
  run(async () => { try {
  if (payload.repeat !== 'now' && (!payload.at || !Number.isFinite(Date.parse(payload.at + ':00+07:00')) || Date.parse(payload.at + ':00+07:00') <= Date.now())) { $('schedule-options').open = true; $('schedule-time').hidden = false; $('at').focus(); throw new Error('Pilih tanggal dan jam jadwal yang akan datang.'); }
  let result;
  try {
    if (file) { const body = new FormData(); body.append('accountId', payload.accountId); body.append('file', file); payload.attachmentId = (await api('/api/attachments', { method: 'POST', body })).id; }
    if (!active || version !== sessionVersion) return;
    result = await post('/api/messages', payload);
  } catch (error) { if (active && version === sessionVersion) messageResult('Pesan gagal diproses', error.message); return; }
  if (!active || version !== sessionVersion) return;
  if (result.status === 'scheduled') { addNotification('Jadwal disimpan.', [accounts.find(a => a.id === payload.accountId)?.name || 'Akun', `Jadwal: ${payload.at.replace('T', ' ')} WIB`]); messageResult('Jadwal disimpan', 'Pesan akan diproses sesuai jadwal.', true); }
  else if (result.status === 'success') messageResult('Pesan berhasil diproses', 'Pesan diterima oleh koneksi WhatsApp. Ini bukan bukti diterima atau dibaca penerima.', true);
  else messageResult('Pesan gagal diproses', result.detail || 'Permintaan gagal diproses.');
  if (result.status === 'success' || result.status === 'scheduled') { if ($('message').value === payload.text) $('message').value = ''; if ($('file').files[0] === file) $('file').value = ''; }
  await Promise.all([loadSchedules(), loadHistory()]);
  } finally { if (form.submitting === operation) form.submitting = null; } }); });
run(async () => { try { const session = await api('/api/me'); await enterSession(session); } catch { if (active) showDashboard(false); } });
setInterval(() => { if (active) { run(loadAccounts); run(pollEvents); } }, 5000);
