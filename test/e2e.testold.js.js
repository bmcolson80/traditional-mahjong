import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

process.env.NODE_ENV = 'test';
process.env.DB_PATH = './test/e2e-test.db';
process.env.PORT = '3901';
process.env.JWT_SECRET = 'test-secret';

const { startServer, server } = await import('../server.js');

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
});
