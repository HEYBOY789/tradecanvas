const assert = require('node:assert/strict');
const { test } = require('node:test');

test('crowded labels fit the plot without overlap and retain their actual price anchors', async () => {
  const { layoutTradeLabels } = await import('./order-label-layout.js');
  for (const bounds of [{ x: 40, y: 10, width: 1000, height: 700 }, { x: 4, y: 8, width: 300, height: 190 }]) {
    const input = Array.from({ length: 18 }, (_, index) => ({ key: `trade:${index}`, lineY: bounds.y + bounds.height / 2 + index / 10, width: 175 }));
    const result = layoutTradeLabels(input, bounds);
    assert.equal(result.length, input.length);
    for (const box of result) {
      assert.equal(box.lineY, input.find(item => item.key === box.key).lineY);
      assert.ok(box.x >= bounds.x && box.x + box.width <= bounds.x + bounds.width + .01);
      assert.ok(box.y >= bounds.y && box.y + box.height <= bounds.y + bounds.height + .01);
      for (const other of result) if (box.key !== other.key) {
        assert.ok(box.x + box.width <= other.x || other.x + other.width <= box.x || box.y + box.height <= other.y || other.y + other.height <= box.y,
          `overlap: ${box.key} / ${other.key}`);
      }
    }
    assert.ok(result.some(box => Math.abs(box.y + box.height / 2 - box.lineY) > 10), 'crowded labels move, price anchors do not');
    assert.deepEqual(layoutTradeLabels(input, bounds), result, 'polling does not shuffle label rows');
  }
});

test('compact labels use broker P/L only for filled positions and do not repeat the price or lots', async () => {
  const { tradeLabel } = await import('./order-label-layout.js');
  const position = { side: 'buy', quantity: .02, entryPrice: 3800, profit: 12.4 };
  assert.equal(tradeLabel(position, 'position', 'price', 'USD'), 'BUY · 0.02 · +12.40 USD');
  assert.equal(tradeLabel({ ...position, profit: -8.1 }, 'position', 'price', 'EUR'), 'BUY · 0.02 · -8.10 EUR');
  assert.equal(tradeLabel({ side: 'sell', type: 'stopLimit', quantity: .01, price: 3820 }, 'order', 'price', 'USD'), 'SELL STOP LIMIT · 0.01');
  assert.equal(tradeLabel(position, 'position', 'stopLoss', 'USD'), 'SL · 0.02');
  assert.equal(tradeLabel(position, 'position', 'takeProfit', 'USD'), 'TP · 0.02');
  assert.equal(tradeLabel({ ...position, profit: undefined }, 'position', 'price', 'USD'), 'BUY · 0.02');
});
