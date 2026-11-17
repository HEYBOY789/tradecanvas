const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chromium } = require('playwright');
const { tradingPage, setOneClick } = require('./trading-fixture.cjs');

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

async function dragPoint(page, point, dy, dx = 0) {
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  await page.mouse.move(point.x + dx, point.y + dy, { steps: 5 }); await page.mouse.up();
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
    assert.equal(await page.getByRole('alert').filter({ hasText: fixture.checkError }).isVisible(), true);
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
    await page.mouse.click(point.x + 100, point.y + 50);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(fixture.checked.length, 0);
    assert.equal(fixture.executed.length, 0);
    assert.equal(await page.evaluate(() => testGrid.getWidget(0).getChart().getDrawings().length), 1, 'the drawing tool still receives its points');
  } finally { await browser.close(); }
});

test('reserved modifiers, eraser and zoom keep their gestures on both whole lines and stop labels', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser);
    fixture.positions = [];
    await page.waitForFunction(() => testGrid.getWidget(0).getChart().getPositions().length === 0);
    for (const modifier of ['Shift', 'Control', 'Meta', 'Alt']) {
      const point = await linePoint(page, 3750);
      await page.keyboard.down(modifier);
      try { await dragPoint(page, point, 25, 50); }
      finally { await page.keyboard.up(modifier); }
      const label = page.getByRole('button', { name: 'Kéo SL lệnh 321', exact: true });
      const rect = await label.boundingBox(); assert.ok(rect);
      await page.keyboard.down(modifier);
      try { await dragPoint(page, { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, 15); }
      finally { await page.keyboard.up(modifier); }
      await page.keyboard.press('Escape');
      assert.equal(fixture.checked.length, 0, modifier);
    }
    const mode = page.getByRole('button', { name: 'Kéo SL/TP từ Entry', exact: true });
    for (const tool of ['setEraserMode', 'setZoomAreaMode']) {
      await mode.click();
      await page.evaluate(tool => testGrid.getWidget(0).getChart()[tool](true), tool);
      assert.equal(await mode.getAttribute('aria-pressed'), 'false');
      assert.equal(await mode.isDisabled(), true);
      await dragPoint(page, await linePoint(page, 3750), 25, 50);
      await page.evaluate(tool => testGrid.getWidget(0).getChart()[tool](false), tool);
      assert.equal(fixture.checked.length, 0, tool);
    }
    await mode.click(); await page.keyboard.press('Escape');
    assert.equal(await mode.getAttribute('aria-pressed'), 'false');
    assert.equal(fixture.executed.length, 0); assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});

test('SL/TP mode updates both exits of an existing sell position without moving its filled entry', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser);
    fixture.orders = [];
    Object.assign(fixture.positions[0], { side: 'sell', stopLoss: null, takeProfit: null });
    await page.waitForFunction(() => testGrid.getWidget(0).getChart().getOrders().length === 0 && testGrid.getWidget(0).getChart().getPositions()[0].side === 'sell');
    await setOneClick(page);
    const mode = page.getByRole('button', { name: 'Kéo SL/TP từ Entry', exact: true }); await mode.click();
    async function acceptedDrag(price, dy) {
      const point = await linePoint(page, price);
      const accepted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/trading/execute');
      await dragPoint(page, point, dy); await accepted;
      await page.waitForFunction(() => !document.querySelector('[aria-label="Mua nhanh MT5"]').disabled);
    }
    await acceptedDrag(3800, 40); assert.ok(fixture.positions[0].takeProfit < 3800);
    const tp = fixture.positions[0].takeProfit;
    await acceptedDrag(3800, -45); assert.ok(fixture.positions[0].stopLoss > 3800);
    const sl = fixture.positions[0].stopLoss;
    await acceptedDrag(3800, 25); assert.notEqual(fixture.positions[0].takeProfit, tp);
    assert.equal(fixture.positions[0].stopLoss, sl);
    await acceptedDrag(sl, -15); assert.ok(fixture.positions[0].stopLoss > sl);
    assert.equal(fixture.positions[0].entryPrice, 3800);
    assert.equal(fixture.executed.length, 4); assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});

test('a polling snapshot started before an accepted stop edit cannot restore its old stop value', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser);
    fixture.orders = [];
    await page.waitForFunction(() => testGrid.getWidget(0).getChart().getOrders().length === 0);
    await setOneClick(page);
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
