const assert = require('node:assert/strict');
const { test } = require('node:test');

test('Long/Short geometry preserves entry, stop, target and risk mode without copying drawing units as MT5 lots', async () => {
  const { drawingOrder, orderIntent } = await import('./order-model.js');
  const q = { tickSize: .001, digits: 3 };
  const chart = { getDrawings: () => [{ id: 'plan', type: 'riskReward', anchors: [{ time: 1, price: 3800 }, { time: 2, price: 3810 }] }],
    getDrawingOptions: () => ({ rewardRatio: 2, risk: 1, riskMode: 'percent', accountSize: 10000 }) };
  const draft = drawingOrder(chart, 'plan', q);
  assert.deepEqual([draft.side, draft.price, draft.stopLoss, draft.takeProfit, draft.quantityMode, draft.quantity], ['sell', 3800, 3810, 3780, 'riskPercent', 1]);
  assert.equal(orderIntent(draft, { quantity: .1 }).quantity, .1, 'only the broker estimate determines lots');
  assert.throws(() => orderIntent(draft, null), /Chờ MT5/);
});

test('stop-limit keeps trigger and limit independent and unit conversion respects side and exit direction', async () => {
  const { orderIntent, priceFromUnit, valueInUnit } = await import('./order-model.js');
  const q = { tickSize: .001, digits: 3 };
  const intent = orderIntent({ side: 'buy', type: 'stopLimit', price: 3890, stopPrice: 3900, stopLoss: 3880, takeProfit: 3910 }, { quantity: .02 });
  assert.equal(intent.price, 3890); assert.equal(intent.stopPrice, 3900);
  assert.equal(priceFromUnit(250, 'ticks', 3800, 'sell', 'stopLoss', q), 3800.25);
  assert.equal(priceFromUnit(1, 'percent', 3800, 'buy', 'takeProfit', q), 3838);
  assert.equal(valueInUnit(3799.75, 'ticks', 3800, q), 250);
});

test('moving entry translates stops and a stop-limit trigger while retaining reward/risk', async () => {
  const { translatedOrder, bracketSide } = await import('./order-model.js');
  const moved = translatedOrder({ price: 3800, stopPrice: 3805, stopLoss: 3790, takeProfit: 3820 }, 3810, { tickSize: .001, digits: 3 });
  assert.deepEqual(moved, { price: 3810, stopPrice: 3815, stopLoss: 3800, takeProfit: 3830 });
  assert.equal((moved.takeProfit - moved.price) / (moved.price - moved.stopLoss), 2);
  assert.equal(bracketSide('buy', 3800, 3790), 'stopLoss');
  assert.equal(bracketSide('sell', 3800, 3790), 'takeProfit');
});
