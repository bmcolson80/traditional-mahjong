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
    round: { windIndex: 0, handNumber: 1, dealerSeat: 'E', matchOver: false },
    hostPlayerId,
    gameState: {},
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
// won or the hand was a draw — otherwise dealership passes to the next seat.
export function advanceHand(room, { winnerSeat, isDraw = false } = {}) {
  const dealerRetains = isDraw || winnerSeat === room.round.dealerSeat;
  if (dealerRetains) return room.round;

  room.round.dealerSeat = nextSeat(room.round.dealerSeat);
  room.round.handNumber += 1;
  if (room.round.handNumber > 4) {
    room.round.handNumber = 1;
    room.round.windIndex = (room.round.windIndex + 1) % 4;
    if (room.round.windIndex === 0) room.round.matchOver = true; // completed a full East->North cycle
  }
  return room.round;
}

// Simple point settlement: winner collects `fan` points from each opponent on a
// self-drawn win, or double from the discarder (and single from the other two)
// when winning off a discard. This is a common convention, not a fixed universal rule —
// adjust the multipliers here if your table plays a different settlement style.
export function settleScore(room, winnerSeat, fan, { selfDraw, discarderSeat } = {}) {
  const winner = room.players.find(p => p.seat === winnerSeat);
  const others = room.players.filter(p => p.seat !== winnerSeat);
  let winnerGain = 0;
  for (const p of others) {
    let amount = fan;
    if (!selfDraw && p.seat === discarderSeat) amount = fan * 2;
    p.score -= amount;
    winnerGain += amount;
  }
  winner.score += winnerGain;
  return room.players.map(p => ({ seat: p.seat, score: p.score }));
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
  if (room.players.length !== 4) throw new Error('Need exactly 4 players to start');
  const wall = buildWall();
  room.deadWall = wall.slice(0, 14);
  let live = wall.slice(14);

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

export function nextSeat(seat) {
  const i = SEAT_ORDER.indexOf(seat);
  return SEAT_ORDER[(i + 1) % 4];
}

// ---------- Claims ----------

export function canPung(hand, tile) {
  return hand.filter(t => t === tile).length >= 2;
}

export function canKongFromDiscard(hand, tile) {
  return hand.filter(t => t === tile).length >= 3;
}

export function canChow(hand, tile, claimerSeat, discarderSeat) {
  // Chow only allowed from the player immediately to your left
  if (nextSeat(discarderSeat) !== claimerSeat) return false;
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
  if (tiles.length !== setsNeeded * 3 + 2) return false;
  const sorted = tiles.slice().sort();
  return tryDecompose(sorted, setsNeeded, false);
}

function tryDecompose(tiles, setsNeeded, pairUsed) {
  if (tiles.length === 0) return setsNeeded === 0 && pairUsed;
  const counts = countTiles(tiles);
  const first = tiles[0];

  // Try pair
  if (!pairUsed && counts[first] >= 2) {
    const remaining = removeN(tiles, first, 2);
    if (tryDecompose(remaining, setsNeeded, true)) return true;
  }
  // Try pung
  if (setsNeeded > 0 && counts[first] >= 3) {
    const remaining = removeN(tiles, first, 3);
    if (tryDecompose(remaining, setsNeeded - 1, pairUsed)) return true;
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
        if (tryDecompose(remaining, setsNeeded - 1, pairUsed)) return true;
      }
    }
  }
  return false;
}

function removeN(tiles, tile, n) {
  const remaining = tiles.slice();
  for (let i = 0; i < n; i++) remaining.splice(remaining.indexOf(tile), 1);
  return remaining;
}

// ---------- Basic scoring ----------
// A simplified fan-count scorer covering common traditional categories.
// Returns { fan, breakdown } — intended as a starting point, tune to your table's ruleset.
export function scoreHand(player, exposed, concealedHand, winningTile, { selfDraw, roundWind, seatWind } = {}) {
  const allTiles = [...concealedHand, winningTile, ...exposed.flatMap(s => s.tiles)];
  const breakdown = [];
  let fan = 0;

  const suits = new Set(allTiles.filter(t => !isHonorTile(t) && !isBonusTile(t)).map(t => t.slice(-1)));
  const hasHonors = allTiles.some(isHonorTile);

  if (suits.size === 1 && !hasHonors) { fan += 4; breakdown.push('Pure One Suit (Full Flush)'); }
  else if (suits.size === 1 && hasHonors) { fan += 2; breakdown.push('Half Flush'); }

  if (exposed.length === 0) { fan += 1; breakdown.push('Concealed Hand'); }
  if (selfDraw) { fan += 1; breakdown.push('Self-Drawn'); }

  const allPungKong = exposed.every(s => s.type !== 'chow');
  if (allPungKong) { fan += 1; breakdown.push('All Triplets'); }

  for (const dragon of DRAGONS) {
    if (allTiles.filter(t => t === dragon).length >= 3) { fan += 1; breakdown.push(`Dragon Pung (${dragon})`); }
  }
  if (roundWind && allTiles.filter(t => t === roundWind).length >= 3) { fan += 1; breakdown.push('Round Wind Pung'); }
  if (seatWind && allTiles.filter(t => t === seatWind).length >= 3) { fan += 1; breakdown.push('Seat Wind Pung'); }

  if (fan === 0) { fan = 1; breakdown.push('Base Hand'); }

  return { fan, breakdown };
}

export const constants = { SUITS, WINDS, DRAGONS, SEAT_ORDER, ORPHAN_TILES };
