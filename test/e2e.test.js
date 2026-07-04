import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

process.env.NODE_ENV = 'test';
process.env.DB_PATH = './test/e2e-test.db';
process.env.PORT = '3901';
process.env.JWT_SECRET = 'test-secret';

const { startServer, server, rooms } = await import('../server.js');

let baseUrl;

before(async () => {
  await startServer();
  baseUrl = `http://localhost:${process.env.PORT}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  try {
    const fs = await import('node:fs');
    fs.unlinkSync(process.env.DB_PATH);
  } catch { /* ignore cleanup errors */ }
});

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${process.env.PORT}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitForMessage(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for message')), timeoutMs);
    function onMsg(raw) {
      const msg = JSON.parse(raw.toString());
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(msg);
      }
    }
    ws.on('message', onMsg);
  });
}

describe('WebSocket game flow', () => {
  test('four players can create/join a room and start a game', async () => {
    const sockets = [];
    for (let i = 0; i < 4; i++) sockets.push(await connect());

    const createPromise = waitForMessage(sockets[0], m => m.type === 'room_created');
    sockets[0].send(JSON.stringify({ type: 'create_room', playerId: 'e2e-p0', displayName: 'P0' }));
    const created = await createPromise;
    const roomCode = created.roomCode;
    assert.ok(roomCode);

    for (let i = 1; i < 4; i++) {
      const joinPromise = waitForMessage(sockets[i], m => m.type === 'room_joined');
      sockets[i].send(JSON.stringify({ type: 'join_room', roomCode, playerId: `e2e-p${i}`, displayName: `P${i}` }));
      await joinPromise;
    }

    // once 4th joins, game should auto-start; wait for game_started broadcast
    const started = await waitForMessage(sockets[0], m => m.type === 'game_started');
    assert.ok(started);

    sockets.forEach(s => s.close());
  });

  test('3 human players can fill the last seat with AI and the game auto-starts', async () => {
    const sockets = [];
    for (let i = 0; i < 3; i++) sockets.push(await connect());

    const createPromise = waitForMessage(sockets[0], m => m.type === 'room_created');
    sockets[0].send(JSON.stringify({ type: 'create_room', playerId: 'fill-p0', displayName: 'Host' }));
    const created = await createPromise;
    const roomCode = created.roomCode;

    for (let i = 1; i < 3; i++) {
      const joinPromise = waitForMessage(sockets[i], m => m.type === 'room_joined');
      sockets[i].send(JSON.stringify({ type: 'join_room', roomCode, playerId: `fill-p${i}`, displayName: `P${i}` }));
      await joinPromise;
    }

    // Room now has 3 humans, 1 empty seat — game must NOT have auto-started yet.
    let startedTooEarly = false;
    try {
      await waitForMessage(sockets[0], m => m.type === 'game_started', 400);
      startedTooEarly = true;
    } catch {
      startedTooEarly = false; // expected — no game_started should arrive with only 3 players
    }
    assert.equal(startedTooEarly, false, 'game should not start with only 3 players and no AI');

    // Host fills the last seat with AI — this is exactly what the waiting-room "Add AI" fix enables.
    const startedPromise = waitForMessage(sockets[0], m => m.type === 'game_started');
    sockets[0].send(JSON.stringify({ type: 'add_ai', roomCode, skill: 'rookie' }));
    const started = await startedPromise;
    assert.ok(started);

    sockets.forEach(s => s.close());
  });

  test('3 human players can start a genuine 3-player game directly, with no AI involved at all', async () => {
    const sockets = [];
    for (let i = 0; i < 3; i++) sockets.push(await connect());

    const createPromise = waitForMessage(sockets[0], m => m.type === 'room_created');
    sockets[0].send(JSON.stringify({ type: 'create_room', playerId: 'real3-p0', displayName: 'Host' }));
    const created = await createPromise;
    const roomCode = created.roomCode;

    for (let i = 1; i < 3; i++) {
      const joinPromise = waitForMessage(sockets[i], m => m.type === 'room_joined');
      sockets[i].send(JSON.stringify({ type: 'join_room', roomCode, playerId: `real3-p${i}`, displayName: `P${i}` }));
      await joinPromise;
    }

    // Host explicitly starts with just the 3 real players — no add_ai, no 4th seat at all.
    const startedPromise = waitForMessage(sockets[0], m => m.type === 'game_started');
    const statePromise = waitForMessage(sockets[0], m => m.type === 'room_state' && m.room.phase === 'playing');
    sockets[0].send(JSON.stringify({ type: 'start_game', roomCode }));
    await startedPromise;
    const state = await statePromise;

    assert.equal(state.room.players.length, 3, 'room should have exactly 3 players, no phantom 4th');
    assert.ok(state.room.players.every(p => !p.isAI), 'no AI should have been added');
    assert.deepEqual(state.room.players.map(p => p.seat), ['E', 'S', 'W'], 'seats fill E,S,W, leaving N empty');

    sockets.forEach(s => s.close());
  });

  test('room_state exposes hostPlayerId so the client can re-derive host status after a reconnect', async () => {
    const ws1 = await connect();
    const createdP = waitForMessage(ws1, m => m.type === 'room_created');
    ws1.send(JSON.stringify({ type: 'create_room', playerId: 'host-reco-p0', displayName: 'Host' }));
    const { roomCode } = await createdP;

    const stateP = waitForMessage(ws1, m => m.type === 'room_state');
    // trigger a room_state broadcast by adding an AI (mirrors what the client would see live)
    ws1.send(JSON.stringify({ type: 'add_ai', roomCode, skill: 'rookie' }));
    const state1 = await stateP;
    assert.equal(state1.room.hostPlayerId, 'host-reco-p0');

    // Simulate the host's connection dropping and reconnecting (e.g. phone screen lock, page refresh)
    ws1.close();
    await new Promise(r => setTimeout(r, 50));
    const ws2 = await connect();
    const joinedP = waitForMessage(ws2, m => m.type === 'room_joined');
    const stateP2 = waitForMessage(ws2, m => m.type === 'room_state');
    ws2.send(JSON.stringify({ type: 'rejoin_room', roomCode, playerId: 'host-reco-p0' }));
    await joinedP;
    const state2 = await stateP2;

    // The reconnected client must still be told it's the host — this is what lets the
    // waiting-room "Add AI" / "Start Game" controls survive a refresh instead of vanishing.
    assert.equal(state2.room.hostPlayerId, 'host-reco-p0', 'hostPlayerId must persist across reconnects');
    ws2.close();
  });

  test('invalid message type returns an error, not a crash', async () => {
    const ws = await connect();
    const errPromise = waitForMessage(ws, m => m.type === 'error');
    ws.send(JSON.stringify({ type: 'not_a_real_type' }));
    const err = await errPromise;
    assert.match(err.message, /Unknown message type/);
    ws.close();
  });

  test('discarding out of turn is rejected', async () => {
    const ws = await connect();
    const createPromise = waitForMessage(ws, m => m.type === 'room_created');
    ws.send(JSON.stringify({ type: 'create_room', playerId: 'solo-p0', displayName: 'Solo' }));
    await createPromise;

    const errPromise = waitForMessage(ws, m => m.type === 'error');
    ws.send(JSON.stringify({ type: 'discard', tile: '1D' }));
    const err = await errPromise;
    assert.ok(err.message);
    ws.close();
  });

  test('host can abandon the game, ending it for every player at the table', async () => {
    const sockets = [];
    for (let i = 0; i < 3; i++) sockets.push(await connect());

    const createPromise = waitForMessage(sockets[0], m => m.type === 'room_created');
    sockets[0].send(JSON.stringify({ type: 'create_room', playerId: 'abandon-p0', displayName: 'Host' }));
    const created = await createPromise;
    const roomCode = created.roomCode;

    for (let i = 1; i < 3; i++) {
      const joinPromise = waitForMessage(sockets[i], m => m.type === 'room_joined');
      sockets[i].send(JSON.stringify({ type: 'join_room', roomCode, playerId: `abandon-p${i}`, displayName: `P${i}` }));
      await joinPromise;
    }

    // A non-host trying to end the game should be rejected.
    const rejectPromise = waitForMessage(sockets[1], m => m.type === 'error');
    sockets[1].send(JSON.stringify({ type: 'abandon_game' }));
    const rejected = await rejectPromise;
    assert.match(rejected.message, /Only the host/);

    // The host ending it broadcasts game_abandoned to everyone at the table, including themself.
    const abandonedPromises = sockets.map(s => waitForMessage(s, m => m.type === 'game_abandoned'));
    sockets[0].send(JSON.stringify({ type: 'abandon_game' }));
    const abandonedMsgs = await Promise.all(abandonedPromises);
    for (const msg of abandonedMsgs) assert.equal(msg.roomCode, roomCode);

    // The room should be gone — a late join attempt should fail with "Room not found".
    const notFoundPromise = waitForMessage(sockets[0], m => m.type === 'error');
    sockets[0].send(JSON.stringify({ type: 'add_ai', roomCode, skill: 'rookie' }));
    const notFound = await notFoundPromise;
    assert.match(notFound.message, /Room not found/);

    sockets.forEach(s => s.close());
  });

  test('a rapid double-fire "draw" (e.g. a double-tap before the UI updates) does not grant an extra tile', async () => {
    const sockets = [];
    for (let i = 0; i < 4; i++) sockets.push(await connect());

    const createPromise = waitForMessage(sockets[0], m => m.type === 'room_created');
    sockets[0].send(JSON.stringify({ type: 'create_room', playerId: 'dbl-p0', displayName: 'P0' }));
    const created = await createPromise;
    const roomCode = created.roomCode;

    for (let i = 1; i < 4; i++) {
      const joinPromise = waitForMessage(sockets[i], m => m.type === 'room_state');
      sockets[i].send(JSON.stringify({ type: 'join_room', roomCode, playerId: `dbl-p${i}`, displayName: `P${i}` }));
      await joinPromise;
    }
    // Room auto-starts once the 4th player joins.
    await waitForMessage(sockets[0], m => m.type === 'game_started');

    const room = rooms.get(roomCode);
    const dealer = room.players.find(p => p.seat === room.round.dealerSeat);
    const dealerSocket = sockets[room.players.indexOf(dealer)];

    // Dealer discards, handing the "needs to draw" turn to the next seat.
    const discardTile = dealer.hand[0];
    const dealerDiscardAck = waitForMessage(dealerSocket, m => m.type === 'room_state');
    dealerSocket.send(JSON.stringify({ type: 'discard', tile: discardTile }));
    await dealerDiscardAck;

    const nextSeat = room.turnSeat;
    const nextPlayer = room.players.find(p => p.seat === nextSeat);
    const nextSocket = sockets[room.players.indexOf(nextPlayer)];
    assert.equal(nextPlayer.hand.length % 3, 1, 'next player should be in a "needs to draw" state');

    // Fire 'draw' twice back-to-back, exactly like a fast double-tap would, before
    // either response comes back.
    const firstAck = waitForMessage(nextSocket, m => m.type === 'room_state');
    const secondError = waitForMessage(nextSocket, m => m.type === 'error');
    nextSocket.send(JSON.stringify({ type: 'draw' }));
    nextSocket.send(JSON.stringify({ type: 'draw' }));
    await firstAck;
    const err = await secondError;
    assert.match(err.message, /already drew/);

    const finalHandLen = room.players.find(p => p.seat === nextSeat).hand.length;
    assert.equal(finalHandLen, 14, 'the second draw must be rejected — hand should have exactly 14 tiles, not 15');

    sockets.forEach(s => s.close());
  });
});
