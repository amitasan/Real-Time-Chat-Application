'use strict';
/* Realtime chat client - vanilla JS, no build step.
   All user-supplied text is inserted with textContent (never innerHTML) to prevent XSS. */

const $ = (s) => document.querySelector(s);

const state = {
  token: localStorage.getItem('token'),
  me: localStorage.getItem('me'),
  rooms: [],              // [{name, members, joined}]
  users: [],              // usernames
  online: new Set(),      // usernames currently connected
  current: null,          // "room:x" | "dm:y"
  unread: {},             // channel -> count
  oldestId: {},           // channel -> id of oldest loaded message (for paging)
  hasMore: {},            // channel -> bool
  ws: null,
  retry: 0,
  typingTimers: {},       // username -> timeout id
  lastTypingSent: 0,
  mode: 'login',
};

// ------------------------------------------------------------------ helpers
async function api(path, { method = 'GET', json, body } = {}) {
  const headers = {};
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  const res = await fetch(path, { method, headers, body });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) logout();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  children.forEach((c) => node.append(c));
  return node;
}

const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDay = (ts) => new Date(ts).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const isImage = (f) => /^image\/(png|jpe?g|gif|webp)$/.test(f.mime || '');
const chanName = (ch) => ch.slice(ch.indexOf(':') + 1);

// ------------------------------------------------------------------ auth
function showAuth() {
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
}

function setMode(mode) {
  state.mode = mode;
  $('#tab-login').classList.toggle('active', mode === 'login');
  $('#tab-register').classList.toggle('active', mode === 'register');
  $('#auth-submit').textContent = mode === 'login' ? 'Log in' : 'Create account';
  $('#password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#auth-error').textContent = '';
}

$('#tab-login').onclick = () => setMode('login');
$('#tab-register').onclick = () => setMode('register');

$('#auth-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const data = await api('/api/' + (state.mode === 'login' ? 'login' : 'register'), {
      method: 'POST',
      json: { username: $('#username').value.trim(), password: $('#password').value },
    });
    state.token = data.token;
    state.me = data.username;
    localStorage.setItem('token', data.token);
    localStorage.setItem('me', data.username);
    $('#password').value = '';
    // Ask for notification permission on a user gesture (login click).
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    startApp();
  } catch (err) {
    $('#auth-error').textContent = err.message;
  }
};

function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('me');
  state.token = state.me = null;
  state.current = null;
  if (state.ws) { state.ws.onclose = null; state.ws.close(); state.ws = null; }
  document.title = 'Realtime Chat';
  showAuth();
}
$('#logout').onclick = logout;

// ------------------------------------------------------------------ app start
async function startApp() {
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#me-name').textContent = state.me;
  state.unread = {};
  state.current = null;
  renderHeader();
  $('#messages').replaceChildren(el('div', { className: 'empty', textContent: 'Pick a room or start a private chat from the sidebar.' }));
  $('#composer').classList.add('hidden');
  await Promise.all([loadRooms(), loadUsers()]);
  connect();
  const general = state.rooms.find((r) => r.name === 'general' && r.joined);
  if (general) openChannel('room:' + general.name);
}

async function loadRooms() { state.rooms = await api('/api/rooms'); renderSidebar(); }
async function loadUsers() { state.users = await api('/api/users'); renderSidebar(); }

// ------------------------------------------------------------------ websocket
function connect() {
  if (!state.token) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(state.token)}`);
  state.ws = ws;

  ws.onopen = () => { state.retry = 0; $('#conn').classList.add('hidden'); };

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'init') { state.online = new Set(m.online); renderSidebar(); renderHeader(); }
    else if (m.type === 'presence') {
      m.online ? state.online.add(m.username) : state.online.delete(m.username);
      if (!state.users.includes(m.username)) loadUsers(); // a brand-new user signed up
      renderSidebar(); renderHeader();
    }
    else if (m.type === 'message') onIncoming(m.message);
    else if (m.type === 'typing') onTyping(m);
    else if (m.type === 'error') alert(m.error);
  };

  ws.onclose = () => {
    if (state.ws !== ws || !state.token) return;
    $('#conn').classList.remove('hidden');
    const delay = Math.min(1000 * 2 ** state.retry++, 15000);
    setTimeout(async () => {
      if (!state.token) return;
      try { await loadRooms(); } catch {}
      connect();
      if (state.current) reloadCurrent(); // catch up on anything missed while offline
    }, delay);
  };
}

function sendWS(obj) {
  if (state.ws && state.ws.readyState === 1) { state.ws.send(JSON.stringify(obj)); return true; }
  alert('Not connected - reconnecting, try again in a moment.');
  return false;
}

// ------------------------------------------------------------------ incoming
function onIncoming(msg) {
  const mine = msg.sender === state.me;
  const visible = msg.channel === state.current && !document.hidden;

  if (msg.channel === state.current) {
    appendMessage(msg);
    scrollBottom();
    clearTyping(msg.sender);
  }
  if (!mine && !visible) {
    state.unread[msg.channel] = (state.unread[msg.channel] || 0) + 1;
    renderSidebar();
    updateTitle();
    notify(msg);
  }
}

function notify(msg) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
  const where = msg.channel.startsWith('room:') ? '#' + chanName(msg.channel) : 'private message';
  const n = new Notification(`${msg.sender} (${where})`, {
    body: msg.kind === 'file' ? '📎 ' + msg.file.name : msg.text,
    tag: msg.channel,
  });
  n.onclick = () => { window.focus(); openChannel(msg.channel); n.close(); };
}

function updateTitle() {
  const total = Object.values(state.unread).reduce((a, b) => a + b, 0);
  document.title = total ? `(${total}) Realtime Chat` : 'Realtime Chat';
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.current) { delete state.unread[state.current]; renderSidebar(); updateTitle(); }
});

// ------------------------------------------------------------------ typing indicator
function onTyping({ channel, username }) {
  if (channel !== state.current) return;
  clearTimeout(state.typingTimers[username]);
  state.typingTimers[username] = setTimeout(() => clearTyping(username), 3000);
  renderTyping();
}
function clearTyping(username) {
  clearTimeout(state.typingTimers[username]);
  delete state.typingTimers[username];
  renderTyping();
}
function renderTyping() {
  const names = Object.keys(state.typingTimers);
  $('#typing').textContent = names.length ? `${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} typing…` : '';
}

$('#text').addEventListener('input', () => {
  if (!state.current || Date.now() - state.lastTypingSent < 2000) return;
  state.lastTypingSent = Date.now();
  if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({ type: 'typing', channel: state.current }));
});

// ------------------------------------------------------------------ rendering
function renderSidebar() {
  const rl = $('#room-list');
  rl.replaceChildren(...state.rooms.map((r) => {
    const ch = 'room:' + r.name;
    const li = el('li', { className: (r.joined ? '' : 'unjoined ') + (state.current === ch ? 'active' : '') });
    li.append(el('span', { className: 'hash', textContent: '#' }), el('span', { className: 'name', textContent: r.name, title: `${r.members} member(s)` }));
    if (r.joined) {
      if (state.unread[ch]) li.append(el('span', { className: 'badge', textContent: state.unread[ch] }));
      li.onclick = () => openChannel(ch);
    } else {
      const b = el('button', { textContent: 'Join' });
      b.onclick = async (e) => { e.stopPropagation(); await api(`/api/rooms/${encodeURIComponent(r.name)}/join`, { method: 'POST' }); await loadRooms(); openChannel(ch); };
      li.append(b);
    }
    return li;
  }));

  const ul = $('#user-list');
  const others = state.users.filter((u) => u !== state.me)
    .sort((a, b) => (state.online.has(b) - state.online.has(a)) || a.localeCompare(b));
  ul.replaceChildren(...others.map((u) => {
    const ch = 'dm:' + u;
    const li = el('li', { className: state.current === ch ? 'active' : '' });
    li.append(el('span', { className: 'dot' + (state.online.has(u) ? ' online' : '') }), el('span', { className: 'name', textContent: u }));
    if (state.unread[ch]) li.append(el('span', { className: 'badge', textContent: state.unread[ch] }));
    li.onclick = () => openChannel(ch);
    return li;
  }));
  if (!others.length) ul.append(el('li', { textContent: 'No other users yet', style: 'cursor:default;opacity:.6' }));
}

function renderHeader() {
  const ch = state.current;
  $('#leave').classList.toggle('hidden', !(ch && ch.startsWith('room:') && chanName(ch) !== 'general'));
  if (!ch) { $('#chat-title').textContent = 'Select a room or person'; $('#chat-sub').textContent = ''; return; }
  const name = chanName(ch);
  if (ch.startsWith('room:')) {
    const r = state.rooms.find((x) => x.name === name);
    $('#chat-title').textContent = '# ' + name;
    $('#chat-sub').textContent = r ? `${r.members} member(s)` : '';
  } else {
    $('#chat-title').textContent = name;
    $('#chat-sub').textContent = state.online.has(name) ? '● online' : '○ offline';
  }
}

function appendMessage(msg, { prepend = false } = {}) {
  const box = $('#messages');
  const mine = msg.sender === state.me;
  const div = el('div', { className: 'msg' + (mine ? ' mine' : '') });
  div.dataset.id = msg.id;
  div.dataset.ts = msg.ts;

  const meta = el('div', { className: 'meta' });
  meta.append(el('b', { textContent: mine ? 'You' : msg.sender }), ' · ' + fmtTime(msg.ts));
  div.append(meta);

  if (msg.kind === 'file' && msg.file) {
    const f = msg.file;
    if (isImage(f)) {
      const a = el('a', { href: f.url, target: '_blank', rel: 'noopener' });
      a.append(el('img', { src: f.url, alt: f.name, loading: 'lazy' }));
      div.append(a);
    }
    div.append(el('a', { className: 'file', href: f.url, download: f.name, target: '_blank', rel: 'noopener', textContent: '📎 ' + f.name }));
  } else {
    div.append(el('div', { className: 'body', textContent: msg.text }));
  }

  if (prepend) box.prepend(div); else box.append(div);
}

/** Insert "Today / date" separators after a full (re)render. */
function addDayDividers() {
  const box = $('#messages');
  box.querySelectorAll('.day').forEach((d) => d.remove());
  let last = '';
  [...box.querySelectorAll('.msg')].forEach((m) => {
    const d = fmtDay(+m.dataset.ts);
    if (d !== last) { box.insertBefore(el('div', { className: 'day', textContent: d }), m); last = d; }
  });
}

const scrollBottom = () => { const b = $('#messages'); b.scrollTop = b.scrollHeight; };

// ------------------------------------------------------------------ channels & history
async function openChannel(ch) {
  state.current = ch;
  state.typingTimers = {};
  renderTyping();
  delete state.unread[ch];
  updateTitle();
  $('#sidebar').classList.remove('open');
  $('#composer').classList.remove('hidden');
  renderSidebar();
  renderHeader();
  await reloadCurrent();
  $('#text').focus();
}

async function reloadCurrent() {
  const ch = state.current;
  try {
    const data = await api('/api/history?channel=' + encodeURIComponent(ch));
    if (state.current !== ch) return;
    const box = $('#messages');
    box.replaceChildren();
    state.hasMore[ch] = data.hasMore;
    state.oldestId[ch] = data.messages.length ? data.messages[0].id : null;
    data.messages.forEach((m) => appendMessage(m));
    if (!data.messages.length) box.append(el('div', { className: 'empty', textContent: 'No messages yet - say hello!' }));
    renderLoadMore();
    addDayDividers();
    scrollBottom();
  } catch (err) { alert(err.message); }
}

function renderLoadMore() {
  const box = $('#messages');
  box.querySelectorAll('.load-more').forEach((b) => b.remove());
  if (!state.hasMore[state.current]) return;
  const b = el('button', { className: 'load-more', textContent: 'Load earlier messages' });
  b.onclick = loadEarlier;
  box.prepend(b);
}

async function loadEarlier() {
  const ch = state.current;
  const box = $('#messages');
  const prevHeight = box.scrollHeight;
  const data = await api(`/api/history?channel=${encodeURIComponent(ch)}&before=${state.oldestId[ch]}`);
  state.hasMore[ch] = data.hasMore;
  if (data.messages.length) state.oldestId[ch] = data.messages[0].id;
  [...data.messages].reverse().forEach((m) => appendMessage(m, { prepend: true }));
  renderLoadMore();
  addDayDividers();
  box.scrollTop = box.scrollHeight - prevHeight; // keep the viewport where it was
}

// ------------------------------------------------------------------ actions
$('#composer').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#text').value.trim();
  if (!text || !state.current) return;
  if (sendWS({ type: 'message', channel: state.current, text })) $('#text').value = '';
};

$('#file').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !state.current) return;
  if (file.size > 10 * 1024 * 1024) return alert('File too large (max 10 MB)');
  const fd = new FormData();
  fd.append('file', file);
  try {
    const info = await api('/api/upload', { method: 'POST', body: fd });
    sendWS({ type: 'message', channel: state.current, file: info });
  } catch (err) { alert(err.message); }
};

$('#room-form').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('#room-name').value.trim();
  if (!name) return;
  try {
    await api('/api/rooms', { method: 'POST', json: { name } });
    $('#room-name').value = '';
    await loadRooms();
    openChannel('room:' + name);
  } catch (err) { alert(err.message); }
};

$('#leave').onclick = async () => {
  const name = chanName(state.current);
  if (!confirm(`Leave #${name}?`)) return;
  await api(`/api/rooms/${encodeURIComponent(name)}/leave`, { method: 'POST' });
  await loadRooms();
  openChannel('room:general');
};

$('#menu').onclick = () => $('#sidebar').classList.toggle('open');

// ------------------------------------------------------------------ boot
setMode('login');
if (state.token && state.me) startApp(); else showAuth();
