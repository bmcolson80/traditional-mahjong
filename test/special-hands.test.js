import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../game.js';
import { TIER_CHIPS, TIER_FISHING_CHIPS } from '../special-hands.js';

// Each case: [name, full 14-tile hand (last tile is the winning tile), expectedKey, expectedTier, ctx?]
const CASES = [
  ['Red Lantern', ['1D','2D','3D','4D','5D','6D','7D','2D','RD','RD','RD','EW','EW','EW'], 'red_lantern', 'double_limit', { ownWind: 'EW' }],
  ['Golden Gates', ['2B','2B','4B','4B','6B','6B','8B','8B','1B','1B','1B','GD','GD','GD'], 'golden_gates', 'limit'],
  ['Civil War', ['NW','NW','NW','SW','SW','SW','1C','1C','6C','8C','1D','5D','6D','8D'], 'civil_war', 'middle_limit'],
  // "At least one Pair of Green Dragons" + "Five OR SIX Pairs of Green Bamboos"
  // — the reference sheet's other valid shape: all 4 GD (2 pairs) + 5 bamboo pairs.
  ['All Pair Jade (4 Green Dragons variant)', ['GD','GD','GD','2B','2B','3B','3B','4B','4B','6B','6B','8B','8B','GD'], 'all_pair_jade', 'limit'],
  // "Pairs of 1s & 9s only, Winds & Dragons only, or all combined" — a mix of
  // terminal pairs and a single wind pair, not literally all 7 honor types.
  ['All Pair Honours (terminals mixed with a wind)', ['1B','1B','9B','9B','9D','9D','1C','1C','9C','9C','WW','WW','EW','EW'], 'all_pair_honours', 'limit'],
  ['Wriggly Snake', ['1D','2D','3D','4D','5D','6D','7D','8D','9D','EW','SW','WW','NW','EW'], 'wriggly_snake', 'limit'],
  ['Gates of Heaven', ['2D','3D','4D','5D','6D','7D','8D','2D','1D','1D','1D','9D','9D','9D'], 'gates_of_heaven', 'limit'],
  ['Confused Gates', ['2D','3D','4D','5D','6D','7D','8D','2D','1B','1B','1B','9C','9C','9C'], 'confused_gates', 'limit'],
  ['Run, Pung and Pair', ['1D','2D','3D','4D','5D','6D','7D','8D','9D','2D','2D','2D','3D','3D'], 'run_pung_pair', 'limit'],
  ['Heavenly Twins', ['1D','1D','3D','3D','4D','4D','5D','5D','6D','6D','8D','8D','9D','9D'], 'heavenly_twins', 'limit'],
  ['Five Odd Honours', ['1D','2D','3D','5D','6D','7D','8D','9D','EW','GD','NW','WD','WW','4D'], 'five_odd_honours', 'half_limit'],
  ['Wriggly Dragon', ['1D','2D','3D','4D','5D','6D','7D','8D','9D','RD','GD','WD','WD','WD'], 'wriggly_dragon', 'limit'],
  ['Windfall', ['EW','SW','WW','NW','1D','1D','3D','3D','5D','5D','7D','7D','9D','9D'], 'windfall', 'limit'],
  ['All Pair Honours', ['EW','EW','SW','SW','WW','WW','NW','NW','RD','RD','GD','GD','WD','WD'], 'all_pair_honours', 'limit'],
  ['All Pair Jade', ['GD','GD','2B','2B','3B','3B','4B','4B','4B','4B','6B','6B','8B','8B'], 'all_pair_jade', 'limit'],
  ['Ruby Jade', ['RD','RD','RD','GD','GD','GD','1B','1B','1B','2B','2B','2B','3B','3B'], 'ruby_jade', 'limit'],
  ['Three Great Scholars', ['RD','RD','RD','GD','GD','GD','WD','WD','WD','1D','1D','1D','2B','2B'], 'three_great_scholars', 'middle_limit'],
  ['Windy Chow', ['4D','5D','6D','4B','5B','6B','4C','5C','6C','EW','SW','WW','NW','EW'], 'windy_chow', 'half_limit'],
  ['Chop Suey', ['1D','2D','3D','1B','2B','3B','1C','2C','3C','EW','SW','WW','NW','EW'], 'chop_suey', 'limit'],
  ['Knitting', ['1D','1B','2D','2B','4D','4B','5D','5B','7D','7B','8D','8B','9D','9B'], 'knitting', 'half_limit'],
  // The reference sheet's own worked example repeats a number across two of the
  // seven pairs (1,2,2,4,5,7,8) — Knitting only requires each pair to match
  // across the two suits, not that all seven numbers be distinct from each other.
  ['Knitting with a repeated number', ['1B','1C','2B','2C','3B','3C','6B','6C','7B','7C','8B','8B','8C','8C'], 'knitting', 'half_limit'],
  ['Triple Knitting', ['1D','1B','1C','2D','2B','2C','3D','3B','3C','4D','4B','4C','5D','5B'], 'triple_knitting', 'half_limit'],
  ["Sparrow's Sanctuary", ['1B','1B','1B','1B','2B','2B','3B','3B','4B','4B','6B','6B','8B','8B'], 'sparrows_sanctuary', 'middle_limit'],
  ['Windy Ones', ['EW','SW','WW','NW','EW','1D','1D','1D','1B','1B','1B','1C','1C','1C'], 'windy_ones', 'limit'],
  ['Windvane', ['EW','SW','WW','NW','EW','2D','2D','2D','3B','3B','3B','4C','4C','4C'], 'windvane', 'limit'],
  ['Dragon\'s Breath', ['1D','1D','3D','3D','5D','5D','7D','7D','9D','9D','RD','GD','WD','RD'], 'dragons_breath', 'limit'],
  ['Windy Dragons', ['EW','EW','SW','SW','WW','WW','NW','NW','RD','RD','RD','GD','GD','GD'], 'windy_dragons', 'limit'],
  ['Dragonfly', ['RD','GD','WD','1D','1D','1D','1B','1B','1B','1C','1C','1C','2D','2D'], 'dragonfly', 'limit'],
  ['Unique Wonder', ['1D','9D','1B','9B','1C','9C','EW','SW','WW','NW','RD','GD','WD','EW'], 'unique_wonder', 'double_limit'],
  ['Sunrise', ['EW','EW','EW','WD','WD','2D','2D','2D','3B','3B','3B','4C','4C','4C'], 'sunrise', 'limit'],
  ['Sunset', ['WW','WW','WW','RD','RD','2D','2D','2D','3B','3B','3B','4C','4C','4C'], 'sunset', 'limit'],
  ['Heads and Tails', ['1D','1D','1D','9D','9D','9D','1B','1B','1B','9C','9C','9C','1C','1C'], 'heads_and_tails', 'limit'],
];

describe('special-hands catalog: representative hands are recognized', () => {
  for (const [name, full14, expectKey, expectTier, ctx] of CASES) {
    test(`${name} is recognized as a valid win at the right tier`, () => {
      const winningTile = full14[full14.length - 1];
      const hand = full14.slice(0, -1);
      const win = G.checkWin(hand, [], winningTile, ctx);
      assert.equal(win.win, true, `${name} should be a valid win`);
      assert.equal(win.type, `special:${expectKey}`);
      assert.equal(win.tier, expectTier);
    });
  }
});

describe('special-hands catalog: near-misses do not false-positive', () => {
  test('a duplicated honor tile breaks Five Odd Honours / Wriggly Snake (needs 5 distinct, not 4+dup)', () => {
    const hand = ['1D','2D','3D','4D','5D','6D','7D','8D','EW','EW','GD','NW','WD'];
    const win = G.checkWin(hand, [], '9D');
    assert.equal(win.win, false);
  });

  test('a run spanning two suits breaks any pure-run special hand', () => {
    const hand = ['1D','2D','3D','4D','5D','6D','7D','8B','EW','GD','NW','WD','WW'];
    const win = G.checkWin(hand, [], '9D');
    assert.equal(win.win, false);
  });

  test('seven pairs across mixed suits is still a plain win, not mistaken for a same-suit special hand', () => {
    const hand = ['1D','1D','2B','2B','3C','3C','4D','4D','5B','5B','6C','6C','7D'];
    const win = G.checkWin(hand, [], '7D');
    assert.equal(win.win, true);
    assert.equal(win.type, 'seven_pairs');
  });

  test("Sparrow's Sanctuary only counts in Bamboo, not the same shape in another suit", () => {
    const hand = ['1D','1D','1D','2D','2D','3D','3D','4D','4D','6D','6D','8D'];
    const win = G.checkWin(hand, [], '8D');
    assert.notEqual(win.type, 'special:sparrows_sanctuary');
  });

  test('Golden Gates needs the dragon corresponding to the suit, not just any dragon', () => {
    const hand = ['2B','2B','4B','4B','6B','6B','8B','8B','1B','1B','1B','RD','RD'];
    const win = G.checkWin(hand, [], 'RD');
    assert.notEqual(win.type, 'special:golden_gates');
  });

  test('Red Lantern requires the wind to be the player\'s own seat wind', () => {
    const hand = ['1D','2D','3D','4D','5D','6D','7D','2D','RD','RD','RD','EW','EW'];
    const winWrongWind = G.checkWin(hand, [], 'EW', { ownWind: 'SW' });
    assert.notEqual(winWrongWind.type, 'special:red_lantern');
    const winNoCtx = G.checkWin(hand, [], 'EW');
    assert.notEqual(winNoCtx.type, 'special:red_lantern');
  });
});

describe('special-hands catalog: Chow Chow requires an entirely self-drawn hand', () => {
  // Bamboo suit (not Circles), so this doesn't also collide with Moon at Bottom
  // of Well (which specifically requires the Circle suit).
  const chowChowHand = ['1B','2B','3B','4B','5B','6B','7B','8B','9B','1B','2B','3B','1B','1B'];

  test('matches Chow Chow when self-drawn', () => {
    const winningTile = chowChowHand[chowChowHand.length - 1];
    const hand = chowChowHand.slice(0, -1);
    const win = G.checkWin(hand, [], winningTile, { selfDraw: true });
    assert.equal(win.type, 'special:chow_chow');
  });

  test('does not credit Chow Chow specifically when the winning tile was claimed off a discard', () => {
    const winningTile = chowChowHand[chowChowHand.length - 1];
    const hand = chowChowHand.slice(0, -1);
    const win = G.checkWin(hand, [], winningTile, { selfDraw: false });
    assert.notEqual(win.type, 'special:chow_chow');
  });
});

describe('special-hands catalog: own-wind-dependent hands need ctx.ownWind', () => {
  test('Hovering Angel matches only when ownWind is supplied and present in the hand', () => {
    const hand = ['1D','2D','3D','1B','2B','3B','1C','2C','3C','NW','NW','NW','RD'];
    const winningTile = 'RD';
    const withCtx = G.checkWin(hand, [], winningTile, { ownWind: 'NW' });
    assert.equal(withCtx.type, 'special:hovering_angel');
    const withoutCtx = G.checkWin(hand, [], winningTile);
    assert.notEqual(withoutCtx.type, 'special:hovering_angel');
  });
});

describe('special-hands scoring: tiers map onto the chip economy correctly', () => {
  test('every tier chip value matches TIER_CHIPS', () => {
    for (const [name, full14, , expectTier, ctx] of CASES) {
      const winningTile = full14[full14.length - 1];
      const hand = full14.slice(0, -1);
      const win = G.checkWin(hand, [], winningTile, ctx);
      const score = G.scoreHand({}, [], hand, winningTile, {
        handType: win.type, tier: win.tier, specialName: win.specialName,
      });
      assert.equal(score.chips, TIER_CHIPS[expectTier], `${name} should score ${TIER_CHIPS[expectTier]} chips`);
    }
  });

  test('a fished win scores the reduced Fishing value instead of the full Winning value', () => {
    const full14 = ['1D','2D','3D','4D','5D','6D','7D','8D','9D','EW','SW','WW','NW','EW'];
    const winningTile = full14[full14.length - 1];
    const hand = full14.slice(0, -1);
    const win = G.checkWin(hand, [], winningTile);
    const normalScore = G.scoreHand({}, [], hand, winningTile, { handType: win.type, tier: win.tier, specialName: win.specialName, isFishing: false });
    const fishedScore = G.scoreHand({}, [], hand, winningTile, { handType: win.type, tier: win.tier, specialName: win.specialName, isFishing: true });
    assert.equal(normalScore.chips, TIER_CHIPS.limit);
    assert.equal(fishedScore.chips, TIER_FISHING_CHIPS.limit);
    assert.ok(fishedScore.chips < normalScore.chips, 'fishing score must be lower than the full winning score');
  });
});

describe('special-hands: All Honour fan bonus on the generic standard-hand path', () => {
  test('four pungs of terminals/honors + a pair of terminals/honors scores the All Honour bonus on top of All Pungs', () => {
    const exposed = [
      { type: 'pung', tiles: ['EW', 'EW', 'EW'] },
      { type: 'pung', tiles: ['1D', '1D', '1D'] },
      { type: 'pung', tiles: ['9B', '9B', '9B'] },
    ];
    const concealed = ['RD', 'RD', '1C', '1C'];
    const score = G.scoreHand({}, exposed, concealed, '1C', { selfDraw: false, handType: 'standard' });
    assert.ok(score.breakdown.includes('All Pungs'));
    assert.ok(score.breakdown.includes('All Honour'), `expected All Honour in ${JSON.stringify(score.breakdown)}`);
  });

  test('four pungs that include a non-terminal, non-honor tile do NOT get the All Honour bonus', () => {
    const exposed = [
      { type: 'pung', tiles: ['EW', 'EW', 'EW'] },
      { type: 'pung', tiles: ['5D', '5D', '5D'] }, // 5 is not a terminal
      { type: 'pung', tiles: ['9B', '9B', '9B'] },
    ];
    const concealed = ['RD', 'RD', '1C', '1C'];
    const score = G.scoreHand({}, exposed, concealed, '1C', { selfDraw: false, handType: 'standard' });
    assert.ok(score.breakdown.includes('All Pungs'));
    assert.ok(!score.breakdown.includes('All Honour'));
  });
});
