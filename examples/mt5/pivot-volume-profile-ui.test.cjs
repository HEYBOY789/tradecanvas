const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chromium } = require('playwright');

const name = 'Volume Profile, Pivot Anchored by DGT';

test('Pivot VP renders on MT5 candles and restores its settings and alerts from a layout', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1540, height: 950 } });
    await require('./market-fixture.cjs').mockMarket(page);
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const loadFailures = [];
    page.on('requestfailed', request => loadFailures.push(`${new URL(request.url()).pathname} ${request.failure()?.errorText}`));
    const layoutWarnings = [];
    page.on('console', message => {
      if (message.text().startsWith('Layout restore:')) layoutWarnings.push(message.text());
      if (message.type() === 'error') loadFailures.push(message.text());
    });
    await page.addInitScript(() => {
      const fillRect = CanvasRenderingContext2D.prototype.fillRect;
      const fill = CanvasRenderingContext2D.prototype.fill;
      const fillText = CanvasRenderingContext2D.prototype.fillText;
      window.profilePaint = { rows: 0, candle: 0, label: null };
      CanvasRenderingContext2D.prototype.fillRect = function (...args) {
        if (String(this.fillStyle).includes('251, 192, 45')) window.profilePaint.rows++;
        return fillRect.apply(this, args);
      };
      CanvasRenderingContext2D.prototype.fill = function (...args) {
        if (this.fillStyle === '#4caf50') window.profilePaint.candle++;
        return fill.apply(this, args);
      };
      CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...args) {
        if (/\d [↑↓] .+%/.test(text)) window.profilePaint.label = { x, y };
        return fillText.call(this, text, x, y, ...args);
      };
    });
    await page.route('**/app.js', async route => {
      const response = await route.fetch();
      const marker = 'installGridLayoutPersistence(grid);';
      await route.fulfill({ response, body: (await response.text()).replace(marker, `${marker}\nwindow.testGrid = grid; window.testReady = layoutOperations;`) });
    });
    await page.goto(process.env.TRADECANVAS_URL);
    await page.waitForFunction(() => window.testReady && testGrid.getWidget(0).getChart().getData().length > 200, null, { timeout: 20000 })
      .catch(async error => {
        throw new Error(`Fixture chart did not load. ${await page.locator('#status').textContent()} ${[...errors, ...loadFailures].join(' ')} ${error.message}`);
      });
    await page.evaluate(() => testReady.ready());
    await page.getByRole('button', { name: 'Chỉ báo', exact: true }).click();
    await page.getByRole('searchbox').fill('Pivot Anchored');
    await page.getByText(name, { exact: true }).click();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => profilePaint.rows > 10 && profilePaint.candle > 0 && profilePaint.label);
    const label = await page.evaluate(() => {
      const bounds = testGrid.getWidget(0).chartContainer.getBoundingClientRect();
      return { x: bounds.left + profilePaint.label.x, y: bounds.top + profilePaint.label.y };
    });
    await page.mouse.move(label.x, label.y);
    const tooltip = page.locator('.mt5-pivot-profile-tooltip:visible');
    await tooltip.waitFor();
    assert.match(await tooltip.textContent(), /Tick volume:[\s\S]+POC:[\s\S]+VAH:[\s\S]+VAL:/);
    const row = page.locator('.tcw-ind-legend-row[data-instance*="pivot-volume-profile-dgt"]');
    await row.locator('.tcw-ind-legend-name').click();
    const settings = page.getByRole('dialog', { name });
    const field = label => settings.locator('label').filter({ has: page.getByText(label, { exact: true }) });
    assert.equal(await field('Số nến xác nhận mỗi phía pivot').locator('input').inputValue(), '20');
    assert.equal(await field('Tỷ lệ Value Area (%)').locator('input').inputValue(), '68');
    await field('Số hàng giá').locator('input').fill('32');
    await field('Kéo dài POC').locator('select').selectOption('touch');
    await field('Vị trí thanh').locator('select').selectOption('right');
    await field('Nhãn mức giá').locator('select').selectOption('area');
    await field('Đổi màu nến theo volume').getByRole('switch').click();
    await settings.locator('[data-act="ok"]').click();
    await row.hover();
    await row.locator('[data-act="more"]').click();
    await page.getByRole('menuitemcheckbox', { name: 'Cảnh báo Giá cắt POC', exact: true }).click();
    const saved = await page.evaluate(() => testGrid.getLayoutSession().saveAs('Pivot Volume Profile'));
    await page.reload();
    await page.waitForFunction(() => window.testReady);
    await page.evaluate(() => testReady.ready());
    const reopened = await page.evaluate(() => testGrid.getLayoutSession().current()?.id);
    assert.equal(reopened, saved.id, [...layoutWarnings, ...errors].join('\n'));
    const restored = await page.evaluate(() => {
      const chart = testGrid.getWidget(0).getChart();
      const item = chart.getActiveIndicators().find(ind => ind.id === 'pivot-volume-profile-dgt');
      const { rows, extendPoc, side, labelMode, weightedCandles } = item.params;
      const point = chart.getIndicatorOutput(item.instanceId).series.at(-1);
      const alert = chart.getAlerts().find(alert => alert.target === `${item.instanceId}:poc`);
      return { rows, extendPoc, side, labelMode, weightedCandles, ordered: point.val <= point.poc && point.poc <= point.vah,
        condition: alert.condition, close: alert.onBarClose };
    });
    assert.deepEqual(restored, { rows: 32, extendPoc: 'touch', side: 'right', labelMode: 'area', weightedCandles: false,
      ordered: true, condition: 'crossing', close: true });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
