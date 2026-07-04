// game.js — Traditional (Chinese/Classical) Mahjong rules engine
// All game state is authoritative server-side. Tiles are represented as strings:
//   Suits: "1D".."9D" (Dots), "1B".."9B" (Bamboo), "1C".."9C" (Characters/Wan)
//   Winds: "EW","SW","WW","NW"
//   Dragons: "RD" (Red), "GD" (Green), "WD" (White)
//   Flowers: "F1".."F4"   Seasons: "S1".."S4"

const SUITS = ['D', 'B', 'C'];
const WINDS = ['EW', 'SW', 'WW', 'NW'];
const DRAGONS = ['RD', 'GD', 'WD'];
const SEAT_ORDER = ['E', 'S', 'W', 'N'];

export function buildWall() {
  const tiles = [];
  for (const suit of SUITS) {
    for (let n = 1; n <= 9; n++) {
      for (let i = 0; i < 4; i++) tiles.push(`${n}${suit}`);
    }
  }
  for (const w of WINDS) for (let i = 0; i < 4; i++) tiles.push(w);
  for (const d of DRAGONS) for (let i = 0; i < 4; i++) tiles.push(d);
  for (let i = 1; i <= 4; i++) tiles.push(`F${i}`);
  for (let i = 1; i <= 4; i++) tiles.push(`S${i}`);
  return shuffle(tiles);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function isBonusTile(tile) {
  return tile.startsWith('F') || tile.startsWith('S');
}

export function isHonorTile(tile) {
  return WINDS.includes(tile) || DRAGONS.includes(tile);
}

// ---------- Room / game state ----------

export function createRoom(roomCode, hostPlayerId) {
  return {
    code: roomCode,
    phase: 'waiting', // waiting | playing | finished
    players: [], // [{ playerId, userId, displayName, seat, hand, exposed, flowers, score }]
    wall: [],
    deadWall: [],
    discardPile: [],
    turnSeat: 'E',
    currentDiscard: null, // { tile, fromSeat }
    // Round/dealer tracking. windIndex 0-3 = East/South/West/North round.
    // dealerSeat is the physical seat currently acting as dealer for this hand.
    // handNumber counts 1-4 within the current round wind (dealer rotates through all 4 seats).
    // dealerStreak: consecutive hands the current dealer has WON (not draws).
    // Resets to 0 whenever the deal passes to a new dealer. Multiplies chip payouts
    // on dealer wins (see settleScore).
    // matchOverReason/bankruptSeats: set when matchOver becomes true, so the client
    // can tell "completed a full East→North cycle" apart from "someone went bankrupt"
    // even after a page refresh (this is part of persisted room state, unlike the
    // one-off game_won broadcast).
    round: {
      windIndex: 0, handNumber: 1, dealerSeat: 'E', matchOver: false,
      dealerStreak: 0, matchOverReason: null, bankruptSeats: [],
    },
    hostPlayerId,
    gameState: {},
    chipsInitialized: false, // set true once starting chips are assigned (first startGame of the match)
  };
}

// Prevailing round wind for the current hand, derived from round.windIndex
export function getRoundWind(room) {
  return WINDS[room.round.windIndex];
}

// A player's seat wind rotates with the dealer: whoever is dealer this hand
// is always "East" for scoring purposes, regardless of their fixed table seat.
export function getSeatWind(room, physicalSeat) {
  const dealerIdx = SEAT_ORDER.indexOf(room.round.dealerSeat);
  const seatIdx = SEAT_ORDER.indexOf(physicalSeat);
  const offset = (seatIdx - dealerIdx + 4) % 4;
  return WINDS[offset];
}

// Call after a hand ends to advance dealer/round state for the next hand.
// Dealer retains their seat (and the round wind stays the same) if the dealer
// won or the hand was a draw — otherwise dealership passes to the next ACTIVE seat
// (2/3-player games leave the remaining seat(s) physically empty — see room.players;
// nextSeat is given the room's actual seated order so it skips any empty seat entirely).
// dealerStreak (house rule): increments each time the dealer wins consecutively,
// resets to 0 the moment the deal passes to someone else. A draw keeps the dealer
// in their seat but does not itself count as a "win", so the streak is unaffected.
// A Round ends once the deal has rotated through every ACTIVE player once — so a
// 3-player round is 3 hands, not 4 — but the match is still always the same 4
// Prevailing Winds (East/South/West/North Round) regardless of player count.
export function advanceHand(room, { winnerSeat, isDraw = false } = {}) {
  if (room.round.dealerStreak === undefined) room.round.dealerStreak = 0; // back-compat for older persisted rooms
  const activeSeats = room.players.map(p => p.seat); // e.g. ['E','S','W'] for a 3-player game
  const dealerRetains = isDraw || winnerSeat === room.round.dealerSeat;

  if (dealerRetains) {
    if (!isDraw && winnerSeat === room.round.dealerSeat) room.round.dealerStreak += 1;
    return room.round;
  }

  room.round.dealerStreak = 0;
  room.round.dealerSeat = nextSeat(room.round.dealerSeat, activeSeats);
  room.round.handNumber += 1;
  if (room.round.handNumber > activeSeats.length) {
    room.round.handNumber = 1;
    room.round.windIndex = (room.round.windIndex + 1) % 4;
    if (room.round.windIndex === 0) {
      room.round.matchOver = true; // completed a full East->North cycle
      room.round.matchOverReason = 'cycle';
    }
  }
  return room.round;
}

// ---------- Chip settlement (house rules) ----------
// Fan → chip conversion table: exponential doubling, capped at 64 (limit hand).
// 0=1, 1=2, 2=4, 3=8, 4=16, 5=32, 6+=64
export function fanToChips(fan) {
  if (fan >= 6) return 64;
  return 2 ** fan;
}

// Chip settlement under the custom house rules. Verified directly against the
// rulebook's worked examples:
//  Example 1 (discard win, 2 fan/4 chips): only the discarder pays the base value.
//  Example 2 (dealer self-draw, 3 fan/8 chips): base DOUBLES to 16 for the dealer
//    win, THEN the flat +1 self-draw bonus is added on top (16 + 1 = 17/opponent,
//    34 total) — the +1 bonus is a flat per-payer add-on, NOT itself doubled.
//  - Discard win: only the discarder pays the winner; everyone else pays nothing.
//  - Self-draw win: every other active player pays the base chip value, then a
//    flat +1 extra chip each (added after any dealer/streak multiplier below).
//  - Dealer wins: the base portion of the payout is doubled.
//  - Non-dealer wins: the dealer (as a payer) pays double the base portion.
//  - Dealer win streak: consecutive dealer wins multiply the base portion further
//    (1st win = x1, 2nd consecutive win = x2, 3rd = x3, ...), same treatment as
//    the dealer-win double above — the flat self-draw +1 is never scaled by this.
//  - Bankruptcy: if any payer's chips hit 0 or below, `bankruptSeats` is returned
//    non-empty so the caller can end the match immediately.
export function settleScore(room, winnerSeat, fan, { selfDraw, discarderSeat } = {}) {
  const winner = room.players.find(p => p.seat === winnerSeat);
  const others = room.players.filter(p => p.seat !== winnerSeat);
  const dealerSeat = room.round.dealerSeat;
  const winnerIsDealer = winnerSeat === dealerSeat;
  const streak = room.round.dealerStreak ?? 0;
  const streakMultiplier = winnerIsDealer ? streak + 1 : 1;
  const base = fanToChips(fan);

  let winnerGain = 0;
  const bankruptSeats = [];
  for (const p of others) {
    let raw = 0;
    if (selfDraw) {
      raw = base; // self-draw: every active player owes the base value
    } else if (p.seat === discarderSeat) {
      raw = base; // discard win: only the discarder owes anything
    }

    if (raw > 0) {
      if (winnerIsDealer) raw *= 2 * streakMultiplier;   // dealer win: base doubled, plus win-streak multiplier
      else if (p.seat === dealerSeat) raw *= 2;           // non-dealer win: dealer pays double the base
    }

    // Flat +1 self-draw bonus is added AFTER doubling, never scaled by it (see Example 2 above).
    const amount = (selfDraw && raw > 0) ? raw + 1 : raw;

    p.score -= amount;
    winnerGain += amount;
    if (amount > 0 && p.score <= 0) bankruptSeats.push(p.seat);
  }
  winner.score += winnerGain;

  return {
    standings: room.players.map(p => ({ seat: p.seat, score: p.score })),
    bankruptSeats,
  };
}

export function addPlayer(room, { playerId, userId, displayName }) {
  if (room.players.length >= 4) throw new Error('Room is full');
  const seat = SEAT_ORDER[room.players.length];
  room.players.push({
    playerId, userId, displayName, seat,
    hand: [], exposed: [], flowers: [], score: 0,
  });
  return seat;
}

export function startGame(room) {
  if (room.players.length < 2 || room.players.length > 4) throw new Error('Need 2-4 players to start');
  const wall = buildWall();
  room.deadWall = wall.slice(0, 14);
  let live = wall.slice(14);

  // Starting chips (house rule): 500/player for a full 4-player table, 1000/player
  // for a 2 or 3 player game (chips concentrate faster with fewer players at the
  // table, per the rulebook's "Fewer Player Adjustment" — this is about how many
  // seats are actually occupied, not whether any of them are AI). Only assigned
  // once per match — p.score is intentionally NOT reset on subsequent hands so
  // chips carry across the match.
  if (!room.chipsInitialized) {
    const startingChips = room.players.length <= 3 ? 1000 : 500;
    for (const p of room.players) p.score = startingChips;
    room.chipsInitialized = true;
  }

  for (const p of room.players) {
    p.hand = [];
    p.exposed = [];
    p.flowers = [];
    // note: p.score is intentionally NOT reset here so it carries across hands/rounds
  }

  // Deal 13 to each player, then replace bonus tiles as they're drawn
  for (let round = 0; round < 13; round++) {
    for (const p of room.players) {
      const tile = live.shift();
      p.hand.push(tile);
    }
  }
  // Resolve flowers/seasons drawn during initial deal
  for (const p of room.players) {
    live = replaceBonusTiles(p, live, room.deadWall);
  }

  room.wall = live;
  room.phase = 'playing';
  room.turnSeat = room.round.dealerSeat;
  room.discardPile = [];
  room.currentDiscard = null;

  // Dealer draws the 14th tile to open play
  const dealer = room.players.find(p => p.seat === room.round.dealerSeat);
  drawTile(room, dealer);
}

function replaceBonusTiles(player, live, deadWall) {
  let changed = true;
  while (changed) {
    changed = false;
    const bonusIdx = player.hand.findIndex(isBonusTile);
    if (bonusIdx !== -1) {
      const [bonus] = player.hand.splice(bonusIdx, 1);
      player.flowers.push(bonus);
      const replacement = deadWall.length > 0 ? deadWall.pop() : live.shift();
      player.hand.push(replacement);
      changed = true;
    }
  }
  return live;
}

export function drawTile(room, player) {
  if (room.wall.length === 0) return null;
  room.currentDiscard = null;
  let tile = room.wall.shift();
  player.hand.push(tile);
  // auto-replace bonus tiles on draw
  room.wall = replaceBonusTiles(player, room.wall, room.deadWall);
  return tile;
}

export function discardTile(room, player, tile) {
  const idx = player.hand.indexOf(tile);
  if (idx === -1) throw new Error('Tile not in hand');
  player.hand.splice(idx, 1);
  room.currentDiscard = { tile, fromSeat: player.seat };
  room.discardPile.push(tile);
  return tile;
}

// Returns the next seat after `seat`, cycling only through `activeSeats` (defaults to
// the full 4-seat compass). Pass the room's actual seated order (room.players.map(p=>p.seat))
// to correctly skip empty seats in a 2/3-player game — physical seat identity (E/S/W/N)
// never changes, only which of those seats currently has someone in it.
export function nextSeat(seat, activeSeats = SEAT_ORDER) {
  const i = activeSeats.indexOf(seat);
  return activeSeats[(i + 1) % activeSeats.length];
}

// ---------- Claims ----------

export function canPung(hand, tile) {
  return hand.filter(t => t === tile).length >= 2;
}

export function canKongFromDiscard(hand, tile) {
  return hand.filter(t => t === tile).length >= 3;
}

export function canChow(hand, tile, claimerSeat, discarderSeat) {
  // House rule: free-for-all chow — any player may claim a chow from any discarder
  // (the traditional "left player only" restriction is intentionally removed).
  if (isHonorTile(tile) || isBonusTile(tile)) return false;
  const suit = tile.slice(-1);
  const num = parseInt(tile.slice(0, -1), 10);
  const has = n => hand.includes(`${n}${suit}`);
  const options = [];
  if (num >= 3 && has(num - 2) && has(num - 1)) options.push([num - 2, num - 1, num]);
  if (num >= 2 && num <= 8 && has(num - 1) && has(num + 1)) options.push([num - 1, num, num + 1]);
  if (num <= 7 && has(num + 1) && has(num + 2)) options.push([num, num + 1, num + 2]);
  return options.map(seq => seq.map(n => `${n}${suit}`));
}

export function applyPung(room, player, tile, fromSeat) {
  const removed = takeFromHand(player.hand, tile, 2);
  player.exposed.push({ type: 'pung', tiles: [...removed, tile], from: fromSeat });
  room.currentDiscard = null;
}

export function applyKong(room, player, tile, fromSeat, concealed = false) {
  const need = concealed ? 4 : 3;
  const removed = takeFromHand(player.hand, tile, need);
  const tiles = concealed ? removed : [...removed, tile];
  player.exposed.push({ type: 'kong', tiles, from: fromSeat ?? player.seat, concealed });
  room.currentDiscard = null;
  // replacement tile from dead wall
  const repl = room.deadWall.length > 0 ? room.deadWall.pop() : room.wall.shift();
  if (repl) {
    player.hand.push(repl);
    room.wall = replaceBonusTiles(player, room.wall, room.deadWall);
  }
  return repl;
}

export function applyChow(room, player, sequenceTiles, claimedTile, fromSeat) {
  const need = sequenceTiles.filter(t => t !== claimedTile);
  for (const t of need) takeFromHand(player.hand, t, 1);
  player.exposed.push({ type: 'chow', tiles: sequenceTiles, from: fromSeat });
  room.currentDiscard = null;
}

function takeFromHand(hand, tile, count) {
  const removed = [];
  for (let i = 0; i < count; i++) {
    const idx = hand.indexOf(tile);
    if (idx === -1) throw new Error(`Not enough ${tile} in hand`);
    hand.splice(idx, 1);
    removed.push(tile);
  }
  return removed;
}

// ---------- Win detection ----------

// Standard hand: 4 sets (pung/chow/kong) + 1 pair, built from exposed sets + concealed hand + winning tile
export function checkWin(hand, exposed, winningTile) {
  const fullConcealed = [...hand, winningTile].sort();
  const setsNeeded = 4 - exposed.length;

  if (isSevenPairs(fullConcealed) && exposed.length === 0) return { win: true, type: 'seven_pairs' };
  if (isThirteenOrphans(fullConcealed) && exposed.length === 0) return { win: true, type: 'thirteen_orphans' };
  if (canDecompose(fullConcealed, setsNeeded)) return { win: true, type: 'standard' };

  return { win: false };
}

function isSevenPairs(tiles) {
  if (tiles.length !== 14) return false;
  const counts = countTiles(tiles);
  const values = Object.values(counts);
  return values.length === 7 && values.every(c => c === 2);
}

const ORPHAN_TILES = ['1D','9D','1B','9B','1C','9C', ...WINDS, ...DRAGONS];
function isThirteenOrphans(tiles) {
  if (tiles.length !== 14) return false;
  const counts = countTiles(tiles);
  const keys = Object.keys(counts);
  if (!keys.every(k => ORPHAN_TILES.includes(k))) return false;
  if (keys.length !== 13) return false;
  return Object.values(counts).some(c => c === 2) && Object.values(counts).every(c => c <= 2);
}

function countTiles(tiles) {
  const counts = {};
  for (const t of tiles) counts[t] = (counts[t] || 0) + 1;
  return counts;
}

// Recursively check whether `tiles` can form `setsNeeded` sets (pung/chow) + exactly one pair
function canDecompose(tiles, setsNeeded) {
  return analyzeSets(tiles, setsNeeded) !== null;
}

// Like canDecompose, but also returns which sets (pung/chow) and pair were used —
// needed for scoring categories like "All Chows" / "All Pungs" that depend on the
// concealed portion's composition, not just the exposed melds.
// Ties are broken the same way the original win-detection walk did (pair, then pung,
// then chow, taking the first tile in sorted order) so existing win-detection behavior
// is unchanged; this is a best-effort classification, not an optimal-fan search.
function analyzeSets(tiles, setsNeeded) {
  if (tiles.length !== setsNeeded * 3 + 2) return null;
  const sorted = tiles.slice().sort();
  return decomposeCapture(sorted, setsNeeded, null, []);
}

function decomposeCapture(tiles, setsNeeded, pair, sets) {
  if (tiles.length === 0) {
    return (setsNeeded === 0 && pair) ? { pair, sets } : null;
  }
  const counts = countTiles(tiles);
  const first = tiles[0];

  // Try pair
  if (!pair && counts[first] >= 2) {
    const remaining = removeN(tiles, first, 2);
    const result = decomposeCapture(remaining, setsNeeded, first, sets);
    if (result) return result;
  }
  // Try pung
  if (setsNeeded > 0 && counts[first] >= 3) {
    const remaining = removeN(tiles, first, 3);
    const result = decomposeCapture(remaining, setsNeeded - 1, pair, [...sets, { type: 'pung', tiles: [first, first, first] }]);
    if (result) return result;
  }
  // Try chow (suited tiles only)
  if (setsNeeded > 0 && !isHonorTile(first) && !isBonusTile(first)) {
    const suit = first.slice(-1);
    const num = parseInt(first.slice(0, -1), 10);
    if (num <= 7) {
      const t2 = `${num + 1}${suit}`;
      const t3 = `${num + 2}${suit}`;
      if (tiles.includes(t2) && tiles.includes(t3)) {
        let remaining = tiles.slice();
        remaining.splice(remaining.indexOf(first), 1);
        remaining.splice(remaining.indexOf(t2), 1);
        remaining.splice(remaining.indexOf(t3), 1);
        const result = decomposeCapture(remaining, setsNeeded - 1, pair, [...sets, { type: 'chow', tiles: [first, t2, t3] }]);
        if (result) return result;
      }
    }
  }
  return null;
}

function removeN(tiles, tile, n) {
  const remaining = tiles.slice();
  for (let i = 0; i < n; i++) remaining.splice(remaining.indexOf(tile), 1);
  return remaining;
}

// ---------- Basic scoring ----------
// A fan-count scorer covering common traditional categories plus the table's house rules:
//   All Chows = 2 fan, One Suit + Honors = 3 fan, All Pungs = 3 fan, Pure One Suit = 6 fan,
//   Thirteen Orphans = limit hand (fan pinned at cap → 64 chips), Chicken Hand (0 fan) = 1 chip.
// Returns { fan, breakdown }. Pass handType from checkWin's result.type when available
// ('standard' | 'seven_pairs' | 'thirteen_orphans') so special hands score correctly.
export function scoreHand(player, exposed, concealedHand, winningTile, { selfDraw, roundWind, seatWind, handType = 'standard' } = {}) {
  if (handType === 'thirteen_orphans') {
    // Limit hand — fan is pinned at the fanToChips cap (6+ = 64 chips), exact value beyond that doesn't matter.
    return { fan: 6, breakdown: ['Thirteen Orphans (Limit Hand)'] };
  }

  const allTiles = [...concealedHand, winningTile, ...exposed.flatMap(s => s.tiles)];
  const breakdown = [];
  let fan = 0;

  const suits = new Set(allTiles.filter(t => !isHonorTile(t) && !isBonusTile(t)).map(t => t.slice(-1)));
  const hasHonors = allTiles.some(isHonorTile);

  if (suits.size === 1 && !hasHonors) { fan += 6; breakdown.push('Pure One Suit'); }
  else if (suits.size === 1 && hasHonors) { fan += 3; breakdown.push('One Suit + Honors'); }

  if (exposed.length === 0) { fan += 1; breakdown.push('Concealed Hand'); }
  if (selfDraw) { fan += 1; breakdown.push('Self-Drawn'); }

  // All Chows / All Pungs require knowing how the concealed portion breaks down into sets,
  // not just the exposed melds — only meaningful for standard (4 sets + pair) hands.
  if (handType === 'standard') {
    const setsNeeded = 4 - exposed.length;
    const concealedAnalysis = analyzeSets([...concealedHand, winningTile].sort(), setsNeeded);
    if (concealedAnalysis) {
      const concealedChows = concealedAnalysis.sets.filter(s => s.type === 'chow').length;
      const concealedPungs = concealedAnalysis.sets.filter(s => s.type === 'pung').length;
      const exposedChows = exposed.filter(s => s.type === 'chow').length;
      const exposedPungKongs = exposed.filter(s => s.type === 'pung' || s.type === 'kong').length;
      const totalSets = exposed.length + concealedAnalysis.sets.length;

      if (totalSets === 4) {
        if (exposedChows + concealedChows === 4) { fan += 2; breakdown.push('All Chows'); }
        else if (exposedPungKongs + concealedPungs === 4) { fan += 3; breakdown.push('All Pungs'); }
      }
    }
  }

  for (const dragon of DRAGONS) {
    if (allTiles.filter(t => t === dragon).length >= 3) { fan += 1; breakdown.push(`Dragon Pung (${dragon})`); }
  }
  if (roundWind && allTiles.filter(t => t === roundWind).length >= 3) { fan += 1; breakdown.push('Round Wind Pung'); }
  if (seatWind && allTiles.filter(t => t === seatWind).length >= 3) { fan += 1; breakdown.push('Seat Wind Pung'); }

  if (fan === 0) breakdown.push('Chicken Hand'); // 0 fan → 1 chip via fanToChips

  return { fan, breakdown };
}

export const constants = { SUITS, WINDS, DRAGONS, SEAT_ORDER, ORPHAN_TILES };
