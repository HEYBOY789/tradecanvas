const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chromium } = require('playwright');

test('Sessions settings open from the native indicator controls and keep saved values', async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
    await require('./market-fixture.cjs').mockMarket(page);
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      if (sessionStorage.getItem('sessions-test-seeded')) return;
      localStorage.setItem('mt5:texmoonbeam-sessions:v1', JSON.stringify({
        zone: 'GMT+3', transparency: 63,
        sessions: { asia: { start: '21:30', end: '06:30', showOpen: true } },
        periods: { monday: { mid: true, width: 3 } },
        custom: [{ enabled: true, label: 'Saved level', days: '23456', color: '#ffaa22' }],
      }));
      sessionStorage.setItem('sessions-test-seeded', 'yes');
    });
    await page.goto(process.env.TRADECANVAS_URL || 'http://127.0.0.1:8772/');
    const row = page.locator('.tcw-ind-legend-row[data-instance*="texmoonbeam-sessions"]');
    await row.waitFor();
    await row.hover();
    await row.locator('[data-act="settings"]').click();
    const dialog = page.getByRole('dialog', { name: 'All-In-One Sessions' });
    await dialog.waitFor({ timeout: 3000 });
    const zone = dialog.getByLabel('Múi giờ phiên');
    assert.equal(await zone.evaluate(element => element.tagName), 'SELECT');
    assert.equal(await zone.inputValue(), 'GMT+3');
    assert.equal(await zone.locator('option[value="GMT+7"]').textContent(), 'GMT+7 (Việt Nam)');
    assert.equal(await dialog.getByLabel('Độ trong nền (%)').inputValue(), '63');
    const sections = await dialog.locator('summary').allTextContents();
    for (const name of ['Châu Á', 'London', 'New York', 'Thứ Hai', 'Tuần trước', 'Tháng trước', 'Mức 6']) {
      assert.ok(sections.includes(name), name);
    }
    await zone.selectOption('GMT+2');
    await dialog.getByRole('button', { name: 'Áp dụng' }).click();
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('mt5:texmoonbeam-sessions:v1')));
    assert.equal(saved.zone, 'GMT+2');
    assert.equal(saved.sessions.asia.start, '21:30');
    assert.equal(saved.sessions.asia.showOpen, true);
    assert.equal(saved.periods.monday.fibonacciLevels.p500, true);
    assert.equal(saved.periods.monday.mid, undefined);
    assert.equal(saved.periods.monday.width, 3);
    assert.equal(saved.custom[0].label, 'Saved level');

    await row.locator('.tcw-ind-legend-name').click();
    await dialog.waitFor();
    assert.equal(await dialog.getByLabel('Múi giờ phiên').inputValue(), 'GMT+2');
    await dialog.getByRole('button', { name: 'Hủy' }).click();
    await page.reload();
    await row.waitFor();
    await row.hover();
    await row.locator('[data-act="more"]').click();
    await page.getByRole('menuitem', { name: 'Cài đặt', exact: true }).click();
    await dialog.waitFor();
    assert.equal(await dialog.getByLabel('Múi giờ phiên').inputValue(), 'GMT+2');
    await dialog.getByRole('button', { name: 'Hủy' }).click();

    const cvd = page.locator('.tcw-ind-legend-row[data-instance*="mt5-cvd-candle"]');
    await cvd.locator('.tcw-ind-legend-name').click();
    const frameSelect = page.locator('select:visible').filter({ has: page.locator('option', { hasText: /^45 giây$/ }) });
    await frameSelect.first().waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
