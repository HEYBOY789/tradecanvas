// Deterministic bars for browser UI checks, independent of an open terminal.
exports.mockMarket = async function mockMarket(page) {
  const frames = ['1m', '5m', '15m', '1h', '4h', '1d', '1w', '1M'];
  await page.route('**/api/config', route => route.fulfill({ json: {
    symbols: [{ symbol: 'XAUUSDm', description: 'Test Gold', exchange: 'Fixture', pricePrecision: 3, minTick: .001 }],
    frames, symbol: 'XAUUSDm', frame: '5m', server: 'Fixture', pageSize: 600, count: 1000000,
  } }));
  await page.route('**/api/trading/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/session')) return route.fulfill({ json: { key: 'read-only-fixture' } });
    if (url.pathname.endsWith('/state')) return route.fulfill({ json: {
      account: { id: 'read-only', login: 'TEST', server: 'Fixture', demo: true, allowed: false, reason: 'Read-only fixture', currency: 'USD', balance: 10000, equity: 10000, marginFree: 10000, profit: 0, leverage: 100 },
      positions: [], orders: [], quotes: Object.fromEntries((url.searchParams.get('symbols') || 'XAUUSDm').split(',').map(symbol => [symbol,
        { bid: 3800, ask: 3800.01, min: .01, max: 100, step: .01, tickSize: .001, digits: 3, expirationMode: 15, orderMode: 127 }])),
    } });
    return route.abort('blockedbyclient');
  });
  await page.route('**/api/bars?**', route => {
    const query = new URL(route.request().url()).searchParams;
    const step = ({ '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800, '1M': 2592000 }[query.get('frame')] || 300) * 1000;
    const end = Math.floor(Date.UTC(2026, 10, 17, 12) / step) * step;
    let bars = query.has('before') ? [] : Array.from({ length: 600 }, (_, i) => {
      const value = 3800 + Math.sin(i / 17) * 12;
      return { time: end - (599 - i) * step, open: value, high: value + 2, low: value - 2, close: value + Math.sin(i), volume: 100 + i % 30 };
    });
    if (query.has('since')) bars = bars.filter(bar => bar.time >= Number(query.get('since')));
    const cvd = Object.fromEntries((query.get('cvd') || '1m').split(',').map(frame => [frame,
      { frame: '1m', volume: 'tick_volume', rows: bars.map((bar, i) => [bar.time, 60 + Math.sin(i) * 20, -40, 70, -45, 5]), coverage: { from: bars[0]?.time, to: end + step } }]));
    const periods = { day: [1, 0].map(n => ({ time: end - n * 86400000, open: 3800, high: 3820, low: 3780, close: 3800 })), week: [], month: [] };
    return route.fulfill({ json: { reset: !query.has('since'), server: 'Fixture', bars, periods, cvd } });
  });
};
