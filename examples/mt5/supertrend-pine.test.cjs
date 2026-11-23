const assert = require('node:assert/strict');
const { test } = require('node:test');

const bars = [100, 102, 95, 95, 110, 112].map((close, i) => ({
  time: i * 60000, open: close, high: close + 1, low: close - 1, close, volume: 1,
}));
const config = { params: { period: 2, multiplier: 1 } };

test('Pine bands start up, break at each reversal and use the prior trailed bands', async () => {
  const { supertrendPine } = await import('./supertrend-pine.js');
  assert.deepEqual(supertrendPine.calculate(bars, config).series, [
    null,
    { trend: 1, up: 99.5, ohlc4: 102 },
    { trend: -1, down: 100.25, ohlc4: 95, sell: 100.25 },
    { trend: -1, down: 98.625, ohlc4: 95 },
    { trend: 1, up: 100.1875, ohlc4: 110, buy: 100.1875 },
    { trend: 1, up: 105.59375, ohlc4: 112 },
  ]);
});

test('SMA starts one bar later, and Source changes the band without changing candle true range', async () => {
  const { supertrendPine } = await import('./supertrend-pine.js');
  const params = { ...config.params, wilderATR: false, priceSource: 'high', highlight: false, showSignals: false };
  const output = supertrendPine.calculate(bars, { params });
  assert.equal(output.meta.showSignals, false);
  assert.deepEqual(output.series.map(point => point?.up), [undefined, undefined, 90.5, 91, 102, 103.5]);
  assert.ok(output.series.slice(2).every(point => !('ohlc4' in point)));
  assert.equal(supertrendPine.calculate(bars, { params: { ...config.params, showSignals: false } }).series[2].sell, 100.25);
});

test('updating a forming bar and appending another agree with a full calculation', async () => {
  const { supertrendPine } = await import('./supertrend-pine.js');
  const edited = bars.map((bar, i) => i === 3 ? { ...bar, close: 104, high: 105 } : bar);
  for (const wilderATR of [true, false]) {
    const settings = { params: { ...config.params, wilderATR } };
    const output = supertrendPine.calculate(bars.slice(0, 4), settings);
    for (const length of [4, 5, 6]) {
      const data = edited.slice(0, length);
      const updated = supertrendPine.update(data, settings, output, length === 4 ? 3 : length - 1);
      assert.deepEqual(updated, supertrendPine.calculate(data, settings));
    }
  }
});
