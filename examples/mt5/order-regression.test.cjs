const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chromium } = require('playwright');
const { tradingPage } = require('./trading-fixture.cjs');

async function linePoint(page, price) {
  return page.evaluate(async price => {
    const { priceToY } = await import('/vendor/core/index.js');
    const widget = testGrid.getWidget(0), chart = widget.getChart();
    chart.setAutoScale(false); chart.viewport.setPriceRange(3700, 3860); chart.requestRender();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const viewport = chart.viewport.getState(), rect = widget.chartContainer.getBoundingClientRect();
    return { x: rect.left + viewport.chartRect.x + viewport.chartRect.width / 2, y: rect.top + priceToY(price, viewport) };
  }, price);
}

test('a rejected SL drag restores broker values and keeps the exact failure visible after polling', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser);
    fixture.orders = [];
    await page.waitForFunction(() => testGrid.getWidget(0).getChart().getOrders().length === 0);
    fixture.checkError = 'Bật nút Algo Trading trong MT5 (Ctrl+E).';
    const point = await linePoint(page, 3790);
    const checked = page.waitForResponse(response => new URL(response.url()).pathname === '/api/trading/check');
    await page.mouse.move(point.x, point.y); await page.mouse.down();
    await page.mouse.move(point.x, point.y + 30, { steps: 5 }); await page.mouse.up();
    assert.equal((await checked).status(), 400);
    await page.waitForResponse(response => new URL(response.url()).pathname === '/api/trading/state');
    assert.equal(fixture.executed.length, 0);
    assert.equal(await page.evaluate(() => testGrid.getWidget(0).getChart().getPositions()[0].stopLoss), 3790);
    assert.equal(await page.getByRole('alert').filter({ hasText: fixture.checkError }).count(), 1);
    assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});

test('an active drawing tool retains its Shift drag instead of changing a live pending order', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser);
    fixture.positions = [];
    await page.waitForFunction(() => testGrid.getWidget(0).getChart().getPositions().length === 0);
    const point = await linePoint(page, 3750);
    await page.evaluate(() => testGrid.getWidget(0).getChart().setDrawingTool('trendLine'));
    await page.keyboard.down('Shift');
    try {
      await page.mouse.move(point.x, point.y); await page.mouse.down();
      await page.mouse.move(point.x + 70, point.y + 30, { steps: 5 }); await page.mouse.up();
    } finally { await page.keyboard.up('Shift'); }
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(fixture.checked.length, 0);
    assert.equal(fixture.executed.length, 0);
  } finally { await browser.close(); }
});

test('a polling snapshot started before an accepted stop edit cannot restore its old stop value', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser);
    fixture.orders = [];
    await page.waitForFunction(() => testGrid.getWidget(0).getChart().getOrders().length === 0);
    await page.getByLabel('One-click trading trên chart', { exact: true }).check();
    fixture.pauseNextState = true;
    const limit = Date.now() + 3000;
    while (!fixture.releaseState && Date.now() < limit) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(fixture.releaseState, 'captured an old polling snapshot');
    const point = await linePoint(page, 3790);
    const accepted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/trading/execute');
    await page.mouse.move(point.x, point.y); await page.mouse.down();
    await page.mouse.move(point.x, point.y + 30, { steps: 5 }); await page.mouse.up();
    await accepted;
    assert.notEqual(fixture.positions[0].stopLoss, 3790, 'broker fixture accepted the new stop');
    fixture.releaseState();
    await page.waitForFunction(() => !document.querySelector('[aria-label="Mua nhanh MT5"]').disabled);
    assert.equal(await page.evaluate(() => testGrid.getWidget(0).getChart().getPositions()[0].stopLoss), fixture.positions[0].stopLoss);
    assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});
