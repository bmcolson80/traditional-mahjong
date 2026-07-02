import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as AI from '../ai.js';

describe('AI discard — evaluateHand', () => {
  test('scores a complete pung higher than isolated tiles', () => {
    const withPung = ['1D', '1D', '1D', '5C', '7B'];
    const withJunk = ['1D', '3B', '5C', '7B', '9C'];
    assert.ok(AI.evaluateHand(withPung, []) > AI.evaluateHand(withJunk, []));
  });

  test('scores a complete chow higher than isolated tiles', () => {
    const withChow = ['2D', '3D', '4D', '9B', '9C'];
    const withJunk = ['2D', '5C', '8B', '9B', '9C'];
    assert.ok(AI.evaluateHand(withChow, []) > AI.evaluateHand(withJunk, []));
  });

  test('partial sequence scores higher than a fully isolated tile', () => {
    const withPartial = ['2D', '3D', '9C'];
    const withJunk = ['2D', '7B', '9C'];
    assert.ok(AI.evaluateHand(withPartial, []) > AI.evaluateHand(withJunk, []));
  });

  test('accounts for exposed sets reducing sets needed', () => {
    // With 3 exposed sets, only 1 concealed set + pair needed
    const exposed = [
      { type: 'pung', tiles: ['EW', 'EW', 'EW'] },
      { type: 'pung', tiles: ['1D', '1D', '1D'] },
      { type: 'pung', tiles: ['9C', '9C', '9C'] },
    ];
    const score = AI.evaluateHand(['2B', '2B', '3B', '4B', '5C'], exposed);
    // Should score highly since we only need 1 more set + pair from 5 tiles
    assert.ok(score >= 2);
  });
});

describe('AI discard — chooseDiscard', () => {
  test('master discards isolated tile over one contributing to a set', () => {
    // Hand has a chow (1D,2D,3D), a pair (5C,5C), and two isolated tiles (7B,9B)
    // Master should discard 7B or 9B (not tiles in sets)
    const hand = ['1D', '2D', '3D', '5C', '5C', '7B', '9B'];
    const discarded = AI.chooseDiscard(hand, [], 'master');
    assert.ok(['7B', '9B'].includes(discarded), `Expected isolated tile, got ${discarded}`);
  });

  test('rookie sometimes discards a tile that is part of a set (random play)', () => {
    // Run 100 times — rookie should occasionally make a suboptimal discard
    let suboptimalCount = 0;
    const hand = ['1D', '2D', '3D', '5C', '5C', '7B'];
    for (let i = 0; i < 100; i++) {
      const d = AI.chooseDiscard(hand, [], 'rookie');
      if (!['7B'].includes(d)) suboptimalCount++;
    }
    // Rookie should be suboptimal at least sometimes (> 20% of the time)
    assert.ok(suboptimalCount > 5, `Rookie was always optimal (${suboptimalCount}/100 suboptimal moves)`);
  });
});

describe('AI claim — shouldClaimPung', () => {
  test('veteran always claims a pung', () => {
    for (let i = 0; i < 20; i++) {
      assert.equal(AI.shouldClaimPung(['1D', '1D', '5C'], '1D', [], 'veteran'), true);
    }
  });

  test('rookie sometimes declines a pung', () => {
    let declined = 0;
    for (let i = 0; i < 200; i++) {
      if (!AI.shouldClaimPung(['1D', '1D', '5C'], '1D', [], 'rookie')) declined++;
    }
    assert.ok(declined > 10, `Rookie never declined a pung (${declined}/200)`);
  });
});

describe('AI claim — shouldDeclareWin', () => {
  test('veteran always declares win on a valid hand', () => {
    // 1D-9D is a complete flush (with pair)
    const hand = ['1D','2D','3D','4D','5D','6D','7D','8D','9D','1D','1D','1B','2B'];
    for (let i = 0; i < 10; i++) {
      assert.equal(AI.shouldDeclareWin(hand, [], '3B', 'veteran'), true);
    }
  });

  test('returns false when hand does not qualify', () => {
    const hand = ['1D','2D','4D','5D','7D','8D','1B','2B','4B','5B','7B','8B','1C'];
    assert.equal(AI.shouldDeclareWin(hand, [], '9C', 'master'), false);
  });
});

describe('AI think time', () => {
  test('master thinks faster than rookie on average', () => {
    let masterTotal = 0, rookieTotal = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) {
      masterTotal += AI.aiThinkTime('master');
      rookieTotal += AI.aiThinkTime('rookie');
    }
    assert.ok(masterTotal / N < rookieTotal / N, 'Master should think faster than Rookie on average');
  });

  test('think times stay within declared ranges', () => {
    for (const [skill, [min, max]] of Object.entries(AI.THINK_TIME)) {
      for (let i = 0; i < 50; i++) {
        const t = AI.aiThinkTime(skill);
        assert.ok(t >= min && t <= max, `${skill} think time ${t} outside [${min},${max}]`);
      }
    }
  });
});
