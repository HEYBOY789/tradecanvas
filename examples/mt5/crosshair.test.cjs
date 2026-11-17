const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chromium } = require('playwright');

test('crosshair shares one vertical line across price and indicator panes', async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 930 } });
    await require('./market-fixture.cjs').mockMarket(page);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/app.js', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const marker = 'installPaneScale(widget.getChart());';
      assert.ok(source.includes(marker));
      await route.fulfill({ response, body: source.replace(marker,
        `${marker}\nwindow.crosshairTestChart = widget.getChart();`) });
    });
    await page.goto(process.env.TRADECANVAS_URL || 'http://127.0.0.1:8772/');
    await page.waitForFunction(() => window.crosshairTestChart?.getData().length > 0);
    await page.waitForFunction(() => {
      const chart = window.crosshairTestChart, cvd = chart.getActiveIndicators().find(item => item.id === 'mt5-cvd-candle');
      return cvd && chart.getIndicatorOutput(cvd.instanceId)?.values.size > 20;
    });
    const points = await page.evaluate(async () => {
      const chart = window.crosshairTestChart;
      chart.addIndicator('rsi');
      const data = chart.getData();
      chart.setVisibleRange(data[240].time, data[430].time);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      function record(owner, method, key) {
        const render = owner[method];
        owner[method] = function (ctx, ...args) {
          const begin = ctx.beginPath;
          const move = ctx.moveTo;
          const line = ctx.lineTo;
          const stroke = ctx.stroke;
          let path = [];
          const paths = [];
          ctx.beginPath = function () { path = []; return begin.call(this); };
          ctx.moveTo = function (x, y) { path.push({ x, y }); return move.call(this, x, y); };
          ctx.lineTo = function (x, y) { path.push({ x, y }); return line.call(this, x, y); };
          ctx.stroke = function (...values) { paths.push(path.slice()); return stroke.apply(this, values); };
          try {
            return render.call(this, ctx, ...args);
          } finally {
            ctx.beginPath = begin;
            ctx.moveTo = move;
            ctx.lineTo = line;
            ctx.stroke = stroke;
            window.crosshairPaths[key] = paths;
          }
        };
      }

      window.crosshairPaths = {};
      record(chart.engine, 'renderPanelCrosshair', 'panes');
      record(chart.crosshairHandler, 'render', 'price');
      const main = chart.viewport.getState().chartRect;
      const panels = chart.getIndicatorPanes().map(pane => pane.rect);
      const bounds = chart.container.getBoundingClientRect();
      return { main, panels, bounds: { x: bounds.x, y: bounds.y } };
    });

    async function hover(rect, mode = 'magnet', xFraction = 0.583) {
      await page.evaluate(mode => window.crosshairTestChart.setCrosshairMode(mode), mode);
      const x = points.main.x + points.main.width * xFraction;
      const y = rect.y + rect.height * 0.55;
      await page.mouse.move(points.bounds.x + x, points.bounds.y + y);
      await page.waitForTimeout(100);
      return page.evaluate(() => window.crosshairPaths);
    }

    function verticals(paths) {
      return Object.values(paths).flat().filter(path => path.length === 2 &&
        Math.abs(path[0].x - path[1].x) < 0.001 && Math.abs(path[0].y - path[1].y) > 20);
    }

    function checkColumns(paths) {
      const lines = verticals(paths);
      for (const rect of [points.main, ...points.panels]) {
        assert.ok(lines.some(line => line[0].y <= rect.y + 1 && line[1].y >= rect.y + rect.height - 1),
          `crosshair must reach the bottom of pane: ${JSON.stringify({ rect, lines, panels: points.panels })}`);
      }
      assert.ok(Math.max(...lines.map(line => line[0].x)) - Math.min(...lines.map(line => line[0].x)) < 0.01,
        'all panes must draw the same time column');
    }

    const onPrice = await hover(points.main);
    checkColumns(onPrice);
    for (const panel of points.panels) {
      const paths = await hover(panel);
      checkColumns(paths);
      const horizontal = paths.panes.filter(path => path.length === 2 && path[0].y === path[1].y);
      assert.equal(horizontal.length, 1, 'horizontal crosshair belongs to the hovered pane');
    }
    checkColumns(await hover(points.main, 'normal'));
    checkColumns(await hover(points.panels[0], 'normal'));

    await hover(points.main);
    await page.evaluate(() => window.crosshairTestChart.setCrosshairCursor('arrow'));
    await page.waitForTimeout(100);
    assert.equal(verticals(await page.evaluate(() => window.crosshairPaths)).length, 0);
    await page.evaluate(() => window.crosshairTestChart.setCrosshairCursor('cross'));
    await hover(points.main, 'hidden');
    assert.equal(verticals(await page.evaluate(() => window.crosshairPaths)).length, 0);

    await hover(points.main);
    await page.waitForResponse(response => response.ok() && response.url().includes('since='));
    await page.waitForTimeout(100);
    checkColumns(await page.evaluate(() => window.crosshairPaths));
    await page.mouse.move(2, 2);
    await page.waitForTimeout(100);
    assert.equal(verticals(await page.evaluate(() => window.crosshairPaths)).length, 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
