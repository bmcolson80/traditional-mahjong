// special-hands.js — "The Western Hands" catalog of named special Mah Jong hands
// (source: Mah_Jong_Hands.pdf, a Western/club-style hands reference). Pure logic,
// no I/O — mirrors game.js's structure.
//
// Every hand here is checked against a flat "pool" of tiles: the player's concealed
// hand + the winning tile + every tile physically in their exposed melds (kongs
// included, so the pool can be 14-17 tiles). A hand matches only if every tile in
// the pool is accounted for by the hand's required components — no leftovers.
//
// Scoring tiers map onto this project's existing 1-64 chip fan-doubling economy
// (see game.js fanToChips) rather than the book's own point scale (500-2000 —
// a separate physical-counter economy incompatible with a 500-1000 chip starting
// bank). Tier chip values: half_limit=32, limit=64 (same cap Thirteen Orphans
// already uses), middle_limit=96, double_limit=128. Fishing bonus ≈ 40% of the
// tier value, matching the book's own ratio ("Fishing = two-fifths of Winning").
//
// A handful of the more obscure/idiosyncratic hands (Yin Yang, Numbers Doubled,
// Chinese Odds fine print) were reconstructed from a scanned, partly garbled OCR
// source and are lower-confidence best-effort interpretations — see the project
// CLAUDE.md note left alongside this file.
const SUITS = ['D', 'B', 'C'];
const WINDS = ['EW', 'SW', 'WW', 'NW'];
const DRAGONS = ['RD', 'GD', 'WD'];
// Dragon <-> suit correspondence used by several hands (Ruby Jade, Green Jade, etc.)
const DRAGON_SUIT = { RD: 'C', GD: 'B', WD: 'D' }; // Red-Characters, Green-Bamboo, White-Circles
const SUIT_DRAGON = { C: 'RD', B: 'GD', D: 'WD' }; // inverse of DRAGON_SUIT
const GREEN_BAMBOO_NUMBERS = [2, 3, 4, 6, 8];
const RED_BAMBOO_NUMBERS = [1, 5, 7, 9];

export const TIER_CHIPS = { half_limit: 32, limit: 64, middle_limit: 96, double_limit: 128 };
export const TIER_FISHING_CHIPS = { half_limit: 13, limit: 26, middle_limit: 38, double_limit: 51 };
const TIER_RANK = TIER_CHIPS;

function isHonorTile(t) { return WINDS.includes(t) || DRAGONS.includes(t); }
function isSuited(t) { return !isHonorTile(t) && !t.startsWith('F') && !t.startsWith('S'); }
function suitOf(t) { return t.slice(-1); }
function tile(n, suit) { return `${n}${suit}`; }
function run(suit, start, end) {
  const out = [];
  for (let n = start; n <= end; n++) out.push(tile(n, suit));
  return out;
}

// ---------- Pool helpers (mutate a plain-object tile-count map) ----------
function counts(tiles) {
  const c = {};
  for (const t of tiles) c[t] = (c[t] || 0) + 1;
  return c;
}
function remainingCount(c) { return Object.values(c).reduce((a, b) => a + b, 0); }
function take(c, t, n = 1) {
  if ((c[t] || 0) < n) return false;
  c[t] -= n;
  if (c[t] === 0) delete c[t];
  return true;
}
function takePair(c, t) { return take(c, t, 2); }
// Pung or Kong: consumes exactly what's there (3 or 4) so a kong's bonus tile
// doesn't get left over as an unaccounted leftover.
function takeMeld(c, t) {
  const n = c[t] || 0;
  if (n !== 3 && n !== 4) return false;
  delete c[t];
  return true;
}
// Atomic: checks every tile in the run is available *before* consuming any of
// them, so a failed attempt never leaves `c` partially mutated — important
// since several hands try a run, and on failure retry something else against
// the very same counts object.
function takeRun(c, suit, start, end) {
  const tiles = run(suit, start, end);
  if (!tiles.every(t => (c[t] || 0) >= 1)) return false;
  for (const t of tiles) take(c, t);
  return true;
}
function takeEachWind(c) { for (const w of WINDS) if (!take(c, w)) return false; return true; }
function takeEachWindPair(c) { for (const w of WINDS) if (!takePair(c, w)) return false; return true; }
function takeEachDragon(c) { for (const d of DRAGONS) if (!take(c, d)) return false; return true; }
function takeEachDragonMeld(c) { for (const d of DRAGONS) if (!takeMeld(c, d)) return false; return true; }
// Consumes exactly one extra tile that duplicates one of the already-required
// singles ("+ any tile paired" — the book's shorthand for "add a duplicate of
// something already in the hand", not an independent new pair). `allowed` is the
// list of tile values eligible to be duplicated.
function takeAnyDup(c, allowed) {
  for (const t of allowed) if ((c[t] || 0) >= 1) return take(c, t, 1);
  return false;
}
function takePairFromSet(c, tiles) {
  for (const t of tiles) if ((c[t] || 0) >= 2) return takePair(c, t);
  return false;
}
function takeMeldFromSet(c, tiles) {
  for (const t of tiles) if (takeMeld(c, t)) return true;
  return false;
}
function takePairAnySuit(c) {
  for (const t of Object.keys(c)) if (isSuited(t) && (c[t] || 0) >= 2) return takePair(c, t);
  return false;
}
function takeRunAnywhere(c, suit) {
  for (let s = 1; s <= 7; s++) {
    const t1 = tile(s, suit), t2 = tile(s + 1, suit), t3 = tile(s + 2, suit);
    if ((c[t1] || 0) >= 1 && (c[t2] || 0) >= 1 && (c[t3] || 0) >= 1) {
      take(c, t1); take(c, t2); take(c, t3);
      return true;
    }
  }
  return false;
}
function empty(c) { return remainingCount(c) === 0; }

// Tries `fn` once per suit, each time against a *fresh* copy of the pool's
// counts, since a hand may only be satisfiable under one particular suit choice.
function tryEachSuit(pool, fn) {
  for (const suit of SUITS) {
    const c = counts(pool);
    if (fn(c, suit)) return true;
  }
  return false;
}
function tryEachSuitPair(pool, fn) {
  for (const a of SUITS) {
    for (const b of SUITS) {
      if (a === b) continue;
      const c = counts(pool);
      if (fn(c, a, b)) return true;
    }
  }
  return false;
}
function tryEachDragon(pool, fn) {
  for (const d of DRAGONS) {
    const c = counts(pool);
    if (fn(c, d)) return true;
  }
  return false;
}
// "Chow in each suit" (one chow per suit, any rank) + a caller-supplied final component.
function threeSuitChowsPlus(pool, finalFn) {
  const c = counts(pool);
  for (const suit of SUITS) if (!takeRunAnywhere(c, suit)) return false;
  return finalFn(c);
}
// "Chow start-end in each suit" (fixed rank across all 3 suits) + a final component.
function threeFixedChows(pool, start, end, finalFn) {
  const c = counts(pool);
  for (const suit of SUITS) if (!takeRun(c, suit, start, end)) return false;
  return finalFn(c);
}
// Three pairs of Winds OR three pairs of Dragons + a run (1-8 or 2-9) in one suit.
function hachiBan(pool) {
  for (const honorSet of [WINDS, DRAGONS]) {
    const c = counts(pool);
    let pairs = 0;
    for (const h of honorSet) if (takePair(c, h)) pairs++;
    if (pairs !== 3) continue;
    const suited = counts(Object.keys(c).flatMap(t => Array(c[t]).fill(t)));
    for (const suit of SUITS) {
      const c2 = { ...suited };
      if ((takeRun(c2, suit, 1, 8) || (() => { Object.assign(c2, suited); return takeRun(c2, suit, 2, 9); })()) && empty(c2)) return true;
    }
  }
  return false;
}
function windyNumberPungs(pool, n) {
  const c = counts(pool);
  if (!takeEachWind(c)) return false;
  for (const suit of SUITS) if (!takeMeld(c, tile(n, suit))) return false;
  return takeAnyDup(c, WINDS) && empty(c);
}

// ---------- The catalog ----------
// Each entry: { key, name, tier, exposedTier (optional, lower tier if any meld
// was claimed), concealedOnly (defaults to true — exposed.length must be 0 —
// unless exposedTier is set or concealedOnly:false is explicit), requireAllSelfDrawn
// (Chow Chow), test(pool, ctx) }
export const SPECIAL_HANDS = [
  // ---- Long runs, no honours ----
  {
    key: 'run_pung_pair', name: 'Run, Pung and Pair', tier: 'limit',
    test: pool => tryEachSuit(pool, (c, suit) =>
      takeRun(c, suit, 1, 9) && takeMeldFromSet(c, run(suit, 1, 9)) && takePairFromSet(c, run(suit, 1, 9)) && empty(c)),
  },
  {
    key: 'gates_of_heaven', name: 'Gates of Heaven', tier: 'limit',
    test: pool => tryEachSuit(pool, (c, suit) => {
      const mid = run(suit, 2, 8);
      return takeRun(c, suit, 2, 8) && takeAnyDup(c, mid) && takeMeld(c, tile(1, suit)) && takeMeld(c, tile(9, suit)) && empty(c);
    }),
  },
  {
    key: 'confused_gates', name: 'Confused Gates', tier: 'limit',
    test: pool => tryEachSuit(pool, (c, suit1) => {
      const mid = run(suit1, 2, 8);
      if (!takeRun(c, suit1, 2, 8) || !takeAnyDup(c, mid)) return false;
      for (const suit2 of SUITS) {
        if (suit2 === suit1) continue;
        for (const suit3 of SUITS) {
          if (suit3 === suit1 || suit3 === suit2) continue;
          const c2 = { ...c };
          if (takeMeld(c2, tile(1, suit2)) && takeMeld(c2, tile(9, suit3)) && empty(c2)) return true;
        }
      }
      return false;
    }),
  },
  // ---- Long runs, with honours ----
  {
    key: 'wriggly_snake', name: 'Wriggly Snake', tier: 'limit',
    test: pool => tryEachSuit(pool, (c, suit) => {
      const req = [...run(suit, 1, 9), ...WINDS];
      return takeRun(c, suit, 1, 9) && takeEachWind(c) && takeAnyDup(c, req) && empty(c);
    }),
  },
  {
    key: 'hachi_ban', name: 'Hachi Ban', tier: 'limit',
    test: pool => hachiBan(pool),
  },
  {
    key: 'guardian_winds', name: 'Guardian Winds', tier: 'limit',
    test: pool => tryEachSuit(pool, (c, suit) =>
      takeRun(c, suit, 1, 9) && takeMeldFromSet(c, WINDS) && takePairFromSet(c, WINDS) && empty(c)),
  },
  {
    key: 'guardian_dragons', name: 'Guardian Dragons', tier: 'limit',
    test: pool => tryEachSuit(pool, (c, suit) =>
      takeRun(c, suit, 1, 9) && takeMeldFromSet(c, DRAGONS) && takePairFromSet(c, DRAGONS) && empty(c)),
  },
  {
    key: 'five_odd_honours', name: 'Five Odd Honours', tier: 'half_limit',
    test: pool => tryEachSuit(pool, (c, suit) => {
      if (!takeRun(c, suit, 1, 9)) return false;
      const honorTilesLeft = Object.keys(c).filter(isHonorTile);
      if (honorTilesLeft.length !== 5) return false;
      if (!honorTilesLeft.every(h => c[h] === 1)) return false;
      for (const h of honorTilesLeft) take(c, h, 1);
      return empty(c);
    }),
  },
  {
    key: 'wriggly_dragon', name: 'Wriggly Dragon', tier: 'limit',
    test: pool => tryEachSuit(pool, (c, suit) =>
      takeRun(c, suit, 1, 9) && takeEachDragon(c) && takePairFromSet(c, DRAGONS) && empty(c)),
  },
  {
    key: 'grand_sequence', name: 'Grand Sequence', tier: 'limit',
    test: pool => tryEachSuit(pool, (c, suit) => {
      if (!takeRun(c, suit, 1, 9)) return false;
      if (!takeMeldFromSet(c, [...WINDS, ...DRAGONS])) return false;
      const remaining = Object.keys(c).filter(isSuited);
      return takePairFromSet(c, remaining) && empty(c);
    }),
  },
  {
    key: 'dragons_gates', name: "Dragon's Gates", tier: 'limit', exposedTier: 'half_limit',
    test: pool => tryEachDragon(pool, (c, dragon) => {
      const suit = DRAGON_SUIT[dragon];
      const mid = run(suit, 2, 8);
      return takeRun(c, suit, 2, 8) && takeAnyDup(c, mid) && (takeMeld(c, tile(1, suit)) || takeMeld(c, tile(9, suit)))
        && takeMeld(c, dragon) && empty(c);
    }),
  },
  {
    key: 'dragons_tail', name: "Dragon's Tail", tier: 'limit', exposedTier: 'half_limit',
    test: pool => tryEachSuit(pool, (c, suit) =>
      takeRun(c, suit, 1, 9) && takeMeldFromSet(c, DRAGONS) && takePairFromSet(c, WINDS) && empty(c))
      || tryEachSuit(pool, (c, suit) =>
        takeRun(c, suit, 1, 9) && takePairFromSet(c, DRAGONS) && takeMeldFromSet(c, WINDS) && empty(c)),
  },
  {
    key: 'dragons_teeth', name: "Dragon's Teeth", tier: 'limit', exposedTier: 'half_limit',
    test: pool => tryEachSuit(pool, (c, suit) => {
      if (suit === 'B') return false; // Characters or Circles only
      const low = takeRun(c, suit, 1, 7) ? run(suit, 1, 7) : (takeRun(c, suit, 2, 8) ? run(suit, 2, 8) : null);
      if (!low) return false;
      return takeAnyDup(c, low) && takeMeld(c, 'WD') && takeMeld(c, 'RD') && empty(c);
    }),
  },
  {
    key: 'gretas_garden', name: "Greta's Garden", tier: 'limit',
    test: pool => tryEachSuit(pool, (c, suit) =>
      takeRun(c, suit, 1, 7) && takeEachWind(c) && takeEachDragon(c) && empty(c)),
  },
  {
    key: 'gretas_dragon', name: "Greta's Dragon", tier: 'limit',
    test: pool => tryEachSuit(pool, (c, suit) =>
      takeRun(c, suit, 1, 7) && takeEachWind(c) && takeMeldFromSet(c, DRAGONS) && empty(c)),
  },
  {
    key: 'red_lantern', name: 'Red Lantern', tier: 'double_limit', exposedTier: 'limit',
    test: (pool, ctx) => tryEachSuit(pool, (c, suit) => {
      const low = run(suit, 1, 7);
      return Boolean(ctx?.ownWind) && takeRun(c, suit, 1, 7) && takeAnyDup(c, low) && takeMeld(c, 'RD') && takeMeld(c, ctx.ownWind) && empty(c);
    }),
  },
  {
    key: 'gerties_garter', name: "Gertie's Garter", tier: 'limit',
    test: pool => tryEachSuitPair(pool, (c, a, b) => takeRun(c, a, 1, 7) && takeRun(c, b, 1, 7) && empty(c)),
  },
  // ---- Chows ----
  {
    key: 'moon_at_bottom_of_well', name: 'Moon at Bottom of Well', tier: 'limit',
    test: pool => {
      const c = counts(pool);
      let chowCount = 0, last = 0;
      for (let s = 1; s <= 7 && chowCount < 3; s++) {
        if (s <= last) continue;
        if (takeRun(c, 'D', s, s + 2)) { last = s + 2; chowCount++; }
      }
      if (chowCount < 3) return false;
      return takeRunAnywhere(c, 'D') && takePairFromSet(c, run('D', 1, 9)) && empty(c);
    },
  },
  {
    key: 'chow_chow', name: 'Chow Chow', tier: 'half_limit', requireAllSelfDrawn: true,
    test: pool => tryEachSuit(pool, (c, suit) => {
      for (let i = 0; i < 4; i++) if (!takeRunAnywhere(c, suit)) return false;
      return takePairFromSet(c, run(suit, 1, 9)) && empty(c);
    }),
  },
  {
    key: 'three_philosophers', name: 'Three Philosophers', tier: 'limit',
    test: pool => threeSuitChowsPlus(pool, (c) => {
      for (const suit of SUITS) { const c2 = { ...c }; if (takeRunAnywhere(c2, suit) && takePairAnySuit(c2) && empty(c2)) return true; }
      return false;
    }),
  },
  {
    key: 'crazy_chows', name: 'Crazy Chows', tier: 'half_limit',
    test: pool => {
      const c = counts(pool);
      for (let i = 0; i < 4; i++) {
        let found = false;
        for (const suit of SUITS) if (takeRunAnywhere(c, suit)) { found = true; break; }
        if (!found) return false;
      }
      return takePairAnySuit(c) && empty(c);
    },
  },
  {
    key: 'little_robert', name: 'Little Robert', tier: 'half_limit',
    test: pool => threeSuitChowsPlus(pool, (c) => {
      const suited = Object.keys(c).filter(isSuited);
      return takeMeldFromSet(c, suited) && takePairAnySuit(c) && empty(c);
    }),
  },
  {
    key: 'little_brother', name: 'Little Brother', tier: 'half_limit',
    test: (pool, ctx) => threeSuitChowsPlus(pool, (c) => {
      for (const suit of SUITS) { const c2 = { ...c }; if (takeRunAnywhere(c2, suit) && ctx?.ownWind && takePair(c2, ctx.ownWind) && empty(c2)) return true; }
      return false;
    }),
  },
  {
    key: 'hovering_angel', name: 'Hovering Angel', tier: 'limit',
    test: (pool, ctx) => threeSuitChowsPlus(pool, (c) => Boolean(ctx?.ownWind) && takeMeld(c, ctx.ownWind) && takePairFromSet(c, DRAGONS) && empty(c)),
  },
  {
    key: 'windy_chow', name: 'Windy Chow', tier: 'half_limit',
    test: pool => threeSuitChowsPlus(pool, (c) => takeEachWind(c) && takeAnyDup(c, WINDS) && empty(c)),
  },
  {
    key: 'chop_suey', name: 'Chop Suey', tier: 'limit',
    test: pool => threeFixedChows(pool, 1, 3, (c) => takeEachWind(c) && takeAnyDup(c, WINDS) && empty(c)),
  },
  {
    key: 'chow_mein', name: 'Chow Mein', tier: 'limit',
    test: pool => threeFixedChows(pool, 7, 9, (c) => takeEachWind(c) && takeAnyDup(c, WINDS) && empty(c)),
  },
  {
    key: 'the_professors', name: 'The Professors', tier: 'half_limit',
    test: (pool, ctx) => threeSuitChowsPlus(pool, (c) => takeEachDragon(c) && Boolean(ctx?.ownWind) && takePair(c, ctx.ownWind) && empty(c)),
  },
  {
    key: 'apple_blossom', name: 'Apple Blossom', tier: 'limit',
    test: pool => threeSuitChowsPlus(pool, (c) => takeMeld(c, 'WD') && takePair(c, 'GD') && empty(c)),
  },
  // ---- Pairs ----
  {
    key: 'knitting', name: 'Knitting', tier: 'half_limit',
    // Seven pairs, each pair being one tile of the same number in each of two
    // suits — the number itself may repeat across pairs (e.g. two "8" pairs),
    // per the reference sheet's own example (1,2,2,4,5,7,8).
    test: pool => tryEachSuitPair(pool, (c, a, b) => {
      let n = 0;
      for (let num = 1; num <= 9; num++) {
        while ((c[tile(num, a)] || 0) >= 1 && (c[tile(num, b)] || 0) >= 1) {
          take(c, tile(num, a));
          take(c, tile(num, b));
          n++;
        }
      }
      return n === 7 && empty(c);
    }),
  },
  {
    key: 'triple_knitting', name: 'Triple Knitting', tier: 'half_limit',
    test: pool => {
      const c = counts(pool);
      let sets = 0;
      for (let num = 1; num <= 9 && sets < 4; num++) if (SUITS.every(s => take(c, tile(num, s)))) sets++;
      if (sets < 4) return false;
      for (let num = 1; num <= 9; num++) {
        for (const a of SUITS) {
          for (const b of SUITS) {
            if (a === b) continue;
            const c2 = { ...c };
            if (take(c2, tile(num, a)) && take(c2, tile(num, b)) && empty(c2)) return true;
          }
        }
      }
      return false;
    },
  },
  {
    key: 'sparrows_sanctuary', name: "Sparrow's Sanctuary", tier: 'middle_limit',
    // Always Bamboo — the reference sheet lists this under "BAMBOO SUIT", not
    // "any suit" (unlike most other named hands here).
    test: pool => {
      const c = counts(pool);
      if (c['1B'] !== 4) return false;
      take(c, '1B', 4);
      for (const n of GREEN_BAMBOO_NUMBERS) if (!takePair(c, tile(n, 'B'))) return false;
      return empty(c);
    },
  },
  {
    key: 'heavenly_twins', name: 'Heavenly Twins', tier: 'limit',
    test: pool => tryEachSuit(pool, (c, suit) => {
      let pairs = 0;
      for (let n = 1; n <= 9; n++) if (takePair(c, tile(n, suit))) pairs++;
      return pairs === 7 && empty(c);
    }),
  },
  {
    key: 'all_pair', name: 'All Pair', tier: 'half_limit',
    test: pool => tryEachSuit(pool, (c, suit) => {
      let pairs = 0;
      for (let n = 1; n <= 9; n++) if (takePair(c, tile(n, suit))) pairs++;
      for (const h of [...WINDS, ...DRAGONS]) if (takePair(c, h)) pairs++;
      return pairs === 7 && empty(c);
    }),
  },
  {
    key: 'all_pair_honours', name: 'All Pair Honours', tier: 'limit',
    // "Pairs of 1s & 9s only, Winds & Dragons only, or all combined" (reference
    // sheet) — the 7 pairs may draw from terminals too, not just the 7 honor tiles.
    test: pool => {
      const c = counts(pool);
      const candidates = [...WINDS, ...DRAGONS, ...SUITS.flatMap(s => [tile(1, s), tile(9, s)])];
      let pairs = 0;
      for (const t of candidates) if (takePair(c, t)) pairs++;
      return pairs === 7 && empty(c);
    },
  },
  {
    key: 'all_pair_jade', name: 'All Pair Jade', tier: 'limit', concealedOnly: false,
    // "At least one Pair of Green Dragons" + "Five or Six Pairs of Green Bamboos"
    // (reference sheet) — either 1 GD pair + 6 bamboo pairs, or all 4 GD (2 pairs)
    // + 5 bamboo pairs.
    test: pool => {
      const c = counts(pool);
      // Six pairs from only 5 distinct numbers means one number contributes two
      // pairs (all 4 copies) — keep taking pairs from each number until exhausted.
      let pairs = 0;
      for (const n of GREEN_BAMBOO_NUMBERS) while (takePair(c, tile(n, 'B'))) pairs++;
      if (takePair(c, 'GD')) {
        if (pairs === 6 && empty(c)) return true;
        return pairs === 5 && takePair(c, 'GD') && empty(c);
      }
      return false;
    },
  },
  {
    key: 'all_pair_ruby_jade', name: 'All Pair Ruby Jade', tier: 'limit',
    test: pool => {
      const c = counts(pool);
      if (!takePair(c, 'RD') || !takePair(c, 'GD')) return false;
      let pairs = 0;
      for (const n of [...GREEN_BAMBOO_NUMBERS, ...RED_BAMBOO_NUMBERS]) if (takePair(c, tile(n, 'B'))) pairs++;
      return pairs === 5 && empty(c);
    },
  },
  {
    key: 'dragons_breath', name: "Dragon's Breath", tier: 'limit',
    test: pool => tryEachSuit(pool, (c, suit) => {
      let pairs = 0;
      for (let n = 1; n <= 9; n++) if (takePair(c, tile(n, suit))) pairs++;
      if (pairs !== 5 || !takeEachDragon(c)) return false;
      return takeAnyDup(c, DRAGONS) && empty(c);
    }),
  },
  {
    key: 'windfall', name: 'Windfall', tier: 'limit',
    test: pool => tryEachSuit(pool, (c, suit) => {
      let pairs = 0;
      for (let n = 1; n <= 9; n++) if (takePair(c, tile(n, suit))) pairs++;
      return pairs === 5 && takeEachWind(c) && empty(c);
    }),
  },
  {
    key: 'dragonette', name: 'Dragonette', tier: 'limit',
    test: pool => tryEachSuit(pool, (c, suit) => {
      let pairs = 0;
      for (let n = 2; n <= 8; n++) if (takePair(c, tile(n, suit))) pairs++;
      if (pairs !== 3) return false;
      if (!takeEachWind(c) || !takeEachDragon(c)) return false;
      return takeAnyDup(c, [...WINDS, ...DRAGONS]) && empty(c);
    }),
  },
  {
    key: 'golden_gates', name: 'Golden Gates', tier: 'limit', exposedTier: 'half_limit',
    test: pool => tryEachSuit(pool, (c, suit) => {
      for (const n of [2, 4, 6, 8]) if (!takePair(c, tile(n, suit))) return false;
      return (takeMeld(c, tile(1, suit)) || takeMeld(c, tile(9, suit))) && takeMeld(c, SUIT_DRAGON[suit]) && empty(c);
    }),
  },
  {
    key: 'windy_dragons', name: 'Windy Dragons', tier: 'limit', concealedOnly: false,
    test: pool => {
      const c = counts(pool);
      if (!takeEachWindPair(c)) return false;
      let pungs = 0;
      for (const d of DRAGONS) if (takeMeld(c, d)) pungs++;
      return pungs === 2 && empty(c);
    },
  },
  // ---- Winds & Dragons pungs ----
  {
    key: 'windy_ones', name: 'Windy Ones', tier: 'limit', exposedTier: 'half_limit',
    test: pool => windyNumberPungs(pool, 1),
  },
  {
    key: 'windy_nines', name: 'Windy Nines', tier: 'limit', exposedTier: 'half_limit',
    test: pool => windyNumberPungs(pool, 9),
  },
  {
    key: 'three_sisters', name: 'Three Sisters', tier: 'limit', exposedTier: 'half_limit',
    test: pool => windyNumberPungs(pool, 3),
  },
  {
    key: 'seven_brothers', name: 'Seven Brothers', tier: 'limit', exposedTier: 'half_limit',
    test: pool => windyNumberPungs(pool, 7),
  },
  {
    key: 'windvane', name: 'Windvane', tier: 'limit',
    test: pool => {
      const c = counts(pool);
      if (!takeEachWind(c)) return false;
      for (const suit of SUITS) if (!takeMeldFromSet(c, run(suit, 1, 9))) return false;
      return takeAnyDup(c, WINDS) && empty(c);
    },
  },
  {
    key: 'four_blessings', name: 'The Four Blessings', tier: 'middle_limit', concealedOnly: false,
    test: pool => {
      const c = counts(pool);
      for (const w of WINDS) if (!takeMeld(c, w)) return false;
      const remaining = Object.keys(c);
      return remaining.length > 0 && takePairFromSet(c, remaining) && empty(c);
    },
  },
  {
    key: 'civil_war', name: 'Civil War', tier: 'middle_limit', concealedOnly: false,
    // Literal fixed shape per the reference sheet's diagram: "1, 8, 6, 1 in one
    // suit" + "1, 8, 6, 5 in another suit" — not a meld/pair decomposition.
    test: pool => tryEachSuitPair(pool, (c, a, b) => {
      if (!takeMeld(c, 'NW') || !takeMeld(c, 'SW')) return false;
      for (const n of [1, 1, 6, 8]) if (!take(c, tile(n, a))) return false;
      for (const n of [1, 5, 6, 8]) if (!take(c, tile(n, b))) return false;
      return empty(c);
    }),
  },
  // ---- Dragons ----
  {
    key: 'dragonfly', name: 'Dragonfly', tier: 'limit', exposedTier: 'half_limit',
    test: pool => {
      const c = counts(pool);
      if (!takeEachDragon(c)) return false;
      for (const suit of SUITS) if (!takeMeldFromSet(c, run(suit, 1, 9))) return false;
      return takePairFromSet(c, Object.keys(c).filter(isSuited)) && empty(c);
    },
  },
  {
    key: 'green_jade', name: 'Green Jade', tier: 'limit', concealedOnly: false,
    test: pool => {
      const c = counts(pool);
      if (!takeMeld(c, 'GD')) return false;
      let pungs = 0;
      for (let n = 1; n <= 9; n++) if (takeMeld(c, tile(n, 'B'))) pungs++;
      return pungs === 3 && takePairFromSet(c, run('B', 1, 9)) && empty(c);
    },
  },
  {
    key: 'red_coral', name: 'Red Coral', tier: 'limit', concealedOnly: false,
    test: pool => {
      const c = counts(pool);
      if (!takeMeld(c, 'RD')) return false;
      let pungs = 0;
      for (let n = 1; n <= 9; n++) if (takeMeld(c, tile(n, 'C'))) pungs++;
      return pungs === 3 && takePairFromSet(c, run('C', 1, 9)) && empty(c);
    },
  },
  {
    key: 'white_opal', name: 'White Opal', tier: 'limit', concealedOnly: false,
    test: pool => {
      const c = counts(pool);
      if (!takeMeld(c, 'WD')) return false;
      let pungs = 0;
      for (let n = 1; n <= 9; n++) if (takeMeld(c, tile(n, 'D'))) pungs++;
      return pungs === 3 && takePairFromSet(c, run('D', 1, 9)) && empty(c);
    },
  },
  {
    key: 'three_great_scholars', name: 'Three Great Scholars', tier: 'middle_limit', concealedOnly: false,
    test: pool => {
      const base = counts(pool);
      if (!takeEachDragonMeld(base)) return false;
      for (const t of Object.keys(base)) {
        const c = { ...base };
        if (takeMeld(c, t) && takePairFromSet(c, Object.keys(c)) && empty(c)) return true;
      }
      for (const suit of SUITS) {
        const c = { ...base };
        if (takeRunAnywhere(c, suit) && takePairFromSet(c, Object.keys(c)) && empty(c)) return true;
      }
      return false;
    },
  },
  {
    key: 'ruby_jade', name: 'Ruby Jade', tier: 'limit', concealedOnly: false,
    test: pool => {
      const c = counts(pool);
      return takeMeld(c, 'RD') && takeMeld(c, 'GD')
        && takeMeldFromSet(c, RED_BAMBOO_NUMBERS.map(n => tile(n, 'B')))
        && takeMeldFromSet(c, GREEN_BAMBOO_NUMBERS.map(n => tile(n, 'B')))
        && takePairFromSet(c, run('B', 1, 9)) && empty(c);
    },
  },
  {
    key: 'red_lily', name: 'Red Lily', tier: 'double_limit', concealedOnly: false,
    test: pool => {
      const c = counts(pool);
      if (!takeMeld(c, 'RD') || !takeMeld(c, 'WD')) return false;
      let pungs = 0;
      for (const n of RED_BAMBOO_NUMBERS) if (takeMeld(c, tile(n, 'B'))) pungs++;
      return pungs === 2 && takePairFromSet(c, RED_BAMBOO_NUMBERS.map(n => tile(n, 'B'))) && empty(c);
    },
  },
  {
    key: 'royal_ruby', name: 'Royal Ruby', tier: 'double_limit', concealedOnly: false,
    test: pool => {
      const c = counts(pool);
      if (!takeMeld(c, 'RD')) return false;
      let pungs = 0;
      for (const n of RED_BAMBOO_NUMBERS) if (takeMeld(c, tile(n, 'B'))) pungs++;
      return pungs === 3 && takePairFromSet(c, RED_BAMBOO_NUMBERS.map(n => tile(n, 'B'))) && empty(c);
    },
  },
  {
    key: 'imperial_jade', name: 'Imperial Jade', tier: 'double_limit', concealedOnly: false,
    test: pool => {
      const c = counts(pool);
      if (!takeMeld(c, 'GD')) return false;
      let pungs = 0;
      for (const n of GREEN_BAMBOO_NUMBERS) if (takeMeld(c, tile(n, 'B'))) pungs++;
      return pungs === 3 && takePairFromSet(c, GREEN_BAMBOO_NUMBERS.map(n => tile(n, 'B'))) && empty(c);
    },
  },
  {
    key: 'lily_of_the_valley', name: 'Lily of the Valley', tier: 'double_limit', concealedOnly: false,
    test: pool => {
      const c = counts(pool);
      if (!takeMeld(c, 'GD') || !takeMeld(c, 'WD')) return false;
      let pungs = 0;
      for (const n of GREEN_BAMBOO_NUMBERS) if (takeMeld(c, tile(n, 'B'))) pungs++;
      return pungs === 2 && takePairFromSet(c, GREEN_BAMBOO_NUMBERS.map(n => tile(n, 'B'))) && empty(c);
    },
  },
  {
    key: 'lillypilly', name: 'Lillypilly', tier: 'limit', concealedOnly: false,
    test: pool => {
      const c = counts(pool);
      if (!takeMeld(c, 'GD') || !takePair(c, 'WD')) return false;
      let pungs = 0;
      for (let n = 1; n <= 9; n++) if (takeMeld(c, tile(n, 'D'))) pungs++;
      return pungs === 3 && takePairFromSet(c, run('D', 1, 9)) && empty(c);
    },
  },
  {
    key: 'red_waratah', name: 'Red Waratah', tier: 'limit', concealedOnly: false,
    test: pool => {
      const c = counts(pool);
      if (!takeMeld(c, 'RD') || !takePair(c, 'GD')) return false;
      for (const suit of SUITS) {
        if (!takeMeldFromSet(c, RED_BAMBOO_NUMBERS.map(n => tile(n, suit)))) return false;
      }
      return empty(c);
    },
  },
  // ---- Winds and/or Dragons with suits ----
  {
    key: 'unique_wonder', name: 'Unique Wonder', tier: 'double_limit',
    test: pool => {
      const c = counts(pool);
      const req = [];
      for (const suit of SUITS) {
        req.push(tile(1, suit), tile(9, suit));
        if (!take(c, tile(1, suit)) || !take(c, tile(9, suit))) return false;
      }
      if (!takeEachWind(c)) return false;
      if (!takeEachDragon(c)) return false;
      req.push(...WINDS, ...DRAGONS);
      return takeAnyDup(c, req) && empty(c);
    },
  },
  {
    key: 'sunrise', name: 'Sunrise', tier: 'limit', exposedTier: 'half_limit',
    test: pool => {
      const c = counts(pool);
      if (!takeMeld(c, 'EW') || !takePair(c, 'WD')) return false;
      for (const suit of SUITS) if (!takeMeldFromSet(c, run(suit, 2, 8))) return false;
      return empty(c);
    },
  },
  {
    key: 'sunset', name: 'Sunset', tier: 'limit', exposedTier: 'half_limit',
    test: pool => {
      const c = counts(pool);
      if (!takeMeld(c, 'WW') || !takePair(c, 'RD')) return false;
      for (const suit of SUITS) if (!takeMeldFromSet(c, run(suit, 2, 8))) return false;
      return empty(c);
    },
  },
  {
    key: 'numbers_in_parallel', name: 'Numbers in Parallel', tier: 'middle_limit', concealedOnly: false,
    test: pool => {
      const c = counts(pool);
      if (!(takeMeldFromSet(c, [...WINDS, ...DRAGONS]) && takePairFromSet(c, [...WINDS, ...DRAGONS]))) return false;
      for (let n = 2; n <= 8; n++) {
        const c2 = { ...c };
        if (SUITS.every(s => takeMeld(c2, tile(n, s))) && empty(c2)) return true;
      }
      return false;
    },
  },
  {
    key: 'heads_and_tails', name: 'Heads and Tails', tier: 'limit', concealedOnly: false,
    test: pool => {
      const c = counts(pool);
      const termini = SUITS.flatMap(s => [tile(1, s), tile(9, s)]);
      let pungs = 0;
      for (const t of termini) if (takeMeld(c, t)) pungs++;
      return pungs === 4 && takePairFromSet(c, termini) && empty(c);
    },
  },
];

// ---------- Public API ----------
// Returns every SPECIAL_HANDS entry that matches this pool, given the exposed
// melds actually on the table (used to gate concealed-only hands and to pick
// exposedTier vs tier). `ctx` carries per-player info some hands need: `ownWind`
// (own seat wind tile) and `selfDraw` (whether the winning tile was drawn, not
// claimed — combined with exposed.length===0 this means every tile in the hand
// came from the wall, since claiming is the only other way tiles enter a hand).
export function matchSpecialHands(hand, exposed, winningTile, ctx = {}) {
  const pool = [...hand, winningTile, ...exposed.flatMap(s => s.tiles)];
  const hasExposed = exposed.length > 0;
  const matches = [];
  for (const entry of SPECIAL_HANDS) {
    if (hasExposed && entry.concealedOnly !== false && !entry.exposedTier) continue;
    if (entry.requireAllSelfDrawn && !ctx.selfDraw) continue;
    let ok;
    try { ok = entry.test(pool, ctx); } catch { ok = false; }
    if (!ok) continue;
    const tier = hasExposed && entry.exposedTier ? entry.exposedTier : entry.tier;
    matches.push({ key: entry.key, name: entry.name, tier, rank: TIER_RANK[tier] });
  }
  matches.sort((a, b) => b.rank - a.rank);
  return matches;
}

export const constants = { DRAGON_SUIT, GREEN_BAMBOO_NUMBERS, RED_BAMBOO_NUMBERS };
