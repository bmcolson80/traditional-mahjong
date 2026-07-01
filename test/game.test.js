import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../game.js';

describe('buildWall', () => {
  test('produces 144 tiles', () => {
    const wall = G.buildWall();
    assert.equal(wall.length, 144);
  });

  test('has exactly 4 of each suited tile', () => {
    const wall = G.buildWall();
    const counts = {};
    for (const t of wall) counts[t] = (counts[t] || 0) + 1;
    assert.equal(counts['5D'], 4);
    assert.equal(counts['1C'], 4);
    assert.equal(counts['EW'], 4);
    assert.equal(counts['RD'], 4);
    assert.equal(counts['F1'], 1);
  });
});

describe('room lifecycle', () => {
  test('creates a room and adds players up to 4', () => {
    const room = G.createRoom('ABCDE', 'p1');
    G.addPlayer(room, { playerId: 'p1', displayName: 'Alice' });
    G.addPlayer(room, { playerId: 'p2', displayName: 'Bob' });
    G.addPlayer(room, { playerId: 'p3', displayName: 'Carl' });
    G.addPlayer(room, { playerId: 'p4', displayName: 'Dana' });
    assert.equal(room.players.length, 4);
    assert.throws(() => G.addPlayer(room, { playerId: 'p5', displayName: 'Eve' }));
  });

  test('startGame deals 13 tiles to each player and 14 to dealer', () => {
    const room = G.createRoom('ROOM1', 'p1');
    ['p1', 'p2', 'p3', 'p4'].forEach((id, i) => G.addPlayer(room, { playerId: id, displayName: `P${i}` }));
    G.startGame(room);
    const east = room.players.find(p => p.seat === 'E');
    const others = room.players.filter(p => p.seat !== 'E');
    assert.equal(east.hand.length, 14);
    others.forEach(p => assert.equal(p.hand.length, 13));
  });
});

describe('claims', () => {
  test('canPung detects a pair in hand', () => {
    assert.equal(G.canPung(['1D', '1D', '3B'], '1D'), true);
    assert.equal(G.canPung(['1D', '2D', '3B'], '1D'), false);
  });

  test('canKongFromDiscard requires 3 in hand', () => {
    assert.equal(G.canKongFromDiscard(['1D', '1D', '1D'], '1D'), true);
    assert.equal(G.canKongFromDiscard(['1D', '1D'], '1D'), false);
  });

  test('canChow only allows the player to the discarder\'s left', () => {
    const hand = ['2D', '3D'];
    const chowOptions = G.canChow(hand, '1D', 'S', 'E'); // S is next after E — allowed
    assert.ok(chowOptions.length > 0);
    const blocked = G.canChow(hand, '1D', 'W', 'E'); // W is not next after E
    assert.equal(blocked, false);
  });

  test('canChow rejects honor tiles', () => {
    assert.equal(G.canChow(['EW', 'EW'], 'EW', 'S', 'E'), false);
  });
});

describe('win detection', () => {
  test('detects a standard winning hand (4 sets + pair)', () => {
    const hand = ['1D','2D','3D', '4D','5D','6D', '7D','8D','9D', '1B','1B'];
    const result = G.checkWin(hand, [], '2C'); // placeholder pair test below instead
    // build a real 13-tile hand + winning tile properly:
    const realHand = ['1D','2D','3D','4D','5D','6D','7D','8D','9D','1B','2B','3B','2C'];
    const win = G.checkWin(realHand, [], '2C');
    assert.equal(win.win, true);
  });

  test('detects seven pairs', () => {
    const hand = ['1D','1D','2D','2D','3D','3D','4D','4D','5D','5D','6D','6D','7D'];
    const win = G.checkWin(hand, [], '7D');
    assert.equal(win.win, true);
    assert.equal(win.type, 'seven_pairs');
  });

  test('detects thirteen orphans', () => {
    const hand = ['1D','9D','1B','9B','1C','9C','EW','SW','WW','NW','RD','GD','WD'];
    const win = G.checkWin(hand, [], '1D');
    assert.equal(win.win, true);
    assert.equal(win.type, 'thirteen_orphans');
  });

  test('rejects a non-winning hand', () => {
    const hand = ['1D','2D','4D','5D','7D','8D','1B','2B','4B','5B','7B','8B','1C'];
    const win = G.checkWin(hand, [], '2C');
    assert.equal(win.win, false);
  });
});

describe('scoring', () => {
  test('gives base fan for a plain hand', () => {
    const exposed = [{ type: 'chow', tiles: ['1D','2D','3D'] }];
    const concealed = ['4D','5D','6D','7D','8D','9D','1B','2B','1C','1C'];
    const score = G.scoreHand({}, exposed, concealed, '3B', { selfDraw: false });
    assert.ok(score.fan >= 1);
  });

  test('awards flush bonus for a single-suit hand', () => {
    const exposed = [];
    const concealed = ['1D','2D','3D','4D','5D','6D','7D','8D','9D','1D','1D'];
    const score = G.scoreHand({}, exposed, concealed, '2D', { selfDraw: true });
    assert.ok(score.breakdown.some(b => b.includes('Flush')));
  });
});
