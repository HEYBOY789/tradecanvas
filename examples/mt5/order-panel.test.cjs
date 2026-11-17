const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chromium } = require('playwright');
const { tradingPage } = require('./trading-fixture.cjs');

async function view(page, min, max) {
  await page.evaluate(async ([min, max]) => {
    const chart = testGrid.getWidget(0).getChart(); chart.setAutoScale(false); chart.viewport.setPriceRange(min, max); chart.requestRender();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, [min, max]);
}
async function drag(page, locator, dy) {
  const rect = await locator.boundingBox(); assert.ok(rect, 'drag handle is visible');
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2); await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2 + dy, { steps: 5 }); await page.mouse.up();
}

async function bracketDrag(page, locator, dy) {
  const mode = page.getByRole('button', { name: 'Kéo SL/TP từ Entry', exact: true });
  await mode.click();
  try { await drag(page, locator, dy); } finally { await mode.click(); }
}

async function executed(page, action) {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/trading/execute');
  await action(); await response;
  await page.waitForFunction(() => !document.querySelector('[aria-label="Mua nhanh MT5"]').disabled);
}

test('SL/TP mode creates or replaces exits from Entry, normal Entry drag preserves the bracket, and stops drag independently', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser);
    fixture.orders[0].stopLoss = null; fixture.orders[0].takeProfit = null;
    await page.waitForFunction(() => testGrid.getWidget(0).getChart().getOrders()[0].stopLoss == null);
    await page.getByRole('button', { name: 'Đặt lệnh MT5', exact: true }).click();
    const ticket = page.locator('#mt5-ticket:not([hidden])'); await ticket.waitFor();
    await ticket.getByRole('tab', { name: 'Limit', exact: true }).click(); await ticket.locator('[name=price]').fill('3760');
    await view(page, 3700, 3860);
    const entry = page.getByRole('button', { name: 'Kéo Entry lệnh nháp', exact: true });
    await bracketDrag(page, entry, 35);
    assert.ok(Number(await ticket.locator('[name=stopLoss]').inputValue()) < 3760);
    await bracketDrag(page, entry, -55);
    assert.ok(Number(await ticket.locator('[name=takeProfit]').inputValue()) > 3760);
    const readDraft = () => page.evaluate(() => Object.fromEntries(['price', 'stopLoss', 'takeProfit'].map(key => [key, Number(document.querySelector(`#mt5-ticket [name=${key}]`).value)])));
    const before = await readDraft();
    await drag(page, entry, -20);
    const moved = await readDraft(), delta = moved.price - before.price;
    assert.ok(delta > 0, JSON.stringify({ before, moved })); assert.ok(Math.abs(moved.stopLoss - before.stopLoss - delta) < .002); assert.ok(Math.abs(moved.takeProfit - before.takeProfit - delta) < .002);
    await bracketDrag(page, entry, 20);
    const replaced = await readDraft();
    assert.notEqual(replaced.stopLoss, moved.stopLoss); assert.equal(replaced.price, moved.price); assert.equal(replaced.takeProfit, moved.takeProfit);
    await drag(page, page.getByRole('button', { name: 'Kéo SL lệnh nháp', exact: true }), 10);
    assert.equal((await readDraft()).price, replaced.price); assert.equal((await readDraft()).takeProfit, replaced.takeProfit);
    assert.equal(fixture.executed.length, 0);
    await page.getByRole('button', { name: 'Đóng phiếu đặt lệnh' }).click();
    await view(page, 3700, 3860);
    async function liveEntry(dy, bracket) {
      const at = await page.evaluate(async () => {
        const { priceToY } = await import('/vendor/core/index.js'); const w = testGrid.getWidget(0), chart = w.getChart(), v = chart.viewport.getState(), r = w.chartContainer.getBoundingClientRect();
        return { x: r.left + v.chartRect.x + v.chartRect.width / 2, y: r.top + priceToY(chart.getOrders()[0].price, v) };
      });
      const mode = page.getByRole('button', { name: 'Kéo SL/TP từ Entry', exact: true });
      if ((await mode.getAttribute('aria-pressed') === 'true') !== bracket) await mode.click();
      await page.mouse.move(at.x, at.y); await page.mouse.down(); await page.mouse.move(at.x, at.y + dy, { steps: 6 }); await page.mouse.up();
    }
    await liveEntry(30, true);
    await page.locator('#mt5-review').waitFor(); assert.equal(fixture.executed.length, 0);
    assert.ok(fixture.checked.at(-1).intent.stopLoss < 3750);
    await page.locator('#mt5-review').getByRole('button', { name: 'Gửi tới MT5' }).click();
    await page.locator('#mt5-review').waitFor({ state: 'detached' });
    await page.getByLabel('One-click trading trên chart', { exact: true }).check();
    await executed(page, () => liveEntry(-45, true));
    const original = { ...fixture.orders[0] };
    await executed(page, () => liveEntry(-20, false));
    const translated = { ...fixture.orders[0] }, liveDelta = translated.price - original.price;
    assert.ok(Math.abs(translated.stopLoss - original.stopLoss - liveDelta) < .002);
    assert.ok(Math.abs(translated.takeProfit - original.takeProfit - liveDelta) < .002);
    await executed(page, () => liveEntry(15, true));
    assert.equal(fixture.orders[0].price, translated.price); assert.equal(fixture.orders[0].takeProfit, translated.takeProfit);
    assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});

test('right-click Long/Short copies broker-risk-sized Entry/SL/TP and keeps projection and drawing in sync', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser);
    await view(page, 3760, 3840);
    const drawing = await page.evaluate(async () => {
      const chart = testGrid.getWidget(0).getChart(), bars = chart.getData();
      const start = bars.at(-25), end = bars.at(-10);
      chart.setVisibleRange(bars.at(-60).time, bars.at(-1).time);
      const id = chart.addDrawing({ type: 'riskReward', anchors: [{ time: start.time, price: 3800 }, { time: end.time, price: 3790 }],
        options: { rewardRatio: 2, accountSize: 10000, riskMode: 'percent', risk: 1 }, style: { color: '#2962ff', lineWidth: 1 } });
      chart.selectDrawing(id); chart.requestRender();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = chart.getDrawingRect(id), bounds = testGrid.getWidget(0).chartContainer.getBoundingClientRect();
      return { id, x: bounds.left + rect.x + rect.width / 2, y: bounds.top + rect.y + rect.height / 3 };
    });
    await page.mouse.click(drawing.x, drawing.y, { button: 'right' });
    await page.getByRole('menuitem', { name: 'Tạo lệnh giới hạn MT5 từ vị thế…', exact: true }).click();
    const ticket = page.locator('#mt5-ticket:not([hidden])'); await ticket.waitFor();
    assert.equal(await ticket.locator('[name=price]').inputValue(), '3800');
    assert.equal(await ticket.locator('[name=stopLoss]').inputValue(), '3790');
    assert.equal(await ticket.locator('[name=takeProfit]').inputValue(), '3820');
    assert.equal(await ticket.locator('[name=quantityMode]').inputValue(), 'riskPercent');
    await ticket.locator('.order-ticket-number').first().getByText('0,1 lot', { exact: true }).waitFor();
    assert.equal(fixture.executed.length, 0, 'drawing and opening a draft never execute');
    await view(page, 3760, 3840);
    await drag(page, page.getByRole('button', { name: 'Kéo SL lệnh nháp', exact: true }), 30);
    const sl = Number(await ticket.locator('[name=stopLoss]').inputValue()); assert.ok(sl < 3790);
    assert.equal(await page.evaluate(id => testGrid.getWidget(0).getChart().getDrawings().find(d => d.id === id).anchors[1].price, drawing.id), sl);
    await page.evaluate(id => {
      const chart = testGrid.getWidget(0).getChart(), d = chart.getDrawings().find(d => d.id === id);
      chart.updateDrawing(id, { anchors: d.anchors.map((anchor, i) => ({ ...anchor, price: i ? 3785 : 3801 })) });
    }, drawing.id);
    await page.waitForFunction(() => document.querySelector('#mt5-ticket [name=price]').value === '3801');
    assert.equal(await ticket.locator('[name=stopLoss]').inputValue(), '3785');
    await ticket.getByRole('tab', { name: 'Stop Limit', exact: true }).click();
    await ticket.locator('[name=quantityMode]').selectOption('lots'); await ticket.locator('[name=quantity]').fill('0.02');
    await ticket.locator('[name=stopPrice]').fill('3900'); await ticket.locator('[name=price]').fill('3890');
    await ticket.locator('[name=stopLoss]').fill('3880'); await ticket.locator('[name=takeProfit]').fill('3910');
    await ticket.locator('.order-ticket-submit').click();
    await page.locator('#mt5-review').waitFor();
    assert.equal(fixture.executed.length, 0);
    assert.equal(fixture.checked.at(-1).intent.stopPrice, 3900);
    assert.equal(fixture.checked.at(-1).intent.price, 3890);
    await page.locator('#mt5-review').getByRole('button', { name: 'Gửi tới MT5' }).click();
    await ticket.waitFor({ state: 'hidden' }); assert.equal(fixture.executed.length, 1);
    assert.equal(await page.locator('.mt5-projection:not(.mt5-live-stops)').count(), 0);
    assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});

test('right-click chart and dragging pending or open-position stops route real ticket identities', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser);
    await view(page, 3700, 3860);
    const at = await page.evaluate(async () => {
      const { priceToY } = await import('/vendor/core/index.js'); const w = testGrid.getWidget(0), chart = w.getChart(), v = chart.viewport.getState();
      const r = w.chartContainer.getBoundingClientRect(); return { x: r.left + v.chartRect.x + 180, y: r.top + priceToY(3760, v) };
    });
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await page.getByRole('menuitem', { name: /Mua Limit .*tại/ }).click();
    await page.locator('#mt5-ticket:not([hidden])').waitFor();
    assert.equal(await page.locator('#mt5-ticket [data-order-type=limit]').getAttribute('aria-selected'), 'true');
    await page.getByRole('button', { name: 'Đóng phiếu đặt lệnh' }).click();
    await view(page, 3700, 3860);
    await drag(page, page.getByRole('button', { name: 'Kéo SL lệnh 321', exact: true }), 20);
    assert.deepEqual(fixture.errors, []);
    await page.locator('#mt5-review').waitFor();
    assert.equal(fixture.checked.at(-1).action, 'modifyOrder');
    assert.equal(fixture.checked.at(-1).intent.orderId, '321'); assert.ok(fixture.checked.at(-1).intent.stopLoss < 3740);
    await page.locator('#mt5-review').getByRole('button', { name: 'Gửi tới MT5' }).click();
    await page.locator('#mt5-review').waitFor({ state: 'detached' });
    await page.getByLabel('One-click trading trên chart', { exact: true }).check();
    const line = await page.evaluate(async () => {
      const { priceToY } = await import('/vendor/core/index.js'); const w = testGrid.getWidget(0), chart = w.getChart(), v = chart.viewport.getState(), r = w.chartContainer.getBoundingClientRect();
      return { x: r.left + v.chartRect.x + v.chartRect.width / 2, y: r.top + priceToY(3790, v) };
    });
    await executed(page, async () => {
      await page.mouse.move(line.x, line.y); await page.mouse.down(); await page.mouse.move(line.x, line.y + 25, { steps: 5 }); await page.mouse.up();
    });
    assert.equal(fixture.executed.at(-1).action, 'modifyPosition'); assert.equal(fixture.executed.at(-1).intent.positionId, '123');
    assert.equal(await page.locator('#mt5-review').count(), 0);
    assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});
