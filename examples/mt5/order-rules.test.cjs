const assert = require('node:assert/strict');
const { test } = require('node:test');
const q = { bid: 100, ask: 100.02, stops: .05, tickSize: .01, digits: 2 };

test('pending entries validate against the correct Bid/Ask and stop distance before submission', async () => {
  const { tradeIssue } = await import('./order-rules.js');
  for (const [side, type, price] of [['sell', 'stop', 101], ['buy', 'stop', 99], ['sell', 'limit', 99], ['buy', 'limit', 101]]) {
    assert.ok(tradeIssue({ side, type, price }, q));
  }
  for (const [side, type, price] of [['sell', 'stop', 99], ['buy', 'stop', 101], ['sell', 'limit', 101], ['buy', 'limit', 99]]) {
    assert.equal(tradeIssue({ side, type, price }, q), '');
  }
  assert.ok(tradeIssue({ side: 'buy', type: 'stopLimit', price: 102, stopPrice: 101 }, q));
});

test('draft entry crossings change side and preserve distances, while position stops respect the current closing quote', async () => {
  const { projectOrder, tradeIssue } = await import('./order-rules.js');
  const flipped = projectOrder({ side: 'buy', type: 'limit', price: 99, stopLoss: 98, takeProfit: 101 }, 'price', 102, q, 'draft');
  assert.equal(flipped.side, 'sell'); assert.equal(flipped.stopLoss, 103); assert.equal(flipped.takeProfit, 100);
  assert.equal(tradeIssue(flipped, q), '');
  for (const side of ['buy', 'sell']) {
    const row = { side, entryPrice: side === 'buy' ? 95 : 105 };
    const sl = projectOrder(row, 'stopLoss', side === 'buy' ? 102 : 98, q, 'position');
    const tp = projectOrder(row, 'takeProfit', side === 'buy' ? 98 : 102, q, 'position');
    assert.equal(sl.side, side); assert.equal(tp.side, side);
    assert.equal(tradeIssue(sl, q, 'position'), ''); assert.equal(tradeIssue(tp, q, 'position'), '');
    assert.ok(side === 'buy' ? sl.stopLoss < q.bid && tp.takeProfit > q.bid : sl.stopLoss > q.ask && tp.takeProfit < q.ask);
  }
  // A losing buy can take profit below its original entry, provided it is above Bid.
  assert.equal(tradeIssue({ side: 'buy', entryPrice: 110, takeProfit: 102, stopLoss: 99 }, q, 'position'), '');
});
