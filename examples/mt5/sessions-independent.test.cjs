const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chromium } = require('playwright');

test('each Sessions instance keeps its own timezone, times and colors across layouts', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await require('./market-fixture.cjs').mockMarket(page);
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/app.js', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace(
        'installGridLayoutPersistence(grid);', 'installGridLayoutPersistence(grid); window.testGrid = grid; window.testWidget = grid.getWidget(0);') });
    });
    await page.goto(process.env.TRADECANVAS_URL || 'http://127.0.0.1:8772/');
    await page.waitForFunction(() => window.testWidget?.getChart().getData().length > 0);
    await page.evaluate(() => {
      const chart = window.testWidget.getChart();
      const cvd = chart.getActiveIndicators().find(item => item.id === 'mt5-cvd-candle');
      chart.addIndicator('texmoonbeam-sessions-panel', { source: `ind:${cvd.instanceId}:close` }, undefined, { pane: cvd.instanceId });
    });
    async function edit(id, zone, start, color) {
      const row = page.locator(`.tcw-ind-legend-row[data-instance="${id}"]`);
      await row.locator('.tcw-ind-legend-name').click();
      const dialog = page.getByRole('dialog', { name: 'All-In-One Sessions' });
      if (zone !== undefined) {
        await dialog.getByLabel('Múi giờ phiên').selectOption(zone);
        const asia = dialog.locator('details').filter({ has: page.locator('summary', { hasText: /^Châu Á$/ }) }).last();
        if (!await asia.evaluate(element => element.open)) await asia.locator('summary').click();
        await asia.getByLabel('Bắt đầu mùa hè', { exact: true }).fill(start);
        await asia.getByLabel('Màu hộp', { exact: true }).fill(color);
        await dialog.getByRole('button', { name: 'Áp dụng' }).click();
        return;
      }
      const asia = dialog.locator('details').filter({ has: page.locator('summary', { hasText: /^Châu Á$/ }) }).last();
      const result = { zone: await dialog.getByLabel('Múi giờ phiên').inputValue(),
        start: await asia.getByLabel('Bắt đầu mùa hè', { exact: true }).inputValue(),
        color: await asia.getByLabel('Màu hộp', { exact: true }).inputValue() };
      await dialog.getByRole('button', { name: 'Hủy' }).click();
      return result;
    }
    const ids = () => page.evaluate(() => Object.fromEntries(window.testWidget.getChart().getActiveIndicators().map(item => [item.id, item.instanceId])));
    let active = await ids();
    const main = 'texmoonbeam-sessions';
    const panel = 'texmoonbeam-sessions-panel';
    await edit(active[main], 'GMT+7', '20:15', '#eeaa11');
    await edit(active[panel], 'GMT-5', '23:45', '#11aacc');
    const mainSettings = { zone: 'GMT+7', start: '20:15', color: '#eeaa11' };
    const panelSettings = { zone: 'GMT-5', start: '23:45', color: '#11aacc' };
    assert.deepEqual(await edit(active[main]), mainSettings, 'editing the CVD instance must not change the price instance');
    assert.deepEqual(await edit(active[panel]), panelSettings);
    const first = await page.evaluate(() => window.testGrid.getLayoutSession().saveAs('Independent Sessions'));
    await edit(active[main], 'GMT+9', '19:00', '#bb22aa');
    await page.evaluate(() => window.testGrid.getLayoutSession().saveAs('Other Sessions'));
    await page.evaluate(id => window.testGrid.getLayoutSession().open(id), first.id);
    active = await ids();
    assert.deepEqual(await edit(active[main]), mainSettings);
    assert.deepEqual(await edit(active[panel]), panelSettings);
    await page.reload();
    await page.waitForFunction(id => window.testGrid?.getLayoutSession().current()?.id === id, first.id);
    active = await ids();
    assert.deepEqual(await edit(active[main]), mainSettings);
    assert.deepEqual(await edit(active[panel]), panelSettings);

    // Old layouts saved one shared object and no per-instance parameters.
    const migrated = await page.evaluate(async () => {
      const widget = window.testWidget;
      const legacy = widget.layouts.captureLayout();
      legacy.sessions.zone = 'GMT+3';
      legacy.sessions.sessions.asia.start = '21:30';
      legacy.sessions.sessions.asia.color = '#33bb55';
      for (const item of legacy.chart.indicators) delete item.params.sessionSettings;
      return widget.applyLayoutContent(JSON.stringify(legacy));
    });
    assert.equal(migrated, true);
    active = await ids();
    const legacySettings = { zone: 'GMT+3', start: '21:30', color: '#33bb55' };
    assert.deepEqual(await edit(active[main]), legacySettings);
    assert.deepEqual(await edit(active[panel]), legacySettings);
    await edit(active[panel], 'GMT-5', '23:45', '#11aacc');
    assert.deepEqual(await edit(active[main]), legacySettings, 'migrated instances are independent too');

    // A second copy of the panel indicator must have its own settings as well.
    const copy = await page.evaluate(() => window.testWidget.getChart().addIndicator('texmoonbeam-sessions-panel'));
    await edit(copy, 'GMT+2', '18:30', '#bb44cc');
    assert.deepEqual(await edit(active[panel]), panelSettings);
    assert.deepEqual(await edit(active[main]), legacySettings);
    assert.deepEqual(await edit(copy), { zone: 'GMT+2', start: '18:30', color: '#bb44cc' });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
