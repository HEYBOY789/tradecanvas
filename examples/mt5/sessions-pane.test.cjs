const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chromium } = require('playwright');

const PANEL = 'texmoonbeam-sessions-panel';
const CVD = 'mt5-cvd-candle';

test('Sessions has its own pane, merges with CVD and survives layout reload', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/app.js', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace(
        'installGridLayoutPersistence(grid);', 'installGridLayoutPersistence(grid); window.testGrid = grid; window.testWidget = grid.getWidget(0);') });
    });
    await page.goto(process.env.TRADECANVAS_URL || 'http://127.0.0.1:8772/');
    await page.waitForFunction(() => window.testWidget?.getChart().getActiveIndicators()
      .some(item => item.id === 'mt5-cvd-candle' && window.testWidget.getChart().getIndicatorOutput(item.instanceId)?.values.size > 20));
    await page.getByRole('button', { name: 'Chỉ báo', exact: true }).click();
    await page.locator('input:visible').first().fill('All-In-One Sessions');
    await page.getByText('All-In-One Sessions · Ô riêng / CVD', { exact: true }).click();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.testWidget.getChart().getActiveIndicators().some(item => item.id === 'texmoonbeam-sessions-panel'));
    const ids = await page.evaluate(() => {
      const chart = window.testWidget.getChart();
      return Object.fromEntries(chart.getActiveIndicators().map(item => [item.id, item.instanceId]));
    });
    const inspect = () => page.evaluate(({ panel, cvd }) => {
      const chart = window.testWidget.getChart();
      const source = chart.getIndicatorOutput(cvd);
      const output = chart.getIndicatorOutput(panel);
      const time = [...output.values.keys()].at(-1);
      return { panes: chart.getIndicatorPanes().map(pane => pane.instanceIds),
        source: source.values.get(time), actual: output.values.get(time), count: output.values.size,
        config: chart.getIndicatorConfig(panel), sourceId: output.meta.sourceId };
    }, { panel: ids[PANEL], cvd: ids[CVD] });
    let state = await inspect();
    assert.equal(state.sourceId, ids[CVD]);
    assert.ok(state.count > 20);
    for (const key of ['open', 'high', 'low', 'close']) assert.equal(state.actual[key], state.source[key], key);
    assert.ok(state.panes.some(pane => pane.length === 1 && pane[0] === ids[PANEL]), 'independent Sessions pane');

    const row = page.locator(`.tcw-ind-legend-row[data-instance="${ids[PANEL]}"]`);
    await row.locator('.tcw-ind-legend-name').click();
    const dialog = page.getByRole('dialog', { name: 'All-In-One Sessions' });
    await dialog.waitFor();
    await dialog.getByLabel('Múi giờ phiên').selectOption('GMT+7');
    await dialog.getByRole('button', { name: 'Áp dụng' }).click();
    await row.hover();
    await row.locator('[data-act="more"]').click();
    await page.getByRole('menuitem', { name: 'Ghép vào CVD Candle', exact: true }).click();
    state = await inspect();
    assert.ok(state.panes.some(pane => pane.includes(ids[PANEL]) && pane.includes(ids[CVD])), 'shared CVD pane');
    assert.ok(!state.panes.some(pane => pane.length === 1 && pane[0] === ids[PANEL]));
    const painted = await page.evaluate(async panelId => {
      const chart = window.testWidget.getChart();
      const engine = chart.indicatorEngine;
      const render = engine.renderPanel;
      const boxes = [];
      engine.renderPanel = function (ctx, ...args) {
        const fill = ctx.fillRect;
        ctx.fillRect = function (x, y, width, height) {
          if (['#4caf50', '#f23645', '#00bcd4'].includes(this.fillStyle) && width > 10) {
            boxes.push({ x, y, width, height });
          }
          return fill.call(this, x, y, width, height);
        };
        try { return render.call(this, ctx, ...args); } finally { ctx.fillRect = fill; }
      };
      try {
        chart.requestRender();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      } finally { engine.renderPanel = render; }
      const pane = chart.buildPanelRenderInfos().find(info => info.instanceIds?.includes(panelId) ||
        chart.getIndicatorPanes().find(pane => pane.instanceIds.includes(panelId))?.instanceId === info.instanceId);
      return { boxes, rect: pane.viewport.chartRect };
    }, ids[PANEL]);
    assert.ok(painted.boxes.some(box => box.y < painted.rect.y + painted.rect.height &&
      box.y + box.height > painted.rect.y), 'session boxes are painted on the CVD pane');
    if (process.env.TRADECANVAS_SCREENSHOT) await page.screenshot({ path: process.env.TRADECANVAS_SCREENSHOT });

    // A source recalculation must propagate, including wick OHLC, not a flat close line.
    await page.evaluate(cvd => window.testWidget.getChart().updateIndicator(cvd, { reset: 'Không đặt lại' }), ids[CVD]);
    await page.waitForTimeout(1200);
    state = await inspect();
    for (const key of ['open', 'high', 'low', 'close']) assert.equal(state.actual[key], state.source[key], key);
    const saved = await page.evaluate(async () => {
      const widget = window.testWidget;
      const result = await window.testGrid.getLayoutSession().saveAs('Sessions CVD test');
      return { result, content: widget.layouts.captureLayout() };
    });
    assert.ok(saved.result);
    await page.reload();
    await page.waitForFunction(() => window.testGrid?.getLayoutSession().current());
    const restoredIds = await page.evaluate(() => Object.fromEntries(window.testWidget.getChart().getActiveIndicators()
      .map(item => [item.id, item.instanceId])));
    assert.ok(restoredIds[PANEL], 'Sessions is included in the restored layout');
    Object.assign(ids, restoredIds);
    await page.waitForFunction(cvd => window.testWidget.getChart().getIndicatorOutput(cvd)?.values.size > 20, ids[CVD]);
    state = await inspect();
    assert.equal(state.sourceId, ids[CVD]);
    assert.ok(state.panes.some(pane => pane.includes(ids[PANEL]) && pane.includes(ids[CVD])));

    const restored = page.locator(`.tcw-ind-legend-row[data-instance="${ids[PANEL]}"]`);
    await restored.hover();
    await restored.locator('[data-act="more"]').click();
    await page.getByRole('menuitem', { name: 'Tách Sessions ra ô riêng', exact: true }).click();
    state = await inspect();
    assert.ok(state.panes.some(pane => pane.length === 1 && pane[0] === ids[PANEL]));
    assert.equal(state.sourceId, ids[CVD]);

    const cvdRow = page.locator(`.tcw-ind-legend-row[data-instance="${ids[CVD]}"]`);
    await cvdRow.hover();
    await cvdRow.locator('[data-act="more"]').click();
    await page.getByRole('menuitem', { name: 'Thêm Sessions vào ô này', exact: true }).click();
    const count = await page.evaluate(() => window.testWidget.getChart().getActiveIndicators().filter(item => item.id === 'texmoonbeam-sessions-panel').length);
    assert.equal(count, 2);
    await cvdRow.hover();
    await cvdRow.locator('[data-act="more"]').click();
    await page.getByRole('menuitem', { name: 'Thêm Sessions vào ô này', exact: true }).click();
    assert.equal(await page.evaluate(() => window.testWidget.getChart().getActiveIndicators().filter(item => item.id === 'texmoonbeam-sessions-panel').length), 2);

    const periods = await page.evaluate(async () => {
      const { sourcePeriods, periodLines } = await import('/session-levels.js');
      const { DEFAULTS } = await import('/session-settings.js');
      const day = Date.UTC(2026, 10, 16);
      const timeline = [{ time: day }, { time: day + 300000 }];
      const bars = [{ time: day, open: 0, high: 50, low: -15, close: 20 },
        { time: day + 300000, open: 20, high: 80, low: -30, close: 40 }];
      const anchors = { day: [{ time: day - 86400000, high: 9999, low: 8888 }, { time: day, high: 9999, low: 8888 }], week: [], month: [] };
      const projected = sourcePeriods(anchors, timeline, bars);
      return { projected, lines: periodLines(projected, DEFAULTS), missing: sourcePeriods(anchors, timeline, bars.slice(1)) };
    });
    assert.equal(periods.projected.day[0], null, 'unavailable previous day stays missing');
    assert.equal(periods.projected.day[1].high, 80);
    assert.equal(periods.projected.day[1].low, -30);
    assert.ok(periods.lines.every(line => Math.abs(line.price) < 100), 'no price levels on CVD axis');
    assert.equal(periods.missing.day[1], null, 'incomplete source period is omitted');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
