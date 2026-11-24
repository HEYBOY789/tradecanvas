const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chromium } = require('playwright');
const { mockMarket } = require('./market-fixture.cjs');

test('the existing drawing gains profile settings and restores them after reload', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(15000);
    await mockMarket(page);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const network = [];
    page.on('requestfailed', request => network.push(new URL(request.url()).pathname + ' ' + request.failure()?.errorText));
    page.on('console', message => { if (message.type() === 'error') network.push(message.text()); });
    const requests = [];
    await page.route('**/api/profile-bars?**', route => {
      const query = new URL(route.request().url()).searchParams;
      const from = Number(query.get('from')), to = Number(query.get('to'));
      requests.push({ frame: query.get('frame'), from, to });
      const step = 300_000, last = Date.UTC(2026, 10, 17, 12);
      const bars = [];
      for (let time = from; time < to; time += step) {
        const i = 599 - (last - time) / step;
        const price = 3800 + Math.sin(i / 17) * 12;
        bars.push({ time, open: price - 2, high: price - 2, low: price - 2, close: price - 2, volume: 100 + i % 30 });
      }
      return route.fulfill({ json: { server: 'Fixture', bars } });
    });
    await page.addInitScript(() => {
      window.profilePaint = {};
      const fillText = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...args) {
        if (/^(POC|VAH|VAL) /.test(text)) profilePaint[text.slice(0, 3)] = { text, x, y, color: this.fillStyle };
        return fillText.call(this, text, x, y, ...args);
      };
    });
    await page.route('**/app.js', async route => {
      const response = await route.fetch();
      const marker = 'installGridLayoutPersistence(grid);';
      const body = (await response.text()).replace(marker, marker + '\nwindow.testGrid = grid; window.testReady = layoutOperations;');
      await route.fulfill({ response, body });
    });
    await page.goto(process.env.TRADECANVAS_URL);
    const ready = () => page.waitForFunction(() => window.testReady && testGrid.getWidget(0).getChart().getData().length > 200);
    await ready().catch(async error => {
      throw Error([await page.locator('#status').textContent(), ...errors, ...network, error.message].join('\n'));
    });
    await page.evaluate(() => testReady.ready());

    // A saved drawing from before the extra settings has no options object.
    const coordinates = await page.evaluate(async () => {
      const widget = testGrid.getWidget(0);
      const chart = widget.getChart();
      const { timeToX, priceToY } = await import('/vendor/core/index.js');
      const data = chart.getData();
      const a = data.at(-40), b = data.at(-8), m = data.at(-20);
      chart.setDrawings([{ id: 'old-profile', type: 'volumeProfileRange', visible: true, locked: false,
        anchors: [{ time: b.time, price: b.high }, { time: a.time, price: a.low }],
        style: { color: '#4f91df', lineWidth: 1, lineStyle: 'dashed' } }]);
      chart.setDrawingOptions('old-profile', { source: 'chart' });
      const bounds = widget.chartContainer.getBoundingClientRect();
      const view = { ...chart.viewport.getState(), data };
      return { x: bounds.left + timeToX(m.time, view), y: bounds.top + priceToY(m.close, view),
        start: a.time, end: b.time + 300_000 };
    });
    await page.waitForFunction(() => profilePaint.POC && profilePaint.VAH && profilePaint.VAL);
    const chartPoc = await page.evaluate(() => profilePaint.POC.text);
    await Promise.all([
      page.waitForResponse(response => response.url().includes('/api/profile-bars?')),
      page.evaluate(() => testGrid.getWidget(0).getChart().setDrawingOptions('old-profile', { source: 'auto' })),
    ]);
    assert.deepEqual(requests[0], { frame: '1m', from: coordinates.start, to: coordinates.end });
    await page.waitForFunction(previous => profilePaint.POC.text !== previous, chartPoc).catch(async error => {
      const state = await page.evaluate(() => {
        const chart = testGrid.getWidget(0).getChart();
        return { paint: profilePaint, symbol: chart.getSymbolInfo(), options: chart.getDrawingOptions('old-profile'),
          bar: chart.getData().at(-20) };
      });
      throw new Error(JSON.stringify({ chartPoc, state, errors, requests }) + ' ' + error.message);
    });

    await page.mouse.dblclick(coordinates.x, coordinates.y);
    const settings = page.getByRole('dialog', { name: 'Fixed Range Volume Profile' });
    await settings.waitFor();
    const field = label => settings.locator('label').filter({ has: page.getByText(label, { exact: true }) });
    const rowSize = field('Kích thước hàng').locator('input');
    assert.equal(await rowSize.inputValue(), '40');
    await field('Chia hàng theo').locator('select').selectOption('ticks');
    await rowSize.fill('500');
    await rowSize.press('Tab');
    await field('Hiển thị volume').locator('select').selectOption('delta');
    await field('Vị trí histogram').locator('select').selectOption('right');
    const beforeExtension = await page.evaluate(() => profilePaint.POC.x);
    await field('Kéo dài sang phải theo nến mới').getByRole('checkbox').check();
    await field('Hiện POC theo từng nến').getByRole('checkbox').check();
    const color = field('Màu POC').locator('input[type="color"]');
    await color.fill('#a815d1');
    await settings.locator('[data-act="ok"]').click();
    await page.waitForFunction(oldX => profilePaint.POC.color === '#a815d1' && profilePaint.POC.x > oldX, beforeExtension);
    const saved = await page.evaluate(() => testGrid.getLayoutSession().saveAs('Fixed range profile'));
    await page.reload();
    await ready();
    await page.evaluate(() => testReady.ready());
    const restored = await page.evaluate(() => {
      const chart = testGrid.getWidget(0).getChart();
      const drawing = chart.getDrawings().find(d => d.id === 'old-profile');
      const { rowMode, rowSize, volumeMode, profileSide, extendToLive, showDevelopingPoc, pocColor } = drawing.options;
      return { id: testGrid.getLayoutSession().current()?.id, rowMode, rowSize, volumeMode, profileSide, extendToLive, showDevelopingPoc, pocColor };
    });
    assert.deepEqual(restored, { id: saved.id, rowMode: 'ticks', rowSize: 500, volumeMode: 'delta', profileSide: 'right',
      extendToLive: true, showDevelopingPoc: true, pocColor: '#a815d1' });
    await page.evaluate(() => testGrid.getWidget(0).getChart().removeDrawing('old-profile'));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
