const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chromium } = require('playwright');
const { mkdir } = require('node:fs/promises');
const { tradingPage } = require('./trading-fixture.cjs');

test('automatic seasonal pairs persist independently across instances, layouts and reload without season controls', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser);
    await page.evaluate(() => {
      const c = testGrid.getWidget(0).getChart(), cvd = c.getActiveIndicators().find(row => row.id === 'mt5-cvd-candle');
      c.addIndicator('texmoonbeam-sessions-panel', { source: `ind:${cvd.instanceId}:close` }, undefined, { pane: cvd.instanceId });
    });
    const main = 'texmoonbeam-sessions', panel = 'texmoonbeam-sessions-panel';
    async function open(id) {
      const instance = await page.evaluate(id => testGrid.getWidget(0).getChart().getActiveIndicators().find(row => row.id === id).instanceId, id);
      await page.locator(`.tcw-ind-legend-row[data-instance="${instance}"] .tcw-ind-legend-name`).click();
      const dialog = page.getByRole('dialog', { name: 'All-In-One Sessions', exact: true }); await dialog.waitFor();
      const groups = {};
      for (const [key, title] of [['asia', 'Châu Á'], ['london', 'London'], ['newYork', 'New York']]) {
        const row = dialog.locator('details').filter({ has: page.locator('summary', { hasText: new RegExp(`^${title}$`) }) }).last();
        if (!await row.evaluate(node => node.open)) await row.locator(':scope > summary').click();
        groups[key] = row;
      }
      assert.equal(await dialog.getByLabel('Tự đổi giờ mùa đông/hè', { exact: true }).count(), 0);
      assert.equal(await dialog.getByLabel('Mùa áp dụng', { exact: true }).count(), 0);
      return { dialog, ...groups };
    }
    const read = id => page.evaluate(id => {
      const c = testGrid.getWidget(0).getChart(), row = c.getActiveIndicators().find(row => row.id === id);
      return JSON.parse(c.getIndicatorConfig(row.instanceId).params.sessionSettings);
    }, id);
    const values = async row => ({
      start: await row.getByLabel('Bắt đầu mùa hè', { exact: true }).inputValue(),
      end: await row.getByLabel('Kết thúc mùa hè', { exact: true }).inputValue(),
      winterStart: await row.getByLabel('Bắt đầu mùa đông', { exact: true }).inputValue(),
      winterEnd: await row.getByLabel('Kết thúc mùa đông', { exact: true }).inputValue(),
    });
    async function fill(row, value) {
      for (const [key, label] of [['start', 'Bắt đầu mùa hè'], ['end', 'Kết thúc mùa hè'], ['winterStart', 'Bắt đầu mùa đông'], ['winterEnd', 'Kết thúc mùa đông']]) {
        await row.getByLabel(label, { exact: true }).fill(value[key]);
      }
    }
    const expected = {
      asia: { start: '23:30', end: '07:15', winterStart: '23:45', winterEnd: '08:30' },
      london: { start: '07:15', end: '16:45', winterStart: '08:10', winterEnd: '17:20' },
      newYork: { start: '12:00', end: '21:00', winterStart: '13:30', winterEnd: '22:45' },
    };
    let editor = await open(main);
    await editor.dialog.getByLabel('Múi giờ phiên').selectOption('GMT');
    for (const [key, value] of Object.entries(expected)) await fill(editor[key], value);
    await editor.dialog.getByRole('button', { name: 'Áp dụng', exact: true }).click();
    editor = await open(panel);
    assert.equal((await values(editor.london)).start, '08:00');
    const panelHours = { start: '06:15', end: '15:30', winterStart: '09:20', winterEnd: '19:40' };
    const panelAsiaHours = { start: '21:45', end: '06:45', winterStart: '22:15', winterEnd: '08:15' };
    await fill(editor.london, panelHours);
    await fill(editor.asia, panelAsiaHours);
    await editor.dialog.getByRole('button', { name: 'Áp dụng', exact: true }).click();
    editor = await open(main);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(await values(editor[key]), value);
    await editor.london.getByLabel('Bắt đầu mùa đông', { exact: true }).fill('05:00');
    await editor.asia.getByLabel('Kết thúc mùa đông', { exact: true }).fill('06:30');
    await editor.dialog.getByRole('button', { name: 'Hủy', exact: true }).click();
    assert.equal((await read(main)).sessions.london.winterStart, '08:10', 'cancel discards the edited pair');
    assert.equal((await read(main)).sessions.asia.winterEnd, '08:30');
    const saved = await page.evaluate(() => testGrid.getLayoutSession().saveAs('Automatic seasonal Sessions'));
    editor = await open(main);
    await editor.london.getByLabel('Bắt đầu mùa đông', { exact: true }).fill('06:00');
    await editor.dialog.getByRole('button', { name: 'Áp dụng', exact: true }).click();
    await page.evaluate(id => testGrid.getLayoutSession().open(id), saved.id);
    await page.reload(); await page.waitForFunction(() => window.testReady);
    await page.evaluate(async () => { await testReady.ready(); testGrid.getLayoutSession().setAutoSave(false); });
    editor = await open(main);
    assert.equal(await editor.dialog.getByLabel('Múi giờ phiên').inputValue(), 'GMT');
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(await values(editor[key]), value);
    await editor.dialog.getByRole('button', { name: 'Hủy', exact: true }).click();
    editor = await open(panel); assert.deepEqual(await values(editor.london), panelHours);
    assert.deepEqual(await values(editor.asia), panelAsiaHours);
    await editor.dialog.getByRole('button', { name: 'Hủy', exact: true }).click();
    await page.evaluate(async () => {
      const w = testGrid.getWidget(0), legacy = w.layouts.captureLayout();
      const migrate = value => {
        for (const [id, options] of Object.entries(value.sessions)) {
          options.season = 'Mùa hè'; delete options.winterStart; delete options.winterEnd; options.autoDst = false;
          options.start = id === 'asia' ? '23:30' : '14:15'; options.end = id === 'asia' ? '08:00' : '17:45';
        }
      };
      migrate(legacy.sessions);
      for (const item of legacy.chart.indicators) if (item.params.sessionSettings) {
        const value = JSON.parse(item.params.sessionSettings); migrate(value); item.params.sessionSettings = JSON.stringify(value);
      }
      await w.applyLayoutContent(JSON.stringify(legacy));
    });
    editor = await open(main);
    assert.deepEqual(await values(editor.london), { start: '14:15', end: '17:45', winterStart: '15:15', winterEnd: '18:45' });
    assert.deepEqual(await values(editor.asia), { start: '23:30', end: '08:00', winterStart: '23:30', winterEnd: '09:00' });
    await editor.london.getByLabel('Bắt đầu mùa hè', { exact: true }).fill('11:00');
    await editor.dialog.getByRole('button', { name: 'Áp dụng', exact: true }).click();
    const migrated = (await read(main)).sessions.london;
    assert.equal('autoDst' in migrated, false); assert.equal('season' in migrated, false);
    assert.equal(migrated.winterStart, '15:15', 'editing summer retains its independent winter pair');
    editor = await open(main);
    assert.equal((await values(editor.london)).start, '11:00'); assert.equal((await values(editor.london)).winterStart, '15:15');
    await editor.dialog.getByRole('button', { name: 'Hủy', exact: true }).click();
    assert.equal(fixture.executed.length, 0); assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});

test('Asian seasonal hour groups fit phone, laptop and wide charts across themes and looks', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser);
    await mkdir('artifacts/sessions-asia-seasons', { recursive: true });
    for (const width of [390, 1366, 1920]) for (const theme of ['dark', 'light']) for (const look of ['print', 'studio', 'terminal']) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.evaluate(({ theme, look }) => { testGrid.setTheme(theme); testGrid.setUI(look); }, { theme, look });
      const id = await page.evaluate(() => testGrid.getWidget(0).getChart().getActiveIndicators().find(row => row.id === 'texmoonbeam-sessions').instanceId);
      await page.locator(`.tcw-ind-legend-row[data-instance="${id}"] .tcw-ind-legend-name`).click();
      const dialog = page.getByRole('dialog', { name: 'All-In-One Sessions', exact: true }); await dialog.waitFor();
      await dialog.locator('details').evaluateAll(rows => rows.forEach(row => {
        row.open = ['Phiên giao dịch', 'Châu Á'].includes(row.querySelector(':scope > summary').textContent);
      }));
      const asia = dialog.locator('details').filter({ has: page.locator('summary', { hasText: /^Châu Á$/ }) }).last();
      assert.equal(await asia.getByLabel('Mùa áp dụng', { exact: true }).count(), 0);
      await asia.scrollIntoViewIfNeeded();
      const metrics = await dialog.evaluate(root => ({ client: root.clientWidth, scroll: root.scrollWidth }));
      assert.ok(metrics.scroll <= metrics.client + 1, `${width} ${theme} ${look}: no horizontal overflow`);
      assert.equal(await asia.locator('input[type="time"]').count(), 4);
      await page.screenshot({ path: `artifacts/sessions-asia-seasons/${width}-${theme}-${look}.png` });
      await dialog.getByRole('button', { name: 'Hủy', exact: true }).click();
    }
    assert.equal(fixture.executed.length, 0); assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});
