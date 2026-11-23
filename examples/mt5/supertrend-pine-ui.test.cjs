const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chromium } = require('playwright');

test('Supertrend Pine v4 has native settings and restores its indicator and alert in a saved layout', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
    page.setDefaultTimeout(8000);
    await require('./market-fixture.cjs').mockMarket(page);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/app.js', async route => {
      const response = await route.fetch();
      const marker = 'installGridLayoutPersistence(grid);';
      await route.fulfill({ response, body: (await response.text()).replace(marker, `${marker}\nwindow.testGrid = grid; window.testReady = layoutOperations;`) });
    });
    await page.goto(process.env.TRADECANVAS_URL || 'http://127.0.0.1:8772/');
    await page.waitForFunction(() => window.testReady && testGrid.getWidget(0).getChart().getData().length > 20).catch(async error => {
      const status = await page.locator('#status').textContent();
      throw new Error(`Fixture chart did not load. ${status} ${errors.join(' ')} ${error.message}`);
    });
    await page.evaluate(() => testReady.ready());
    await page.getByRole('button', { name: 'Chỉ báo', exact: true }).click();
    await page.getByRole('searchbox').fill('Supertrend');
    await page.getByText('Supertrend', { exact: true }).waitFor();
    await page.getByText('Supertrend (Pine v4)', { exact: true }).click();
    await page.keyboard.press('Escape');
    const row = page.locator('.tcw-ind-legend-row[data-instance*="supertrend-pine-v4"]');
    await row.locator('.tcw-ind-legend-name').click();
    const settings = page.getByRole('dialog', { name: 'Supertrend (Pine v4)' });
    assert.equal(await settings.getByLabel('Chu kỳ ATR', { exact: true }).inputValue(), '10');
    assert.equal(await settings.getByLabel('Hệ số ATR', { exact: true }).inputValue(), '3');
    await settings.getByLabel('Chu kỳ ATR', { exact: true }).fill('7');
    const inputRow = name => settings.locator('label').filter({ has: page.getByText(name, { exact: true }) });
    await inputRow('Nguồn giá').locator('select').selectOption('hlc3');
    for (const name of ['Dùng Wilder ATR (tắt để dùng SMA)', 'Hiện nhãn Buy/Sell', 'Tô vùng xu hướng']) {
      const toggle = inputRow(name).getByRole('switch');
      assert.equal(await toggle.getAttribute('aria-checked'), 'true');
      await toggle.click();
    }
    await settings.locator('[data-act="ok"]').click();
    await row.hover();
    await row.locator('[data-act="more"]').click();
    await page.getByRole('menuitemcheckbox', { name: 'Cảnh báo SuperTrend Buy', exact: true }).click();
    const saved = await page.evaluate(() => testGrid.getLayoutSession().saveAs('Supertrend Pine test'));
    await page.reload();
    await page.waitForFunction(id => window.testGrid?.getLayoutSession().current()?.id === id, saved.id);
    const restored = await page.evaluate(() => {
      const chart = testGrid.getWidget(0).getChart();
      const item = chart.getActiveIndicators().find(ind => ind.id === 'supertrend-pine-v4');
      const alert = chart.getAlerts().find(alert => alert.channel === `${item.instanceId}:trend`);
      return { params: item.params, condition: alert.condition, message: alert.message, close: alert.onBarClose };
    });
    assert.deepEqual(restored, { params: { period: 7, priceSource: 'hlc3', multiplier: 3, wilderATR: false, showSignals: false, highlight: false },
      condition: 'crossingUp', message: 'SuperTrend Buy!', close: true });

    const alerts = await page.evaluate(() => {
      const chart = testGrid.getWidget(0).getChart();
      const item = chart.getActiveIndicators().find(ind => ind.id === 'supertrend-pine-v4');
      chart.updateIndicator(item.instanceId, { period: 2, priceSource: 'hl2', multiplier: 1, wilderATR: true });
      const bars = [100, 102, 95, 95, 110, 112].map((close, i) => ({
        time: Date.UTC(2026, 10, 20) + i * 300000, open: close, close, high: close + 1, low: close - 1, volume: 1,
      }));
      const fired = [];
      chart.on('alertTriggered', ({ payload }) => fired.push(payload.message));
      chart.setData(bars.slice(0, 2));
      chart.updateLastBar(bars[1]);
      for (const bar of bars.slice(2, 5)) chart.appendBar(bar);
      const beforeClose = [...fired];
      chart.appendBar(bars[5]);
      return { beforeClose, fired };
    });
    assert.deepEqual(alerts, { beforeClose: [], fired: ['SuperTrend Buy!'] });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
