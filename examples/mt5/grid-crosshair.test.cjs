const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chromium } = require('playwright');

test('M5 and M15 mirror the crosshair price even within the same candle', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1740, height: 1000 } });
    await page.route('**/app.js', async route => {
      const response = await route.fetch();
      const marker = 'installGridLayoutPersistence(grid);';
      await route.fulfill({ response, body: (await response.text()).replace(marker, `${marker}\nwindow.testGrid = grid; window.testReady = layoutOperations;`) });
    });
    await page.goto(process.env.TRADECANVAS_URL || 'http://127.0.0.1:8772/');
    await page.waitForFunction(() => window.testGrid);
    await page.evaluate(async () => {
      await testReady.ready(); testGrid.getLayoutSession().setAutoSave(false);
      testGrid.setLayout('1x2'); testGrid.setSync({ timeframe: false, crosshair: true });
      await Promise.all(testGrid.getWidgets().map((widget, index) => widget.setTimeframe(index ? '15m' : '5m')));
    });
    await page.waitForFunction(() => testGrid.getWidgets().every(widget => widget.getChart().getData().length > 100));
    const moves = await page.evaluate(async () => {
      const { priceToY, barIndexToX } = await import('/vendor/core/index.js');
      const [left, right] = testGrid.getWidgets().map(widget => widget.getChart());
      right.setInvertScale(true);
      const end = left.getData().at(-2).time;
      const start = end - 2 * 3600000;
      for (const chart of [left, right]) chart.setVisibleRange(start, end);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      for (const chart of [left, right]) chart.setAutoScale(false);
      window.crosshairLines = [];
      const render = right.engine.renderPanelCrosshair;
      right.engine.renderPanelCrosshair = function (ctx, ...args) {
        const { beginPath, moveTo, lineTo, stroke } = ctx;
        let path;
        const lines = [];
        ctx.beginPath = function () { path = []; return beginPath.call(this); };
        ctx.moveTo = function (x, y) { path?.push([x, y]); return moveTo.call(this, x, y); };
        ctx.lineTo = function (x, y) { path?.push([x, y]); return lineTo.call(this, x, y); };
        ctx.stroke = function (...params) {
          if (path?.length === 2 && path[0][1] === path[1][1]) lines.push(path);
          return stroke.apply(this, params);
        };
        try { return render.call(this, ctx, ...args); }
        finally {
          Object.assign(ctx, { beginPath, moveTo, lineTo, stroke });
          window.crosshairLines = lines;
        }
      };
      const from = left.viewport.getState();
      const to = right.viewport.getState();
      const low = Math.max(from.priceRange.min, to.priceRange.min);
      const high = Math.min(from.priceRange.max, to.priceRange.max);
      const index = Math.floor((from.visibleRange.from + from.visibleRange.to) / 2);
      const bounds = left.container.getBoundingClientRect();
      return [0.3, 0.65].map(ratio => {
        const price = low + (high - low) * ratio;
        return { x: bounds.x + barIndexToX(index, from), y: bounds.y + priceToY(price, from),
          expected: priceToY(price, to), step: from.barWidth + from.barSpacing };
      });
    });
    for (const move of moves) {
      await page.mouse.move(move.x, move.y);
      await page.waitForFunction(y => window.crosshairLines.some(line => Math.abs(line[0][1] - y) < 2), move.expected, { timeout: 3000 });
    }
    assert.ok(Math.abs(moves[0].expected - moves[1].expected) > 5, 'same candle has different cursor prices');
    await page.evaluate(() => testGrid.setSync({ crosshair: false }));
    await page.waitForFunction(() => window.crosshairLines.length === 0);
    await page.evaluate(() => testGrid.setSync({ crosshair: true }));
    await page.mouse.move(moves[0].x, moves[0].y);
    await page.mouse.move(moves[0].x + moves[0].step, moves[0].y);
    await page.waitForFunction(y => window.crosshairLines.some(line => Math.abs(line[0][1] - y) < 2), moves[0].expected, { timeout: 3000 });
    await page.mouse.move(3, 3);
    await page.waitForFunction(() => window.crosshairLines.length === 0);
  } finally {
    await browser.close();
  }
});
