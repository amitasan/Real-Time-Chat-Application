# Realtime Chat (WebSocket)

A real-time messaging app: user accounts, public chat rooms, private (1-to-1) conversations, and instant delivery over WebSockets. Optional features included: **chat history, notifications, presence indicators, typing indicators, and file/image sharing**.

## Quick start

```bash
npm install
npm start            # http://localhost:3000
npm test             # end-to-end smoke test (9 checks)
```

Open `http://localhost:3000` in two different browsers (or one normal + one private window), sign up as two users, and chat.

Environment variables (optional): `PORT` (default 3000), `JWT_SECRET` (set this in production, otherwise logins reset on every restart), `DB_PATH`.

Requires Node.js 22.13 or newer. The database uses Node's built-in `node:sqlite` module, so there is nothing to compile and no Visual Studio / Python build tools are needed on Windows. (Node prints an "experimental" notice for SQLite on some versions; it is harmless.)

## Features

| Requirement | How it works |
|---|---|
| Accounts | `POST /api/register`, `POST /api/login`. Passwords hashed with bcrypt; sessions are JWTs (7 days). |
| Rooms | Create rooms, browse all rooms, join / leave. Everyone starts in `#general`. Only members can read or post. |
| Private chat | Click any user in the sidebar. Messages are visible only to the two participants. |
| Real-time messaging | One WebSocket per tab (`/ws?token=...`). Server validates, stores, then pushes to the audience. |
| Chat history | Stored in SQLite; the last 50 messages load on open, "Load earlier messages" pages back. |
| Presence | Green dot for online users. A user is offline only when their last tab disconnects. Heartbeat ping every 30 s removes dead connections. |
| Notifications | Unread badges per room/person, `(n)` in the tab title, and browser desktop notifications when the tab is in the background. |
| Typing indicator | "alice is typing…" shown in the active conversation. |
| File sharing | Paperclip button uploads (max 10 MB) over HTTP; the file is then announced over the WebSocket. Images preview inline, other files download. |
| Reconnect | Client reconnects with exponential backoff and re-syncs missed messages. |

## Architecture

```
Browser (public/app.js)
   |  REST (JSON)     register, login, rooms, users, history, upload
   |  WebSocket       message, typing  ->  server
   |                  init, presence, message, typing, error  <-  server
Node.js server (server.js)
   |- Express          static files, REST API, JWT auth middleware
   |- ws               WebSocket server, token checked during the HTTP upgrade
   |- multer           file uploads -> uploads/ (random names)
   '- SQLite (db.js)   users, rooms, room_members, messages
```

### WebSocket protocol

Client to server:
```json
{ "type": "message", "channel": "room:general", "text": "hi" }
{ "type": "message", "channel": "dm:bob", "file": { "url": "/uploads/...", "name": "a.png", "mime": "image/png" } }
{ "type": "typing",  "channel": "dm:bob" }
```
Server to client: `init` (own name + online users), `presence`, `message`, `typing`, `error`.

A channel is `room:<name>` or `dm:<username>`. For DMs, the server rewrites the channel per viewer, so Alice sees `dm:bob` and Bob sees `dm:alice` for the same message.

### Database schema

- `users(id, username, password_hash, created_at)`
- `rooms(name, created_by, created_at)`
- `room_members(room, username)`
- `messages(id, room, sender, recipient, kind, body, file_name, file_url, file_mime, created_at)` - `room` is set for room messages, `recipient` for private ones.

## Security notes

- Passwords hashed with bcrypt; parameterised SQL everywhere.
- All message text is rendered with `textContent`, so user input can never inject HTML.
- WebSocket and REST both require a valid token; room membership is checked on every send, typing event and history request.
- Uploads get random server-side names, are size-limited, and only png/jpg/gif/webp are served inline. Everything else is a forced download with `nosniff` + a restrictive CSP, so an uploaded HTML/SVG file can't run scripts.
- The server only accepts file URLs of the exact form `/uploads/<32 hex chars>.<ext>` in messages.

## Ideas for extending it (good for the internship write-up)

- Rate limiting on login and message sending (`express-rate-limit`).
- Replace the single process with several using Redis pub/sub so presence and delivery work across servers.
- Message edit/delete, read receipts, emoji reactions.
- Store uploads in S3-compatible object storage instead of local disk.
- Move the token from the WebSocket query string to a cookie or first-message handshake.
- HTTPS (required for desktop notifications outside localhost).

## Project layout

```
server.js        Express + WebSocket server
db.js            SQLite schema
public/          index.html, style.css, app.js (frontend)
test/smoke.js    automated end-to-end test
```
