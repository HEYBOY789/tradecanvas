const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chromium } = require('playwright');
const { tradingPage, setOneClick } = require('./trading-fixture.cjs');

test('sidebar ticket, review, position actions and uncertain results use only mocked execution', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser);
    await page.getByRole('button', { name: 'Đặt lệnh MT5', exact: true }).click();
    const ticket = page.locator('#mt5-ticket');
    await ticket.locator('visible=true').waitFor();
    assert.equal(await ticket.locator('[name=quantity]').inputValue(), '0.01');
    await ticket.getByRole('tab', { name: 'Limit', exact: true }).click();
    await ticket.getByRole('button', { name: 'Chọn Bán', exact: true }).click();
    await ticket.locator('[name=quantity]').fill('0.03');
    await ticket.locator('[name=price]').fill('3900');
    await ticket.getByRole('switch', { name: 'Bật Stop Loss', exact: true }).check();
    await ticket.locator('[name=stopLoss]').fill('3910');
    await ticket.getByRole('switch', { name: 'Bật Take Profit', exact: true }).check();
    await ticket.locator('[name=takeProfit]').fill('3870');
    await ticket.locator('.order-ticket-submit').click();
    await page.locator('#mt5-review').waitFor();
    assert.equal(fixture.executed.length, 0);
    assert.match(await page.locator('#mt5-review').textContent(), /SELL LIMIT · 0.03 lot/);
    await page.locator('#mt5-review').getByRole('button', { name: 'Gửi tới MT5' }).click();
    await ticket.waitFor({ state: 'hidden' });
    assert.deepEqual(fixture.executed[0], fixture.checked[0]);
    assert.equal(fixture.executed[0].intent.stopLoss, 3910);
    assert.equal(fixture.executed[0].account, 'mock-account');
    await page.getByRole('button', { name: 'Vị thế MT5', exact: true }).click();
    const panel = page.locator('#mt5-account');
    await panel.getByRole('button', { name: 'Sửa SL/TP', exact: true }).click();
    const edit = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'SL/TP · XAUUSDm · 123' }) });
    await edit.locator('[name=stopLoss]').fill(''); await edit.locator('[name=takeProfit]').fill('3830');
    await edit.getByRole('button', { name: 'Kiểm tra thay đổi' }).click();
    await page.locator('#mt5-review').getByRole('button', { name: 'Gửi tới MT5' }).click();
    await edit.waitFor({ state: 'detached' });
    assert.deepEqual(fixture.executed.at(-1).intent, { positionId: '123', stopLoss: null, takeProfit: 3830 });
    await panel.getByRole('button', { name: 'Đóng', exact: true }).click();
    await page.evaluate(() => testGrid.getWidget(0).getChart().closePositionIntent('123'));
    await page.locator('#mt5-review').getByRole('button', { name: 'Hủy', exact: true }).click();
    await page.locator('#mt5-review').waitFor({ state: 'detached' });
    assert.equal(fixture.executed.length, 2);
    await page.evaluate(() => testGrid.getWidget(0).getChart().closePositionIntent('123'));
    await page.locator('#mt5-review').getByRole('button', { name: 'Gửi tới MT5' }).click();
    await page.waitForFunction(() => testGrid.getWidget(0).getChart().getPositions().length === 0);
    assert.equal(fixture.executed.at(-1).intent.quantity, .02);
    fixture.fail = true;
    await page.evaluate(() => testGrid.getWidget(0).getChart().cancelOrderIntent('321'));
    const review = page.locator('#mt5-review');
    await review.getByRole('button', { name: 'Gửi tới MT5' }).click();
    await review.getByRole('status').filter({ hasText: 'Mock unknown outcome' }).waitFor();
    const count = fixture.executed.length;
    assert.equal(await review.getByRole('button', { name: 'Gửi tới MT5' }).isDisabled(), true);
    await page.waitForTimeout(1100); assert.equal(fixture.executed.length, count);
    assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});

test('one-click buttons use visible lots, avoid duplicate sends and disarm on an account switch', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser);
    await page.getByRole('button', { name: 'Mua nhanh MT5', exact: true }).click();
    await page.locator('#mt5-ticket:not([hidden])').waitFor();
    assert.equal(fixture.executed.length, 0, 'One-click is off by default');
    await page.getByRole('button', { name: 'Đóng phiếu đặt lệnh' }).click();
    await page.getByLabel('Số lot giao dịch nhanh', { exact: true }).fill('0.02');
    await setOneClick(page);
    fixture.delay = 400;
    await page.getByRole('button', { name: 'Bán nhanh MT5', exact: true }).dblclick();
    await page.waitForFunction(() => document.querySelector('[aria-label="Bán nhanh MT5"]').disabled === false);
    assert.equal(fixture.executed.length, 1);
    assert.equal(fixture.executed[0].intent.quantity, .02);
    assert.equal(fixture.executed[0].intent.side, 'sell');
    assert.equal(await page.locator('#mt5-review').count(), 0);
    fixture.account.id = 'another-account'; fixture.account.login = 'OTHER-TEST-ACCOUNT';
    await page.waitForFunction(() => document.querySelector('.mt5-quick-trade').dataset.oneClick === 'false');
    await page.getByRole('button', { name: 'Mua nhanh MT5', exact: true }).click();
    await page.locator('#mt5-ticket:not([hidden])').waitFor();
    assert.equal(fixture.executed.length, 1);
    assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});
