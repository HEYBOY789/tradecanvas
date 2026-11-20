const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chromium } = require('playwright');
const { tradingPage, setOneClick } = require('./trading-fixture.cjs');

async function viewport(page) {
  await page.evaluate(async () => {
    const chart = testGrid.getWidget(0).getChart();
    chart.setAutoScale(false); chart.viewport.setPriceRange(3700, 3860); chart.requestRender();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function drag(page, point, dy, button = 'middle') {
  await page.mouse.move(point.x, point.y); await page.mouse.down({ button });
  await page.mouse.move(point.x, point.y + dy, { steps: 6 }); await page.mouse.up({ button });
}

async function draftPoint(page) {
  const rect = await page.getByRole('button', { name: 'Kéo Entry lệnh nháp', exact: true }).boundingBox();
  assert.ok(rect, 'draft Entry is visible');
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

async function livePoint(page, kind, id, label = false) {
  return page.evaluate(async ({ kind, id, label }) => {
    const { priceToY } = await import('/vendor/core/index.js');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const widget = testGrid.getWidget(0), chart = widget.getChart(), manager = chart.tradingManager;
    const bounds = widget.chartContainer.getBoundingClientRect(), viewport = chart.viewport.getState();
    const row = (kind === 'order' ? chart.getOrders() : chart.getPositions()).find(row => row.id === id);
    if (!label) return { x: bounds.left + viewport.chartRect.x + viewport.chartRect.width / 2,
      y: bounds.top + priceToY(row.price ?? row.entryPrice, viewport) };
    const button = manager.buttons.find(button => kind === 'order'
      ? button.action.type === 'cancelOrder' && button.action.orderId === id
      : button.action.type === 'closePosition' && button.action.positionId === id);
    const tag = manager.tagRects().find(rect => button.x + button.size / 2 >= rect.x && button.x + button.size / 2 <= rect.x + rect.width &&
      button.y + button.size / 2 >= rect.y && button.y + button.size / 2 <= rect.y + rect.height);
    // The top of the native label is outside the line's narrow hit area.
    return { x: bounds.left + tag.x + 10, y: bounds.top + tag.y + 2 };
  }, { kind, id, label });
}

async function accepted(page, action) {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/trading/execute');
  await action(); await response;
  await page.waitForFunction(() => !document.querySelector('[aria-label="Mua nhanh MT5"]').disabled);
}

async function checkStopReadout(page, field, price, entry) {
  const readout = page.locator('.mt5-stop-drag-readout:visible');
  await readout.waitFor({ timeout: 2000 });
  const formatted = await page.evaluate(price => testGrid.getWidget(0).getChart().formatPrice(price), price);
  const pips = Math.abs(price - entry) / .01;
  const formattedPips = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 8 }).format(pips);
  assert.equal(await readout.textContent(), `${field} ${formatted} · ${formattedPips} pip từ Entry`);
  return readout;
}

test('middle-drag from draft Entry creates SL/TP without enabling a mode or moving Entry', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser);
    await page.getByRole('button', { name: 'Đặt lệnh MT5', exact: true }).click();
    const ticket = page.locator('#mt5-ticket:not([hidden])'); await ticket.waitFor();
    await ticket.getByRole('tab', { name: 'Limit', exact: true }).click(); await ticket.locator('[name=price]').fill('3760');
    await viewport(page);
    assert.equal(await page.getByRole('button', { name: 'Kéo SL/TP từ Entry', exact: true }).getAttribute('aria-pressed'), 'false');
    const entry = await draftPoint(page);
    await page.mouse.move(entry.x, entry.y); await page.mouse.down({ button: 'middle' });
    await page.mouse.move(entry.x, entry.y + 20, { steps: 3 });
    const firstSL = Number(await ticket.locator('[name=stopLoss]').inputValue());
    await checkStopReadout(page, 'SL', firstSL, 3760);
    await page.mouse.move(entry.x, entry.y + 35, { steps: 3 });
    const sl = Number(await ticket.locator('[name=stopLoss]').inputValue());
    assert.notEqual(sl, firstSL);
    const readout = await checkStopReadout(page, 'SL', sl, 3760);
    await page.mouse.up({ button: 'middle' }); await readout.waitFor({ state: 'hidden' });
    assert.ok(sl > 0 && sl < 3760, `middle-drag must create SL below Entry, got ${sl}; Entry=${await ticket.locator('[name=price]').inputValue()}`);
    assert.equal(Number(await ticket.locator('[name=price]').inputValue()), 3760);
    await drag(page, await draftPoint(page), -55);
    assert.ok(Number(await ticket.locator('[name=takeProfit]').inputValue()) > 3760);
    assert.equal(Number(await ticket.locator('[name=stopLoss]').inputValue()), sl);
    assert.equal(Number(await ticket.locator('[name=price]').inputValue()), 3760);
    const tp = Number(await ticket.locator('[name=takeProfit]').inputValue());
    await drag(page, await draftPoint(page), 20);
    const replaced = Number(await ticket.locator('[name=stopLoss]').inputValue());
    assert.notEqual(replaced, sl); assert.equal(Number(await ticket.locator('[name=takeProfit]').inputValue()), tp);
    await drag(page, await draftPoint(page), -20, 'left');
    const delta = Number(await ticket.locator('[name=price]').inputValue()) - 3760;
    assert.ok(delta > 0);
    assert.ok(Math.abs(Number(await ticket.locator('[name=stopLoss]').inputValue()) - replaced - delta) < .002);
    assert.ok(Math.abs(Number(await ticket.locator('[name=takeProfit]').inputValue()) - tp - delta) < .002);
    await ticket.getByRole('switch', { name: 'Bật Stop Loss', exact: true }).uncheck();
    await ticket.getByRole('switch', { name: 'Bật Take Profit', exact: true }).uncheck();
    await ticket.getByRole('button', { name: 'Chọn Bán', exact: true }).click(); await ticket.locator('[name=price]').fill('3840');
    await viewport(page);
    await drag(page, await draftPoint(page), -30);
    assert.ok(Number(await ticket.locator('[name=stopLoss]').inputValue()) > 3840);
    await drag(page, await draftPoint(page), 40);
    assert.ok(Number(await ticket.locator('[name=takeProfit]').inputValue()) < 3840);
    assert.equal(Number(await ticket.locator('[name=price]').inputValue()), 3840);
    assert.equal(fixture.checked.length, 0); assert.equal(fixture.executed.length, 0);
    assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});

test('middle-drag from the native pending-order label creates exits and keeps the confirmation flow', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser);
    fixture.positions = []; fixture.orders[0].stopLoss = null; fixture.orders[0].takeProfit = null;
    await page.waitForFunction(() => !testGrid.getWidget(0).getChart().getPositions().length && testGrid.getWidget(0).getChart().getOrders()[0].stopLoss == null);
    await viewport(page);
    await drag(page, await livePoint(page, 'order', '321', true), 35);
    await page.locator('#mt5-review').waitFor({ timeout: 2000 });
    assert.equal(fixture.checked.at(-1).action, 'modifyOrder');
    assert.equal(fixture.checked.at(-1).intent.newPrice, 3750);
    assert.ok(fixture.checked.at(-1).intent.stopLoss < 3750);
    assert.equal(fixture.executed.length, 0, 'release opens review while one-click is off');
    await page.locator('#mt5-review').getByRole('button', { name: 'Gửi tới MT5', exact: true }).click();
    await page.locator('#mt5-review').waitFor({ state: 'detached' });
    await setOneClick(page);
    await accepted(page, async () => drag(page, await livePoint(page, 'order', '321', true), -45));
    const previous = { ...fixture.orders[0] };
    assert.ok(previous.takeProfit > previous.price);
    await accepted(page, async () => drag(page, await livePoint(page, 'order', '321'), 25));
    assert.notEqual(fixture.orders[0].stopLoss, previous.stopLoss);
    assert.equal(fixture.orders[0].price, 3750); assert.equal(fixture.orders[0].takeProfit, previous.takeProfit);
    const beforeMove = { ...fixture.orders[0] };
    await accepted(page, async () => drag(page, await livePoint(page, 'order', '321'), -15, 'left'));
    const delta = fixture.orders[0].price - beforeMove.price;
    assert.ok(delta > 0);
    assert.ok(Math.abs(fixture.orders[0].stopLoss - beforeMove.stopLoss - delta) < .002);
    assert.ok(Math.abs(fixture.orders[0].takeProfit - beforeMove.takeProfit - delta) < .002);
    Object.assign(fixture.orders[0], { type: 'stopLimit', price: 3810, stopPrice: 3820, stopLoss: null, takeProfit: null });
    await page.waitForFunction(() => testGrid.getWidget(0).getChart().getOrders()[0].type === 'stopLimit');
    await accepted(page, async () => drag(page, await livePoint(page, 'order', '321', true), 35));
    assert.ok(fixture.orders[0].stopLoss < 3810);
    assert.equal(fixture.orders[0].price, 3810); assert.equal(fixture.orders[0].stopPrice, 3820);
    assert.equal(await page.getByRole('button', { name: 'Kéo SL/TP từ Entry', exact: true }).getAttribute('aria-pressed'), 'false');
    assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});

test('middle-drag targets the right filled position even when buy and sell share an Entry price', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser);
    fixture.orders = [];
    fixture.positions = ['buy', 'sell'].map((side, index) => ({ ...fixture.positions[0], id: String(123 + index), side, stopLoss: null, takeProfit: null }));
    await page.waitForFunction(() => !testGrid.getWidget(0).getChart().getOrders().length && testGrid.getWidget(0).getChart().getPositions().length === 2);
    await setOneClick(page); await viewport(page);
    for (const row of fixture.positions) {
      const lossDirection = row.side === 'buy' ? 1 : -1;
      await accepted(page, async () => drag(page, await livePoint(page, 'position', row.id, true), 35 * lossDirection));
      assert.equal(fixture.executed.at(-1).intent.positionId, row.id);
      assert.ok(row.side === 'buy' ? row.stopLoss < 3800 : row.stopLoss > 3800);
      const sl = row.stopLoss;
      await accepted(page, async () => drag(page, await livePoint(page, 'position', row.id, true), -45 * lossDirection));
      assert.equal(fixture.executed.at(-1).intent.positionId, row.id);
      assert.ok(row.side === 'buy' ? row.takeProfit > 3800 : row.takeProfit < 3800);
      assert.equal(row.stopLoss, sl);
      const tp = row.takeProfit;
      await accepted(page, async () => drag(page, await livePoint(page, 'position', row.id, true), 25 * lossDirection));
      assert.notEqual(row.stopLoss, sl); assert.equal(row.takeProfit, tp);
      assert.equal(row.entryPrice, 3800); assert.equal(row.quantity, .02);
    }
    assert.equal(fixture.executed.length, 6); assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});

test('left-drag from a filled Entry sets an exit without switching modes or moving the Entry', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser);
    fixture.orders = [];
    fixture.quote = { bid: 3815, ask: 3815.01 };
    Object.assign(fixture.positions[0], { stopLoss: null, takeProfit: null });
    await page.waitForFunction(() => !testGrid.getWidget(0).getChart().getOrders().length && testGrid.getWidget(0).getChart().getPositions()[0].stopLoss == null);
    await viewport(page);
    const mode = page.getByRole('button', { name: 'Kéo SL/TP từ Entry', exact: true });
    assert.equal(await mode.getAttribute('aria-pressed'), 'false');
    const entry = await livePoint(page, 'position', '123');
    await page.mouse.click(entry.x, entry.y);
    assert.equal(fixture.checked.length, 0, 'a click alone only selects the position');

    const yAt = price => page.evaluate(async price => {
      const { priceToY } = await import('/vendor/core/index.js'), widget = testGrid.getWidget(0);
      return widget.chartContainer.getBoundingClientRect().top + priceToY(price, widget.getChart().viewport.getState());
    }, price);
    await page.mouse.move(entry.x, entry.y); await page.mouse.down();
    await page.mouse.move(entry.x, await yAt(3806), { steps: 6 });
    await page.locator('.mt5-stop-drag-readout:visible').waitFor({ timeout: 2000 });
    const previewSL = await page.evaluate(() => testGrid.getWidget(0).getChart().getPositions()[0].stopLoss);
    const readout = await checkStopReadout(page, 'SL', previewSL, 3800);
    assert.equal(fixture.checked.length, 0);
    await page.mouse.up(); await readout.waitFor({ state: 'hidden' });
    const review = page.locator('#mt5-review'); await review.waitFor({ timeout: 3000 });
    const sl = fixture.checked.at(-1).intent;
    assert.equal(sl.positionId, '123');
    assert.equal(sl.stopLoss, previewSL);
    assert.ok(sl.stopLoss > 3800 && sl.stopLoss < 3815, 'SL can lock in profit between Entry and Bid');
    assert.equal(sl.takeProfit, undefined); assert.equal(fixture.executed.length, 0);
    await review.getByRole('button', { name: 'Gửi tới MT5', exact: true }).click();
    await review.waitFor({ state: 'detached' });

    const tag = await livePoint(page, 'position', '123', true);
    await page.mouse.move(tag.x, tag.y); await page.mouse.down();
    await page.mouse.move(tag.x, tag.y + await yAt(3835) - entry.y, { steps: 6 });
    await readout.waitFor({ timeout: 2000 });
    const previewTP = await page.evaluate(() => testGrid.getWidget(0).getChart().getPositions()[0].takeProfit);
    await checkStopReadout(page, 'TP', previewTP, 3800);
    await page.mouse.up(); await readout.waitFor({ state: 'hidden' });
    await review.waitFor({ timeout: 3000 });
    const tp = fixture.checked.at(-1).intent;
    assert.equal(tp.positionId, '123'); assert.ok(tp.takeProfit > 3815); assert.equal(tp.stopLoss, undefined);
    assert.equal(tp.takeProfit, previewTP);
    await review.getByRole('button', { name: 'Hủy', exact: true }).click();
    await review.waitFor({ state: 'detached' });
    assert.equal(fixture.positions[0].entryPrice, 3800);
    assert.equal(fixture.positions[0].stopLoss, sl.stopLoss);
    assert.equal(fixture.executed.length, 1); assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});

test('middle-drag respects tools, modifiers, native buttons and Escape without submitting a trade', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser); await setOneClick(page); await viewport(page);
    for (const modifier of ['Shift', 'Control', 'Meta', 'Alt']) {
      await page.keyboard.down(modifier);
      try { await drag(page, await livePoint(page, 'order', '321'), 30); }
      finally { await page.keyboard.up(modifier); }
    }
    for (const tool of ['drawing', 'eraser', 'zoom']) {
      await page.evaluate(tool => {
        const chart = testGrid.getWidget(0).getChart();
        if (tool === 'drawing') chart.setDrawingTool('trendLine');
        if (tool === 'eraser') chart.setEraserMode(true);
        if (tool === 'zoom') chart.setZoomAreaMode(true);
      }, tool);
      await drag(page, await livePoint(page, 'order', '321'), 30);
      await page.evaluate(() => {
        const chart = testGrid.getWidget(0).getChart(); chart.setDrawingTool(null); chart.setEraserMode(false); chart.setZoomAreaMode(false);
      });
    }
    const buttons = await page.evaluate(() => {
      const widget = testGrid.getWidget(0), rect = widget.chartContainer.getBoundingClientRect();
      return widget.getChart().tradingManager.buttons.map(button => ({ x: rect.left + button.x + button.size / 2, y: rect.top + button.y + button.size / 2 }));
    });
    for (const point of buttons) await page.mouse.click(point.x, point.y, { button: 'middle' });
    await page.getByRole('button', { name: 'Mua nhanh MT5', exact: true }).click({ button: 'middle' });
    const point = await livePoint(page, 'order', '321');
    await page.mouse.click(point.x, point.y, { button: 'middle' });
    await page.mouse.move(point.x, point.y); await page.mouse.down({ button: 'middle' });
    await page.mouse.move(point.x, point.y + 30, { steps: 6 });
    const readout = page.locator('.mt5-stop-drag-readout:visible');
    await readout.waitFor({ timeout: 2000 });
    await page.keyboard.press('Escape'); await page.mouse.up({ button: 'middle' });
    await readout.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => testGrid.getWidget(0).getChart().getOrders()[0].stopLoss), 3740);
    assert.equal(fixture.checked.length, 0); assert.equal(fixture.executed.length, 0);
    assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});
