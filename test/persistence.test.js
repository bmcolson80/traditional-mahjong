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
process.env.ADMIN_EMAIL = 'admin@test.com';

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

// Like nodeRequest, but for endpoints that don't return JSON (e.g. the admin HTML shell).
function nodeRequestRaw(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: 'localhost', port: Number(process.env.PORT), path, method }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
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

// ── bankruptcy house rule (server-level) ────────────────────────────────────────

describe('bankruptcy ends the match instantly', () => {
  test('declare_win sets matchOverReason "bankruptcy" and includes bankruptSeats when a payer runs out of chips', async () => {
    const { ws, roomCode } = await createRoomWithAI('bankrupt-p0', null, 'Host');
    const room = rooms.get(roomCode);
    const east = room.players.find(p => p.seat === 'E'); // host is always dealt seat E as first player

    // Rig a simple concealed self-draw win: 3 chow-able runs + a pair, 14th tile completes it.
    east.hand = ['1D','2D','3D','4D','5D','6D','7D','8D','9D','1B','2B','3B','9C','9C'];
    east.exposed = [];
    room.currentDiscard = null; // ensures declare_win treats this as a self-draw

    // Put an opponent on the brink so any payout bankrupts them, regardless of the exact
    // dealer-win/streak multiplier math (this test only cares about the end-of-match wiring).
    const west = room.players.find(p => p.seat === 'W');
    west.score = 1;

    const wonP = waitMsg(ws, m => m.type === 'game_won');
    ws.send(JSON.stringify({ type: 'declare_win' }));
    const won = await wonP;

    assert.ok(won.bankruptSeats.includes('W'), 'West should be reported bankrupt in the broadcast');
    assert.equal(won.matchOver, true);

    const after = rooms.get(roomCode);
    assert.equal(after.round.matchOverReason, 'bankruptcy', 'room.round should persist the reason the match ended');
    assert.ok(after.round.bankruptSeats.includes('W'), 'room.round should persist which seat(s) went bankrupt');

    ws.close();
  });
});

// ── cleanupOldGames ──────────────────────────────────────────────────────────

describe('cleanupOldGames', () => {
  test('deletes finished/ended games older than the retention window, and their game_players rows', async () => {
    const { run, get, cleanupOldGames } = await import('../db.js');
    const { ws, roomCode } = await createRoomWithAI('cleanup-old-p0', 7, 'OldHost');
    ws.close();

    // Simulate a long-abandoned game: ended, and created/ended far in the past.
    run(
      `UPDATE games SET phase='ended', created_at=datetime('now','-60 days'), ended_at=datetime('now','-60 days')
       WHERE room_code=?`,
      [roomCode]
    );
    const before = get('SELECT id FROM games WHERE room_code=?', [roomCode]);
    assert.ok(before, 'Game row exists before cleanup');
    assert.ok(
      get('SELECT COUNT(*) as c FROM game_players WHERE game_id=?', [before.id]).c > 0,
      'game_players rows exist before cleanup'
    );

    const result = cleanupOldGames({ retentionDays: 30 });
    assert.ok(result.deletedGames >= 1, 'Should delete at least the old game');

    assert.equal(get('SELECT id FROM games WHERE room_code=?', [roomCode]), null, 'Game row deleted');
    assert.equal(
      get('SELECT COUNT(*) as c FROM game_players WHERE game_id=?', [before.id]).c,
      0,
      'game_players rows deleted'
    );
  });

  test('does not delete recent finished/ended games', async () => {
    const { run, get, cleanupOldGames } = await import('../db.js');
    const { ws, roomCode } = await createRoomWithAI('cleanup-recent-p0', 8, 'RecentHost');
    ws.close();

    run(`UPDATE games SET phase='ended' WHERE room_code=?`, [roomCode]);
    cleanupOldGames({ retentionDays: 30 });

    assert.ok(get('SELECT id FROM games WHERE room_code=?', [roomCode]), 'Recent game row must survive cleanup');
  });

  test('does not delete a game excluded via excludeRoomCodes, even if old', async () => {
    const { run, get, cleanupOldGames } = await import('../db.js');
    const { ws, roomCode } = await createRoomWithAI('cleanup-excl-p0', 9, 'ExclHost');
    ws.close();

    run(
      `UPDATE games SET phase='finished', created_at=datetime('now','-60 days') WHERE room_code=?`,
      [roomCode]
    );
    cleanupOldGames({ retentionDays: 30, excludeRoomCodes: [roomCode] });

    assert.ok(get('SELECT id FROM games WHERE room_code=?', [roomCode]), 'Excluded room must survive cleanup');
  });

  test('does not delete active waiting/playing games regardless of age', async () => {
    const { run, get, cleanupOldGames } = await import('../db.js');
    const { ws, roomCode } = await createRoomWithAI('cleanup-active-p0', 10, 'ActiveHost');

    run(`UPDATE games SET created_at=datetime('now','-60 days') WHERE room_code=?`, [roomCode]);
    cleanupOldGames({ retentionDays: 30 });

    assert.ok(get('SELECT id FROM games WHERE room_code=?', [roomCode]), 'Active game row must survive cleanup');
    ws.close();
  });
});

// ── /api/admin/stats ─────────────────────────────────────────────────────────

describe('/api/admin/stats', () => {
  test('returns 401 for unauthenticated requests', async () => {
    const { status } = await nodeRequest('GET', '/api/admin/stats');
    assert.equal(status, 401);
  });

  test('returns 403 for an authenticated non-admin user', async () => {
    const { cookie } = await registerAndGetCookie('notadmin@test.com', 'NotAdmin');
    const { status } = await nodeRequest('GET', '/api/admin/stats', null, cookie);
    assert.equal(status, 403);
  });

  test('returns aggregate stats for the admin user', async () => {
    const { cookie } = await registerAndGetCookie('admin@test.com', 'Admin');
    const { ws } = await createRoomWithAI('admin-stats-p0', 99, 'StatsHost');
    ws.close();

    const { status, body } = await nodeRequest('GET', '/api/admin/stats', null, cookie);
    assert.equal(status, 200);
    assert.ok(body.totalUsers >= 1);
    assert.ok(body.totalGames >= 1);
    assert.ok(body.activeGames >= 1, 'the just-created game should count as active');
    assert.ok(body.gamesLast7d >= 1);
    assert.ok(body.newUsersLast7d >= 1);
    assert.ok('avgGameDurationMinutes' in body);
  });
});

// ── /admin page + isAdmin flag ───────────────────────────────────────────────

describe('/admin page', () => {
  test('serves the admin HTML shell to anyone (gating happens client-side via the API)', async () => {
    const { status, body } = await nodeRequestRaw('GET', '/admin');
    assert.equal(status, 200);
    assert.match(body, /admin/i);
  });
});

describe('isAdmin flag', () => {
  test('/api/register reports isAdmin: false for a non-admin email', async () => {
    const { body: registerBody } = await nodeRequest('POST', '/api/register', {
      email: 'notadmin2@test.com', name: 'NotAdmin2', password: 'test1234',
    });
    assert.equal(registerBody.isAdmin, false);
  });

  test('/api/me reports isAdmin: true only for the configured ADMIN_EMAIL', async () => {
    // admin@test.com was already registered by the /api/admin/stats suite above.
    const { body: loginBody, cookie: adminCookie } = await nodeRequest('POST', '/api/login', {
      email: 'admin@test.com', password: 'test1234',
    });
    assert.equal(loginBody.isAdmin, true);
    const adminMe = await nodeRequest('GET', '/api/me', null, adminCookie);
    assert.equal(adminMe.body.isAdmin, true);

    const { cookie: regularCookie } = await registerAndGetCookie('regular@test.com', 'Regular');
    const regularMe = await nodeRequest('GET', '/api/me', null, regularCookie);
    assert.equal(regularMe.body.isAdmin, false);
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
