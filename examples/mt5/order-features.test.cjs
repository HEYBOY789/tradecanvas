const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chromium } = require('playwright');
const { tradingPage, setOneClick } = require('./trading-fixture.cjs');

async function viewport(page) {
  await page.evaluate(async () => {
    const chart = testGrid.getWidget(0).getChart(); chart.setAutoScale(false); chart.viewport.setPriceRange(3700, 3860); chart.requestRender();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}
async function drag(page, locator, dy, dx = 0, beforeUp, button = 'left') {
  const rect = await locator.boundingBox(); assert.ok(rect);
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2); await page.mouse.down({ button });
  await page.mouse.move(rect.x + rect.width / 2 + dx, rect.y + rect.height / 2 + dy, { steps: 7 });
  if (beforeUp) await beforeUp(); await page.mouse.up({ button });
}

test('invalid pending placement is disabled locally and quick controls keep One-click in settings', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser);
    await page.getByRole('button', { name: 'Đặt lệnh MT5', exact: true }).click();
    const ticket = page.locator('#mt5-ticket:not([hidden])');
    await ticket.getByRole('tab', { name: 'Stop', exact: true }).click();
    await ticket.locator('[name=price]').fill('3750');
    await page.waitForTimeout(300);
    assert.equal(await ticket.locator('.order-ticket-submit').isDisabled(), true);
    assert.match(await ticket.locator('.order-ticket-error').last().textContent(), /Ask/);
    assert.equal(await page.locator('.mt5-quick-trade input[type=checkbox]').count(), 0);
    assert.equal(fixture.executed.length, 0);
  } finally { await browser.close(); }
});

test('middle-drag previews stay local until release with no floating TP/SL/deadline controls', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser);
    fixture.orders = []; fixture.positions[0].stopLoss = null; fixture.positions[0].takeProfit = null;
    await page.waitForFunction(() => testGrid.getWidget(0).getChart().getOrders().length === 0 && testGrid.getWidget(0).getChart().getPositions()[0].stopLoss == null);
    await setOneClick(page); await viewport(page);
    assert.equal(await page.locator('.mt5-line-switches').count(), 0);
    const entry = await page.evaluate(async () => {
      const { priceToY } = await import('/vendor/core/index.js');
      const widget = testGrid.getWidget(0), viewport = widget.getChart().viewport.getState(), rect = widget.chartContainer.getBoundingClientRect();
      return { x: rect.left + viewport.chartRect.x + viewport.chartRect.width / 2, y: rect.top + priceToY(3800, viewport) };
    });
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/trading/execute');
    await page.mouse.move(entry.x, entry.y); await page.mouse.down({ button: 'middle' });
    await page.mouse.move(entry.x, entry.y + 30, { steps: 7 });
    assert.equal(fixture.checked.length, 0); assert.equal(fixture.positions[0].stopLoss, null);
    await page.mouse.up({ button: 'middle' }); await response;
    assert.ok(fixture.positions[0].stopLoss < 3800);
    await page.waitForFunction(() => !document.querySelector('[aria-label="Mua nhanh MT5"]').disabled);
    await page.getByRole('button', { name: 'Đặt lệnh MT5', exact: true }).click();
    const ticket = page.locator('#mt5-ticket:not([hidden])');
    await ticket.getByRole('tab', { name: 'Limit', exact: true }).click(); await ticket.locator('[name=price]').fill('3760');
    await viewport(page);
    assert.equal(await page.locator('.mt5-line-switches').count(), 0);
    assert.equal(await ticket.locator('[name=takeProfit]').inputValue(), '');
    await drag(page, page.getByRole('button', { name: 'Kéo Entry lệnh nháp', exact: true }), -20, 0,
      async () => { assert.equal(fixture.executed.length, 1); }, 'middle');
    assert.ok(Number(await ticket.locator('[name=takeProfit]').inputValue()) > 3760);
    assert.equal(fixture.executed.length, 1); assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});

test('expiry applies to filled positions and drafts, uses chart timezone and can be dragged on the chart', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser);
    await page.evaluate(() => testGrid.getWidget(0).setSettings({ timezone: 'Asia/Ho_Chi_Minh' }));
    await viewport(page);
    await page.getByRole('button', { name: 'Vị thế MT5', exact: true }).click();
    const accountPanel = page.locator('#mt5-account');
    await accountPanel.locator('tr').filter({ hasText: '123 · XAUUSDm' }).getByRole('button', { name: 'Thời hạn', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Thời hạn #123', exact: true }); await editor.waitFor();
    await editor.getByLabel('Định dạng giờ', { exact: true }).selectOption('12h');
    await editor.getByLabel('Ngày hết hạn', { exact: true }).fill('2027-01-05');
    await editor.getByLabel('Giờ hết hạn', { exact: true }).fill('11:30'); await editor.getByLabel('AM / PM', { exact: true }).selectOption('PM');
    await editor.getByRole('button', { name: 'Lưu thời hạn', exact: true }).click();
    const review = page.locator('#mt5-review'); await review.waitFor();
    assert.match(await review.textContent(), /Asia\/Ho_Chi_Minh/);
    await review.getByRole('button', { name: 'Gửi tới MT5', exact: true }).click();
    await review.waitFor({ state: 'detached' }); await editor.waitFor({ state: 'detached' });
    await accountPanel.getByRole('button', { name: 'Đóng', exact: true }).click();
    assert.equal(fixture.executed.at(-1).action, 'setExpiry');
    assert.equal(fixture.executed.at(-1).intent.expiresAt, Date.UTC(2027, 0, 5, 16, 30));
    await page.getByRole('button', { name: 'Đặt lệnh MT5', exact: true }).click();
    const ticket = page.locator('#mt5-ticket:not([hidden])');
    await ticket.waitFor();
    assert.equal(await ticket.getByLabel('Thời hạn lệnh', { exact: true }).isVisible(), true, 'market positions support deadlines');
    await ticket.getByRole('tab', { name: 'Limit', exact: true }).click(); await ticket.locator('[name=price]').fill('3760');
    await ticket.getByLabel('Thời hạn lệnh', { exact: true }).selectOption('specified');
    await ticket.getByLabel('Định dạng giờ', { exact: true }).selectOption('24h');
    await ticket.getByLabel('Ngày hết hạn', { exact: true }).fill('2027-01-06');
    await ticket.getByLabel('Giờ hết hạn', { exact: true }).fill('10:45'); await ticket.getByLabel('Ngày hết hạn', { exact: true }).click();
    assert.equal(await ticket.getByLabel('AM / PM', { exact: true }).isVisible(), false);
    await page.getByRole('button', { name: 'Đóng phiếu đặt lệnh' }).click();
    await page.evaluate(() => {
      const chart = testGrid.getWidget(0).getChart(); chart.setVisibleRange(Date.UTC(2027, 0, 4), Date.UTC(2027, 0, 6));
    });
    await setOneClick(page);
    const line = page.getByRole('button', { name: 'Kéo thời hạn lệnh 123', exact: true }); await line.waitFor();
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/trading/execute');
    await drag(page, line, 0, -70); await response;
    assert.notEqual(fixture.executed.at(-1).intent.expiresAt, Date.UTC(2027, 0, 5, 16, 30));
    assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});

test('Bid/Ask settings draw independently, cancel rolls back and named layouts retain both', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser);
    await page.evaluate(() => testGrid.getWidget(0).chartSettings.openSettings('symbol'));
    let settings = page.locator('.tcw-set'); await settings.getByLabel('Đường giá Ask', { exact: true }).check();
    await settings.getByLabel('Đường giá Bid', { exact: true }).check();
    await page.waitForFunction(() => testGrid.getWidget(0).getChart().getBidAsk()?.ask === 3800.01);
    await settings.locator('[data-act=ok]').click();
    const saved = await page.evaluate(() => testGrid.getLayoutSession().saveAs('Bid Ask settings'));
    await page.evaluate(() => testGrid.getWidget(0).chartSettings.openSettings('symbol'));
    settings = page.locator('.tcw-set'); await settings.getByLabel('Đường giá Ask', { exact: true }).uncheck();
    await settings.locator('[data-act=cancel]').click();
    await page.waitForFunction(() => testGrid.getWidget(0).getChart().getBidAsk()?.ask === 3800.01);
    await page.evaluate(async id => { testGrid.getWidget(0).setTradePreferences({ bid: false, ask: false }); await testGrid.getLayoutSession().open(id); }, saved.id);
    const quotes = await page.evaluate(() => testGrid.getWidget(0).getChart().getBidAsk());
    assert.deepEqual(quotes, { bid: 3800, ask: 3800.01 });
    assert.equal(fixture.executed.length, 0); assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});

test('native close, cancel and remove-stop buttons keep their click instead of starting a drag', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser); await viewport(page);
    for (const [type, action] of [['closePosition', 'close'], ['cancelOrder', 'cancel'], ['removeStop', 'modifyPosition']]) {
    const point = await page.evaluate(type => {
      const widget = testGrid.getWidget(0), button = widget.getChart().tradingManager.buttons.find(item => item.action.type === type);
      const r = widget.chartContainer.getBoundingClientRect();
      return { x: r.left + button.x + button.size / 2, y: r.top + button.y + button.size / 2 };
    }, type);
    await page.mouse.click(point.x, point.y);
    await page.locator('#mt5-review').waitFor().catch(error => { throw new Error(`${type}: ${error.message}; checked=${JSON.stringify(fixture.checked.map(row => row.action))}`); });
    assert.equal(fixture.checked.at(-1).action, action); assert.equal(fixture.executed.length, 0);
    await page.locator('#mt5-review').getByRole('button', { name: 'Hủy', exact: true }).click();
    await page.locator('#mt5-review').waitFor({ state: 'detached' });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});

test('chart drags clamp filled stops to Bid/Ask and auto-flip only a draft when Entry or exits cross', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser); fixture.orders = [];
    await page.waitForFunction(() => testGrid.getWidget(0).getChart().getOrders().length === 0);
    await setOneClick(page); await viewport(page);
    async function movePrice(handle, price, execute = false) {
      const rect = await handle.boundingBox(); assert.ok(rect);
      const target = await page.evaluate(async price => {
        const { priceToY } = await import('/vendor/core/index.js'); const w = testGrid.getWidget(0);
        return w.chartContainer.getBoundingClientRect().top + priceToY(price, w.getChart().viewport.getState());
      }, price);
      const response = execute ? page.waitForResponse(r => new URL(r.url()).pathname === '/api/trading/execute') : null;
      await drag(page, handle, target - rect.y - rect.height / 2);
      if (response) { await response; await page.waitForFunction(() => !document.querySelector('[aria-label="Mua nhanh MT5"]').disabled); }
    }
    await movePrice(page.getByRole('button', { name: 'Kéo SL lệnh 123', exact: true }), 3830, true);
    assert.ok(fixture.positions[0].stopLoss < 3800);
    await movePrice(page.getByRole('button', { name: 'Kéo TP lệnh 123', exact: true }), 3780, true);
    assert.ok(fixture.positions[0].takeProfit > 3800);
    assert.equal(fixture.positions[0].side, 'buy');
    await page.getByRole('button', { name: 'Đặt lệnh MT5', exact: true }).click();
    const ticket = page.locator('#mt5-ticket:not([hidden])'); await ticket.waitFor();
    await ticket.getByRole('tab', { name: 'Limit', exact: true }).click(); await ticket.locator('[name=price]').fill('3760');
    await ticket.getByRole('switch', { name: 'Bật Stop Loss', exact: true }).check(); await ticket.locator('[name=stopLoss]').fill('3750');
    await ticket.getByRole('switch', { name: 'Bật Take Profit', exact: true }).check(); await ticket.locator('[name=takeProfit]').fill('3780');
    await viewport(page);
    await movePrice(page.getByRole('button', { name: 'Kéo Entry lệnh nháp', exact: true }), 3830);
    assert.equal(await ticket.getByRole('button', { name: 'Chọn Bán', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.ok(Number(await ticket.locator('[name=stopLoss]').inputValue()) > Number(await ticket.locator('[name=price]').inputValue()));
    await movePrice(page.getByRole('button', { name: 'Kéo SL lệnh nháp', exact: true }), 3820);
    assert.equal(await ticket.getByRole('button', { name: 'Chọn Mua', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await ticket.getByRole('tab', { name: 'Stop', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(fixture.executed.length, 2); assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});
