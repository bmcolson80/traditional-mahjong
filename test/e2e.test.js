import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.DB_PATH = './test/e2e-test.db';
process.env.PORT = '3901';
process.env.JWT_SECRET = 'test-secret';
process.env.HUB_URL = 'http://localhost:4901';

const { startServer, server, rooms, persistRoom } = await import('../server.js');

let baseUrl;
let hubProcess;

// /api/register and password-reset routes now proxy to the GamesNight hub
// (the sibling gamesnight-hub repo owns the real password) rather than
// checking a local table directly, so any test that hits those routes
// needs a real hub instance to talk to — spin one up as a child process on
// a dedicated test port, using the same JWT_SECRET so its issued tokens
// verify here.
const HUB_REPO_PATH = '/Users/colsons/gamesnight-hub';
const HUB_TEST_DB    = '/tmp/gamesnight-hub-mahjong-test.db';

async function waitForHubReady(url, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('gamesnight-hub did not become ready in time — is it checked out at ' + HUB_REPO_PATH + '?');
}

before(async () => {
  try { fs.unlinkSync(HUB_TEST_DB); } catch { /* ignore */ }
  hubProcess = spawn('node', ['server.js'], {
    cwd: HUB_REPO_PATH,
    env: { ...process.env, PORT: '4901', JWT_SECRET: 'test-secret', DB_PATH: HUB_TEST_DB },
    stdio: 'ignore',
  });
  await waitForHubReady(process.env.HUB_URL);

  await startServer();
  baseUrl = `http://localhost:${process.env.PORT}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  hubProcess?.kill();
  try { fs.unlinkSync(process.env.DB_PATH); } catch { /* ignore cleanup errors */ }
  try { fs.unlinkSync(HUB_TEST_DB); } catch { /* ignore cleanup errors */ }
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

  test('host rejoining with a NEW local playerId (cleared storage, private browsing, reinstall) keeps host status', async () => {
    const ws1 = await connect();
    const createdP = waitForMessage(ws1, m => m.type === 'room_created');
    ws1.send(JSON.stringify({ type: 'create_room', playerId: 'orig-pid', userId: 777, displayName: 'Host' }));
    const { roomCode } = await createdP;
    ws1.close();
    await new Promise(r => setTimeout(r, 50));

    // Reconnect as the SAME account (same userId) but with a brand-new local playerId —
    // exactly what happens after clearing browser storage, reinstalling, or a private tab.
    const ws2 = await connect();
    const joinedP = waitForMessage(ws2, m => m.type === 'room_joined');
    const stateP = waitForMessage(ws2, m => m.type === 'room_state');
    ws2.send(JSON.stringify({ type: 'rejoin_room', roomCode, playerId: 'brand-new-pid', userId: 777 }));
    await joinedP;
    const state = await stateP;

    assert.equal(state.room.hostPlayerId, 'brand-new-pid',
      'hostPlayerId must be carried forward to the new local playerId, or the host silently loses ' +
      'access to host-only controls (End Game, Start Game, Add AI) despite still owning the room');
    ws2.close();
  });

  test('a legacy room with a completely untraceable hostPlayerId still recovers host status for the sole human player', async () => {
    // This models exactly the kind of already-corrupted production room this fix
    // targets: created before hostUserId existed, and hostPlayerId no longer matches
    // anything (worse than a simple "playerId changed" case — simple carryover can't
    // help here since there's no matching old ID to carry forward).
    const email = `legacy${Date.now()}@example.com`;
    const regRes = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name: 'LegacyHost', password: 'testpass123' }),
    });
    const cookie = regRes.headers.get('set-cookie').split(';')[0];
    const { id: userId } = await regRes.json();

    const ws1 = await connect();
    const createdP = waitForMessage(ws1, m => m.type === 'room_created');
    ws1.send(JSON.stringify({ type: 'create_room', playerId: 'some-pid', userId, displayName: 'LegacyHost' }));
    const { roomCode } = await createdP;

    // Simulate the pre-existing corruption directly: no hostUserId (legacy), and
    // hostPlayerId now pointing at something untraceable.
    const room = rooms.get(roomCode);
    room.hostUserId = null;
    room.hostPlayerId = 'totally-unrelated-stale-id';
    persistRoom(room);
    ws1.close();
    await new Promise(r => setTimeout(r, 50));

    const myGames = await (await fetch(`${baseUrl}/api/my-games`, { headers: { Cookie: cookie } })).json();
    const listed = myGames.find(g => g.roomCode === roomCode);
    assert.ok(listed, 'the room should still be listed');
    assert.equal(listed.isHost, true,
      'the sole human at the table should be inferred as host even when hostPlayerId is untraceable');

    const endRes = await fetch(`${baseUrl}/api/games/${roomCode}/end`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(endRes.status, 200, 'ending the game via the same inference should succeed');
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

  test('declare_fishing rejects non-tenpai hands, locks the hand once accepted, blocks melds, and forces every future discard to the tile just drawn', async () => {
    const sockets = [];
    for (let i = 0; i < 4; i++) sockets.push(await connect());

    const createPromise = waitForMessage(sockets[0], m => m.type === 'room_created');
    sockets[0].send(JSON.stringify({ type: 'create_room', playerId: 'fish-p0', displayName: 'P0' }));
    const created = await createPromise;
    const roomCode = created.roomCode;

    for (let i = 1; i < 4; i++) {
      const joinPromise = waitForMessage(sockets[i], m => m.type === 'room_state');
      sockets[i].send(JSON.stringify({ type: 'join_room', roomCode, playerId: `fish-p${i}`, displayName: `P${i}` }));
      await joinPromise;
    }
    await waitForMessage(sockets[0], m => m.type === 'game_started');

    const room = rooms.get(roomCode);
    const dealer = room.players.find(p => p.seat === room.round.dealerSeat);
    const dealerSocket = sockets[room.players.indexOf(dealer)];

    // The real, randomly-dealt opening hand is essentially never tenpai — declaring
    // fishing on it should be rejected rather than silently locking a dead hand.
    const rejectPromise = waitForMessage(dealerSocket, m => m.type === 'error');
    dealerSocket.send(JSON.stringify({ type: 'declare_fishing', tile: dealer.hand[0] }));
    const rejected = await rejectPromise;
    assert.match(rejected.message, /not one tile away/);
    assert.equal(dealer.fishing, false);

    // Overwrite the dealer's hand with an engineered tenpai hand (waiting on a 9D
    // pair) so we can test the acceptance path deterministically.
    dealer.hand = ['1D', '1D', '1D', '2D', '3D', '4D', '2B', '2B', '2B', '3C', '4C', '5C', '9D', '9D'];

    const fishingBroadcasts = sockets.map(s => waitForMessage(s, m => m.type === 'player_fishing'));
    dealerSocket.send(JSON.stringify({ type: 'declare_fishing', tile: '9D' }));
    const fishingMsgs = await Promise.all(fishingBroadcasts);
    for (const msg of fishingMsgs) assert.equal(msg.seat, dealer.seat);

    assert.equal(dealer.fishing, true);
    assert.equal(dealer.hand.length, 13);
    assert.equal(room.currentDiscard.tile, '9D');
    assert.equal(room.currentDiscard.fromSeat, dealer.seat);
    assert.notEqual(room.turnSeat, dealer.seat);

    // A fishing player cannot call melds, even before any other eligibility check runs.
    const meldRejectPromise = waitForMessage(dealerSocket, m => m.type === 'error');
    dealerSocket.send(JSON.stringify({ type: 'claim_pung' }));
    const meldRejected = await meldRejectPromise;
    assert.match(meldRejected.message, /cannot call melds/);

    // Cycle the other 3 seats through a normal draw+discard so play comes back
    // around to the fishing dealer.
    for (let i = 0; i < 3; i++) {
      const turnPlayer = room.players.find(p => p.seat === room.turnSeat);
      const turnSocket = sockets[room.players.indexOf(turnPlayer)];
      const drawAck = waitForMessage(turnSocket, m => m.type === 'room_state');
      turnSocket.send(JSON.stringify({ type: 'draw' }));
      await drawAck;
      const drawnHand = room.players.find(p => p.seat === turnPlayer.seat).hand;
      const discardAck = waitForMessage(turnSocket, m => m.type === 'room_state');
      turnSocket.send(JSON.stringify({ type: 'discard', tile: drawnHand[drawnHand.length - 1] }));
      await discardAck;
    }
    assert.equal(room.turnSeat, dealer.seat, 'play should have cycled back to the fishing dealer');

    // Dealer draws again — the lock means only that exact tile may be discarded.
    const dealerDrawAck = waitForMessage(dealerSocket, m => m.type === 'room_state');
    dealerSocket.send(JSON.stringify({ type: 'draw' }));
    await dealerDrawAck;
    const relockedDealer = room.players.find(p => p.seat === dealer.seat);
    const drawnTile = relockedDealer.hand[relockedDealer.hand.length - 1];
    const wrongTile = relockedDealer.hand.find(t => t !== drawnTile);

    const wrongDiscardReject = waitForMessage(dealerSocket, m => m.type === 'error');
    dealerSocket.send(JSON.stringify({ type: 'discard', tile: wrongTile }));
    const wrongRejected = await wrongDiscardReject;
    assert.match(wrongRejected.message, /can only discard the tile you just drew/);

    const forcedDiscardAck = waitForMessage(dealerSocket, m => m.type === 'room_state');
    dealerSocket.send(JSON.stringify({ type: 'discard', tile: drawnTile }));
    await forcedDiscardAck;
    assert.equal(room.currentDiscard.tile, drawnTile);

    sockets.forEach(s => s.close());
  });
});
