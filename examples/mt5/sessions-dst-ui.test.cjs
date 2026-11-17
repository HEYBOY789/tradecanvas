const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chromium } = require('playwright');
const { mkdir } = require('node:fs/promises');
const { tradingPage } = require('./trading-fixture.cjs');

test('seasonal options are per Sessions instance and survive cancel, layouts and reload without changing entered times', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser);
    await page.evaluate(() => {
      const c = testGrid.getWidget(0).getChart(), cvd = c.getActiveIndicators().find(row => row.id === 'mt5-cvd-candle');
      c.addIndicator('texmoonbeam-sessions-panel', { source: `ind:${cvd.instanceId}:close` }, undefined, { pane: cvd.instanceId });
    });
    const ids = () => page.evaluate(() => Object.fromEntries(testGrid.getWidget(0).getChart().getActiveIndicators().map(row => [row.id, row.instanceId])));
    async function open(instance) {
      await page.locator(`.tcw-ind-legend-row[data-instance="${instance}"] .tcw-ind-legend-name`).click();
      const dialog = page.getByRole('dialog', { name: 'All-In-One Sessions', exact: true }); await dialog.waitFor();
      const group = name => dialog.locator('details').filter({ has: page.locator('summary', { hasText: new RegExp(`^${name}$`) }) }).last();
      const london = group('London'), ny = group('New York');
      for (const row of [london, ny]) if (!await row.evaluate(node => node.open)) await row.locator(':scope > summary').click();
      return { dialog, london, ny };
    }
    const read = id => page.evaluate(id => {
      const c = testGrid.getWidget(0).getChart(), row = c.getActiveIndicators().find(row => row.id === id);
      return JSON.parse(c.getIndicatorConfig(row.instanceId).params.sessionSettings);
    }, id);
    let active = await ids();
    let { dialog, london, ny } = await open(active['texmoonbeam-sessions']);
    assert.equal(await london.getByLabel('Tự đổi giờ mùa đông/hè', { exact: true }).isChecked(), false);
    await dialog.getByLabel('Múi giờ phiên').selectOption('GMT+7');
    await london.getByLabel('Bắt đầu', { exact: true }).fill('14:00'); await london.getByLabel('Kết thúc', { exact: true }).fill('16:00');
    await london.getByLabel('Tự đổi giờ mùa đông/hè', { exact: true }).check(); await ny.getByLabel('Tự đổi giờ mùa đông/hè', { exact: true }).check();
    await dialog.getByRole('button', { name: 'Áp dụng', exact: true }).click();
    assert.equal((await read('texmoonbeam-sessions')).sessions.london.autoDst, true);
    assert.equal((await read('texmoonbeam-sessions')).sessions.newYork.autoDst, true);
    assert.equal((await read('texmoonbeam-sessions-panel')).sessions.london.autoDst, false);
    ({ dialog, london } = await open(active['texmoonbeam-sessions']));
    await london.getByLabel('Tự đổi giờ mùa đông/hè', { exact: true }).uncheck(); await dialog.getByRole('button', { name: 'Hủy', exact: true }).click();
    assert.equal((await read('texmoonbeam-sessions')).sessions.london.autoDst, true);
    const saved = await page.evaluate(() => testGrid.getLayoutSession().saveAs('Seasonal Sessions'));
    ({ dialog, london } = await open(active['texmoonbeam-sessions']));
    await london.getByLabel('Tự đổi giờ mùa đông/hè', { exact: true }).uncheck(); await dialog.getByRole('button', { name: 'Áp dụng', exact: true }).click();
    await page.evaluate(id => testGrid.getLayoutSession().open(id), saved.id);
    assert.equal((await read('texmoonbeam-sessions')).sessions.london.autoDst, true);
    await page.reload(); await page.waitForFunction(() => window.testReady);
    await page.evaluate(async () => { await testReady.ready(); testGrid.getLayoutSession().setAutoSave(false); });
    const restored = await read('texmoonbeam-sessions');
    assert.equal(restored.sessions.london.autoDst, true); assert.equal(restored.sessions.london.start, '14:00'); assert.equal(restored.sessions.london.end, '16:00');
    assert.equal((await read('texmoonbeam-sessions-panel')).sessions.london.autoDst, false);
    await page.evaluate(async () => {
      const w = testGrid.getWidget(0), legacy = w.layouts.captureLayout();
      delete legacy.sessions.sessions.london.autoDst; delete legacy.sessions.sessions.newYork.autoDst;
      for (const item of legacy.chart.indicators) if (item.params.sessionSettings) {
        const value = JSON.parse(item.params.sessionSettings); delete value.sessions.london.autoDst; delete value.sessions.newYork.autoDst; item.params.sessionSettings = JSON.stringify(value);
      }
      await w.applyLayoutContent(JSON.stringify(legacy));
    });
    active = await ids();
    ({ dialog, london } = await open(active['texmoonbeam-sessions']));
    assert.equal(await london.getByLabel('Tự đổi giờ mùa đông/hè', { exact: true }).isChecked(), false, 'old layouts do not silently shift manually configured sessions');
    assert.equal(await london.getByLabel('Bắt đầu', { exact: true }).inputValue(), '14:00');
    await dialog.getByRole('button', { name: 'Hủy', exact: true }).click();
    assert.equal(fixture.executed.length, 0); assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});

test('seasonal session controls fit phone, laptop and wide charts across themes and looks', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser);
    await mkdir('artifacts/sessions-dst', { recursive: true });
    for (const width of [390, 1366, 1920]) for (const theme of ['dark', 'light']) for (const look of ['print', 'studio', 'terminal']) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.evaluate(({ theme, look }) => { testGrid.setTheme(theme); testGrid.setUI(look); }, { theme, look });
      const id = await page.evaluate(() => testGrid.getWidget(0).getChart().getActiveIndicators().find(row => row.id === 'texmoonbeam-sessions').instanceId);
      await page.locator(`.tcw-ind-legend-row[data-instance="${id}"] .tcw-ind-legend-name`).click();
      const dialog = page.getByRole('dialog', { name: 'All-In-One Sessions', exact: true }); await dialog.waitFor();
      await dialog.locator('details').evaluateAll(rows => rows.forEach(row => {
        row.open = ['Phiên giao dịch', 'London'].includes(row.querySelector(':scope > summary').textContent);
      }));
      const london = dialog.locator('details').filter({ has: page.locator('summary', { hasText: /^London$/ }) }).last();
      await london.getByLabel('Tự đổi giờ mùa đông/hè', { exact: true }).check();
      await london.scrollIntoViewIfNeeded();
      const metrics = await dialog.evaluate(root => ({ client: root.clientWidth, scroll: root.scrollWidth }));
      assert.ok(metrics.scroll <= metrics.client + 1, `${width} ${theme} ${look}: no horizontal overflow`);
      await page.screenshot({ path: `artifacts/sessions-dst/${width}-${theme}-${look}.png` });
      await dialog.getByRole('button', { name: 'Hủy', exact: true }).click();
    }
    assert.equal(fixture.executed.length, 0); assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});
