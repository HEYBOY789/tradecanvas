const assert = require('node:assert/strict');
const { test } = require('node:test');
const HOUR = 3600000;

test('summer-entered session hours move one hour in winter, using separate UK and US calendars', async () => {
  const { seasonalSessionClock } = await import('./session-dst.js');
  const { sessionClock, sessionRanges } = await import('./session-levels.js');
  for (const [date, london, newYork] of [['2026-01-15', 9, 14], ['2026-03-16', 9, 13], ['2026-07-15', 8, 13], ['2026-10-26', 9, 13], ['2026-11-02', 9, 14], ['2027-03-15', 9, 13]]) {
    const bars = Array.from({ length: 18 }, (_, hour) => ({ time: Date.parse(`${date}T00:00Z`) + hour * HOUR, open: 100, high: 110, low: 90 }));
    const clock = bars.map(bar => sessionClock('GMT')(bar.time));
    for (const [id, start, wanted] of [['london', '08:00', london], ['newYork', '13:00', newYork]]) {
      const end = `${String(Number(start.slice(0, 2)) + 2).padStart(2, '0')}:00`;
      const adjusted = seasonalSessionClock(bars, clock, id, 'GMT');
      const range = sessionRanges(bars, adjusted, { start, end }, true)[0];
      assert.equal(range.start, Date.parse(`${date}T00:00Z`) + wanted * HOUR, `${date} ${id}`);
      assert.equal(range.end, range.start + HOUR);
    }
  }
});

test('DST changes at the actual transition minute and is not applied twice in a local DST timezone', async () => {
  const { seasonalSessionClock } = await import('./session-dst.js');
  const { sessionClock } = await import('./session-levels.js');
  for (const [id, zone, times, shifts] of [
    ['london', 'Europe/London', ['2026-03-29T00:59Z', '2026-03-29T01:00Z', '2026-10-25T00:59Z', '2026-10-25T01:00Z'], [60, 0, 0, 60]],
    ['newYork', 'America/New_York', ['2026-03-08T06:59Z', '2026-03-08T07:00Z', '2026-11-01T05:59Z', '2026-11-01T06:00Z'], [60, 0, 0, 60]],
  ]) {
    const bars = times.map(text => ({ time: Date.parse(text) }));
    const clock = bars.map(bar => sessionClock('GMT')(bar.time));
    const adjusted = seasonalSessionClock(bars, clock, id, 'GMT');
    assert.deepEqual(clock.map((value, i) => (value.day - adjusted[i].day) * 1440 + value.minute - adjusted[i].minute), shifts);
    const local = bars.map(bar => sessionClock(zone)(bar.time));
    assert.deepEqual(seasonalSessionClock(bars, local, id, zone), local, `${zone} already changes its own clock`);
  }
  const bars = ['2026-01-15', '2026-03-16', '2026-07-15', '2026-10-26', '2026-11-02'].map(date => ({ time: Date.parse(`${date}T12:00Z`) }));
  const clock = bars.map(bar => sessionClock('America/New_York')(bar.time));
  const london = seasonalSessionClock(bars, clock, 'london', 'America/New_York');
  assert.deepEqual(clock.map((value, i) => (value.day - london[i].day) * 1440 + value.minute - london[i].minute), [0, 60, 0, 60, 0]);
});

test('winter shifts crossing midnight keep session and completed CVD/Fibo ranges together', async () => {
  const { seasonalSessionClock } = await import('./session-dst.js');
  const { sessionClock, sessionRanges, previousSessionRange } = await import('./session-levels.js');
  const start = Date.parse('2026-11-16T17:00Z'); // 00:00 at GMT+7.
  const bars = Array.from({ length: 7 }, (_, index) => ({ time: start + index * HOUR / 2, open: 100, high: 110 + index, low: 90 - index }));
  const raw = bars.map(bar => sessionClock('GMT+7')(bar.time));
  const clock = seasonalSessionClock(bars, raw, 'newYork', 'GMT+7');
  const options = { start: '23:30', end: '01:00' };
  const range = sessionRanges(bars, clock, options, true)[0];
  assert.equal(range.start, bars[1].time); assert.equal(range.end, bars[3].time);
  const cvd = bars.map(bar => ({ ...bar, high: bar.high - 300, low: bar.low - 300 }));
  assert.deepEqual(previousSessionRange(cvd, bars, clock, options), { start: bars[1].time, end: bars[3].time, high: -187, low: -213 });
  assert.equal(previousSessionRange(cvd.filter((_, i) => i !== 2), bars, clock, options), null);
  assert.equal(seasonalSessionClock(bars, raw, 'asia', 'GMT+7'), raw, 'a session with no DST rule keeps the entered hours');
});

test('actual Sessions rendering uses the shifted range for the box, opening line and previous-session Fibo', async () => {
  const { createSessionLevels } = await import('./session-levels.js');
  const { DEFAULTS } = await import('./session-settings.js');
  const { priceToY } = await import('@tradecanvas/core');
  const settings = structuredClone(DEFAULTS); settings.zone = 'GMT';
  for (const options of Object.values(settings.sessions)) Object.assign(options, { enabled: false, fibonacci: false });
  Object.assign(settings.sessions.london, { enabled: true, autoDst: true, start: '08:00', end: '10:00', showOpen: true, openColor: '#aa00ff', fibonacci: true });
  settings.fibonacci.levels = { p500: true }; settings.fibonacci.colors.p500 = '#face00';
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
  settings.sessions.london.autoDst = false; config.params.sessionSettings = JSON.stringify(settings); boxes.length = 0;
  plugin.render(ctx, plugin.calculate(bars, config), viewport);
  assert.equal(boxes[0].y, priceToY(1000, viewport), 'unchecked settings retain the original manually entered hours');
});
