// ai.js — Mahjong AI decision engine
// All logic is pure (no side effects, no I/O) so it can be unit-tested without a server.

import { checkWin, isHonorTile, isBonusTile } from './game.js';

// Think time ranges in ms. Master plays faster (more decisive), Rookie takes longer.
export const THINK_TIME = {
  rookie:  [2500, 4500],
  veteran: [1000, 2000],
  master:  [400,  1000],
};

export function aiThinkTime(skill) {
  const [min, max] = THINK_TIME[skill] ?? THINK_TIME.rookie;
  return min + Math.random() * (max - min);
}

// AI display names — indexed by slot position (0=Red Dragon, 1=Green Dragon, 2=White Dragon)
// then by skill level
export const AI_NAMES = {
  rookie:  ['Long Xiao',    'Fa Mei',     'Bai Yue'   ], // young/novice: small dragon, new fortune, white moon
  veteran: ['Long Wei',     'Fa Shen',    'Bai He'    ], // adept: dragon power, fortune spirit, white crane
  master:  ['Crimson Lord', 'Jade Dragon','Pearl Dragon'], // master tier
};

export function aiDisplayName(skill, index = 0) {
  const names = AI_NAMES[skill] ?? AI_NAMES.rookie;
  return names[index % names.length];
}

// ─── Discard decision ─────────────────────────────────────────────────────────

// Returns the tile the AI should discard from its hand.
export function chooseDiscard(hand, exposed, skill) {
  if (skill === 'rookie' && Math.random() < 0.60) {
    // Rookie discards randomly most of the time
    return hand[Math.floor(Math.random() * hand.length)];
  }
  return bestDiscard(hand, exposed, skill);
}

function bestDiscard(hand, exposed, skill) {
  // Score each candidate discard: the tile whose removal leaves the highest-scoring hand wins.
  let bestTile = hand[0];
  let bestScore = -Infinity;
  const tried = new Set();
  for (const tile of hand) {
    if (tried.has(tile)) continue; // no need to evaluate duplicates twice
    tried.add(tile);
    const remaining = removeTile(hand, tile);
    const score = evaluateHand(remaining, exposed);
    if (score > bestScore) { bestScore = score; bestTile = tile; }
  }
  return bestTile;
}

// Evaluate a concealed hand: returns a score where higher = closer to winning.
// Uses a block-counting heuristic: complete set = 2pts, pair = 1pt,
// adjacent partial sequence = 0.5pts, skip-one partial = 0.4pts.
export function evaluateHand(hand, exposed) {
  const setsNeeded = 4 - (exposed?.length ?? 0);
  return scoreBlocks(hand.slice().sort(), setsNeeded, false);
}

function scoreBlocks(tiles, setsLeft, pairUsed) {
  if (tiles.length === 0) return 0;
  const counts = countTiles(tiles);
  const first = tiles[0];
  let best = 0;

  // Pair (only one allowed in a hand)
  if (!pairUsed && counts[first] >= 2) {
    const rem = removeTiles(tiles, [first, first]);
    best = Math.max(best, 1 + scoreBlocks(rem, setsLeft, true));
  }
  // Pung (complete triplet)
  if (setsLeft > 0 && counts[first] >= 3) {
    const rem = removeTiles(tiles, [first, first, first]);
    best = Math.max(best, 2 + scoreBlocks(rem, setsLeft - 1, pairUsed));
  }
  // Chow (complete run) and partial runs — only for suited tiles
  if (setsLeft > 0 && !isHonorTile(first) && !isBonusTile(first)) {
    const suit = first.slice(-1);
    const num = parseInt(first.slice(0, -1), 10);
    if (num <= 7) {
      const t2 = `${num + 1}${suit}`, t3 = `${num + 2}${suit}`;
      if (counts[t2] && counts[t3]) {
        best = Math.max(best, 2 + scoreBlocks(removeTiles(tiles, [first, t2, t3]), setsLeft - 1, pairUsed));
      }
    }
    // Adjacent partial (n, n+1)
    if (num <= 8) {
      const t2 = `${num + 1}${suit}`;
      if (counts[t2]) best = Math.max(best, 0.5 + scoreBlocks(removeTiles(tiles, [first, t2]), setsLeft, pairUsed));
    }
    // Skip-one partial (n, n+2)
    if (num <= 7) {
      const t2 = `${num + 2}${suit}`;
      if (counts[t2]) best = Math.max(best, 0.4 + scoreBlocks(removeTiles(tiles, [first, t2]), setsLeft, pairUsed));
    }
  }
  // Isolated tile — skip and continue
  best = Math.max(best, scoreBlocks(tiles.slice(1), setsLeft, pairUsed));
  return best;
}

// ─── Claim decisions ──────────────────────────────────────────────────────────

// Should AI claim a pung from the discard pile?
export function shouldClaimPung(hand, tile, exposed, skill) {
  if (skill === 'rookie')  return Math.random() < 0.55;
  if (skill === 'veteran') return true;
  // Master: evaluate whether punging improves hand score
  const beforeScore = evaluateHand(hand, exposed);
  const afterHand   = removeTiles(hand, [tile, tile]);
  const afterExposed = [...(exposed ?? []), { type: 'pung', tiles: [tile, tile, tile] }];
  const afterScore  = evaluateHand(afterHand, afterExposed);
  return afterScore >= beforeScore - 0.2; // only decline if it clearly hurts the hand
}

// Should AI claim a chow from the discard pile?
// House rule: free-for-all chow — any seat may claim from any discarder, so no
// direction check here (claimerSeat/discarderSeat kept for signature compatibility).
export function shouldClaimChow(hand, tile, exposed, skill, claimerSeat, discarderSeat) {
  if (skill === 'rookie')  return Math.random() < 0.30;
  if (skill === 'veteran') return Math.random() < 0.65;
  // Master: chow only if it clearly improves the hand
  return Math.random() < 0.45;
}

// Should AI declare Mahjong (win)?
export function shouldDeclareWin(hand, exposed, winningTile, skill) {
  // winningTile may be null for self-draw (last tile in hand IS the winning tile)
  const wTile  = winningTile ?? hand[hand.length - 1];
  const hCheck = winningTile ? hand : hand.slice(0, -1);
  const result = checkWin(hCheck, exposed, wTile);
  if (!result.win) return false;
  if (skill === 'rookie') return Math.random() < 0.93; // very occasionally misses
  return true;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function countTiles(tiles) {
  const c = {};
  for (const t of tiles) c[t] = (c[t] || 0) + 1;
  return c;
}

function removeTile(arr, tile) {
  const copy = arr.slice();
  const i = copy.indexOf(tile);
  if (i !== -1) copy.splice(i, 1);
  return copy;
}

export function removeTiles(arr, toRemove) {
  let copy = arr.slice();
  for (const t of toRemove) {
    const i = copy.indexOf(t);
    if (i !== -1) copy.splice(i, 1);
  }
  return copy;
}
