const path = require('path');
// Node's built-in SQLite (Node 22.13+): no native compile step, nothing extra to install.
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'chat.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  name       TEXT PRIMARY KEY COLLATE NOCASE,
  created_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS room_members (
  room     TEXT NOT NULL COLLATE NOCASE REFERENCES rooms(name) ON DELETE CASCADE,
  username TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (room, username)
);

-- A message belongs either to a room (room set) or to a private chat (recipient set).
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room       TEXT COLLATE NOCASE,
  sender     TEXT NOT NULL COLLATE NOCASE,
  recipient  TEXT COLLATE NOCASE,
  kind       TEXT NOT NULL DEFAULT 'text',   -- 'text' | 'file'
  body       TEXT NOT NULL DEFAULT '',
  file_name  TEXT,
  file_url   TEXT,
  file_mime  TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_room ON messages(room, id);
CREATE INDEX IF NOT EXISTS idx_msg_dm   ON messages(sender, recipient, id);
`);

db.prepare('INSERT OR IGNORE INTO rooms (name, created_by, created_at) VALUES (?, ?, ?)')
  .run('general', 'system', Date.now());

module.exports = db;
