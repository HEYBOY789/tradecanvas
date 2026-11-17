const assert = require('node:assert/strict');
const { test } = require('node:test');

test('MT5 M15 / 1000 ticks backfills every candle across the initial tick cap', {
  skip: !process.env.TRADECANVAS_URL,
  timeout: 60000,
}, async () => {
  const { createCvd } = await import('./cvd.js');
  const originalRaf = global.requestAnimationFrame;
  global.requestAnimationFrame = callback => setImmediate(callback);
  let stopped = false;
  try {
    const base = process.env.TRADECANVAS_URL;
    const config = await (await fetch(new URL('/api/config', base))).json();
    const request = { symbol: config.symbol, timeframe: '15m' };
    const calls = [];
    async function load({ before, countBack } = {}) {
      const query = new URLSearchParams({ symbol: request.symbol, frame: '15m', cvd: '1000T' });
      if (before) { query.set('before', before); query.set('count', countBack); }
      const response = await fetch(new URL(`/api/bars?${query}`, base));
      const result = await response.json();
      assert.equal(response.status, 200, result.error);
      calls.push({ before, bars: result.bars.length, samples: result.cvd['1000T'].rows.length,
        coverage: result.cvd['1000T'].coverage });
      return result;
    }
    const initial = await load();
    let plugin;
    const active = [];
    const handlers = new Map();
    const chart = {
      registerIndicator(value) { plugin = value; },
      getData: () => initial.bars,
      getActiveIndicators: () => stopped ? [] : active,
      getVisibleTimeRange: () => ({ from: initial.bars[0].time }),
      isReplayActive: () => false,
      on(event, handler) { handlers.set(event, handler); },
      addIndicator() { active.push({ id: 'mt5-cvd-candle', instanceId: 'cvd', visible: true,
        params: { ...plugin.descriptor.defaultConfig, calculationFrame: '1000 ticks' } }); },
      updateIndicator(id, params) {
        Object.assign(active[0].params, params);
        handlers.get('indicatorChange')?.({ payload: { instanceId: id, change: 'params' } });
      },
    };
    const cvd = createCvd(load);
    cvd.attach({ getChart: () => chart, getSymbol: () => request.symbol, getTimeframe: () => request.timeframe });
    cvd.accept(request, initial);
    let output;
    const until = Date.now() + 45000;
    while (Date.now() < until) {
      output = plugin.calculate(initial.bars, { params: active[0].params });
      if (output.values.size === initial.bars.length) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(output.values.size, initial.bars.length, JSON.stringify({ calls, loading: output.meta.loading, unavailable: output.meta.unavailable }));
    assert.equal(output.meta.loading, 0);
    assert.equal(output.meta.unavailable, 0);
    assert.ok(calls[0].coverage, 'the backend reports the interval actually read');
    console.log(JSON.stringify({ chart: 'M15', calculation: '1000T', bars: initial.bars.length,
      initiallyAvailable: initial.cvd['1000T'].rows.length, finalAvailable: output.values.size,
      backfillRequests: calls.length - 1 }));

    const older = await load({ before: initial.bars[0].time, countBack: 600 });
    cvd.accept(request, older);
    initial.bars.unshift(...older.bars);
    handlers.get('historyLoad')?.({ payload: { added: older.bars.length } });
    const historyUntil = Date.now() + 30000;
    while (Date.now() < historyUntil) {
      output = plugin.calculate(initial.bars, { params: active[0].params });
      if (output.values.size === initial.bars.length) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(output.values.size, initial.bars.length, 'newly prepended history must fill its bounded tick gaps too');
    assert.equal(output.meta.loading, 0);
    assert.equal(output.meta.unavailable, 0);
    console.log(JSON.stringify({ afterHistoryPage: output.values.size, bars: initial.bars.length }));
  } finally {
    stopped = true;
    global.requestAnimationFrame = originalRaf;
  }
});
