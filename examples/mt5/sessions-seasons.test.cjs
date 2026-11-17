const assert = require('node:assert/strict');
const { test } = require('node:test');

test('legacy hours seed independent seasonal pairs and discard automatic DST', async () => {
  const { withSessionSeasons, SESSION_SEASONS } = await import('./session-seasons.js');
  const defaults = { start: '08:00', end: '17:00' };
  const legacy = { start: '23:15', end: '01:45', autoDst: true, color: '#123456' };
  assert.deepEqual(SESSION_SEASONS, ['Mùa hè', 'Mùa đông']);
  for (const id of ['london', 'newYork']) {
    const result = withSessionSeasons(id, legacy, defaults);
    assert.equal(result.start, '23:15'); assert.equal(result.end, '01:45');
    assert.equal(result.winterStart, '00:15'); assert.equal(result.winterEnd, '02:45');
    assert.equal(result.season, 'Mùa hè'); assert.equal(result.color, '#123456');
    assert.equal('autoDst' in result, false);
  }
  const asia = withSessionSeasons('asia', legacy, defaults);
  assert.equal(asia.winterStart, '23:15'); assert.equal(asia.winterEnd, '01:45');
  assert.equal(legacy.autoDst, true, 'migration leaves its input intact');
  const invalid = withSessionSeasons('london', { start: '25:00', end: '', winterStart: 'oops', season: 'automatic' }, defaults);
  assert.equal(invalid.start, '08:00'); assert.equal(invalid.end, '17:00');
  assert.equal(invalid.winterStart, '09:00'); assert.equal(invalid.winterEnd, '18:00');
  assert.equal(invalid.season, 'Mùa hè');
});

test('season selection uses editable hours without adding an offset or changing the saved summer pair', async () => {
  const { withSessionSeasons, sessionHours } = await import('./session-seasons.js');
  const summer = { start: '07:15', end: '16:45' };
  for (const id of ['asia', 'london', 'newYork']) {
    const snapshot = { ...summer, season: 'Mùa đông', winterStart: '22:30', winterEnd: '03:15' };
    const options = withSessionSeasons(id, snapshot, summer);
    assert.deepEqual([sessionHours(options).start, sessionHours(options).end], ['22:30', '03:15']);
    assert.deepEqual([options.start, options.end], ['07:15', '16:45']);
    assert.equal(sessionHours({ ...options, season: 'Mùa hè' }).start, '07:15');
    const changed = withSessionSeasons(id, { ...options, start: '05:00', end: '11:00' }, summer);
    assert.deepEqual([changed.winterStart, changed.winterEnd], ['22:30', '03:15']);
  }
});

test('manually selected overnight ranges and CVD closure are identical in summer and winter calendar dates', async () => {
  const { sessionHours } = await import('./session-seasons.js');
  const { sessionClock, sessionRanges, previousSessionRange } = await import('./session-levels.js');
  const options = sessionHours({ start: '12:00', end: '13:00', season: 'Mùa đông', winterStart: '23:30', winterEnd: '01:00' });
  for (const month of [6, 10]) {
    const start = Date.UTC(2026, month, 16, 22, 30);
    const bars = Array.from({ length: 7 }, (_, i) => ({ time: start + i * 1800000, open: 100, high: 110 + i, low: 90 - i }));
    const clock = bars.map(bar => sessionClock('GMT')(bar.time));
    const range = sessionRanges(bars, clock, options, true)[0];
    assert.equal(range.start, bars[2].time); assert.equal(range.end, bars[4].time);
    const cvd = bars.map(bar => ({ ...bar, high: bar.high - 300, low: bar.low - 300 }));
    assert.deepEqual(previousSessionRange(cvd, bars, clock, options), { start: bars[2].time, end: bars[4].time, high: -186, low: -214 });
    assert.equal(previousSessionRange(cvd.filter((_, i) => i !== 3), bars, clock, options), null);
  }
});

test('actual Sessions rendering shares selected hours across boxes, opening lines and retained Fibonacci', async () => {
  const { createSessionLevels } = await import('./session-levels.js');
  const { DEFAULTS } = await import('./session-settings.js');
  const { priceToY } = await import('@tradecanvas/core');
  const settings = structuredClone(DEFAULTS); settings.zone = 'GMT';
  for (const options of Object.values(settings.sessions)) Object.assign(options, { enabled: false, fibonacci: false });
  Object.assign(settings.sessions.london, { enabled: true, start: '08:00', end: '10:00', season: 'Mùa đông', winterStart: '09:00', winterEnd: '11:00', showOpen: true, openColor: '#aa00ff', fibonacci: true });
  settings.fibonacci.levels = { p500: true }; settings.fibonacci.colors.p500 = '#face00'; settings.fibonacci.history = true;
  const bars = [7, 8, 9, 10, 11, 12].map(hour => ({ time: Date.UTC(2026, 10, 16, hour), open: 100 + hour,
    high: hour === 9 ? 110 : hour === 10 ? 130 : 1000, low: hour === 9 ? 90 : hour === 10 ? 80 : 0, close: 100 }));
  const active = { id: 'texmoonbeam-sessions', instanceId: 'sessions', visible: true, shown: true };
  const config = { ...active, params: { sessionSettings: JSON.stringify(settings) } }, plugins = new Map();
  const chart = { getActiveIndicators: () => [active], getIndicatorConfig: () => config, getIndicatorPanes: () => [],
    getData: () => bars, getDisplayData: () => bars, isReplayActive: () => false, registerIndicator(plugin) { plugins.set(plugin.descriptor.id, plugin); }, on() {} };
  const levels = createSessionLevels({ value: settings, normalize: value => value, setPlacement() {}, placement: { present: true, visible: true } }, () => {});
  levels.attach({ getChart: () => chart, getSymbol: () => 'XAUUSDm', getTimeframe: () => '1h', openIndicatorSettings() {} });
  const plugin = plugins.get(active.id), boxes = [], strokes = [], stack = []; let path = [];
  const ctx = { save() { stack.push({ ...this }); }, restore() { Object.assign(this, stack.pop()); },
    beginPath() { path = []; }, rect() {}, clip() {}, setLineDash() {}, strokeRect() {}, strokeText() {}, fillText() {},
    fillRect(x, y, width, height) { boxes.push({ x, y, width, height }); }, moveTo(x, y) { path.push([x, y]); }, lineTo(x, y) { path.push([x, y]); },
    stroke() { strokes.push({ color: this.strokeStyle, path: [...path] }); } };
  const viewport = { chartRect: { x: 0, y: 0, width: 400, height: 300 }, barWidth: 8, barSpacing: 2, offset: 0,
    visibleRange: { from: 0, to: 5 }, priceRange: { min: 0, max: 200 } };
  plugin.render(ctx, plugin.calculate(bars, config), viewport);
  assert.equal(boxes.length, 1); assert.equal(boxes[0].y, priceToY(130, viewport));
  assert.equal(boxes[0].height, priceToY(80, viewport) - priceToY(130, viewport));
  assert.equal(strokes.find(row => row.color === '#aa00ffbf').path[0][1], priceToY(109, viewport));
  assert.equal(strokes.find(row => row.color === '#face00').path[0][1], priceToY(105, viewport));
  settings.sessions.london.season = 'Mùa hè'; config.params.sessionSettings = JSON.stringify(settings); boxes.length = 0;
  plugin.render(ctx, plugin.calculate(bars, config), viewport);
  assert.equal(boxes[0].y, priceToY(1000, viewport), 'the summer selection uses its original pair on the same date');
});
