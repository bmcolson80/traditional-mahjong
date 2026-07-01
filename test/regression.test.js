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
