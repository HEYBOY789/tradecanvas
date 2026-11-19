const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chromium } = require('playwright');
const { tradingPage } = require('./trading-fixture.cjs');

test('Sell Limit starts at a valid price and explains a blocked draft beside both submit controls', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser);
    await page.setViewportSize({ width: 1366, height: 768 });
    fixture.quote = { bid: 3800, ask: 3800.01, stops: .05 };
    await page.waitForResponse(response => new URL(response.url()).pathname === '/api/trading/state');
    await page.getByRole('button', { name: 'Đặt lệnh MT5', exact: true }).click();
    const ticket = page.locator('#mt5-ticket:not([hidden])');
    await ticket.getByRole('button', { name: 'Chọn Bán', exact: true }).click();
    await ticket.getByRole('tab', { name: 'Limit', exact: true }).click();
    const entry = ticket.locator('[name=price]');
    const submit = ticket.locator('.order-ticket-submit');
    const chartSubmit = page.getByRole('button', { name: 'Gửi lệnh nháp từ chart', exact: true });
    const status = ticket.getByRole('status');
    assert.ok(Number(await entry.inputValue()) >= 3800.05, 'new Sell Limit must clear Bid plus the minimum stop distance');
    await page.waitForFunction(() => !document.querySelector('.order-ticket-submit').disabled);
    await page.evaluate(() => {
      const chart = testGrid.getWidget(0).getChart();
      chart.setAutoScale(false); chart.viewport.setPriceRange(3760, 3840); chart.requestRender();
    });
    await chartSubmit.waitFor();
    assert.equal(await chartSubmit.isEnabled(), true);

    // The other input order, Limit then Sell, also needs a valid starting price.
    await ticket.getByRole('button', { name: 'Chọn Mua', exact: true }).click();
    assert.ok(Number(await entry.inputValue()) <= 3799.96);
    await ticket.getByRole('button', { name: 'Chọn Bán', exact: true }).click();
    assert.ok(Number(await entry.inputValue()) >= 3800.05);

    await entry.fill('3800.02');
    const blocked = /Sell Limit.*Bid.*0\.05/;
    assert.match(await status.textContent(), blocked);
    assert.equal(await status.evaluate(node => Boolean(node.closest('.order-ticket-content'))), false, 'reason stays in view next to submit');
    assert.equal(await submit.isDisabled(), true);
    await page.waitForFunction(() => document.querySelector('.mt5-projection-send').disabled);
    assert.match(await chartSubmit.getAttribute('title'), blocked);
    assert.equal(await chartSubmit.evaluate(node => getComputedStyle(node).cursor), 'not-allowed');

    fixture.estimateError = 'MT5 chưa tính được khối lượng.';
    await entry.fill('3810');
    await status.filter({ hasText: fixture.estimateError }).waitFor();
    assert.equal(await chartSubmit.isDisabled(), true);
    assert.match(await chartSubmit.getAttribute('title'), /chưa tính được khối lượng/);
    fixture.estimateError = '';
    await entry.fill('3811');
    await page.waitForFunction(() => !document.querySelector('.mt5-projection-send').disabled);

    // A newer quote may invalidate an explicit Entry, but must never move it.
    fixture.quote = { ...fixture.quote, bid: 3812, ask: 3812.01 };
    await status.filter({ hasText: blocked }).waitFor();
    assert.equal(await entry.inputValue(), '3811');
    assert.equal(await submit.isDisabled(), true);
    fixture.quote = { ...fixture.quote, bid: 3800, ask: 3800.01 };
    await page.waitForFunction(() => !document.querySelector('.mt5-projection-send').disabled);
    await chartSubmit.click();
    await page.locator('#mt5-review').waitFor();
    assert.deepEqual(fixture.checked.at(-1).intent, { side: 'sell', type: 'limit', quantity: .01, price: 3811, timeInForce: 'gtc' });
    await page.locator('#mt5-review').getByRole('button', { name: 'Hủy', exact: true }).click();
    assert.equal(fixture.executed.length, 0);
    assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});
