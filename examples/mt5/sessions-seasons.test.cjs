const assert = require('node:assert/strict');
const { test } = require('node:test');

test('legacy hours seed independent seasonal pairs and discard the old controls', async () => {
  const { withSessionSeasons } = await import('./session-seasons.js');
  const defaults = { start: '08:00', end: '17:00' };
  const legacy = { start: '23:15', end: '01:45', autoDst: false, season: 'Mùa hè', color: '#123456' };
  for (const id of ['london', 'newYork']) {
    const result = withSessionSeasons(id, legacy, defaults);
    assert.equal(result.start, '23:15'); assert.equal(result.end, '01:45');
    assert.equal(result.winterStart, '00:15'); assert.equal(result.winterEnd, '02:45');
    assert.equal('season' in result, false); assert.equal(result.color, '#123456');
    assert.equal('autoDst' in result, false);
  }
  const asia = withSessionSeasons('asia', legacy, defaults);
  assert.equal(asia.winterStart, '23:15'); assert.equal(asia.winterEnd, '02:45');
  assert.equal(legacy.autoDst, false, 'migration leaves its input intact');
  const invalid = withSessionSeasons('london', { start: '25:00', end: '', winterStart: 'oops', season: 'automatic' }, defaults);
  assert.equal(invalid.start, '08:00'); assert.equal(invalid.end, '17:00');
  assert.equal(invalid.winterStart, '09:00'); assert.equal(invalid.winterEnd, '18:00');
  assert.equal('season' in invalid, false);
});

test('regional calendars choose editable hours, including weeks when UK and US seasons differ', async () => {
  const { withSessionSeasons, sessionSchedule } = await import('./session-seasons.js');
  const summer = { start: '07:15', end: '16:45' };
  for (const id of ['asia', 'london', 'newYork']) {
    const snapshot = { ...summer, season: 'Mùa đông', winterStart: '22:30', winterEnd: '03:15' };
    const options = withSessionSeasons(id, snapshot, summer);
    const schedule = sessionSchedule(id, options);
    const winter = schedule(Date.parse('2026-01-15T12:00Z')), summerHours = schedule(Date.parse('2026-07-15T12:00Z'));
    assert.deepEqual([winter.start, winter.end], ['22:30', '03:15']);
    assert.deepEqual([options.start, options.end], ['07:15', '16:45']);
    assert.deepEqual([summerHours.start, summerHours.end], ['07:15', '16:45']);
    for (const date of ['2026-03-16T12:00Z', '2026-10-26T12:00Z']) {
      assert.equal(schedule(Date.parse(date)).start, id === 'newYork' ? '07:15' : '22:30');
    }
    assert.equal(schedule(Date.parse('2006-03-20T12:00Z')).start, '22:30', 'historical US rules predate the 2007 change');
    const changed = withSessionSeasons(id, { ...options, start: '05:00', end: '11:00' }, summer);
    assert.deepEqual([changed.winterStart, changed.winterEnd], ['22:30', '03:15']);
  }
});

test('automatic overnight ranges and CVD closure use the same seasonal pair', async () => {
  const { sessionClock, sessionRanges, previousSessionRange } = await import('./session-levels.js');
  const options = { start: '23:00', end: '00:00', winterStart: '23:30', winterEnd: '01:00' };
  for (const [month, first, last] of [[0, 2, 4], [6, 1, 2]]) {
    const start = Date.UTC(2026, month, 16, 22, 30);
    const bars = Array.from({ length: 7 }, (_, i) => ({ time: start + i * 1800000, open: 100, high: 110 + i, low: 90 - i }));
    const clock = bars.map(bar => sessionClock('GMT')(bar.time));
    const range = sessionRanges(bars, clock, options, true, 'newYork')[0];
    assert.equal(range.start, bars[first].time); assert.equal(range.end, bars[last].time);
    const cvd = bars.map(bar => ({ ...bar, high: bar.high - 300, low: bar.low - 300 }));
    assert.deepEqual(previousSessionRange(cvd, bars, clock, options, 'newYork'), { start: bars[first].time, end: bars[last].time, high: -190 + last, low: -210 - last });
    assert.equal(previousSessionRange(cvd.filter((_, i) => i !== first), bars, clock, options, 'newYork'), null);
  }
});

test('actual Sessions rendering shares automatic hours across boxes, opening lines and retained Fibonacci', async () => {
  const { createSessionLevels } = await import('./session-levels.js');
  const { DEFAULTS } = await import('./session-settings.js');
  const { priceToY } = await import('@tradecanvas/core');
  const settings = structuredClone(DEFAULTS); settings.zone = 'GMT';
  for (const options of Object.values(settings.sessions)) Object.assign(options, { enabled: false, fibonacci: false });
  Object.assign(settings.sessions.london, { enabled: true, start: '08:00', end: '10:00', season: 'Mùa hè', winterStart: '09:00', winterEnd: '11:00', showOpen: true, openColor: '#aa00ff', fibonacci: true });
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
  bars.forEach(bar => { const date = new Date(bar.time); date.setUTCMonth(6); bar.time = date.getTime(); }); boxes.length = 0;
  plugin.render(ctx, plugin.calculate(bars, config), viewport);
  assert.equal(boxes[0].y, priceToY(1000, viewport), 'historical summer bars use the other pair without editing settings');
});

test('season switches at each regional transition rather than browser midnight', async () => {
  const { sessionSchedule } = await import('./session-seasons.js');
  const options = { start: '07:00', end: '16:00', winterStart: '08:30', winterEnd: '18:15' };
  for (const [id, date, before, after] of [
    ['asia', '2026-03-29T01:00:00Z', '08:30', '07:00'],
    ['asia', '2026-10-25T01:00:00Z', '07:00', '08:30'],
    ['london', '2026-03-29T01:00:00Z', '08:30', '07:00'],
    ['london', '2026-10-25T01:00:00Z', '07:00', '08:30'],
    ['newYork', '2026-03-08T07:00:00Z', '08:30', '07:00'],
    ['newYork', '2026-11-01T06:00:00Z', '07:00', '08:30'],
  ]) {
    const schedule = sessionSchedule(id, options), time = Date.parse(date);
    assert.equal(schedule(time - 1).start, before); assert.equal(schedule(time).start, after);
  }
});

test('Asia can close at the European open in both seasons, with matching CVD and Fibonacci membership', async () => {
  const { sessionClock, sessionRanges, closedSessionRanges } = await import('./session-levels.js');
  const asia = { start: '22:00', end: '07:00', winterStart: '22:00', winterEnd: '08:00' };
  const london = { start: '07:00', end: '16:00', winterStart: '08:00', winterEnd: '17:00' };
  for (const [month, day, endHour] of [[0, 16, 8], [6, 16, 7], [2, 16, 8], [9, 26, 8]]) {
    const start = Date.UTC(2026, month, day - 1, 22);
    const bars = Array.from({ length: 14 }, (_, i) => ({ time: start + i * 3600000, open: 100, high: 110 + i, low: 90 - i }));
    const clock = bars.map(bar => sessionClock('GMT')(bar.time));
    const range = sessionRanges(bars, clock, asia, true, 'asia')[0];
    const europe = sessionRanges(bars, clock, london, true, 'london')[0];
    assert.equal(range.end + 3600000, Date.UTC(2026, month, day, endHour));
    assert.equal(range.end + 3600000, europe.start, 'the Asian close follows London rather than the earlier US switch');
    const cvd = bars.map(bar => ({ ...bar, high: bar.high - 300, low: bar.low - 300 }));
    assert.deepEqual(closedSessionRanges(cvd, bars, clock, asia, true, 'asia'), [{
      start: range.start, end: range.end, high: range.high - 300, low: range.low - 300,
    }]);
  }
});

test('retained history chooses each season within one chart and checks its own opening boundary', async () => {
  const { sessionClock, closedSessionRanges } = await import('./session-levels.js');
  const options = { start: '07:00', end: '09:00', winterStart: '09:00', winterEnd: '11:00' };
  const bars = [27, 30].flatMap(day => [6, 7, 8, 9, 10, 11, 12].map(hour => ({
    time: Date.UTC(2026, 2, day, hour), open: 100, high: 100 + hour, low: 100 - hour,
  })));
  const clock = bars.map(bar => sessionClock('GMT')(bar.time));
  const ranges = closedSessionRanges(bars, bars, clock, options, true, 'london');
  assert.deepEqual(ranges.map(range => [range.start, range.end, range.high, range.low]), [
    [Date.UTC(2026, 2, 27, 9), Date.UTC(2026, 2, 27, 10), 110, 90],
    [Date.UTC(2026, 2, 30, 7), Date.UTC(2026, 2, 30, 8), 108, 92],
  ]);
  const partial = bars.slice(4), partialClock = clock.slice(4);
  assert.equal(closedSessionRanges(partial, partial, partialClock, options, true, 'london').length, 1);
  const complete = bars.slice(3), completeClock = clock.slice(3);
  assert.equal(closedSessionRanges(complete, complete, completeClock, options, true, 'london').length, 2);
});

test('entered pairs stay literal in the configured timezone, including local zones that already change clocks', async () => {
  const { sessionClock, sessionRanges } = await import('./session-levels.js');
  const options = { start: '08:00', end: '10:00', winterStart: '08:00', winterEnd: '10:00' };
  for (const [month, first] of [[0, 8], [6, 7]]) {
    const bars = [6, 7, 8, 9, 10, 11].map(hour => ({ time: Date.UTC(2026, month, 16, hour), open: 100, high: 110, low: 90 }));
    const clock = bars.map(bar => sessionClock('Europe/London')(bar.time));
    const range = sessionRanges(bars, clock, options, true, 'london')[0];
    assert.equal(range.start, Date.UTC(2026, month, 16, first));
    assert.equal(range.end, Date.UTC(2026, month, 16, first + 1));
  }
  const bars = [11, 12, 13, 14, 15].map(hour => ({ time: Date.UTC(2026, 0, 16, hour), open: 100, high: 110, low: 90 }));
  const local = { start: '18:00', end: '20:00', winterStart: '19:00', winterEnd: '21:00' };
  const range = sessionRanges(bars, bars.map(bar => sessionClock('GMT+7')(bar.time)), local, true, 'newYork')[0];
  assert.equal(range.start, bars[1].time); assert.equal(range.end, bars[2].time);
});

test('a clock-change night never joins separate seasonal windows through excluded bars', async () => {
  const { sessionClock, closedSessionRanges } = await import('./session-levels.js');
  const options = { start: '01:30', end: '03:00', winterStart: '22:00', winterEnd: '00:30' };
  const start = Date.UTC(2026, 2, 28, 21, 30);
  const bars = Array.from({ length: 25 }, (_, i) => ({ time: start + i * 900000, open: 100,
    high: i === 13 ? 1000 : 110, low: i === 13 ? -1000 : 90 }));
  const clock = bars.map(bar => sessionClock('GMT')(bar.time));
  const ranges = closedSessionRanges(bars, bars, clock, options, true, 'london');
  assert.deepEqual(ranges, [
    { start: Date.UTC(2026, 2, 28, 22), end: Date.UTC(2026, 2, 29, 0, 15), high: 110, low: 90 },
    { start: Date.UTC(2026, 2, 29, 1, 30), end: Date.UTC(2026, 2, 29, 2, 45), high: 110, low: 90 },
  ]);
  const ongoing = bars.slice(0, 19), ongoingClock = clock.slice(0, 19);
  assert.equal(closedSessionRanges(ongoing, ongoing, ongoingClock, options, true, 'london').length, 1,
    'the completed winter window remains eligible while the summer window on the same day is still open');
});
