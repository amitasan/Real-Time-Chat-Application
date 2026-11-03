// End-to-end smoke test: spins up the server on a temp DB and exercises the main flows.
// Run with:  npm test
process.env.DB_PATH = require('path').join(require('os').tmpdir(), `chat-test-${Date.now()}.db`);
process.env.JWT_SECRET = 'test-secret';

const assert = require('assert');
const WebSocket = require('ws');
const { server } = require('../server');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let base;

async function api(path, { method = 'GET', json, token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  const res = await fetch(base + path, { method, headers, body });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function client(token) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws?token=' + token);
  ws.inbox = [];
  ws.on('message', (d) => ws.inbox.push(JSON.parse(d)));
  return new Promise((res, rej) => { ws.on('open', () => res(ws)); ws.on('error', rej); });
}
const send = (ws, o) => ws.send(JSON.stringify(o));
const find = (ws, pred) => ws.inbox.find(pred);

(async () => {
  await new Promise((r) => server.listen(0, r));
  base = 'http://localhost:' + server.address().port;
  const ok = (m) => console.log('  ✓ ' + m);

  // --- accounts
  let r = await api('/api/register', { method: 'POST', json: { username: 'alice', password: 'secret1' } });
  assert.equal(r.status, 200); const alice = r.data.token;
  r = await api('/api/register', { method: 'POST', json: { username: 'bob', password: 'secret2' } });
  const bob = r.data.token;
  r = await api('/api/register', { method: 'POST', json: { username: 'carol', password: 'secret3' } });
  const carol = r.data.token;
  assert.equal((await api('/api/register', { method: 'POST', json: { username: 'ALICE', password: 'secret1' } })).status, 409);
  assert.equal((await api('/api/login', { method: 'POST', json: { username: 'alice', password: 'wrong' } })).status, 401);
  assert.equal((await api('/api/login', { method: 'POST', json: { username: 'alice', password: 'secret1' } })).status, 200);
  assert.equal((await api('/api/rooms')).status, 401);
  ok('register / login / duplicate + bad-password handling / auth required');

  // --- websocket auth + presence
  await assert.rejects(client('garbage'));
  const wa = await client(alice);
  const wb = await client(bob);
  await wait(100);
  assert(find(wa, (m) => m.type === 'presence' && m.username === 'bob' && m.online), 'alice sees bob online');
  assert(find(wb, (m) => m.type === 'init').online.includes('alice'));
  ok('invalid token rejected; presence online + init list');

  // --- rooms
  assert.equal((await api('/api/rooms', { method: 'POST', token: alice, json: { name: 'dev-team' } })).status, 200);
  assert.equal((await api('/api/rooms', { method: 'POST', token: alice, json: { name: 'dev-team' } })).status, 409);
  assert.equal((await api('/api/rooms/dev-team/join', { method: 'POST', token: bob })).status, 200);

  send(wa, { type: 'message', channel: 'room:dev-team', text: 'hello room' });
  await wait(150);
  const got = find(wb, (m) => m.type === 'message' && m.message.text === 'hello room');
  assert(got && got.message.channel === 'room:dev-team' && got.message.sender === 'alice');
  ok('room message delivered to members in real time');

  // carol never joined dev-team: must not receive it nor post to it
  const wc = await client(carol);
  send(wc, { type: 'message', channel: 'room:dev-team', text: 'sneaky' });
  await wait(150);
  assert(!find(wc, (m) => m.type === 'message'), 'non-member received nothing');
  assert(find(wc, (m) => m.type === 'error'), 'non-member got an error');
  assert.equal((await api('/api/history?channel=room:dev-team', { token: carol })).status, 403);
  ok('non-members cannot read or post in a room');

  // --- private messages
  send(wa, { type: 'message', channel: 'dm:bob', text: 'psst' });
  await wait(150);
  const dmB = find(wb, (m) => m.type === 'message' && m.message.text === 'psst');
  const dmA = find(wa, (m) => m.type === 'message' && m.message.text === 'psst');
  assert(dmB && dmB.message.channel === 'dm:alice', 'bob sees it under dm:alice');
  assert(dmA && dmA.message.channel === 'dm:bob', 'alice sees it under dm:bob');
  assert(!find(wc, (m) => m.type === 'message' && m.message.text === 'psst'), 'carol sees nothing');
  ok('private message reaches only the two participants');

  // --- typing
  send(wa, { type: 'typing', channel: 'dm:bob' });
  await wait(100);
  assert(find(wb, (m) => m.type === 'typing' && m.channel === 'dm:alice'));
  ok('typing indicator');

  // --- history
  for (let i = 0; i < 5; i++) send(wa, { type: 'message', channel: 'room:dev-team', text: 'm' + i });
  await wait(200);
  let h = await api('/api/history?channel=room:dev-team&limit=3', { token: bob });
  assert.equal(h.data.messages.length, 3); assert(h.data.hasMore);
  assert.equal(h.data.messages[2].text, 'm4');
  const older = await api(`/api/history?channel=room:dev-team&limit=3&before=${h.data.messages[0].id}`, { token: bob });
  assert.equal(older.data.messages.length, 3);
  h = await api('/api/history?channel=dm:alice', { token: bob });
  assert.deepEqual(h.data.messages.map((m) => m.text), ['psst']);
  ok('chat history with paging (room + private)');

  // --- file sharing
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('hello file')], { type: 'text/plain' }), 'notes.txt');
  const up = await api('/api/upload', { method: 'POST', token: alice, body: fd });
  assert.equal(up.status, 200);
  send(wa, { type: 'message', channel: 'dm:bob', file: up.data });
  await wait(150);
  const fm = find(wb, (m) => m.type === 'message' && m.message.kind === 'file');
  assert(fm && fm.message.file.name === 'notes.txt');
  const dl = await fetch(base + fm.message.file.url);
  assert.equal(await dl.text(), 'hello file');
  assert.match(dl.headers.get('content-disposition') || '', /attachment/);
  send(wa, { type: 'message', channel: 'dm:bob', file: { url: 'javascript:alert(1)', name: 'x' } });
  send(wa, { type: 'message', channel: 'dm:bob', file: { url: '/uploads/../server.js', name: 'x' } });
  await wait(150);
  assert.equal(wa.inbox.filter((m) => m.type === 'error').length, 2);
  ok('file upload, delivery, forced-download header, bad file URLs rejected');

  // --- presence offline (only after the user's last socket closes)
  wb.close();
  await wait(150);
  assert(find(wa, (m) => m.type === 'presence' && m.username === 'bob' && m.online === false));
  ok('presence offline broadcast');

  console.log('\nAll checks passed.');
  process.exit(0);
})().catch((e) => { console.error('\nTEST FAILED:', e); process.exit(1); });
