import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';

const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), 'local.db');

let SQL = null;
let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_code TEXT UNIQUE NOT NULL,
  phase TEXT NOT NULL DEFAULT 'waiting',
  state_json TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS game_players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL,
  user_id INTEGER,
  player_id TEXT NOT NULL,
  seat TEXT,
  display_name TEXT,
  score INTEGER DEFAULT 0,
  joined_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS otp_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  otp TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  endpoint TEXT UNIQUE NOT NULL,
  subscription_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export async function initDB() {
  if (db) return db;
  SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(SCHEMA);
  persist();
  return db;
}

export function persist() {
  const startedAt = Date.now();
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
    const durationMs = Date.now() - startedAt;
    // sql.js re-serializes and rewrites the ENTIRE database on every persist() call,
    // which blocks the single-threaded event loop for everyone. This grows with DB
    // size (e.g. accumulated finished games), so a creeping duration here — not a
    // one-off spike — is the signal that unbounded row growth needs addressing.
    if (durationMs > 200) {
      console.warn(`DB persist took ${durationMs}ms (db size ~${(data.length / 1024).toFixed(0)}KB) — event loop was blocked for this long`);
    }
  } catch (err) {
    console.error('DB persist failed:', err);
  }
}

export function getDB() {
  if (!db) throw new Error('DB not initialized — call initDB() first');
  return db;
}

// Helper: run a query and return rows as objects
export function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

export function get(sql, params = []) {
  const rows = all(sql, params);
  return rows[0] ?? null;
}

export function run(sql, params = []) {
  db.run(sql, params);
  persist();
}
