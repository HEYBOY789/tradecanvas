const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chromium } = require('playwright');
const { tradingPage } = require('./trading-fixture.cjs');

test('place and modify MT5 orders in pips with an absolute price preview', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser);
    const review = page.locator('#mt5-review');
    async function checked(expected) {
      await review.waitFor();
      assert.deepEqual(fixture.checked.at(-1).intent, expected);
      await review.getByRole('button', { name: 'Hủy', exact: true }).click();
      await review.waitFor({ state: 'detached' });
    }
    async function setPips(form, name, value) {
      await form.locator(`[name=${name}Unit]`).selectOption('pips', { timeout: 3000 });
      await form.locator(`[name=${name}]`).fill(String(value));
    }

    await page.getByRole('button', { name: 'Đặt lệnh MT5', exact: true }).click();
    const ticket = page.locator('#mt5-ticket:not([hidden])');
    await ticket.getByRole('tab', { name: 'Limit', exact: true }).click();
    await ticket.getByRole('button', { name: 'Chọn Bán', exact: true }).click();
    await setPips(ticket, 'price', 100);
    await ticket.getByRole('switch', { name: 'Bật Stop Loss', exact: true }).check();
    await ticket.getByRole('switch', { name: 'Bật Take Profit', exact: true }).check();
    await setPips(ticket, 'stopLoss', 50);
    await setPips(ticket, 'takeProfit', 150);
    await ticket.locator('[name=price]').fill('');
    assert.equal(await ticket.locator('.order-ticket-submit').isDisabled(), true);
    await ticket.locator('[name=price]').fill('200');
    assert.equal(await ticket.locator('[name=stopLoss]').inputValue(), '50');
    assert.equal(await ticket.locator('[name=takeProfit]').inputValue(), '150');
    assert.match(await ticket.locator('.order-ticket-pip-note:visible').first().textContent(), /Bid.*1 pip = 0,01/);
    await ticket.locator('.order-ticket-submit').click();
    await checked({ side: 'sell', type: 'limit', quantity: .01, price: 3802, timeInForce: 'gtc', stopLoss: 3802.5, takeProfit: 3800.5 });
    await ticket.getByRole('button', { name: 'Đóng phiếu đặt lệnh' }).click();

    await page.getByRole('button', { name: 'Đặt lệnh MT5', exact: true }).click();
    await ticket.getByRole('tab', { name: 'Stop Limit', exact: true }).click();
    await setPips(ticket, 'stopPrice', 400);
    await setPips(ticket, 'price', 300);
    await ticket.getByRole('switch', { name: 'Bật Take Profit', exact: true }).check();
    await setPips(ticket, 'takeProfit', 50);
    await ticket.locator('.order-ticket-submit').click();
    await checked({ side: 'buy', type: 'stopLimit', quantity: .01, price: 3803.01, stopPrice: 3804.01, timeInForce: 'gtc', takeProfit: 3803.51 });
    await ticket.getByRole('button', { name: 'Đóng phiếu đặt lệnh' }).click();

    await page.getByRole('button', { name: 'Vị thế MT5', exact: true }).click();
    const account = page.locator('#mt5-account');
    await account.getByRole('button', { name: 'Sửa giá', exact: true }).click();
    const pending = page.getByRole('dialog', { name: /^Sửa giá · / });
    await setPips(pending, 'newPrice', -100);
    await setPips(pending, 'stopLoss', 35);
    await setPips(pending, 'takeProfit', 75);
    await pending.locator('[name=newPrice]').fill('-200');
    await pending.getByRole('button', { name: 'Kiểm tra thay đổi' }).click();
    await checked({ orderId: '321', newPrice: 3798.01, previousPrice: 3750, stopLoss: 3797.66, takeProfit: 3798.76 });
    await pending.getByRole('button', { name: 'Đóng', exact: true }).click();

    await account.getByRole('button', { name: 'Sửa SL/TP', exact: true }).click();
    const filled = page.getByRole('dialog', { name: /^SL\/TP · / });
    await setPips(filled, 'stopLoss', 75.5);
    await setPips(filled, 'takeProfit', 125);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await filled.locator('.mt5-edit-price small').first().textContent(), 'Giá 3.799,245');
    assert.ok(await filled.evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1), 'pip controls fit a mobile dialog');
    await filled.getByRole('button', { name: 'Kiểm tra thay đổi' }).click();
    await checked({ positionId: '123', stopLoss: 3799.245, takeProfit: 3801.25 });
    assert.equal(fixture.executed.length, 0);
    assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});
