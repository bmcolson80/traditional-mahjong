import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cookie from 'cookie';
import webpush from 'web-push';
import { Resend } from 'resend';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import { initDB, all, get, run } from './db.js';
import * as G from './game.js';
import * as AI from './ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_DOMAIN = process.env.EMAIL_DOMAIN ?? 'example.com';
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL = process.env.VAPID_EMAIL ?? 'admin@example.com';
const pushConfigured = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (pushConfigured) {
  webpush.setVapidDetails(`mailto:${VAPID_EMAIL}`, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Auth helpers ----------

function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '30d' });
}

function setAuthCookie(res, token) {
  res.setHeader('Set-Cookie', cookie.serialize('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60,
    path: '/',
  }));
}

function requireAuth(req, res, next) {
  try {
    const cookies = cookie.parse(req.headers.cookie ?? '');
    const token = cookies.token;
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

// ---------- Auth routes ----------

app.post('/api/register', async (req, res) => {
  try {
    const { email, name, password } = req.body ?? {};
    if (!email || !name || !password) return res.status(400).json({ error: 'Missing fields' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const existing = get('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hash = bcrypt.hashSync(password, 10);
    run('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)', [email.toLowerCase(), name, hash]);
    const user = get('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);

    const token = signToken(user);
    setAuthCookie(res, token);
    res.json({ id: user.id, email: user.email, name: user.name });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body ?? {};
    if (!email || !password) return res.status(400).json({ error: 'Missing fields' });

    const user = get('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = signToken(user);
    setAuthCookie(res, token);
    res.json({ id: user.id, email: user.email, name: user.name });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/logout', (req, res) => {
  setAuthCookie(res, '');
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json(req.user);
});

// Password reset: request OTP
app.post('/api/password-reset/request', async (req, res) => {
  try {
    const { email } = req.body ?? {};
    if (!email) return res.status(400).json({ error: 'Email required' });
    const user = get('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    // Always respond success to avoid leaking which emails are registered
    if (!user) return res.json({ ok: true });

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    run('INSERT INTO otp_requests (email, otp, expires_at) VALUES (?, ?, ?)', [email.toLowerCase(), otp, expiresAt]);

    if (resend) {
      await resend.emails.send({
        from: `Mahjong <noreply@${EMAIL_DOMAIN}>`,
        to: email,
        subject: 'Your password reset code',
        html: `<p>Your verification code is <strong>${otp}</strong>. It expires in 15 minutes.</p>`,
      });
    } else {
      console.log(`[dev] OTP for ${email}: ${otp}`);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('OTP request error:', err);
    res.status(500).json({ error: 'Could not send reset code' });
  }
});

app.post('/api/password-reset/verify', (req, res) => {
  try {
    const { email, otp } = req.body ?? {};
    const record = get(
      `SELECT * FROM otp_requests WHERE email = ? AND otp = ? AND used = 0 ORDER BY id DESC LIMIT 1`,
      [email?.toLowerCase(), otp]
    );
    if (!record) return res.status(400).json({ error: 'Invalid code' });
    if (new Date(record.expires_at) < new Date()) return res.status(400).json({ error: 'Code expired' });
    res.json({ ok: true });
  } catch (err) {
    console.error('OTP verify error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

app.post('/api/password-reset/complete', (req, res) => {
  try {
    const { email, otp, newPassword } = req.body ?? {};
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const record = get(
      `SELECT * FROM otp_requests WHERE email = ? AND otp = ? AND used = 0 ORDER BY id DESC LIMIT 1`,
      [email?.toLowerCase(), otp]
    );
    if (!record) return res.status(400).json({ error: 'Invalid code' });
    if (new Date(record.expires_at) < new Date()) return res.status(400).json({ error: 'Code expired' });

    const hash = bcrypt.hashSync(newPassword, 10);
    run('UPDATE users SET password_hash = ? WHERE email = ?', [hash, email.toLowerCase()]);
    run('UPDATE otp_requests SET used = 1 WHERE id = ?', [record.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Password reset complete error:', err);
    res.status(500).json({ error: 'Reset failed' });
  }
});

// ---------- Push notification routes ----------

app.get('/api/push/vapid-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC_KEY ?? null });
});

app.get('/api/push/enabled', (req, res) => {
  res.json({ enabled: pushConfigured });
});

app.post('/api/push/subscribe', requireAuth, (req, res) => {
  try {
    const sub = req.body;
    if (!sub?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
    run(
      `INSERT OR REPLACE INTO push_subscriptions (user_id, endpoint, subscription_json) VALUES (?, ?, ?)`,
      [req.user.id, sub.endpoint, JSON.stringify(sub)]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Push subscribe error:', err);
    res.status(500).json({ error: 'Subscribe failed' });
  }
});

app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  try {
    const { endpoint } = req.body ?? {};
    run('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', [req.user.id, endpoint]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Push unsubscribe error:', err);
    res.status(500).json({ error: 'Unsubscribe failed' });
  }
});

app.get('/api/push/status', requireAuth, (req, res) => {
  const subs = all('SELECT endpoint FROM push_subscriptions WHERE user_id = ?', [req.user.id]);
  res.json({ subscribed: subs.length > 0 });
});

// Active games for the current user (for dashboard rejoin section)
app.get('/api/my-games', requireAuth, (req, res) => {
  try {
    const rows = all(
      `SELECT DISTINCT g.room_code, g.phase, g.state_json, gp.player_id
       FROM games g
       JOIN game_players gp ON gp.game_id = g.id
       WHERE gp.user_id = ? AND g.phase IN ('waiting','playing')
       ORDER BY g.created_at DESC LIMIT 10`,
      [req.user.id]
    );
    const games = rows.map(row => {
      try {
        const s = JSON.parse(row.state_json);
        const humans = (s.players ?? []).filter(p => !p.isAI && p.userId != null);
        const isHost = s.hostUserId != null
          ? s.hostUserId === req.user.id
          : (s.hostPlayerId === row.player_id) || (humans.length === 1 && humans[0].userId === req.user.id);
        return {
          roomCode: row.room_code,
          phase: row.phase,
          roundWind: s.round ? ['East','South','West','North'][s.round.windIndex ?? 0] : 'East',
          handNumber: s.round?.handNumber ?? 1,
          turnSeat: s.turnSeat,
          isHost,
          players: (s.players ?? []).map(p => ({
            displayName: p.displayName,
            seat: p.seat,
            isAI: p.isAI ?? false,
            score: p.score ?? 0,
          })),
        };
      } catch { return null; }
    }).filter(Boolean);
    res.json(games);
  } catch (err) {
    console.error('my-games error:', err);
    res.status(500).json({ error: 'Failed to load games' });
  }
});

// Lets the host end one of their games straight from the dashboard list — no
// need to rejoin first. Works whether or not the room is currently loaded in
// memory (e.g. after a server restart, it's restored lazily from the DB here).
app.post('/api/games/:roomCode/end', requireAuth, (req, res) => {
  try {
    const { roomCode } = req.params;
    const gpRow = get(
      `SELECT gp.player_id FROM game_players gp
       JOIN games g ON g.id = gp.game_id
       WHERE g.room_code = ? AND gp.user_id = ?`,
      [roomCode, req.user.id]
    );
    if (!gpRow) return res.status(404).json({ error: 'Game not found' });

    let room = rooms.get(roomCode);
    if (!room) {
      const gameRow = get('SELECT state_json, phase FROM games WHERE room_code = ?', [roomCode]);
      if (!gameRow || gameRow.phase === 'ended') return res.status(404).json({ error: 'Game already ended' });
      try { room = JSON.parse(gameRow.state_json); } catch { return res.status(500).json({ error: 'Corrupt game state' }); }
    }
    const humans = (room.players ?? []).filter(p => !p.isAI && p.userId != null);
    const isHost = room.hostUserId != null
      ? room.hostUserId === req.user.id
      : (room.hostPlayerId === gpRow.player_id) || (humans.length === 1 && humans[0].userId === req.user.id);
    if (!isHost) return res.status(403).json({ error: 'Only the host can end the game' });

    if (rooms.has(roomCode)) endRoom(rooms.get(roomCode));
    else { room.phase = 'ended'; persistRoom(room); }

    res.json({ ok: true });
  } catch (err) {
    console.error('end game (REST) error:', err);
    res.status(500).json({ error: 'Failed to end game' });
  }
});

async function notifyUser(userId, payload) {
  if (!pushConfigured) return;
  const subs = all('SELECT * FROM push_subscriptions WHERE user_id = ?', [userId]);
  for (const s of subs) {
    try {
      await webpush.sendNotification(JSON.parse(s.subscription_json), JSON.stringify(payload));
    } catch (err) {
      console.error('Push send failed, removing stale subscription:', err.message);
      run('DELETE FROM push_subscriptions WHERE id = ?', [s.id]);
    }
  }
}

// ---------- WebSocket game server ----------

const wss = new WebSocketServer({ server });
const clients = new Map(); // ws -> { roomCode, playerId, userId, displayName }
const rooms = new Map();   // roomCode -> room state (see game.js createRoom)

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, exceptWs = null) {
  for (const [ws, meta] of clients.entries()) {
    if (meta.roomCode === room.code && ws !== exceptWs) send(ws, msg);
  }
}

function publicRoomView(room, forSeat) {
  return {
    code: room.code,
    phase: room.phase,
    turnSeat: room.turnSeat,
    round: room.round,
    roundWind: G.getRoundWind(room),
    currentDiscard: room.currentDiscard,
    wallCount: room.wall.length,
    hostPlayerId: room.hostPlayerId,
    hostUserId: room.hostUserId ?? null,
    players: room.players.map(p => ({
      playerId: p.playerId,
      displayName: p.displayName,
      seat: p.seat,
      seatWind: G.getSeatWind(room, p.seat),
      score: p.score,
      handCount: p.hand.length,
      exposed: p.exposed,
      flowers: p.flowers,
      isAI: p.isAI ?? false,
      aiSkill: p.aiSkill ?? null,
      hand: p.seat === forSeat ? p.hand : undefined,
    })),
  };
}

function broadcastRoomState(room) {
  for (const [ws, meta] of clients.entries()) {
    if (meta.roomCode !== room.code) continue;
    const player = room.players.find(p => p.playerId === meta.playerId);
    send(ws, { type: 'room_state', room: publicRoomView(room, player?.seat) });
  }
}

function genRoomCode() {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

function serializeRoom(room) {
  // Exclude transient fields that can't survive a restart
  return JSON.stringify(room, (key, value) => key === '_aiTimeout' ? undefined : value);
}

function persistRoom(room) {
  try {
    run(
      `INSERT INTO games (room_code, phase, state_json) VALUES (?, ?, ?)
       ON CONFLICT(room_code) DO UPDATE SET phase = excluded.phase, state_json = excluded.state_json`,
      [room.code, room.phase, serializeRoom(room)]
    );
    // Refresh game_players so /api/my-games can find this user's active games
    const gameRow = get('SELECT id FROM games WHERE room_code = ?', [room.code]);
    if (gameRow) {
      run('DELETE FROM game_players WHERE game_id = ?', [gameRow.id]);
      for (const p of room.players) {
        if (p.userId) {
          run(
            `INSERT INTO game_players (game_id, user_id, player_id, seat, display_name)
             VALUES (?, ?, ?, ?, ?)`,
            [gameRow.id, p.userId, p.playerId, p.seat, p.displayName]
          );
        }
      }
    }
  } catch (err) {
    console.error('persistRoom failed:', err);
  }
}

export async function loadRoomsFromDB() {
  try {
    const activeGames = all(`SELECT room_code, state_json FROM games WHERE phase IN ('waiting','playing')`);
    let count = 0;
    for (const row of activeGames) {
      try {
        const room = JSON.parse(row.state_json);
        if (room && room.code && room.players) {
          rooms.set(room.code, room);
          count++;
        }
      } catch (err) {
        console.error(`Failed to restore room ${row.room_code}:`, err);
      }
    }
    if (count > 0) console.log(`Restored ${count} active room(s) from database`);
  } catch (err) {
    console.error('loadRoomsFromDB failed:', err);
  }
}

wss.on('connection', (ws) => {
  clients.set(ws, { roomCode: null, playerId: null, userId: null, displayName: null });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, { type: 'error', message: 'Invalid message format' });
    }
    try {
      handleMessage(ws, msg);
    } catch (err) {
      console.error('handleMessage error:', err);
      send(ws, { type: 'error', message: err.message ?? 'Something went wrong' });
    }
  });

  ws.on('close', () => {
    const meta = clients.get(ws);
    clients.delete(ws);
    if (meta?.roomCode) {
      const room = rooms.get(meta.roomCode);
      if (room) broadcast(room, { type: 'player_disconnected', playerId: meta.playerId }, ws);
    }
  });
});

// ─── AI scheduling ────────────────────────────────────────────────────────────
// All AI decisions run server-side via setTimeout. Per GAMESTACK pattern:
// always check room still exists and phase is still 'playing' before firing.

function clearAiTimeout(room) {
  if (room._aiTimeout) { clearTimeout(room._aiTimeout); room._aiTimeout = null; }
}

function scheduleAiTurn(room) {
  const player = room.players.find(p => p.seat === room.turnSeat && p.isAI);
  if (!player || room.phase !== 'playing') return;
  clearAiTimeout(room);
  room._aiTimeout = setTimeout(() => {
    room._aiTimeout = null;
    const current = rooms.get(room.code);
    if (!current || current.phase !== 'playing') return;
    const currentPlayer = current.players.find(p => p.seat === current.turnSeat && p.isAI);
    if (!currentPlayer) return;
    try { executeAiTurn(current, currentPlayer); }
    catch (err) { console.error('AI turn error:', err); }
  }, AI.aiThinkTime(player.aiSkill));
}

// After any discard, give humans a brief window to claim; then let AI claim.
function scheduleAiClaims(room) {
  clearAiTimeout(room);
  room._aiTimeout = setTimeout(() => {
    room._aiTimeout = null;
    const current = rooms.get(room.code);
    if (!current || !current.currentDiscard || current.phase !== 'playing') return;
    try { executeAiClaims(current); }
    catch (err) { console.error('AI claim error:', err); }
  }, 1600); // 1.6 s human window
}

function executeAiTurn(room, player) {
  // hand.length % 3 === 1 → player needs to draw first (13, 10, 7, 4, 1 tiles)
  // hand.length % 3 === 2 → player has drawn / claimed and needs to discard (14, 11, 8, 5, 2 tiles)
  if (player.hand.length % 3 === 1) {
    const tile = G.drawTile(room, player);
    if (!tile) {
      G.advanceHand(room, { isDraw: true });
      room.phase = 'finished';
      persistRoom(room);
      broadcastRoomState(room);
      broadcast(room, { type: 'wall_empty', round: room.round, matchOver: room.round.matchOver });
      return;
    }
    persistRoom(room);
    broadcastRoomState(room);
    // Brief extra pause before discarding so the draw registers on screen
    room._aiTimeout = setTimeout(() => {
      room._aiTimeout = null;
      const current = rooms.get(room.code);
      if (!current || current.phase !== 'playing') return;
      const p = current.players.find(px => px.playerId === player.playerId);
      if (!p) return;
      try { aiDiscard(current, p); }
      catch (err) { console.error('AI discard error:', err); }
    }, AI.aiThinkTime(player.aiSkill) * 0.6);
    return;
  }
  aiDiscard(room, player);
}

function aiDiscard(room, player) {
  // Check for self-draw win first
  if (AI.shouldDeclareWin(player.hand, player.exposed, null, player.aiSkill)) {
    executeAiWin(room, player, true, null, null);
    return;
  }
  const tile = AI.chooseDiscard(player.hand, player.exposed, player.aiSkill);
  G.discardTile(room, player, tile);
  room.turnSeat = G.nextSeat(player.seat, room.players.map(p => p.seat));
  persistRoom(room);
  broadcastRoomState(room);
  broadcast(room, { type: 'tile_discarded', tile, fromSeat: player.seat });
  scheduleAiClaims(room);
}

function executeAiClaims(room) {
  if (!room.currentDiscard) return;
  const { tile, fromSeat } = room.currentDiscard;

  // Priority 1: Any AI wins on the discard
  for (const p of room.players) {
    if (!p.isAI || p.seat === fromSeat) continue;
    if (AI.shouldDeclareWin(p.hand, p.exposed, tile, p.aiSkill)) {
      executeAiWin(room, p, false, tile, fromSeat);
      return;
    }
  }

  // Priority 2: Kong from discard
  for (const p of room.players) {
    if (!p.isAI || p.seat === fromSeat) continue;
    if (G.canKongFromDiscard(p.hand, tile)) {
      G.applyKong(room, p, tile, fromSeat, false);
      room.turnSeat = p.seat;
      persistRoom(room);
      broadcastRoomState(room);
      broadcast(room, { type: 'kong_claimed', playerId: p.playerId, tile });
      scheduleAiTurn(room);
      return;
    }
  }

  // Priority 3: Pung
  for (const p of room.players) {
    if (!p.isAI || p.seat === fromSeat) continue;
    if (G.canPung(p.hand, tile) && AI.shouldClaimPung(p.hand, tile, p.exposed, p.aiSkill)) {
      G.applyPung(room, p, tile, fromSeat);
      room.turnSeat = p.seat;
      persistRoom(room);
      broadcastRoomState(room);
      broadcast(room, { type: 'pung_claimed', playerId: p.playerId, tile });
      scheduleAiTurn(room);
      return;
    }
  }

  // Priority 4: Chow (house rule — free-for-all, any player may claim from any discarder)
  for (const p of room.players) {
    if (!p.isAI || p.seat === fromSeat) continue;
    const options = G.canChow(p.hand, tile, p.seat, fromSeat);
    if (options && options.length > 0 && AI.shouldClaimChow(p.hand, tile, p.exposed, p.aiSkill, p.seat, fromSeat)) {
      G.applyChow(room, p, options[0], tile, fromSeat);
      room.turnSeat = p.seat;
      persistRoom(room);
      broadcastRoomState(room);
      broadcast(room, { type: 'chow_claimed', playerId: p.playerId, sequence: options[0] });
      scheduleAiTurn(room);
      return;
    }
  }

  // No AI claims — schedule whoever's turn it is next
  scheduleAiTurn(room);
}

function executeAiWin(room, player, selfDraw, winningTile, discarderSeat) {
  const wTile   = winningTile ?? player.hand[player.hand.length - 1];
  const hCheck  = selfDraw ? player.hand.slice(0, -1) : player.hand;
  const result  = G.checkWin(hCheck, player.exposed, wTile);
  if (!result.win) return;
  const roundWind = G.getRoundWind(room);
  const seatWind  = G.getSeatWind(room, player.seat);
  const score     = G.scoreHand(player, player.exposed, hCheck, wTile, { selfDraw, roundWind, seatWind, handType: result.type });
  const settlement = G.settleScore(room, player.seat, score.fan, { selfDraw, discarderSeat });
  G.advanceHand(room, { winnerSeat: player.seat });
  room.phase = 'finished';
  // Bankruptcy house rule: the moment any payer's chips hit 0 or below, the match ends instantly.
  if (settlement.bankruptSeats.length > 0) {
    room.round.matchOver = true;
    room.round.matchOverReason = 'bankruptcy';
    room.round.bankruptSeats = settlement.bankruptSeats;
  }
  persistRoom(room);
  broadcastRoomState(room);
  broadcast(room, {
    type: 'game_won', playerId: player.playerId, seat: player.seat, result, score,
    standings: settlement.standings, bankruptSeats: settlement.bankruptSeats,
    round: room.round, matchOver: room.round.matchOver,
  });
  for (const p of room.players) {
    if (p.userId) notifyUser(p.userId, { title: 'Mahjong!', body: `${player.displayName} won!` });
  }
}

function isRoomHost(room, meta) {
  if (room.hostUserId != null) return room.hostUserId === meta.userId;
  return room.hostPlayerId === meta.playerId;
}

function endRoom(room) {
  clearAiTimeout(room);
  room.phase = 'ended';
  persistRoom(room);
  broadcast(room, { type: 'game_abandoned', roomCode: room.code });
  rooms.delete(room.code);
}

function handleMessage(ws, msg) {
  const meta = clients.get(ws);

  switch (msg.type) {
    case 'abandon_game': {
      const room = rooms.get(meta.roomCode);
      if (!room) return send(ws, { type: 'error', message: 'Room not found' });
      if (!isRoomHost(room, meta)) return send(ws, { type: 'error', message: 'Only the host can end the game' });
      endRoom(room);
      break;
    }
    case 'create_room': {
      const roomCode = genRoomCode();
      const playerId = msg.playerId ?? randomUUID();
      const room = G.createRoom(roomCode, playerId, msg.userId ?? null);
      G.addPlayer(room, { playerId, userId: msg.userId, displayName: msg.displayName ?? 'Player' });
      // Pre-configured AI players added from the dashboard
      const aiConfigs = Array.isArray(msg.aiPlayers) ? msg.aiPlayers.slice(0, 3) : [];
      for (const cfg of aiConfigs) {
        const skill = ['rookie','veteran','master'].includes(cfg.skill) ? cfg.skill : 'rookie';
        const aiCount = room.players.filter(p => p.isAI && p.aiSkill === skill).length;
        const aiPlayerId = `ai-${randomUUID()}`;
        G.addPlayer(room, { playerId: aiPlayerId, userId: null, displayName: AI.aiDisplayName(skill, aiCount) });
        const aiPlayer = room.players.find(p => p.playerId === aiPlayerId);
        aiPlayer.isAI = true;
        aiPlayer.aiSkill = skill;
      }
      rooms.set(roomCode, room);
      clients.set(ws, { roomCode, playerId, userId: msg.userId, displayName: msg.displayName });
      persistRoom(room);
      send(ws, { type: 'room_created', roomCode });
      broadcastRoomState(room);
      if (room.players.length === 4) {
        G.startGame(room);
        persistRoom(room);
        broadcastRoomState(room);
        broadcast(room, { type: 'game_started', round: room.round });
        scheduleAiTurn(room);
      }
      break;
    }
    case 'add_ai': {
      const room = rooms.get(msg.roomCode);
      if (!room) return send(ws, { type: 'error', message: 'Room not found' });
      if (room.phase !== 'waiting') return send(ws, { type: 'error', message: 'Game already in progress' });
      if (!isRoomHost(room, meta)) return send(ws, { type: 'error', message: 'Only the host can add AI players' });
      if (room.players.length >= 4) return send(ws, { type: 'error', message: 'Room is full' });
      const skill = ['rookie', 'veteran', 'master'].includes(msg.skill) ? msg.skill : 'rookie';
      const aiCount = room.players.filter(p => p.isAI && p.aiSkill === skill).length;
      const aiPlayerId = `ai-${randomUUID()}`;
      G.addPlayer(room, { playerId: aiPlayerId, userId: null, displayName: AI.aiDisplayName(skill, aiCount) });
      const aiPlayer = room.players.find(p => p.playerId === aiPlayerId);
      aiPlayer.isAI = true;
      aiPlayer.aiSkill = skill;
      persistRoom(room);
      broadcastRoomState(room);
      if (room.players.length === 4) {
        G.startGame(room);
        persistRoom(room);
        broadcastRoomState(room);
        broadcast(room, { type: 'game_started', round: room.round });
        scheduleAiTurn(room);
      }
      break;
    }
    case 'remove_ai': {
      const room = rooms.get(msg.roomCode);
      if (!room) return send(ws, { type: 'error', message: 'Room not found' });
      if (room.phase !== 'waiting') return send(ws, { type: 'error', message: 'Game already in progress' });
      if (!isRoomHost(room, meta)) return send(ws, { type: 'error', message: 'Only the host can remove AI players' });
      const aiIdx = room.players.map((p, i) => ({ p, i })).reverse().find(({ p }) => p.isAI)?.i;
      if (aiIdx === undefined) return send(ws, { type: 'error', message: 'No AI players to remove' });
      room.players.splice(aiIdx, 1);
      // Reassign seats sequentially
      const SEATS = ['E', 'S', 'W', 'N'];
      room.players.forEach((p, i) => { p.seat = SEATS[i]; });
      persistRoom(room);
      broadcastRoomState(room);
      break;
    }
    case 'start_game': {
      const room = rooms.get(msg.roomCode);
      if (!room) return send(ws, { type: 'error', message: 'Room not found' });
      if (!isRoomHost(room, meta)) return send(ws, { type: 'error', message: 'Only the host can start the game' });
      if (room.players.length < 2) return send(ws, { type: 'error', message: 'Need at least 2 players to start' });
      G.startGame(room);
      persistRoom(room);
      broadcastRoomState(room);
      broadcast(room, { type: 'game_started', round: room.round });
      scheduleAiTurn(room);
      break;
    }
    case 'join_room': {
      const room = rooms.get(msg.roomCode);
      if (!room) return send(ws, { type: 'error', message: 'Room not found' });
      if (room.phase !== 'waiting') return send(ws, { type: 'error', message: 'Game already in progress' });
      const playerId = msg.playerId ?? randomUUID();
      const seat = G.addPlayer(room, { playerId, userId: msg.userId, displayName: msg.displayName ?? 'Player' });
      clients.set(ws, { roomCode: room.code, playerId, userId: msg.userId, displayName: msg.displayName });
      persistRoom(room);
      send(ws, { type: 'room_joined', roomCode: room.code, seat, phase: room.phase });
      broadcastRoomState(room);
      if (room.players.length === 4) {
        G.startGame(room);
        persistRoom(room);
        broadcastRoomState(room);
        broadcast(room, { type: 'game_started', round: room.round });
        scheduleAiTurn(room);
      }
      break;
    }
    case 'discard': {
      const room = requireRoom(meta);
      const player = requirePlayer(room, meta.playerId);
      if (room.phase !== 'playing') throw new Error('This hand is no longer in progress');
      if (room.turnSeat !== player.seat) throw new Error('Not your turn');
      G.discardTile(room, player, msg.tile);
      room.turnSeat = G.nextSeat(player.seat, room.players.map(p => p.seat));
      persistRoom(room);
      broadcastRoomState(room);
      broadcast(room, { type: 'tile_discarded', tile: msg.tile, fromSeat: player.seat });
      scheduleAiClaims(room);
      break;
    }
    case 'draw': {
      const room = requireRoom(meta);
      const player = requirePlayer(room, meta.playerId);
      if (room.phase !== 'playing') throw new Error('This hand is no longer in progress');
      if (room.turnSeat !== player.seat) throw new Error('Not your turn');
      // Authoritative guard: a player can only draw when their hand is at a
      // "needs to draw" count (13, 10, 7, 4, 1 — i.e. length % 3 === 1). If a
      // double-tap or retry sends 'draw' twice, the second one lands here with
      // a 14/11/8/5/2-tile hand and gets rejected instead of silently granting
      // an extra tile (which previously broke self-draw win detection).
      if (player.hand.length % 3 !== 1) throw new Error('You already drew this turn — discard or declare first');
      clearAiTimeout(room); // human is taking action, cancel any pending AI
      const tile = G.drawTile(room, player);
      if (!tile) {
        G.advanceHand(room, { isDraw: true });
        room.phase = 'finished';
        persistRoom(room);
        broadcastRoomState(room);
        broadcast(room, { type: 'wall_empty', round: room.round, matchOver: room.round.matchOver });
        break;
      }
      persistRoom(room);
      broadcastRoomState(room);
      break;
    }
    case 'claim_pung': {
      const room = requireRoom(meta);
      if (room.phase !== 'playing') throw new Error('This hand is no longer in progress');
      clearAiTimeout(room); // human beat the AI to the claim
      const player = requirePlayer(room, meta.playerId);
      if (!room.currentDiscard) throw new Error('No discard to claim');
      const { tile, fromSeat } = room.currentDiscard;
      if (!G.canPung(player.hand, tile)) throw new Error('Cannot pung this tile');
      G.applyPung(room, player, tile, fromSeat);
      room.turnSeat = player.seat;
      persistRoom(room);
      broadcastRoomState(room);
      broadcast(room, { type: 'pung_claimed', playerId: player.playerId, tile });
      break;
    }
    case 'claim_kong': {
      const room = requireRoom(meta);
      if (room.phase !== 'playing') throw new Error('This hand is no longer in progress');
      clearAiTimeout(room);
      const player = requirePlayer(room, meta.playerId);
      const concealed = Boolean(msg.concealed);
      let tile = msg.tile;
      let fromSeat = player.seat;
      if (!concealed) {
        if (!room.currentDiscard) throw new Error('No discard to claim');
        tile = room.currentDiscard.tile;
        fromSeat = room.currentDiscard.fromSeat;
        if (!G.canKongFromDiscard(player.hand, tile)) throw new Error('Cannot kong this tile');
      }
      G.applyKong(room, player, tile, fromSeat, concealed);
      room.turnSeat = player.seat;
      persistRoom(room);
      broadcastRoomState(room);
      broadcast(room, { type: 'kong_claimed', playerId: player.playerId, tile, concealed });
      break;
    }
    case 'claim_chow': {
      const room = requireRoom(meta);
      if (room.phase !== 'playing') throw new Error('This hand is no longer in progress');
      clearAiTimeout(room);
      const player = requirePlayer(room, meta.playerId);
      if (!room.currentDiscard) throw new Error('No discard to claim');
      const { tile, fromSeat } = room.currentDiscard;
      const options = G.canChow(player.hand, tile, player.seat, fromSeat);
      if (!options || options.length === 0) throw new Error('Cannot chow this tile');
      const sequence = msg.sequence
        ? options.find(o => JSON.stringify(o) === JSON.stringify(msg.sequence))
        : options[0];
      if (!sequence) throw new Error('Invalid chow sequence');
      G.applyChow(room, player, sequence, tile, fromSeat);
      room.turnSeat = player.seat;
      persistRoom(room);
      broadcastRoomState(room);
      broadcast(room, { type: 'chow_claimed', playerId: player.playerId, sequence });
      break;
    }
    case 'declare_win': {
      const room = requireRoom(meta);
      if (room.phase !== 'playing') throw new Error('This hand is no longer in progress');
      clearAiTimeout(room);
      const player = requirePlayer(room, meta.playerId);
      const selfDraw = !room.currentDiscard || room.currentDiscard.fromSeat === player.seat;
      const winningTile = selfDraw ? player.hand[player.hand.length - 1] : room.currentDiscard.tile;
      const handForCheck = selfDraw ? player.hand.slice(0, -1) : player.hand;
      const expectedLen = 13 - player.exposed.length * 3;
      if (handForCheck.length !== expectedLen) {
        console.error('declare_win: unexpected hand size', {
          handLen: handForCheck.length, expectedLen, exposedCount: player.exposed.length,
          hand: [...handForCheck].sort(),
        });
        throw new Error(`Hand has ${handForCheck.length} tiles (plus winning tile), expected ${expectedLen} — this is a bug, please report it with this exact message`);
      }
      const result = G.checkWin(handForCheck, player.exposed, winningTile);
      if (!result.win) {
        // Log full detail server-side and echo a compact version to the client so a
        // "why didn't this work" report comes with exact ground truth instead of a screenshot guess.
        const detail = {
          selfDraw, winningTile,
          hand: [...handForCheck].sort(),
          exposed: player.exposed.map(s => ({ type: s.type, tiles: s.tiles })),
          currentDiscard: room.currentDiscard,
        };
        console.error('declare_win rejected:', JSON.stringify(detail));
        throw new Error('Hand does not qualify for Mahjong — hand: [' + detail.hand.join(',') +
          '] + winning tile ' + winningTile + (player.exposed.length ? ', exposed: ' + JSON.stringify(detail.exposed) : ''));
      }
      const roundWind = G.getRoundWind(room);
      const seatWind = G.getSeatWind(room, player.seat);
      const score = G.scoreHand(player, player.exposed, handForCheck, winningTile, {
        selfDraw, roundWind, seatWind, handType: result.type,
      });
      const settlement = G.settleScore(room, player.seat, score.fan, {
        selfDraw, discarderSeat: room.currentDiscard?.fromSeat,
      });
      G.advanceHand(room, { winnerSeat: player.seat });
      room.phase = 'finished';
      // Bankruptcy house rule: the moment any payer's chips hit 0 or below, the match ends instantly.
      if (settlement.bankruptSeats.length > 0) {
        room.round.matchOver = true;
        room.round.matchOverReason = 'bankruptcy';
        room.round.bankruptSeats = settlement.bankruptSeats;
      }
      persistRoom(room);
      broadcastRoomState(room);
      broadcast(room, {
        type: 'game_won', playerId: player.playerId, seat: player.seat, result, score,
        standings: settlement.standings, bankruptSeats: settlement.bankruptSeats,
        round: room.round, matchOver: room.round.matchOver,
      });
      for (const p of room.players) {
        if (p.userId) notifyUser(p.userId, { title: 'Mahjong!', body: `${player.displayName} won the game.` });
      }
      break;
    }
    case 'next_hand': {
      const room = requireRoom(meta);
      if (room.phase !== 'finished') throw new Error('Current hand is not finished yet');
      if (room.round.matchOver) throw new Error('Match is already complete (full East\u2192North cycle finished)');
      G.startGame(room);
      persistRoom(room);
      broadcastRoomState(room);
      broadcast(room, { type: 'game_started', round: room.round });
      scheduleAiTurn(room);
      break;
    }
    case 'rejoin_room': {
      const room = rooms.get(msg.roomCode);
      if (!room) return send(ws, { type: 'error', message: 'Room not found — game may have ended' });
      // Match by userId (preferred) or by the original playerId
      const player = room.players.find(p =>
        (msg.userId && p.userId === msg.userId) ||
        p.playerId === msg.playerId
      );
      if (!player) return send(ws, { type: 'error', message: 'You are not in this game' });
      // Refresh the playerId in case the browser generated a new one after restart
      // (cleared storage, reinstalled, private browsing, etc). If this player was
      // the host under their OLD playerId, carry hostPlayerId forward too —
      // otherwise host status silently breaks on reconnect: the End Game button
      // (and everything else gated on isHost) disappears even though it's genuinely
      // still their room, just recognized under a new local ID now.
      const wasHostByLegacyId = room.hostPlayerId === player.playerId;
      if (msg.playerId && msg.playerId !== player.playerId) {
        if (wasHostByLegacyId) room.hostPlayerId = msg.playerId;
        player.playerId = msg.playerId;
      }
      // Backfill the stable hostUserId onto legacy rooms that predate this field —
      // this is what permanently migrates a room like this the moment its host
      // reconnects, instead of this class of bug recurring every time storage resets.
      if (room.hostUserId == null && wasHostByLegacyId && (msg.userId ?? player.userId) != null) {
        room.hostUserId = msg.userId ?? player.userId;
      }
      // Last-resort fallback: if hostUserId is still missing and the legacy playerId
      // trail is ALSO broken (the old hostPlayerId doesn't match anything we can trace),
      // but this player is the only human at the table, they must be the host — nobody
      // else could be. This is what recovers a room where the original corruption was
      // worse than a simple ID swap.
      if (room.hostUserId == null) {
        const humans = room.players.filter(p => !p.isAI && p.userId != null);
        if (humans.length === 1 && humans[0] === player) room.hostUserId = player.userId ?? msg.userId;
      }
      persistRoom(room);
      clients.set(ws, {
        roomCode: room.code,
        playerId: player.playerId,
        userId: msg.userId ?? player.userId,
        displayName: player.displayName,
      });
      send(ws, { type: 'room_joined', roomCode: room.code, seat: player.seat });
      broadcastRoomState(room);
      // Resume AI scheduling if the game is mid-play
      if (room.phase === 'playing') scheduleAiTurn(room);
      persistRoom(room);
      break;
    }
    default:
      send(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
  }
}

function requireRoom(meta) {
  const room = rooms.get(meta.roomCode);
  if (!room) throw new Error('Not in a room');
  return room;
}

function requirePlayer(room, playerId) {
  const player = room.players.find(p => p.playerId === playerId);
  if (!player) throw new Error('Player not in this room');
  return player;
}

// ---------- Error handling ----------

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

// ---------- Startup ----------

const PORT = process.env.PORT ?? 3000;

export async function startServer() {
  await initDB();
  await loadRoomsFromDB();
  return new Promise((resolve) => {
    server.listen(PORT, () => {
      console.log(`Mahjong server listening on port ${PORT}`);
      resolve(server);
    });
  });
}

if (process.env.NODE_ENV !== 'test') {
  startServer();
}

export { app, server, rooms, clients, persistRoom };
