const assert = require('node:assert/strict');
const { test } = require('node:test');

test('Fibonacci uses only the selected levels and supports CVD and reverse direction', async () => {
  const { fibonacciLines } = await import('./session-levels.js');
  const { DEFAULTS } = await import('./session-settings.js');
  const settings = structuredClone(DEFAULTS);
  const range = { start: 1, end: 5, low: 100, high: 200 };
  assert.deepEqual(fibonacciLines(range, 'PD', settings).map(line => line.price), [123.6, 138.2, 150, 161.8, 178.6]);
  settings.fibonacci.levels = { p382: true, p500: true };
  settings.fibonacci.colors.p382 = '#123456';
  assert.deepEqual(fibonacciLines(range, 'PD', settings).map(line => [line.name, line.price, line.color]),
    [['38,2%', 138.2, '#123456'], ['50%', 150, '#089981']]);
  assert.ok(fibonacciLines(range, 'PD', settings).every(line => line.start === 1 && line.end === 5));
  settings.fibonacci.direction = 'High → Low';
  assert.deepEqual(fibonacciLines(range, 'PD', settings).map(line => line.price), [161.8, 150]);
  settings.fibonacci.direction = 'Low → High';
  assert.deepEqual(fibonacciLines({ start: 1, low: -200, high: -100 }, 'CVD', settings).map(line => line.price), [-161.8, -150]);
  settings.fibonacci.levels = {};
  assert.deepEqual(fibonacciLines(range, 'PD', settings), []);
});

test('previous sessions use the last finished range and reject partial histories', async () => {
  const { previousSessionRange, sessionClock } = await import('./session-levels.js');
  const time = text => Date.parse(`${text}:00Z`);
  const bars = ['2026-11-15T21:00', '2026-11-15T22:00', '2026-11-15T23:00',
    '2026-11-16T00:00', '2026-11-16T06:00', '2026-11-16T07:00', '2026-11-16T22:00']
    .map((text, i) => ({ time: time(text), open: 100, high: 100 + i, low: 90 - i, close: 100 }));
  const options = { start: '22:00', end: '07:00', extend: true };
  const clock = bars.map(bar => sessionClock('GMT')(bar.time));
  assert.deepEqual(previousSessionRange(bars, bars, clock, options), {
    start: time('2026-11-15T22:00'), end: time('2026-11-16T06:00'), high: 104, low: 86 });
  assert.equal(previousSessionRange(bars.slice(0, 5), bars.slice(0, 5), clock.slice(0, 5), options), null, 'ongoing session has no fixed Fibo');
  assert.equal(previousSessionRange(bars.slice(2), bars.slice(2), clock.slice(2), options), null, 'loaded history starts inside the session');
  assert.equal(previousSessionRange(bars.filter((_, i) => i !== 2), bars, clock, options), null, 'missing CVD samples cannot establish session extremes');
  const cvd = bars.map(bar => ({ ...bar, high: bar.high - 300, low: bar.low - 300 }));
  assert.deepEqual(previousSessionRange(cvd, bars, clock, options), {
    start: time('2026-11-15T22:00'), end: time('2026-11-16T06:00'), high: -196, low: -214 });
  const shifted = bars.map(bar => ({ ...bar, time: bar.time - 7 * 3600000 }));
  const local = shifted.map(bar => sessionClock('GMT+7')(bar.time));
  assert.equal(previousSessionRange(shifted, shifted, local, options).start, time('2026-11-15T15:00'));
});

test('session Fibo history keeps completed ranges and excludes partial or unfinished CVD ranges', async () => {
  const { closedSessionRanges, sessionClock } = await import('./session-levels.js');
  const time = (day, hour) => Date.UTC(2026, 10, day, hour);
  const bars = [15, 16, 17].flatMap(day => [7, 8, 9, 10].map(hour => ({
    time: time(day, hour), open: 100, high: 100 + day, low: 80 - day, close: 100,
  })));
  const clock = bars.map(bar => sessionClock('GMT')(bar.time));
  const options = { start: '08:00', end: '10:00', extend: true };
  const all = closedSessionRanges(bars, bars, clock, options, true);
  assert.deepEqual(all.map(range => [range.start, range.end]), [15, 16, 17].map(day => [time(day, 8), time(day, 9)]));
  assert.equal(closedSessionRanges(bars, bars, clock, options).length, 1);
  const incomplete = bars.filter(bar => bar.time !== time(16, 9));
  assert.deepEqual(closedSessionRanges(incomplete, bars, clock, options, true).map(range => range.start), [time(15, 8), time(17, 8)]);
  assert.deepEqual(closedSessionRanges(bars.slice(2), bars.slice(2), clock.slice(2), options, true).map(range => range.start), [time(16, 8), time(17, 8)]);
  const ongoing = bars.slice(0, -1);
  assert.deepEqual(closedSessionRanges(ongoing, ongoing, clock.slice(0, -1), options, true).map(range => range.start), [time(15, 8), time(16, 8)]);
});

test('day, week and month Fibos follow each period settings independently', async () => {
  const { periodLines } = await import('./session-levels.js');
  const { DEFAULTS } = await import('./session-settings.js');
  const settings = structuredClone(DEFAULTS);
  for (const id of ['previousDay', 'previousWeek', 'previousMonth']) {
    settings.periods[id].fibonacciLevels = { p500: true };
  }
  const periods = {
    day: [{ time: Date.UTC(2026, 10, 13), high: 200, low: 100 }, { time: Date.UTC(2026, 10, 15, 23), high: 500, low: 300 }],
    week: [{ time: 100, high: 400, low: 200 }, { time: 200, high: 800, low: 400 }],
    month: [{ time: 10, high: 2000, low: 1000 }, { time: 20, high: 4000, low: 2000 }],
  };
  const fibos = periodLines(periods, settings).filter(line => line.fibonacci);
  assert.deepEqual(fibos.map(line => [line.id, line.name, line.price, line.start, line.periodId]), [
    ['PD:fibonacci:p500', 'PD 50%', 150, Date.UTC(2026, 10, 13), 'previousDay'],
    ['PW:fibonacci:p500', 'PW 50%', 300, 100, 'previousWeek'],
    ['PMth:fibonacci:p500', 'PMth 50%', 1500, 10, 'previousMonth'],
  ]);
  Object.assign(settings.periods.previousDay, { extend: true, label: false, offset: 12,
    style: 'dashed', width: 3, labelOutlineColor: '#123456' });
  const day = periodLines(periods, settings).find(line => line.periodId === 'previousDay');
  for (const key of ['extend', 'label', 'offset', 'style', 'width', 'labelOutlineColor']) {
    assert.equal(day.options[key], settings.periods.previousDay[key], key);
  }
  settings.periods.previousWeek.fibonacciLevels = { p382: true };
  settings.periods.previousWeek.fibonacciColors.p382 = '#112233';
  const week = periodLines(periods, settings).find(line => line.periodId === 'previousWeek');
  assert.equal(week.name, 'PW 38,2%');
  assert.equal(week.color, '#112233');
  assert.equal(periodLines(periods, settings).find(line => line.periodId === 'previousDay').name, 'PD 50%');
  settings.periods.previousDay.enabled = false;
  assert.ok(!periodLines(periods, settings).some(line => line.periodId === 'previousDay'), 'period visibility also controls its Fibo');
  settings.periods.previousDay.enabled = true;
  settings.periods.previousDay.fibonacci = false;
  assert.ok(!periodLines(periods, settings).some(line => line.id === 'PD:fibonacci:p500'));
  periods.week[1] = null;
  assert.doesNotThrow(() => periodLines(periods, settings), 'partial CVD period loading is supported');
});
