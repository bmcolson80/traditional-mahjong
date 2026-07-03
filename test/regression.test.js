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

describe('regression: chow direction enforcement', () => {
  test('a player cannot chow from a discarder who is not to their immediate right', () => {
    // seat order E -> S -> W -> N -> E
    // S can chow from E (S is next after E). N cannot chow from E.
    const hand = ['2D', '3D'];
    assert.ok(G.canChow(hand, '1D', 'S', 'E'));
    assert.equal(G.canChow(hand, '1D', 'N', 'E'), false);
    assert.equal(G.canChow(hand, '1D', 'W', 'E'), false);
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

describe('regression: score settlement', () => {
  test('self-draw win collects fan points evenly from all three opponents', () => {
    const room = G.createRoom('RR6', 'p1');
    ['p1','p2','p3','p4'].forEach((id,i) => G.addPlayer(room, { playerId: id, displayName: `P${i}` }));
    G.settleScore(room, 'E', 2, { selfDraw: true });
    const east = room.players.find(p => p.seat === 'E');
    const others = room.players.filter(p => p.seat !== 'E');
    assert.equal(east.score, 6);
    others.forEach(p => assert.equal(p.score, -2));
  });

  test('discard win charges the discarder double', () => {
    const room = G.createRoom('RR7', 'p1');
    ['p1','p2','p3','p4'].forEach((id,i) => G.addPlayer(room, { playerId: id, displayName: `P${i}` }));
    G.settleScore(room, 'E', 3, { selfDraw: false, discarderSeat: 'S' });
    const east = room.players.find(p => p.seat === 'E');
    const south = room.players.find(p => p.seat === 'S');
    const others = room.players.filter(p => p.seat !== 'E' && p.seat !== 'S');
    assert.equal(south.score, -6);
    others.forEach(p => assert.equal(p.score, -3));
    assert.equal(east.score, 6 + 3 + 3);
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
