/**
 * Mah Jong — Account sync regression tests
 *
 * Proves register/login never depend on the hub being reachable (the exact
 * failure mode that caused the prior production incident), and that the
 * internal sync-account endpoint correctly replicates/rejects.
 *
 * Run with: npm run test:account-sync
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV             = 'test';
process.env.DB_PATH              = './test/account-sync-test.db';
process.env.PORT                 = '3902';
process.env.JWT_SECRET           = 'test-secret';
process.env.INTERNAL_SYNC_SECRET = 'test-internal-secret';
process.env.HUB_URL              = 'http://127.0.0.1:1'; // unreachable on purpose

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

describe('Register/login survive an unreachable hub', () => {
  test('register succeeds even though HUB_URL is unreachable', async () => {
    const email = `sync-${Date.now()}@example.com`;
    const res = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name: 'Sync Test', password: 'password123' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.email, email);
  });

  test('login succeeds locally, independent of the hub', async () => {
    const email = `sync-login-${Date.now()}@example.com`;
    await fetch(`${baseUrl}/api/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name: 'Login Test', password: 'password123' }),
    });
    const res = await fetch(`${baseUrl}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'password123' }),
    });
    assert.equal(res.status, 200);
  });
});

describe('Internal sync-account endpoint', () => {
  test('rejects requests without the correct internal secret', async () => {
    const res = await fetch(`${baseUrl}/api/internal/sync-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'x@example.com', name: 'X', passwordHash: 'hash' }),
    });
    assert.equal(res.status, 403);
  });

  test('creates a new local account when none exists for that email', async () => {
    const email = `synced-${Date.now()}@example.com`;
    const res = await fetch(`${baseUrl}/api/internal/sync-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': 'test-internal-secret' },
      body: JSON.stringify({ email, name: 'Synced User', passwordHash: '$2a$10$fakehashfakehashfakehashfa', sourceGameId: 'azul' }),
    });
    assert.equal(res.status, 200);
  });

  test('updates the password hash for an account that already exists', async () => {
    const email = `existing-${Date.now()}@example.com`;
    await fetch(`${baseUrl}/api/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name: 'Existing', password: 'originalpass' }),
    });
    const syncRes = await fetch(`${baseUrl}/api/internal/sync-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': 'test-internal-secret' },
      body: JSON.stringify({ email, name: 'Existing', passwordHash: '$2a$10$fakehashfakehashfakehashfa', sourceGameId: 'azul' }),
    });
    assert.equal(syncRes.status, 200);

    // Original password should no longer work — it was overwritten by the sync.
    const loginRes = await fetch(`${baseUrl}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'originalpass' }),
    });
    assert.equal(loginRes.status, 401);
  });

  test('rejects a brand-new account with no passwordHash', async () => {
    const email = `new-nohash-${Date.now()}@example.com`;
    const res = await fetch(`${baseUrl}/api/internal/sync-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': 'test-internal-secret' },
      body: JSON.stringify({ email, name: 'No Hash', sourceGameId: 'azul' }),
    });
    assert.equal(res.status, 400);
  });

  // A name-only change (e.g. from another game's profile settings) has no new
  // password hash to replicate — this must update the name without requiring
  // or touching the password, and must NOT invalidate the existing password.
  test('updates only the name for an existing account when passwordHash is omitted', async () => {
    const email = `name-only-${Date.now()}@example.com`;
    await fetch(`${baseUrl}/api/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name: 'Old Name', password: 'staysthesame123' }),
    });

    const syncRes = await fetch(`${baseUrl}/api/internal/sync-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': 'test-internal-secret' },
      body: JSON.stringify({ email, name: 'New Name', sourceGameId: 'azul' }),
    });
    assert.equal(syncRes.status, 200);

    // Password must still work — sync-account must not have touched it.
    const loginRes = await fetch(`${baseUrl}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'staysthesame123' }),
    });
    assert.equal(loginRes.status, 200);
    const loginData = await loginRes.json();
    assert.equal(loginData.name, 'New Name');
  });
});
