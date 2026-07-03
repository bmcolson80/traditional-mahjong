// test/persistence.test.js
// Tests for full game state persistence and player rejoin flow.
// Runs on its own server instance (port 3903, separate DB file).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import http from 'node:http';
import fs from 'node:fs';

process.env.NODE_ENV   = 'test';
process.env.DB_PATH    = './test/persistence-test.db';
process.env.PORT       = '3903';
process.env.JWT_SECRET = 'persist-secret';

const { startServer, server, rooms, loadRoomsFromDB } = await import('../server.js');

before(async () => { await startServer(); });

after(async () => {
  await new Promise(resolve => server.close(resolve));
  try { fs.unlinkSync(process.env.DB_PATH); } catch { /* ok */ }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${process.env.PORT}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitMsg(ws, predicate, ms = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`waitMsg timeout (${ms}ms): no matching message`)), ms);
    function handler(raw) {
      const msg = JSON.parse(raw.toString());
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    }
    ws.on('message', handler);
  });
}

// Use node:http directly — Node's built-in fetch strips Set-Cookie headers per spec
function nodeRequest(method, path, body = null, cookieHeader = '') {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = { 'Content-Type': 'application/json' };
    if (cookieHeader) headers['Cookie'] = cookieHeader;
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = http.request({ hostname: 'localhost', port: Number(process.env.PORT), path, method, headers }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        const setCookies = res.headers['set-cookie'] ?? [];
        const tokenCookie = setCookies.find(c => c.startsWith('token='))?.split(';')[0] ?? '';
        resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null, cookie: tokenCookie });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function registerAndGetCookie(email, name = 'Tester') {
  const { body: user, cookie } = await nodeRequest('POST', '/api/register', { email, name, password: 'test1234' });
  return { user, cookie };
}

// Create a room + AI players. Registers both listeners BEFORE sending to avoid race conditions.
async function createRoomWithAI(playerId, userId, displayName, aiCount = 3, skill = 'rookie') {
  const ws = await connect();
  const aiPlayers = Array.from({ length: aiCount }, () => ({ skill }));
  const createdP = waitMsg(ws, m => m.type === 'room_created');
  const startedP = waitMsg(ws, m => m.type === 'game_started');
  ws.send(JSON.stringify({ type: 'create_room', playerId, userId, displayName, aiPlayers }));
  const { roomCode } = await createdP;
  await startedP;
  return { ws, roomCode };
}

// ── persistRoom — full state saved ────────────────────────────────────────────

describe('persistRoom — full state saved', () => {
  test('wall, hands, and exposed sets survive a persist/restore cycle', async () => {
    const { ws, roomCode } = await createRoomWithAI('full-p0', null, 'Host');

    const before = rooms.get(roomCode);
    assert.equal(before.phase, 'playing');
    assert.ok(before.wall.length > 0, 'Wall should not be empty at game start');
    const eastHand = [...before.players.find(p => p.seat === 'E').hand];

    // Simulate server restart: clear in-memory map then reload from DB
    rooms.delete(roomCode);
    assert.equal(rooms.has(roomCode), false);
    await loadRoomsFromDB();

    const after = rooms.get(roomCode);
    assert.ok(after, 'Room restored from DB');
    assert.equal(after.phase, 'playing');
    assert.equal(after.wall.length, before.wall.length, 'Wall length preserved');
    assert.equal(after.players.length, 4, 'All 4 players restored');
    const eastAfter = after.players.find(p => p.seat === 'E');
    assert.deepEqual(eastAfter.hand, eastHand, 'East hand tiles preserved exactly');

    ws.close();
  });

  test('AI player fields (isAI, aiSkill) survive persist/restore', async () => {
    const { ws, roomCode } = await createRoomWithAI('ai-fields-p0', null, 'Host', 3, 'master');

    rooms.delete(roomCode);
    await loadRoomsFromDB();

    const room = rooms.get(roomCode);
    const aiPlayers = room.players.filter(p => p.isAI);
    assert.ok(aiPlayers.length >= 2);
    for (const p of aiPlayers) {
      assert.equal(p.isAI, true);
      assert.equal(p.aiSkill, 'master', 'aiSkill preserved');
    }
    ws.close();
  });

  test('round state survives persist/restore', async () => {
    const { ws, roomCode } = await createRoomWithAI('round-p0', null, 'Host');
    const before = rooms.get(roomCode);
    const { windIndex, handNumber, dealerSeat } = before.round;

    rooms.delete(roomCode);
    await loadRoomsFromDB();

    const after = rooms.get(roomCode);
    assert.equal(after.round.windIndex, windIndex);
    assert.equal(after.round.handNumber, handNumber);
    assert.equal(after.round.dealerSeat, dealerSeat);
    ws.close();
  });

  test('finished games are NOT restored by loadRoomsFromDB', async () => {
    const { ws, roomCode } = await createRoomWithAI('finished-p0', null, 'Host');
    const { run } = await import('../db.js');
    run(`UPDATE games SET phase='finished' WHERE room_code=?`, [roomCode]);

    rooms.delete(roomCode);
    await loadRoomsFromDB();
    assert.equal(rooms.has(roomCode), false, 'Finished game must not be restored');
    ws.close();
  });
});

// ── rejoin_room ───────────────────────────────────────────────────────────────

describe('rejoin_room — player reconnects', () => {
  test('player can rejoin by playerId after disconnecting', async () => {
    const { ws: ws1, roomCode } = await createRoomWithAI('rejoin-pid-0', null, 'Rejoiner');
    ws1.close();
    await new Promise(r => setTimeout(r, 50));

    const ws2 = await connect();
    const joinedP = waitMsg(ws2, m => m.type === 'room_joined');
    ws2.send(JSON.stringify({ type: 'rejoin_room', roomCode, playerId: 'rejoin-pid-0' }));
    const joined = await joinedP;
    assert.equal(joined.roomCode, roomCode);
    assert.ok(joined.seat);
    ws2.close();
  });

  test('player can rejoin by userId with a different playerId (new browser session)', async () => {
    const { ws: ws1, roomCode } = await createRoomWithAI('rejoin-uid-p0', 42, 'UserHost');
    ws1.close();
    await new Promise(r => setTimeout(r, 50));

    const ws2 = await connect();
    const joinedP = waitMsg(ws2, m => m.type === 'room_joined');
    ws2.send(JSON.stringify({ type: 'rejoin_room', roomCode, playerId: 'brand-new-pid', userId: 42 }));
    const joined = await joinedP;
    assert.equal(joined.roomCode, roomCode);
    ws2.close();
  });

  test('rejoin broadcasts room_state so the game screen can render', async () => {
    const { ws: ws1, roomCode } = await createRoomWithAI('rejoin-state-p0', null, 'StateHost');
    ws1.close();
    await new Promise(r => setTimeout(r, 50));

    const ws2 = await connect();
    const joinedP  = waitMsg(ws2, m => m.type === 'room_joined');
    const stateP   = waitMsg(ws2, m => m.type === 'room_state');
    ws2.send(JSON.stringify({ type: 'rejoin_room', roomCode, playerId: 'rejoin-state-p0' }));
    const [joined, state] = await Promise.all([joinedP, stateP]);

    assert.equal(joined.roomCode, roomCode);
    assert.equal(state.room.code, roomCode);
    assert.equal(state.room.phase, 'playing');
    assert.equal(state.room.players.length, 4);
    ws2.close();
  });

  test('rejoining a non-existent room returns an error message', async () => {
    const ws = await connect();
    const errP = waitMsg(ws, m => m.type === 'error');
    ws.send(JSON.stringify({ type: 'rejoin_room', roomCode: 'XXXXX', playerId: 'nobody' }));
    const err = await errP;
    assert.match(err.message, /not found|ended/i);
    ws.close();
  });

  test('a player not in the room gets an error on rejoin attempt', async () => {
    const { ws: ws1, roomCode } = await createRoomWithAI('intruder-host', null, 'Host');
    const ws2 = await connect();
    const errP = waitMsg(ws2, m => m.type === 'error');
    ws2.send(JSON.stringify({ type: 'rejoin_room', roomCode, playerId: 'intruder-id' }));
    const err = await errP;
    assert.match(err.message, /not in this game/i);
    ws1.close();
    ws2.close();
  });
});

// ── /api/my-games ─────────────────────────────────────────────────────────────

describe('/api/my-games', () => {
  test('returns 401 for unauthenticated requests', async () => {
    const { status } = await nodeRequest('GET', '/api/my-games');
    assert.equal(status, 401);
  });

  test('returns empty array when user has no active games', async () => {
    const { cookie } = await registerAndGetCookie('nogames@test.com', 'NoGames');
    const { status, body } = await nodeRequest('GET', '/api/my-games', null, cookie);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 0);
  });

  test('returns the room after a user creates a game', async () => {
    const { cookie, user } = await registerAndGetCookie('hasgame@test.com', 'HasGame');

    const ws = await connect();
    const createdP = waitMsg(ws, m => m.type === 'room_created');
    const startedP = waitMsg(ws, m => m.type === 'game_started');
    ws.send(JSON.stringify({
      type: 'create_room', playerId: 'mg-p0', userId: user.id, displayName: 'HasGame',
      aiPlayers: [{ skill: 'rookie' }, { skill: 'rookie' }, { skill: 'rookie' }],
    }));
    const { roomCode } = await createdP;
    await startedP;

    const { status, body } = await nodeRequest('GET', '/api/my-games', null, cookie);
    assert.equal(status, 200);
    assert.ok(body.length > 0, 'Should have at least one active game');
    assert.ok(body.some(g => g.roomCode === roomCode), 'Should include the created room');
    assert.ok(body[0].players?.length > 0, 'Should include players');
    assert.ok(body[0].roundWind, 'Should include round wind');

    ws.close();
  });
});
