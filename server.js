const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const MAX_FILE_MB = 10;
const MAX_TEXT = 2000;

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[warn] JWT_SECRET not set - using a random one (logins reset on restart).');
}

const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------------------------------------------------------- validation
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const ROOM_RE = /^[a-zA-Z0-9_-]{2,30}$/;
const FILE_URL_RE = /^\/uploads\/[a-f0-9]{32}(\.[a-z0-9]{1,8})?$/;
const SAFE_INLINE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

// ---------------------------------------------------------------- prepared statements
const q = {
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  insertUser: db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)'),
  allUsers: db.prepare('SELECT username FROM users ORDER BY username'),
  roomByName: db.prepare('SELECT * FROM rooms WHERE name = ?'),
  insertRoom: db.prepare('INSERT INTO rooms (name, created_by, created_at) VALUES (?, ?, ?)'),
  roomsWithCounts: db.prepare(`
    SELECT r.name,
           (SELECT COUNT(*) FROM room_members m WHERE m.room = r.name) AS members,
           EXISTS (SELECT 1 FROM room_members m WHERE m.room = r.name AND m.username = ?) AS joined
    FROM rooms r ORDER BY r.name`),
  join: db.prepare('INSERT OR IGNORE INTO room_members (room, username) VALUES (?, ?)'),
  leave: db.prepare('DELETE FROM room_members WHERE room = ? AND username = ?'),
  isMember: db.prepare('SELECT 1 FROM room_members WHERE room = ? AND username = ?'),
  members: db.prepare('SELECT username FROM room_members WHERE room = ?'),
  insertMsg: db.prepare(`INSERT INTO messages (room, sender, recipient, kind, body, file_name, file_url, file_mime, created_at)
                         VALUES (@room, @sender, @recipient, @kind, @body, @file_name, @file_url, @file_mime, @created_at)`),
  msgById: db.prepare('SELECT * FROM messages WHERE id = ?'),
  roomHistory: db.prepare('SELECT * FROM messages WHERE room = ? AND id < ? ORDER BY id DESC LIMIT ?'),
  dmHistory: db.prepare(`SELECT * FROM messages
                         WHERE room IS NULL AND id < @before
                           AND ((sender = @a AND recipient = @b) OR (sender = @b AND recipient = @a))
                         ORDER BY id DESC LIMIT @limit`),
};

// ---------------------------------------------------------------- helpers
const canonicalUser = (name) => (q.userByName.get(name) || {}).username;
const signToken = (username) => jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' });

function toClient(row, viewer) {
  const channel = row.room
    ? 'room:' + row.room
    : 'dm:' + (row.sender.toLowerCase() === viewer.toLowerCase() ? row.recipient : row.sender);
  return {
    id: row.id,
    channel,
    sender: row.sender,
    kind: row.kind,
    text: row.body,
    file: row.kind === 'file' ? { name: row.file_name, url: row.file_url, mime: row.file_mime } : null,
    ts: row.created_at,
  };
}

/** Turn a client channel string ("room:x" / "dm:bob") into a validated target for `user`. */
function resolveChannel(user, channel) {
  if (typeof channel !== 'string') return null;
  if (channel.startsWith('room:')) {
    const room = q.roomByName.get(channel.slice(5));
    if (!room || !q.isMember.get(room.name, user)) return null;
    return { room: room.name, recipient: null, audience: q.members.all(room.name).map((m) => m.username) };
  }
  if (channel.startsWith('dm:')) {
    const other = canonicalUser(channel.slice(3));
    if (!other || other.toLowerCase() === user.toLowerCase()) return null;
    return { room: null, recipient: other, audience: [user, other] };
  }
  return null;
}

// ---------------------------------------------------------------- express
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));

app.use('/uploads', (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  // Only well-known image types render inline; everything else is a forced download (blocks HTML/SVG XSS).
  if (!SAFE_INLINE.has(path.extname(req.path).toLowerCase())) {
    res.setHeader('Content-Disposition', 'attachment');
  }
  next();
}, express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  try {
    const { username } = jwt.verify(h.replace(/^Bearer /, ''), JWT_SECRET);
    if (!canonicalUser(username)) throw new Error('gone');
    req.user = canonicalUser(username);
    next();
  } catch {
    res.status(401).json({ error: 'Please log in again' });
  }
}

// ---- accounts
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!USERNAME_RE.test(username || '')) {
    return res.status(400).json({ error: 'Username must be 3-20 letters, numbers or underscores' });
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 100) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  if (q.userByName.get(username)) return res.status(409).json({ error: 'Username already taken' });
  q.insertUser.run(username, bcrypt.hashSync(password, 10), Date.now());
  q.join.run('general', username);
  res.json({ token: signToken(username), username });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = typeof username === 'string' ? q.userByName.get(username) : null;
  if (!user || typeof password !== 'string' || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  res.json({ token: signToken(user.username), username: user.username });
});

// ---- rooms & users
app.get('/api/rooms', auth, (req, res) => {
  res.json(q.roomsWithCounts.all(req.user).map((r) => ({ ...r, joined: !!r.joined })));
});

app.post('/api/rooms', auth, (req, res) => {
  const name = (req.body || {}).name;
  if (!ROOM_RE.test(name || '')) {
    return res.status(400).json({ error: 'Room name: 2-30 letters, numbers, - or _' });
  }
  if (q.roomByName.get(name)) return res.status(409).json({ error: 'Room already exists' });
  q.insertRoom.run(name, req.user, Date.now());
  q.join.run(name, req.user);
  res.json({ name });
});

app.post('/api/rooms/:name/join', auth, (req, res) => {
  const room = q.roomByName.get(req.params.name);
  if (!room) return res.status(404).json({ error: 'No such room' });
  q.join.run(room.name, req.user);
  res.json({ ok: true });
});

app.post('/api/rooms/:name/leave', auth, (req, res) => {
  const room = q.roomByName.get(req.params.name);
  if (!room) return res.status(404).json({ error: 'No such room' });
  q.leave.run(room.name, req.user);
  res.json({ ok: true });
});

app.get('/api/users', auth, (req, res) => {
  res.json(q.allUsers.all().map((u) => u.username));
});

// ---- chat history (newest page first; client passes ?before=<oldest id> to page back)
app.get('/api/history', auth, (req, res) => {
  const target = resolveChannel(req.user, req.query.channel);
  if (!target) return res.status(403).json({ error: 'Channel not available' });
  const before = parseInt(req.query.before, 10) || Number.MAX_SAFE_INTEGER;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  const rows = target.room
    ? q.roomHistory.all(target.room, before, limit)
    : q.dmHistory.all({ a: req.user, b: target.recipient, before, limit });
  res.json({ messages: rows.reverse().map((r) => toClient(r, req.user)), hasMore: rows.length === limit });
});

// ---- file upload (the file is then announced over the WebSocket)
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 9);
      cb(null, crypto.randomBytes(16).toString('hex') + ext);
    },
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 },
});

app.post('/api/upload', auth, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `File too large (max ${MAX_FILE_MB} MB)` : 'Upload failed';
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'No file' });
    res.json({
      url: '/uploads/' + req.file.filename,
      name: req.file.originalname.slice(0, 120),
      mime: req.file.mimetype,
    });
  });
});

// ---------------------------------------------------------------- websocket
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const sockets = new Map(); // username -> Set<ws>

const send = (ws, obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));
const sendToUser = (u, obj) => (sockets.get(u) || new Set()).forEach((ws) => send(ws, obj));
const broadcast = (obj) => sockets.forEach((set) => set.forEach((ws) => send(ws, obj)));

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') return socket.destroy();
  let username;
  try {
    username = canonicalUser(jwt.verify(url.searchParams.get('token') || '', JWT_SECRET).username);
    if (!username) throw new Error('no user');
  } catch {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, username));
});

wss.on('connection', (ws, user) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  const set = sockets.get(user) || new Set();
  const firstConnection = set.size === 0;
  set.add(ws);
  sockets.set(user, set);

  send(ws, { type: 'init', me: user, online: [...sockets.keys()] });
  if (firstConnection) broadcast({ type: 'presence', username: user, online: true });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.type === 'message') return onMessage(ws, user, m);
    if (m.type === 'typing') return onTyping(user, m);
  });

  ws.on('close', () => {
    set.delete(ws);
    if (set.size === 0) {
      sockets.delete(user);
      broadcast({ type: 'presence', username: user, online: false });
    }
  });
  ws.on('error', () => {});
});

function onMessage(ws, user, m) {
  const target = resolveChannel(user, m.channel);
  if (!target) return send(ws, { type: 'error', error: 'You cannot post in that channel' });

  const row = {
    room: target.room, sender: user, recipient: target.recipient,
    kind: 'text', body: '', file_name: null, file_url: null, file_mime: null,
    created_at: Date.now(),
  };

  if (m.file) {
    const f = m.file;
    if (typeof f.url !== 'string' || !FILE_URL_RE.test(f.url) ||
        !fs.existsSync(path.join(UPLOAD_DIR, path.basename(f.url)))) {
      return send(ws, { type: 'error', error: 'Invalid file' });
    }
    row.kind = 'file';
    row.file_url = f.url;
    row.file_name = String(f.name || 'file').slice(0, 120);
    row.file_mime = String(f.mime || 'application/octet-stream').slice(0, 100);
  } else {
    const text = typeof m.text === 'string' ? m.text.trim() : '';
    if (!text) return;
    if (text.length > MAX_TEXT) return send(ws, { type: 'error', error: `Message too long (max ${MAX_TEXT})` });
    row.body = text;
  }

  const id = q.insertMsg.run(row).lastInsertRowid;
  const saved = q.msgById.get(id);
  new Set(target.audience).forEach((u) => sendToUser(u, { type: 'message', message: toClient(saved, u) }));
}

function onTyping(user, m) {
  const target = resolveChannel(user, m.channel);
  if (!target) return;
  target.audience.filter((u) => u.toLowerCase() !== user.toLowerCase()).forEach((u) => {
    const channel = target.room ? 'room:' + target.room : 'dm:' + user;
    sendToUser(u, { type: 'typing', channel, username: user });
  });
}

// Drop dead connections so presence stays accurate.
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log(`Chat server running at http://localhost:${PORT}`));
}

module.exports = { server };
