const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chromium } = require('playwright');
const { tradingPage } = require('./trading-fixture.cjs');

test('right-click deletes only the targeted price alert and the deletion survives reopening the layout', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser);
    const { point, otherPoint } = await page.evaluate(async () => {
      const { priceToY } = await import('/vendor/core/index.js');
      const widget = testGrid.getWidget(0), chart = widget.getChart();
      chart.setAutoScale(false); chart.viewport.setPriceRange(3750, 3850);
      chart.addAlert(3830, 'crossingUp', 'Remove this line');
      chart.addAlert(3780, 'crossingDown', 'Keep this line');
      const cvd = chart.getActiveIndicators().find(row => row.id === 'mt5-cvd-candle');
      chart.addAlert(3830, 'crossingUp', 'Indicator alert', `${cvd.instanceId}:close`);
      chart.requestRender();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const view = chart.viewport.getState(), bounds = widget.chartContainer.getBoundingClientRect();
      const at = (x, price) => ({ x: bounds.left + x, y: bounds.top + priceToY(price, view) });
      return { point: at(view.chartRect.x + view.chartRect.width / 2, 3830), otherPoint: at(view.chartRect.x + view.chartRect.width / 2, 3840) };
    });
    const saved = await page.evaluate(() => testGrid.getLayoutSession().saveAs('Price alert removal'));
    await page.mouse.click(otherPoint.x, otherPoint.y, { button: 'right' });
    const menu = page.getByRole('menu', { name: 'Biểu đồ', exact: true });
    await menu.waitFor();
    assert.equal(await menu.getByRole('menuitem', { name: /^Xóa cảnh báo/ }).count(), 0);
    await page.keyboard.press('Escape');
    await page.evaluate(() => testGrid.getLayoutSession().setAutoSave(true));
    const autoSave = page.waitForResponse(response => new URL(response.url()).pathname === '/api/layouts' && response.request().method() === 'POST');
    await page.mouse.click(point.x, point.y, { button: 'right' });
    await menu.getByRole('menuitem', { name: /^Xóa cảnh báo tại / }).click({ timeout: 3000 });

    const alerts = () => page.evaluate(() => testGrid.getWidget(0).getChart().getAlerts().map(a => a.message).sort());
    assert.deepEqual(await alerts(), ['Indicator alert', 'Keep this line']);
    assert.ok((await autoSave).ok(), 'deleting a price alert auto-saves the active layout');
    await page.reload(); await page.waitForFunction(() => window.testReady);
    await page.evaluate(async () => { await testReady.ready(); testGrid.getLayoutSession().setAutoSave(false); });
    assert.equal(await page.evaluate(() => testGrid.getLayoutSession().current()?.id), saved.id);
    assert.deepEqual(await alerts(), ['Indicator alert', 'Keep this line']);
    await page.getByRole('button', { name: 'Cảnh báo giá', exact: true }).first().click();
    const remaining = page.locator('.tcw-alerts-row').filter({ hasText: 'Keep this line' });
    await remaining.getByRole('button', { name: /^X(oá|óa) cảnh báo$/ }).click();
    assert.deepEqual(await alerts(), ['Indicator alert']);
    assert.deepEqual(fixture.executed, []);
    assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});
