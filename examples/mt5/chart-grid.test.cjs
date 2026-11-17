const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chromium } = require('playwright');

test('native chart picker, independent MT5 timeframes and saved layouts', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1740, height: 1000 } });
    await require('./market-fixture.cjs').mockMarket(page);
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/app.js', async route => {
      const response = await route.fetch();
      const marker = 'installGridLayoutPersistence(grid);';
      await route.fulfill({ response, body: (await response.text()).replace(marker, `${marker}\nwindow.testGrid = grid;`) });
    });
    const url = process.env.TRADECANVAS_URL || 'http://127.0.0.1:8772/';
    await page.goto(url);
    await page.waitForFunction(() => window.testGrid?.getWidget(0).getChart().getData().length > 20);

    // Seed the format used by the single-chart host and reopen its active id.
    await page.evaluate(() => {
      const widget = testGrid.getWidget(0);
      widget.setSettings({ timezone: 'Europe/London' });
      const content = widget.captureLayout();
      content.sessions.zone = 'GMT+3';
      for (const indicator of content.chart.indicators) delete indicator.params.sessionSettings;
      const layout = { id: 'legacy-test', name: 'Chart cũ', kind: 'chart', updatedAt: Date.now() };
      localStorage.setItem('tcw:layouts:index', JSON.stringify([layout]));
      localStorage.setItem('tcw:layouts:item:legacy-test', JSON.stringify(content));
      localStorage.setItem('mt5:active-layout:v1', layout.id);
      localStorage.removeItem('mt5:grid-layouts-migrated:v1');
    });
    await page.reload();
    await page.waitForFunction(() => window.testGrid?.getLayoutSession().current()?.id === 'legacy-test');
    assert.equal(await page.evaluate(() => testGrid.getWidget(0).getSettings().timezone), 'Europe/London');
    assert.equal(await page.evaluate(() => {
      const sessions = testGrid.getWidget(0).getChart().getActiveIndicators().find(item => item.id === 'texmoonbeam-sessions');
      return JSON.parse(sessions.params.sessionSettings).zone;
    }), 'GMT+3');

    const picker = page.getByRole('button', { name: /^Cách chia biểu đồ/ });
    async function pick(layout) {
      await picker.click();
      await page.locator(`.tcw-grid-picker [data-layout="${layout}"]`).click();
    }
    await pick('1x2');
    const gridCharts = page.locator('.tcw-grid-cell');
    assert.equal(await gridCharts.count(), 2);
    await page.waitForFunction(() => testGrid.getWidgets().every(widget => {
      const chart = widget.getChart();
      const cvd = chart.getActiveIndicators().find(item => item.id === 'mt5-cvd-candle');
      return chart.getData().length > 20 && chart.getIndicatorOutput(cvd.instanceId)?.values.size > 20;
    }));
    assert.deepEqual(await page.evaluate(() => testGrid.getWidgets().map(w => w.getTimeframe())), ['5m', '15m']);

    await gridCharts.nth(1).locator('.tcw-tf-more').click();
    await page.locator('[data-tf-pick="1h"]:visible').click();
    await page.waitForFunction(() => testGrid.getWidget(1).getTimeframe() === '1h' && testGrid.getWidget(1).getChart().getData().length > 20);
    assert.equal(await page.evaluate(() => testGrid.getWidget(0).getTimeframe()), '5m');
    await page.evaluate(() => testGrid.getWidget(1).setSettings({ timezone: 'Asia/Tokyo' }));
    await pick('1x1');
    assert.equal(await gridCharts.count(), 1);
    await pick('1x2');
    await page.waitForFunction(() => testGrid.getWidget(1).getSettings().timezone === 'Asia/Tokyo');
    const saved = await page.evaluate(() => testGrid.getLayoutSession().saveAs('M5 và H1'));
    await page.reload();
    await page.waitForFunction(id => window.testGrid?.getLayoutSession().current()?.id === id, saved.id);
    assert.deepEqual(await page.evaluate(() => testGrid.getWidgets().map(w => [w.getTimeframe(), w.getSettings().timezone])),
      [['5m', 'Europe/London'], ['1h', 'Asia/Tokyo']]);
    await Promise.all(['5m', '1h'].map(frame => page.waitForResponse(response => {
      const params = new URL(response.url()).searchParams;
      return response.ok() && params.get('frame') === frame && params.has('since');
    })));
    await pick('2x2');
    assert.equal(await gridCharts.count(), 4);
    await page.waitForFunction(() => testGrid.getWidgets().every(widget => widget.getChart().getData().length > 20));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
