/**
 * Mah Jong — Notification gating regression tests
 *
 * Covers three easy-to-get-backwards pieces of logic added for the
 * email-fallback / active-session-suppression feature:
 *  1. isActivelyViewing() — must suppress only when a matching userId+roomCode
 *     connection is visible, not merely connected.
 *  2. shouldSendTurnEmail() debounce — must block a second immediate send for
 *     the same (userId, roomCode) but not affect other rooms.
 *  3. notifyUser()'s active-viewing gate wired ahead of the push/email
 *     decision — a viewing user must get no email-debounce side effect at all.
 *
 * Run with: node --test test/notifications.test.js
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV             = 'test';
process.env.DB_PATH              = './test/notifications-test.db';
process.env.PORT                 = '3903';
process.env.JWT_SECRET           = 'test-secret';
process.env.INTERNAL_SYNC_SECRET = 'test-internal-secret';
process.env.HUB_URL              = 'http://127.0.0.1:1'; // unreachable on purpose

const { startServer, server, clients, isActivelyViewing, notifyUser, shouldSendTurnEmail, turnEmailLastSent } = await import('../server.js');
const { run } = await import('../db.js');

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

async function registerUser(email, name) {
  const res = await fetch(`${baseUrl}/api/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name, password: 'password123' }),
  });
  const data = await res.json();
  return data.id;
}

describe('isActivelyViewing', () => {
  test('true when a client for that userId+roomCode is visible', () => {
    const fakeWs = {};
    clients.set(fakeWs, { roomCode: 'ROOMA', playerId: 'p1', userId: 1, displayName: 'A', visible: true });
    assert.equal(isActivelyViewing(1, 'ROOMA'), true);
    clients.delete(fakeWs);
  });

  test('false when the matching client is connected but backgrounded', () => {
    const fakeWs = {};
    clients.set(fakeWs, { roomCode: 'ROOMB', playerId: 'p1', userId: 2, displayName: 'B', visible: false });
    assert.equal(isActivelyViewing(2, 'ROOMB'), false);
    clients.delete(fakeWs);
  });

  test('false when the visible client is scoped to a different room', () => {
    const fakeWs = {};
    clients.set(fakeWs, { roomCode: 'ROOMC', playerId: 'p1', userId: 3, displayName: 'C', visible: true });
    assert.equal(isActivelyViewing(3, 'ROOMD'), false);
    clients.delete(fakeWs);
  });

  test('false when there is no connection at all for that user', () => {
    assert.equal(isActivelyViewing(999999, 'ROOME'), false);
  });
});

describe('shouldSendTurnEmail debounce', () => {
  test('allows the first send, blocks an immediate repeat for the same room', () => {
    assert.equal(shouldSendTurnEmail(101, 'DBROOM'), true);
    assert.equal(shouldSendTurnEmail(101, 'DBROOM'), false);
  });

  test('does not block a different room for the same user', () => {
    assert.equal(shouldSendTurnEmail(102, 'ROOM-X'), true);
    assert.equal(shouldSendTurnEmail(102, 'ROOM-Y'), true);
  });
});

describe('notifyUser active-viewing gate', () => {
  test('a viewing user gets no email-debounce side effect (fully suppressed)', async () => {
    const userId = await registerUser(`viewing-${Date.now()}@example.com`, 'Viewer');
    const fakeWs = {};
    clients.set(fakeWs, { roomCode: 'VIEWROOM', playerId: 'p1', userId, displayName: 'Viewer', visible: true });

    await notifyUser(userId, { title: 'Your turn!', body: 'Go' }, { roomCode: 'VIEWROOM', kind: 'turn' });

    assert.equal(turnEmailLastSent.has(`${userId}:VIEWROOM`), false);
    clients.delete(fakeWs);
  });

  test('a non-viewing user with no active push gets an email-debounce marker set', async () => {
    const userId = await registerUser(`away-${Date.now()}@example.com`, 'Away');
    // No clients entry at all for this user — not connected, so not viewing.

    await notifyUser(userId, { title: 'Your turn!', body: 'Go' }, { roomCode: 'AWAYROOM', kind: 'turn' });

    assert.equal(turnEmailLastSent.has(`${userId}:AWAYROOM`), true);
  });

  test('a non-viewing user WITH an active push subscription gets no email-debounce marker (push, not email)', async () => {
    const userId = await registerUser(`pushed-${Date.now()}@example.com`, 'Pushed');
    run(
      'INSERT INTO push_subscriptions (user_id, endpoint, subscription_json) VALUES (?, ?, ?)',
      [userId, 'https://example.com/push/1', JSON.stringify({ endpoint: 'https://example.com/push/1', keys: { p256dh: 'fake', auth: 'fake' } })]
    );

    await notifyUser(userId, { title: 'Your turn!', body: 'Go' }, { roomCode: 'PUSHROOM', kind: 'turn' });

    assert.equal(turnEmailLastSent.has(`${userId}:PUSHROOM`), false);
  });
});
