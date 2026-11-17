const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdir } = require('node:fs/promises');
const { chromium } = require('playwright');
const { tradingPage } = require('./trading-fixture.cjs');

test('order panel fits phone, laptop and wide layouts in light/dark themes and three widget looks', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser);
    await page.getByRole('button', { name: 'Đặt lệnh MT5', exact: true }).click();
    const panel = page.locator('#mt5-ticket:not([hidden])'); await panel.waitFor();
    await panel.getByRole('tab', { name: 'Limit', exact: true }).click();
    await panel.getByRole('switch', { name: 'Bật Stop Loss', exact: true }).check();
    await panel.getByRole('switch', { name: 'Bật Take Profit', exact: true }).check();
    await panel.locator('[name=price]').fill('3800');
    await panel.locator('[name=stopLoss]').fill('3790'); await panel.locator('[name=takeProfit]').fill('3820');
    await panel.locator('.order-ticket-receipt').getByText('0,001 USD', { exact: true }).waitFor();
    const directory = process.env.TRADECANVAS_VISUALS || 'artifacts/order-panel'; await mkdir(directory, { recursive: true });
    for (const width of [390, 1366, 1920]) for (const theme of ['dark', 'light']) for (const look of ['print', 'studio', 'terminal']) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1050 });
      await page.evaluate(({ theme, look }) => { testGrid.setTheme(theme); testGrid.setUI(look); }, { theme, look });
      await page.waitForTimeout(180);
      const bounds = await panel.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
      const metrics = await panel.evaluate(root => ({ width: root.clientWidth, overflow: root.scrollWidth > root.clientWidth,
        bg: getComputedStyle(root).backgroundColor, submit: root.querySelector('.order-ticket-submit').getBoundingClientRect().bottom,
        viewport: innerHeight }));
      assert.equal(metrics.overflow, false, `${width} ${theme} ${look}: no horizontal panel overflow`);
      assert.ok(metrics.submit <= metrics.viewport + 1, 'Buy/Sell action stays visible without scrolling');
      assert.equal(metrics.bg, theme === 'dark' ? 'rgb(19, 23, 34)' : 'rgb(255, 255, 255)');
      await page.screenshot({ path: `${directory}/${width}-${theme}-${look}.png` });
    }
    assert.equal(fixture.executed.length, 0); assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});
