const assert = require('node:assert/strict');
const { test } = require('node:test');
const model = import('./fixed-range-profile-model.js');

const minute = 60_000;
const candle = (time, low, high, open, close, volume) => ({ time, low, high, open, close, volume });

test('chooses whole ticks per row and preserves the final partial row', async () => {
  const { buildVolumeProfile } = await model;
  const bar = candle(0, 2, 3, 2, 3, 100);
  const profile = buildVolumeProfile([bar], new Map(), .01, { rowMode: 'rows', rowSize: 30, valueArea: 100 });
  assert.equal(profile.ticksPerRow, 3);
  assert.equal(profile.total.length, 34);
  assert.equal(profile.edge(34), 3);
  assert.ok(Math.abs(profile.total[33] - 1) < 1e-8);
  assert.ok(Math.abs(profile.total.reduce((a, b) => a + b) - 100) < 1e-8);
  assert.equal(profile.valueHigh, 33);
});

test('conserves volume across partially overlapping rows and computes directional delta', async () => {
  const { buildVolumeProfile } = await model;
  const bars = [candle(0, 0, 4, 0, 4, 8), candle(1, 1, 2, 2, 1, 9), candle(2, 4, 4, 4, 4, 3)];
  const p = buildVolumeProfile(bars, new Map(), 1, { rowMode: 'ticks', rowSize: 1, valueArea: 70 });
  assert.deepEqual([...p.up], [2, 2, 2, 5]);
  assert.deepEqual([...p.down], [0, 9, 0, 0]);
  assert.equal(p.poc, 1);
  assert.equal(p.maxDelta, 7);
  const flat = buildVolumeProfile([bars[2]], new Map(), 1, { rowMode: 'ticks', rowSize: 1, valueArea: 70 });
  assert.equal(flat.pocPrice, 4);
  assert.equal(flat.down[0], 3);
  assert.equal(buildVolumeProfile([{ ...bars[2], volume: 0 }], new Map(), 1, {}), null);
});

test('Value Area respects the limit and prefers the closest or higher row on ties', async () => {
  const { valueAreaOf } = await model;
  assert.deepEqual(valueAreaOf([10, 10, 40, 10, 10, 20], 70), { poc: 2, valueLow: 1, valueHigh: 4 });
  assert.deepEqual(valueAreaOf([25, 50, 25], 80), { poc: 1, valueLow: 1, valueHigh: 2 });
  assert.deepEqual(valueAreaOf([10, 60, 30], 85), { poc: 1, valueLow: 1, valueHigh: 1 });
});

test('uses lower candles only when a chart bar is covered and develops from accumulated volume', async () => {
  const { buildVolumeProfile, groupLowerBars, profileLowerFrame, candleEnd } = await model;
  const chart = [candle(0, 1, 4, 1, 4, 10), candle(5 * minute, 1, 4, 4, 1, 30), candle(10 * minute, 1, 4, 1, 2, 40)];
  const lower = [candle(0, 1, 2, 1, 2, 2), candle(minute, 4, 4, 4, 4, 8), candle(5 * minute, 1, 1, 1, 1, 3), candle(18 * minute, 1, 1, 1, 1, 100)];
  const groups = groupLowerBars(chart, lower, '5m');
  assert.deepEqual([...groups.keys()], [0]);
  const p = buildVolumeProfile(chart.slice(0, 2), groups, 1, { rowMode: 'ticks', rowSize: 1, valueArea: 70, develop: true });
  assert.equal(p.developing[0].pocPrice, 3.5);
  assert.equal(p.developing.at(-1).pocPrice, p.pocPrice);
  assert.equal(profileLowerFrame('15m', 5000 * minute, ['1m', '3m', '5m']), '3m');
  assert.equal(profileLowerFrame('1m', minute, ['1m', '5m']), undefined);
  assert.equal(candleEnd(Date.UTC(2024, 1, 1), '1M'), Date.UTC(2024, 2, 1));
});
