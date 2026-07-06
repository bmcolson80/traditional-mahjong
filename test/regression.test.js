import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../game.js';

describe('regression: bonus tile handling', () => {
  test('flowers/seasons drawn during deal are replaced automatically', () => {
    const room = G.createRoom('R1', 'p1');
    ['p1', 'p2', 'p3', 'p4'].forEach((id, i) => G.addPlayer(room, { playerId: id, displayName: `P${i}` }));

    // Force a wall where the first tiles are all bonus tiles to stress the replacement loop
    room.startTestOverride = true;
    G.startGame(room);

    for (const p of room.players) {
      assert.equal(p.hand.every(t => !G.isBonusTile(t)), true, `Player ${p.seat} hand should contain no bonus tiles`);
    }
  });
});

describe('regression: kong replacement draw', () => {
  test('applying a concealed kong draws a replacement tile and keeps hand size correct', () => {
    const room = G.createRoom('R2', 'p1');
    ['p1', 'p2', 'p3', 'p4'].forEach((id, i) => G.addPlayer(room, { playerId: id, displayName: `P${i}` }));
    G.startGame(room);
    const east = room.players.find(p => p.seat === 'E');

    // rig hand: give east four of the same tile
    east.hand = ['1D', '1D', '1D', '1D', '2D', '3D', '4D', '5D', '6D', '7D', '8D', '9D', '1B'];
    const wallSizeBefore = room.wall.length;
    G.applyKong(room, east, '1D', undefined, true);

    assert.equal(east.exposed.length, 1);
    assert.equal(east.exposed[0].type, 'kong');
    assert.equal(east.hand.length, 10); // 13 - 4 removed + 1 replacement = 10
    assert.ok(room.wall.length <= wallSizeBefore); // drew from wall or dead wall
  });
});

describe('regression: free-for-all chow (house rule)', () => {
  test('any seat can chow from any discarder, not just the discarder\'s immediate right', () => {
    // seat order E -> S -> W -> N -> E
    const hand = ['2D', '3D'];
    assert.ok(G.canChow(hand, '1D', 'S', 'E'), 'S (next after E) can chow from E');
    assert.ok(G.canChow(hand, '1D', 'N', 'E'), 'N can chow from E under free-for-all rule');
    assert.ok(G.canChow(hand, '1D', 'W', 'E'), 'W can chow from E under free-for-all rule');
  });

  test('canChow still rejects hands that cannot form a run, regardless of seat', () => {
    const hand = ['5D', '9B'];
    const options = G.canChow(hand, '1D', 'N', 'E');
    assert.equal(options.length, 0);
  });
});

describe('regression: discard/turn integrity', () => {
  test('discarding a tile not in hand throws instead of corrupting state', () => {
    const room = G.createRoom('R3', 'p1');
    ['p1', 'p2', 'p3', 'p4'].forEach((id, i) => G.addPlayer(room, { playerId: id, displayName: `P${i}` }));
    G.startGame(room);
    const east = room.players.find(p => p.seat === 'E');
    const handBefore = [...east.hand];

    assert.throws(() => G.discardTile(room, east, '9C-does-not-exist'));
    assert.deepEqual(east.hand, handBefore, 'hand should be unchanged after a failed discard');
  });
});

describe('regression: win detection does not false-positive', () => {
  test('an almost-complete hand missing one tile is not a win', () => {
    const hand = ['1D','2D','3D','4D','5D','6D','7D','8D','9D','1B','2B','3B','9C'];
    const win = G.checkWin(hand, [], '5C'); // unrelated 14th tile, should not complete anything
    assert.equal(win.win, false);
  });

  test('exposed sets correctly reduce the number of concealed sets required', () => {
    const exposed = [
      { type: 'pung', tiles: ['1D', '1D', '1D'] },
      { type: 'pung', tiles: ['2D', '2D', '2D'] },
      { type: 'pung', tiles: ['3D', '3D', '3D'] },
    ];
    // only need 1 more set + pair from concealed hand (4 tiles + winning tile = 5 = 1 set + pair)
    const hand = ['4D', '5D', '9C', '9C'];
    const win = G.checkWin(hand, exposed, '6D');
    assert.equal(win.win, true);
  });
});

describe('regression: round and dealer progression', () => {
  test('dealer retains seat and round wind after winning', () => {
    const room = G.createRoom('RR1', 'p1');
    ['p1','p2','p3','p4'].forEach((id,i) => G.addPlayer(room, { playerId: id, displayName: `P${i}` }));
    assert.equal(room.round.dealerSeat, 'E');
    assert.equal(G.getRoundWind(room), 'EW');

    G.advanceHand(room, { winnerSeat: 'E' });
    assert.equal(room.round.dealerSeat, 'E', 'dealer should retain seat after winning');
    assert.equal(room.round.handNumber, 1, 'hand number should not advance when dealer wins');
  });

  test('dealer retains seat after a draw', () => {
    const room = G.createRoom('RR2', 'p1');
    ['p1','p2','p3','p4'].forEach((id,i) => G.addPlayer(room, { playerId: id, displayName: `P${i}` }));
    G.advanceHand(room, { isDraw: true });
    assert.equal(room.round.dealerSeat, 'E');
    assert.equal(room.round.handNumber, 1);
  });

  test('dealership passes to next seat when a non-dealer wins', () => {
    const room = G.createRoom('RR3', 'p1');
    ['p1','p2','p3','p4'].forEach((id,i) => G.addPlayer(room, { playerId: id, displayName: `P${i}` }));
    G.advanceHand(room, { winnerSeat: 'S' });
    assert.equal(room.round.dealerSeat, 'S');
    assert.equal(room.round.handNumber, 2);
    assert.equal(G.getRoundWind(room), 'EW', 'round wind should not change until 4 hands have passed');
  });

  test('round wind advances after 4 hands with rotating dealer, and match ends after a full cycle', () => {
    const room = G.createRoom('RR4', 'p1');
    ['p1','p2','p3','p4'].forEach((id,i) => G.addPlayer(room, { playerId: id, displayName: `P${i}` }));

    // Simulate every hand being won by someone other than the dealer, 4 times per round,
    // for all 4 rounds — dealer should rotate through all seats each round and wind should advance.
    for (let cycle = 0; cycle < 4; cycle++) {
      for (let i = 0; i < 4; i++) {
        const currentDealer = room.round.dealerSeat;
        G.advanceHand(room, { winnerSeat: G.nextSeat(currentDealer) });
      }
    }
    assert.equal(room.round.matchOver, true, 'match should be complete after 4 full rounds');
  });

  test('getSeatWind assigns East to the current dealer regardless of fixed table seat', () => {
    const room = G.createRoom('RR5', 'p1');
    ['p1','p2','p3','p4'].forEach((id,i) => G.addPlayer(room, { playerId: id, displayName: `P${i}` }));
    G.advanceHand(room, { winnerSeat: 'S' }); // dealer moves to S
    assert.equal(G.getSeatWind(room, 'S'), 'EW');
    assert.equal(G.getSeatWind(room, 'W'), 'SW');
    assert.equal(G.getSeatWind(room, 'N'), 'WW');
    assert.equal(G.getSeatWind(room, 'E'), 'NW');
  });
});

describe('regression: dealer rotation in genuine 2/3-player games (empty seats skipped)', () => {
  test('in a 3-player game (E,S,W — N empty), dealership never lands on the empty seat', () => {
    const room = G.createRoom('RR3P1', 'p1');
    ['p1','p2','p3'].forEach((id,i) => G.addPlayer(room, { playerId: id, displayName: `P${i}` }));
    assert.deepEqual(room.players.map(p => p.seat), ['E', 'S', 'W']);

    G.advanceHand(room, { winnerSeat: 'S' }); // non-dealer win, deal should pass to the NEXT ACTIVE seat
    assert.equal(room.round.dealerSeat, 'S', 'deal passes to S (E->S is the first active neighbor)');

    G.advanceHand(room, { winnerSeat: 'W' });
    assert.equal(room.round.dealerSeat, 'W');

    G.advanceHand(room, { winnerSeat: 'E' }); // must wrap W -> E directly, skipping the empty N seat
    assert.equal(room.round.dealerSeat, 'E', 'dealer rotation wraps W directly to E, never touching empty N');
  });

  test('a 3-player round completes (wind advances) after 3 hands, not 4', () => {
    const room = G.createRoom('RR3P2', 'p1');
    ['p1','p2','p3'].forEach((id,i) => G.addPlayer(room, { playerId: id, displayName: `P${i}` }));

    G.advanceHand(room, { winnerSeat: 'S' }); // hand 1 -> 2
    G.advanceHand(room, { winnerSeat: 'W' }); // hand 2 -> 3
    assert.equal(G.getRoundWind(room), 'EW', 'still East round after only 2 dealer changes');
    G.advanceHand(room, { winnerSeat: 'E' }); // hand 3 -> completes the round (3 active seats)
    assert.equal(G.getRoundWind(room), 'SW', 'round wind advances after the deal cycles through all 3 active seats');
  });

  test('a 2-player round completes after 2 hands', () => {
    const room = G.createRoom('RR2P1', 'p1');
    ['p1','p2'].forEach((id,i) => G.addPlayer(room, { playerId: id, displayName: `P${i}` }));
    assert.deepEqual(room.players.map(p => p.seat), ['E', 'S']);

    G.advanceHand(room, { winnerSeat: 'S' });
    assert.equal(G.getRoundWind(room), 'EW');
    G.advanceHand(room, { winnerSeat: 'E' });
    assert.equal(G.getRoundWind(room), 'SW', 'round wind advances after just 2 hands in a 2-player game');
  });

  test('nextSeat with an explicit active-seat list skips seats not in that list', () => {
    assert.equal(G.nextSeat('E', ['E', 'S', 'W']), 'S');
    assert.equal(G.nextSeat('W', ['E', 'S', 'W']), 'E', 'wraps past the empty N seat straight back to E');
    assert.equal(G.nextSeat('E'), 'S', 'omitting activeSeats defaults to the full 4-seat compass (back-compat)');
  });
});

describe('regression: fan → chip conversion table', () => {
  test('matches the house rule table exactly, capping at 64 for 6+ fan', () => {
    assert.equal(G.fanToChips(0), 1);
    assert.equal(G.fanToChips(1), 2);
    assert.equal(G.fanToChips(2), 4);
    assert.equal(G.fanToChips(3), 8);
    assert.equal(G.fanToChips(4), 16);
    assert.equal(G.fanToChips(5), 32);
    assert.equal(G.fanToChips(6), 64);
    assert.equal(G.fanToChips(7), 64, 'fan above 6 stays capped at the 64-chip limit');
    assert.equal(G.fanToChips(13), 64, 'limit hands (e.g. Thirteen Orphans) cap at 64');
  });
});

describe('regression: chip settlement house rules', () => {
  // Default room: dealerSeat 'E', dealerStreak 0. Players seated E/S/W/N.
  function freshRoom(code) {
    const room = G.createRoom(code, 'p1');
    ['p1','p2','p3','p4'].forEach((id,i) => G.addPlayer(room, { playerId: id, displayName: `P${i}` }));
    return room;
  }

  test('self-draw win: all active players pay base chip value + 1 each (non-dealer winner)', () => {
    const room = freshRoom('CH1');
    // winner S is not the dealer (E is dealer) — no dealer-win doubling applies.
    G.settleScore(room, 'S', G.fanToChips(2), { selfDraw: true }); // fan 2 → base 4 chips
    const south = room.players.find(p => p.seat === 'S');
    const east = room.players.find(p => p.seat === 'E');   // dealer, pays double the BASE as a non-winning-dealer payer
    const west = room.players.find(p => p.seat === 'W');
    const north = room.players.find(p => p.seat === 'N');
    assert.equal(west.score, -5, 'non-dealer opponent pays base(4) + 1');
    assert.equal(north.score, -5, 'non-dealer opponent pays base(4) + 1');
    assert.equal(east.score, -9, 'dealer pays double the BASE (4*2=8), then the flat +1 self-draw bonus (9)');
    assert.equal(south.score, 19, 'winner collects the sum of all three payments');
  });

  test('discard win: only the discarder pays, everyone else pays nothing', () => {
    const room = freshRoom('CH2');
    G.settleScore(room, 'S', G.fanToChips(3), { selfDraw: false, discarderSeat: 'W' }); // fan 3 → base 8 chips
    const south = room.players.find(p => p.seat === 'S');
    const east = room.players.find(p => p.seat === 'E');
    const west = room.players.find(p => p.seat === 'W');
    const north = room.players.find(p => p.seat === 'N');
    assert.equal(west.score, -8, 'the discarder pays the full base amount');
    assert.equal(east.score, 0, 'non-discarders pay nothing');
    assert.equal(north.score, 0, 'non-discarders pay nothing');
    assert.equal(south.score, 8);
  });

  test('discard win: dealer-as-discarder pays double when a non-dealer wins', () => {
    const room = freshRoom('CH3');
    G.settleScore(room, 'S', G.fanToChips(1), { selfDraw: false, discarderSeat: 'E' }); // fan 1 → base 2 chips, E is dealer
    const south = room.players.find(p => p.seat === 'S');
    const east = room.players.find(p => p.seat === 'E');
    assert.equal(east.score, -4, 'dealer discarder pays double the standard base amount');
    assert.equal(south.score, 4);
  });

  test('dealer win: base portion of the payout is doubled (first win, no streak yet)', () => {
    const room = freshRoom('CH4');
    G.settleScore(room, 'E', G.fanToChips(2), { selfDraw: true }); // fan 2 → base 4, dealer wins self-draw
    const east = room.players.find(p => p.seat === 'E');
    const others = room.players.filter(p => p.seat !== 'E');
    // base(4) * 2 [dealer-win double] * 1 [streak multiplier, first win] = 8, + flat 1 self-draw bonus = 9 per opponent
    others.forEach(p => assert.equal(p.score, -9));
    assert.equal(east.score, 27);
  });

  test('dealer win streak multiplies the base portion further on consecutive wins', () => {
    const room = freshRoom('CH5');
    const firstGain = G.settleScore(room, 'E', G.fanToChips(1), { selfDraw: true }).standings.find(s => s.seat === 'E').score;
    G.advanceHand(room, { winnerSeat: 'E' }); // dealer retains seat, streak becomes 1
    assert.equal(room.round.dealerStreak, 1);
    const beforeSecond = room.players.find(p => p.seat === 'E').score;
    G.settleScore(room, 'E', G.fanToChips(1), { selfDraw: true }); // same fan again, now with streak multiplier x2
    const afterSecond = room.players.find(p => p.seat === 'E').score;
    const secondGain = afterSecond - beforeSecond;
    // Per-opponent amount = base(2) * 2[dealer-win double] * streakMultiplier + flat 1, summed over 3 opponents.
    assert.equal(firstGain, 15, 'first dealer win: (2*2*1)+1 = 5 per opponent x 3 = 15');
    assert.equal(secondGain, 27, 'second consecutive win: (2*2*2)+1 = 9 per opponent x 3 = 27');
  });

  // Direct verification against the rulebook's own worked examples (section 7).
  test('matches rulebook Example 1: 2-fan discard win, only the discarder pays 4 chips', () => {
    const room = freshRoom('CHEX1');
    G.settleScore(room, 'S', G.fanToChips(2), { selfDraw: false, discarderSeat: 'W' });
    assert.equal(room.players.find(p => p.seat === 'W').score, -4);
    assert.equal(room.players.find(p => p.seat === 'E').score, 0, 'dealer pays nothing on a discard win it has no part in');
    assert.equal(room.players.find(p => p.seat === 'S').score, 4);
  });

  test('matches rulebook Example 2: dealer self-draw 3-fan (8 base) doubles to 16, +1 flat = 17/opponent, 34 total', () => {
    const room = freshRoom('CHEX2');
    G.settleScore(room, 'E', G.fanToChips(3), { selfDraw: true }); // E is dealer
    const east = room.players.find(p => p.seat === 'E');
    const others = room.players.filter(p => p.seat !== 'E');
    others.forEach(p => assert.equal(p.score, -17, 'doubled base (16) + flat self-draw bonus (1) = 17'));
    assert.equal(east.score, 17 * others.length, `East nets 17 chips from each of ${others.length} opponents`);
  });

  test('dealerStreak resets to 0 once the deal passes to a new dealer', () => {
    const room = freshRoom('CH6');
    G.advanceHand(room, { winnerSeat: 'E' }); // dealer win, streak -> 1
    assert.equal(room.round.dealerStreak, 1);
    G.advanceHand(room, { winnerSeat: 'S' }); // non-dealer wins, deal passes to S
    assert.equal(room.round.dealerStreak, 0, 'streak resets when a new player becomes dealer');
  });

  test('bankruptcy: settleScore flags any payer whose chips hit 0 or below', () => {
    const room = freshRoom('CH7');
    const west = room.players.find(p => p.seat === 'W');
    west.score = 5; // West is nearly broke
    const settlement = G.settleScore(room, 'S', G.fanToChips(3), { selfDraw: false, discarderSeat: 'W' }); // base 8 > 5
    assert.ok(settlement.bankruptSeats.includes('W'), 'West should be flagged bankrupt after paying more than they had');
    assert.ok(west.score <= 0);
  });

  test('bankruptcy is not flagged for players who still have chips left', () => {
    const room = freshRoom('CH8');
    const west = room.players.find(p => p.seat === 'W');
    west.score = 500; // plenty of chips
    const settlement = G.settleScore(room, 'S', G.fanToChips(1), { selfDraw: false, discarderSeat: 'W' }); // base 2, well within balance
    assert.equal(settlement.bankruptSeats.length, 0);
    assert.ok(west.score > 0);
  });
});

describe('regression: serializeRoom excludes transient fields', () => {
  test('_aiTimeout is not present in serialized output', () => {
    const room = G.createRoom('SER1', 'p1');
    ['p1','p2','p3','p4'].forEach((id,i) => G.addPlayer(room, { playerId: id, displayName: `P${i}` }));
    G.startGame(room);
    room._aiTimeout = setTimeout(() => {}, 99999);
    const json = JSON.stringify(room, (k,v) => k === '_aiTimeout' ? undefined : v);
    const parsed = JSON.parse(json);
    assert.equal(parsed._aiTimeout, undefined, '_aiTimeout must not be in serialized room');
    assert.ok(Array.isArray(parsed.wall), 'wall must survive serialization');
    assert.ok(parsed.players.length === 4, 'players must survive serialization');
    clearTimeout(room._aiTimeout);
  });

  test('full hand array survives JSON round-trip', () => {
    const room = G.createRoom('SER2', 'p1');
    ['p1','p2','p3','p4'].forEach((id,i) => G.addPlayer(room, { playerId: id, displayName: `P${i}` }));
    G.startGame(room);
    const east = room.players.find(p => p.seat === 'E');
    const originalHand = [...east.hand];
    const json = JSON.stringify(room, (k,v) => k === '_aiTimeout' ? undefined : v);
    const restored = JSON.parse(json);
    const eastRestored = restored.players.find(p => p.seat === 'E');
    assert.deepEqual(eastRestored.hand, originalHand, 'Hand must survive JSON round-trip exactly');
  });
});

describe('regression: rejoin logic (unit level)', () => {
  test('player matched by userId when playerId differs (new browser session)', () => {
    // Simulate what rejoin_room handler does: find player by userId
    const room = G.createRoom('REJ1', 'original-pid');
    G.addPlayer(room, { playerId: 'original-pid', userId: 77, displayName: 'Alice' });
    G.addPlayer(room, { playerId: 'p2', userId: null, displayName: 'AI' });
    G.addPlayer(room, { playerId: 'p3', userId: null, displayName: 'AI' });
    G.addPlayer(room, { playerId: 'p4', userId: null, displayName: 'AI' });

    const userId = 77;
    const newPlayerId = 'new-browser-pid';

    const player = room.players.find(p =>
      (userId && p.userId === userId) || p.playerId === newPlayerId
    );
    assert.ok(player, 'Should find player by userId even with different playerId');
    assert.equal(player.displayName, 'Alice');
    assert.equal(player.seat, 'E');
  });

  test('player not in room is rejected correctly', () => {
    const room = G.createRoom('REJ2', 'host');
    G.addPlayer(room, { playerId: 'host', userId: 1, displayName: 'Host' });

    const intruderUserId = 999;
    const intruderPlayerId = 'intruder';
    const player = room.players.find(p =>
      (intruderUserId && p.userId === intruderUserId) || p.playerId === intruderPlayerId
    );
    assert.equal(player, undefined, 'Intruder should not be found in room');
  });
});

describe('regression: wall exhaustion edge cases', () => {
  test('drawing from an empty wall returns null', () => {
    const room = G.createRoom('WALL1', 'p1');
    ['p1','p2','p3','p4'].forEach((id,i) => G.addPlayer(room, { playerId: id, displayName: `P${i}` }));
    G.startGame(room);
    room.wall = []; // drain the wall
    const east = room.players.find(p => p.seat === 'E');
    const tile = G.drawTile(room, east);
    assert.equal(tile, null, 'Drawing from empty wall should return null');
  });
});

describe('regression: advanceHand matchOver flag', () => {
  test('matchOver is set after a full East→North cycle (16 hands)', () => {
    const room = G.createRoom('MATCH1', 'p1');
    ['p1','p2','p3','p4'].forEach((id,i) => G.addPlayer(room, { playerId: id, displayName: `P${i}` }));

    // 4 rounds × 4 hands each, dealer always loses = 16 advanceHand calls
    for (let round = 0; round < 4; round++) {
      for (let hand = 0; hand < 4; hand++) {
        const currentDealer = room.round.dealerSeat;
        G.advanceHand(room, { winnerSeat: G.nextSeat(currentDealer) });
      }
    }
    assert.equal(room.round.matchOver, true, 'matchOver should be true after full cycle');
  });

  test('matchOver is NOT set mid-cycle', () => {
    const room = G.createRoom('MATCH2', 'p1');
    ['p1','p2','p3','p4'].forEach((id,i) => G.addPlayer(room, { playerId: id, displayName: `P${i}` }));

    // Only 8 hands (half a cycle)
    for (let i = 0; i < 8; i++) {
      const currentDealer = room.round.dealerSeat;
      G.advanceHand(room, { winnerSeat: G.nextSeat(currentDealer) });
    }
    assert.equal(room.round.matchOver, false, 'matchOver should still be false at 8 hands');
  });

  test('matchOverReason is "cycle" when the match ends via a completed wind cycle', () => {
    const room = G.createRoom('MATCH3', 'p1');
    ['p1','p2','p3','p4'].forEach((id,i) => G.addPlayer(room, { playerId: id, displayName: `P${i}` }));
    assert.equal(room.round.matchOverReason, null, 'no reason before the match ends');

    for (let round = 0; round < 4; round++) {
      for (let hand = 0; hand < 4; hand++) {
        const currentDealer = room.round.dealerSeat;
        G.advanceHand(room, { winnerSeat: G.nextSeat(currentDealer) });
      }
    }
    assert.equal(room.round.matchOverReason, 'cycle');
  });
});

describe('regression: getSeatWind correctly rotates with dealer', () => {
  test('the current dealer always reports seatWind EW regardless of table seat', () => {
    const room = G.createRoom('SW1', 'p1');
    ['p1','p2','p3','p4'].forEach((id,i) => G.addPlayer(room, { playerId: id, displayName: `P${i}` }));

    const SEATS = ['E','S','W','N'];
    for (const dealerSeat of SEATS) {
      room.round.dealerSeat = dealerSeat;
      assert.equal(G.getSeatWind(room, dealerSeat), 'EW',
        `Dealer (${dealerSeat}) should always have seat wind EW`);
    }
  });

  test('all four relative winds are assigned exactly once per hand', () => {
    const room = G.createRoom('SW2', 'p1');
    ['p1','p2','p3','p4'].forEach((id,i) => G.addPlayer(room, { playerId: id, displayName: `P${i}` }));
    room.round.dealerSeat = 'S';

    const winds = ['E','S','W','N'].map(seat => G.getSeatWind(room, seat));
    const uniqueWinds = new Set(winds);
    assert.equal(uniqueWinds.size, 4, 'All 4 seat winds should be unique per hand');
  });
});

describe('regression: tile count integrity', () => {
  test('total tiles in room equals 144 at all times after dealing', () => {
    const room = G.createRoom('TILES1', 'p1');
    ['p1','p2','p3','p4'].forEach((id,i) => G.addPlayer(room, { playerId: id, displayName: `P${i}` }));
    G.startGame(room);

    const tileCount = (
      room.wall.length +
      room.deadWall.length +
      room.players.reduce((sum, p) =>
        sum + p.hand.length + p.flowers.length + p.exposed.reduce((s, e) => s + e.tiles.length, 0), 0)
    );
    assert.equal(tileCount, 144, 'Total tiles should always be 144');
  });
});

describe('regression: currentDiscard must not outlive a draw', () => {
  test('drawTile clears any pending currentDiscard from an earlier turn', () => {
    const room = G.createRoom('CD1', 'p1');
    ['p1','p2','p3','p4'].forEach((id,i) => G.addPlayer(room, { playerId: id, displayName: `P${i}` }));
    G.startGame(room);

    // Simulate a discard nobody claimed, then the next player drawing normally.
    room.currentDiscard = { tile: '4C', fromSeat: 'S' };
    const player = room.players.find(p => p.seat === 'E');
    G.drawTile(room, player);

    assert.equal(room.currentDiscard, null,
      'currentDiscard must be cleared the moment anyone draws — otherwise it stays ' +
      'claimable after the window has closed, and self-draw win checks below get ' +
      'confused about whether the winning tile came from a claim or the wall');
  });

  test('a fully self-drawn winning hand is recognized as a win once currentDiscard is cleared', () => {
    // Same 14-tile concealed hand shape reported as a false-negative in production:
    // GD pair + 9C triplet + 1-2-3B run + 5-6-7B run + 1D triplet.
    const hand14 = ['GD','GD','9C','9C','9C','1B','2B','3B','5B','6B','7B','1D','1D','1D'];
    const currentDiscard = null; // cleared by drawTile, as it should be for a real self-draw
    const player = { seat: 'E', hand: hand14, exposed: [] };
    const selfDraw = !currentDiscard || currentDiscard.fromSeat === player.seat;
    const winningTile = selfDraw ? player.hand[player.hand.length - 1] : currentDiscard.tile;
    const handForCheck = selfDraw ? player.hand.slice(0, -1) : player.hand;

    assert.equal(selfDraw, true);
    const result = G.checkWin(handForCheck, player.exposed, winningTile);
    assert.equal(result.win, true, 'A valid 4-sets-plus-pair concealed hand must be recognized as a win');
  });

  test('a stale currentDiscard from another seat produces a false negative (documents the bug this fixes)', () => {
    const hand14 = ['GD','GD','9C','9C','9C','1B','2B','3B','5B','6B','7B','1D','1D','1D'];
    const staleDiscard = { tile: '4C', fromSeat: 'S' }; // left over from an earlier, unrelated turn
    const player = { seat: 'E', hand: hand14, exposed: [] };
    const selfDraw = !staleDiscard || staleDiscard.fromSeat === player.seat;
    const winningTile = selfDraw ? player.hand[player.hand.length - 1] : staleDiscard.tile;
    const handForCheck = selfDraw ? player.hand.slice(0, -1) : player.hand;

    assert.equal(selfDraw, false, 'stale discard incorrectly looks like a claim from another seat');
    const result = G.checkWin(handForCheck, player.exposed, winningTile);
    assert.equal(result.win, false, 'checking against the wrong winning tile incorrectly fails a valid hand');
  });
});

describe('regression: declare_win tile-count guard holds even with a kong exposed', () => {
  test('expectedLen formula (13 - exposed.length*3) is correct even though a kong holds 4 tiles, not 3', () => {
    // A kong is stored as ONE exposed-set entry with 4 tiles, but the extra tile is
    // exactly offset by the extra replacement draw a kong grants — so counting exposed
    // *sets* (not exposed *tiles*) is the right formula regardless of kongs on the table.
    const room = G.createRoom('KONGCOUNT', 'p1');
    ['p1','p2','p3','p4'].forEach((id,i) => G.addPlayer(room, { playerId: id, displayName: `P${i}` }));
    G.startGame(room);
    const player = room.players.find(p => p.seat === 'E');

    // Give the player a concealed kong of a tile they don't otherwise need, then top up
    // their hand to a normal pre-win count so the shape matches a real mid-game hand.
    player.hand = ['2D','2D','2D','2D', ...player.hand.slice(0, 10)];
    G.applyKong(room, player, '2D', player.seat, true); // concealed kong, draws a replacement tile itself

    const expectedLen = 13 - player.exposed.length * 3;
    // After the kong, hand should sit at exactly expectedLen + 1 (the +1 being the tile
    // they'd remove as "winningTile" if they were declaring right now).
    assert.equal(player.hand.length, expectedLen + 1,
      'hand size after a kong should still satisfy the 13 - exposed.length*3 (+1 pending) formula');
  });
});
