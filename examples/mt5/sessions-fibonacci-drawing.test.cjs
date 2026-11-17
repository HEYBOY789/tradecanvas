const assert = require('node:assert/strict');
const { test } = require('node:test');

test('Fibonacci is drawn inside the closed session with centered outlined numbers', async () => {
  const { createSessionLevels } = await import('./session-levels.js');
  const { DEFAULTS } = await import('./session-settings.js');
  const settings = structuredClone(DEFAULTS);
  settings.zone = 'GMT';
  settings.fibonacci.levels = { p382: true, p500: true };
  settings.fibonacci.colors.p382 = '#123456';
  settings.fibonacci.colors.p500 = '#654321';
  settings.fibonacci.labelOutlineColor = '#aabbcc';
  settings.fibonacci.labelOutlineWidth = .25;
  // A stale layout's former extension flag must not extend Fibonacci.
  settings.fibonacci.extend = true;
  for (const options of Object.values(settings.sessions)) Object.assign(options, { enabled: false, fibonacci: false });
  Object.assign(settings.sessions.london, { start: '08:00', end: '10:00', fibonacci: true });
  const time = hour => Date.UTC(2026, 10, 16, hour);
  const bars = [7, 8, 9, 10].map(hour => ({ time: time(hour), open: 110, high: 150, low: 100, close: 120 }));
  const active = { id: 'texmoonbeam-sessions', instanceId: 'sessions', visible: true, shown: true };
  const config = { ...active, params: { sessionSettings: JSON.stringify(settings) } };
  const plugins = new Map();
  const chart = {
    getActiveIndicators: () => [active],
    getIndicatorConfig: () => config,
    getIndicatorPanes: () => [],
    getData: () => bars,
    getDisplayData: () => bars,
    isReplayActive: () => false,
    registerIndicator(plugin) { plugins.set(plugin.descriptor.id, plugin); },
    on() {},
  };
  const levels = createSessionLevels({ value: settings, normalize: value => value,
    setPlacement() {}, placement: { present: true, visible: true } }, () => {});
  levels.attach({ getChart: () => chart, getSymbol: () => 'XAUUSDm', getTimeframe: () => '1h', openIndicatorSettings() {} });
  const plugin = plugins.get(active.id);
  const output = plugin.calculate(bars, config);
  const strokes = [];
  const texts = [];
  const stack = [];
  let path = [];
  const ctx = {
    save() { stack.push({ strokeStyle: this.strokeStyle, fillStyle: this.fillStyle, lineWidth: this.lineWidth,
      textAlign: this.textAlign, textBaseline: this.textBaseline }); },
    restore() { Object.assign(this, stack.pop()); },
    beginPath() { path = []; }, rect() {}, clip() {}, setLineDash() {},
    moveTo(x, y) { path.push([x, y]); }, lineTo(x, y) { path.push([x, y]); },
    stroke() { strokes.push({ color: this.strokeStyle, path: [...path] }); },
    strokeText(text, x, y) { texts.push({ kind: 'outline', text, x, y, color: this.strokeStyle, width: this.lineWidth, align: this.textAlign, baseline: this.textBaseline }); },
    fillText(text, x, y) { texts.push({ kind: 'fill', text, x, y, color: this.fillStyle, align: this.textAlign, baseline: this.textBaseline }); },
  };
  const viewport = { chartRect: { x: 0, y: 0, width: 400, height: 300 },
    barWidth: 8, barSpacing: 2, offset: 0, visibleRange: { from: 0, to: 3 }, priceRange: { min: 100, max: 150 } };
  plugin.render(ctx, output, viewport);
  assert.deepEqual(strokes.map(line => [line.color, line.path[0][0], line.path[1][0]]),
    [['#123456', 9, 29], ['#654321', 9, 29]], 'both lines end at the session box boundary');
  assert.deepEqual(texts.filter(text => text.kind === 'fill').map(text => [text.text, text.color, text.x]),
    [['38,2%', '#123456', 19], ['50%', '#654321', 19]]);
  assert.ok(texts.every(text => text.align === 'center' && text.baseline === 'middle'));
  assert.ok(texts.filter(text => text.kind === 'outline').every(text => text.color === '#aabbcc'));
  assert.ok(texts.filter(text => text.kind === 'outline').every(text => text.width === .25), 'label outline accepts a fractional width');
  assert.equal(texts[0].y, texts[1].y, 'outline and fill share the same baseline');

  bars.push(...[7, 8, 9, 10].map(hour => ({ time: Date.UTC(2026, 10, 17, hour), open: 110, high: 160, low: 90, close: 120 })));
  settings.fibonacci.history = true;
  config.params.sessionSettings = JSON.stringify(settings);
  const historyOutput = plugin.calculate(bars, config);
  strokes.length = 0; texts.length = 0;
  plugin.render(ctx, historyOutput, { ...viewport, visibleRange: { from: 0, to: 7 } });
  assert.equal(strokes.length, 4, 'two levels are retained on each completed session');
  assert.deepEqual(strokes.map(line => line.path[0][0]), [9, 9, 49, 49]);
  assert.deepEqual(texts.filter(text => text.kind === 'fill').map(text => text.x), [19, 19, 59, 59]);
  for (const options of Object.values(settings.sessions)) Object.assign(options, { start: '08:00', end: '10:00', enabled: false, fibonacci: true });
  settings.fibonacci.levels = { p000: true, p100: true }; settings.fibonacci.history = false;
  config.params.sessionSettings = JSON.stringify(settings); strokes.length = 0; texts.length = 0;
  plugin.render(ctx, plugin.calculate(bars, config), { ...viewport, visibleRange: { from: 0, to: 7 }, priceRange: { min: 80, max: 170 } });
  assert.deepEqual(texts.filter(text => text.kind === 'fill').map(text => text.text), ['PAL', 'PAH', 'PLDL', 'PLDH', 'PNYL', 'PNYH']);
  settings.fibonacci.labelOutlineWidth = 0;
  config.params.sessionSettings = JSON.stringify(settings); texts.length = 0;
  plugin.render(ctx, plugin.calculate(bars, config), { ...viewport, visibleRange: { from: 0, to: 7 }, priceRange: { min: 80, max: 170 } });
  assert.equal(texts.filter(text => text.kind === 'outline').length, 0, 'zero disables the text stroke');
  assert.equal(texts.filter(text => text.kind === 'fill').length, 6, 'labels remain visible without an outline');
});
