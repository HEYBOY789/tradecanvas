const assert = require('node:assert/strict');
const { test } = require('node:test');

test('1000-tick CVD fills older M15 candles omitted by a bounded tick read', async () => {
  const { createCvd } = await import('./cvd.js');
  const frames = [];
  const originalRaf = global.requestAnimationFrame;
  global.requestAnimationFrame = callback => frames.push(callback);
  try {
    const first = Date.UTC(2026, 10, 16, 1);
    const bars = Array.from({ length: 6 }, (_, i) => ({ time: first + i * 900000,
      open: 100, high: 102, low: 99, close: 101, volume: 100 }));
    const request = { symbol: 'XAUUSDm', timeframe: '15m' };
    const sample = bar => [bar.time, 10, -4, 10, -4, 2];
    const response = range => ({ server: 'fixture', bars: range, cvd: { '1000T': {
      frame: '1000T', volume: 'tick_volume', rows: range.slice(-2).map(sample),
      coverage: { from: range.at(-2)?.time ?? range[0].time, to: range.at(-1).time + 900000 },
    } } });
    let plugin;
    const listeners = new Map();
    const active = [];
    const chart = {
      registerIndicator(value) { plugin = value; },
      getActiveIndicators: () => active,
      getData: () => bars,
      getVisibleTimeRange: () => ({ from: bars[0].time }),
      isReplayActive: () => false,
      on(event, callback) { listeners.set(event, callback); },
      addIndicator() { active.push({ id: 'mt5-cvd-candle', instanceId: 'cvd', visible: true,
        params: { ...plugin.descriptor.defaultConfig, calculationFrame: '1000 ticks', reset: 'Không đặt lại' } }); },
      updateIndicator(id, params) {
        Object.assign(active.find(item => item.instanceId === id).params, params);
        listeners.get('indicatorChange')?.({ payload: { instanceId: id, change: 'params' } });
      },
    };
    const calls = [];
    const cvd = createCvd(async (load, targets) => {
      calls.push({ ...load, targets });
      const eligible = bars.filter(bar => bar.time < load.before);
      return response(eligible.slice(-load.countBack));
    });
    cvd.attach({ getChart: () => chart, getSymbol: () => request.symbol, getTimeframe: () => request.timeframe });
    cvd.accept(request, response(bars));
    for (let i = 0; i < 20; i++) {
      while (frames.length) frames.shift()();
      await new Promise(setImmediate);
    }
    const output = plugin.calculate(bars, { params: active[0].params });
    assert.equal(output.values.size, bars.length, 'the tick cap must not leave permanent holes in M15');
    assert.equal(calls.length, 2, 'request only the two remaining historical chunks');
    assert.deepEqual(calls.map(call => call.before), [bars[3].time + 1000, bars[1].time + 1000]);
    assert.ok(calls.every(call => call.targets[0] === '1000T'));
    assert.equal(output.values.get(bars.at(-1).time).close, bars.length * 6, 'cumulative CVD spans the recovered candles');

    // A real hole inside an inspected interval stays visibly missing and is
    // counted as unavailable, rather than inventing flat candles or retrying forever.
    cvd.accept(request, { server: 'fixture', bars: [bars[1]], cvd: { '1000T': {
      frame: '1000T', volume: 'tick_volume', rows: [],
      coverage: { from: bars[1].time, to: bars[1].time + 900000 },
    } } });
    for (let i = 0; i < 5; i++) {
      while (frames.length) frames.shift()();
      await new Promise(setImmediate);
    }
    const unavailable = plugin.calculate(bars, { params: active[0].params });
    assert.equal(unavailable.values.size, bars.length - 1);
    assert.equal(unavailable.meta.unavailable, 1);
    assert.equal(unavailable.meta.loading, 0);
    assert.equal(calls.length, 2);
  } finally {
    global.requestAnimationFrame = originalRaf;
  }
});
