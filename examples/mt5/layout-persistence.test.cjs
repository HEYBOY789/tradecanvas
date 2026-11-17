const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chromium } = require('playwright');

test('named layouts restore chart and Sessions timezones, including after reload', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/app.js', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const marker = 'installGridLayoutPersistence(grid);';
      assert.ok(source.includes(marker));
      await route.fulfill({ response, body: source.replace(marker,
        `${marker}\nwindow.testGrid = grid; window.testReady = layoutOperations; window.layoutTestWidget = grid.getWidget(0);`) });
    });

    async function settingsZone(value) {
      await page.locator('.tcw-ind-legend-row[data-instance*="texmoonbeam-sessions"] .tcw-ind-legend-name').click();
      const dialog = page.getByRole('dialog', { name: 'All-In-One Sessions' });
      await dialog.getByLabel('Múi giờ phiên').selectOption(value);
      await dialog.getByRole('button', { name: 'Áp dụng' }).click();
    }

    const read = () => page.evaluate(() => ({
      settings: layoutTestWidget.getSettings(),
      layout: testGrid.getLayoutSession().current(),
      sessions: JSON.parse(localStorage.getItem('mt5:texmoonbeam-sessions:v1')),
      indicators: layoutTestWidget.getChart().getActiveIndicators().map(item => item.id),
    }));

    await page.goto(process.env.TRADECANVAS_URL || 'http://127.0.0.1:8772/');
    await page.waitForFunction(() => window.layoutTestWidget?.getChart().getData().length > 0);
    await page.evaluate(async () => {
      await testReady.ready(); testGrid.getLayoutSession().setAutoSave(false); testGrid.setLayout('1x1');
      const chart = layoutTestWidget.getChart();
      chart.removeIndicators(chart.getActiveIndicators().filter(item => item.id === 'rsi').map(item => item.instanceId));
    });
    await page.evaluate(() => layoutTestWidget.setSettings({ timezone: 'UTC', gridVisible: false }));
    await settingsZone('GMT');
    const first = await page.evaluate(() => testGrid.getLayoutSession().saveAs('UTC layout'));
    const captured = await page.evaluate(() => JSON.parse(layoutTestWidget.getLayoutContent()));
    assert.equal(captured.settings.timezone, 'UTC');

    await page.evaluate(() => {
      layoutTestWidget.setSettings({ timezone: 'Asia/Tokyo', gridVisible: true });
      layoutTestWidget.getChart().addIndicator('rsi', { period: 7 });
    });
    await settingsZone('GMT+9');
    const second = await page.evaluate(() => testGrid.getLayoutSession().saveAs('Tokyo layout'));
    assert.equal(await page.evaluate(id => testGrid.getLayoutSession().open(id), first.id), true);
    let current = await read();
    assert.equal(current.settings.timezone, 'UTC');
    assert.equal(current.settings.gridVisible, false);
    assert.equal(current.sessions.zone, 'GMT');
    assert.ok(!current.indicators.includes('rsi'));

    await page.reload();
    await page.waitForFunction(id => window.testGrid?.getLayoutSession().current()?.id === id, first.id);
    current = await read();
    assert.equal(current.settings.timezone, 'UTC');
    assert.equal(current.settings.gridVisible, false);
    assert.equal(current.sessions.zone, 'GMT');
    assert.ok(current.indicators.includes('mt5-cvd-candle'));
    assert.equal(await page.evaluate(id => testGrid.getLayoutSession().open(id), second.id), true);
    current = await read();
    assert.equal(current.settings.timezone, 'Asia/Tokyo');
    assert.equal(current.settings.gridVisible, true);
    assert.equal(current.sessions.zone, 'GMT+9');
    assert.ok(current.indicators.includes('rsi'));

    // A layout saved by older versions has no timezone or Sessions snapshot.
    await page.evaluate(async () => {
      const old = layoutTestWidget.captureLayout();
      delete old.settings.timezone;
      delete old.sessions;
      await layoutTestWidget.applyLayoutContent(JSON.stringify(old));
    });
    assert.equal((await read()).settings.timezone, 'Asia/Tokyo');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
