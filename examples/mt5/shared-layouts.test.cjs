const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { chromium } = require('playwright');

test('independent LAN clients share layouts, refresh visible lists and preserve concurrent edits', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const errors = [], suffix = randomUUID().slice(0, 8);
  try {
    async function client(seed) {
      const context = await browser.newContext({ viewport: { width: 1740, height: 1050 } });
      const page = await context.newPage();
      await require('./market-fixture.cjs').mockMarket(page);
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(error.message));
      if (seed) await page.addInitScript(seed => {
        if (localStorage.getItem('test-seeded')) return;
        localStorage.setItem('test-seeded', '1');
        localStorage.setItem('tcw:grid-layouts:index', JSON.stringify([{ ...seed, content: undefined }]));
        localStorage.setItem(`tcw:grid-layouts:item:${seed.id}`, seed.content);
        localStorage.setItem('mt5:active-layout:v1', seed.id);
      }, seed);
      await page.route('**/app.js', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: (await response.text()).replace('installGridLayoutPersistence(grid);',
          'installGridLayoutPersistence(grid); window.testGrid=grid; window.testStorage=layoutStorage; window.testReady=layoutOperations;') });
      });
      await page.goto(process.env.TRADECANVAS_URL || 'http://127.0.0.1:8773/');
      await page.waitForFunction(() => window.testReady && testGrid.getWidget(0).getChart().getData().length > 20);
      await page.evaluate(async () => { await testReady.ready(); testGrid.getLayoutSession().setAutoSave(false); });
      return page;
    }
    const a = await client();
    const name = `LAN ${suffix}`;
    const saved = await a.evaluate(async name => {
      testGrid.setLayout('1x2');
      testGrid.getWidget(0).setSettings({ timezone: 'Asia/Tokyo' });
      testGrid.getWidget(1).setSettings({ timezone: 'UTC' });
      return testGrid.getLayoutSession().saveAs(name);
    }, name);
    const b = await client();
    assert.equal(await b.evaluate(() => testGrid.getLayoutSession().current().id), saved.id, 'fresh device opens latest shared layout');
    assert.deepEqual(await b.evaluate(() => testGrid.getWidgets().map(w => w.getSettings().timezone)), ['Asia/Tokyo', 'UTC']);
    assert.equal(await b.evaluate(() => localStorage.getItem('tcw:grid-layouts:index')), null, 'shared records are not separate local copies');

    await b.evaluate(() => testGrid.layoutsUI.openDialog());
    const renamed = `LAN đã đổi ${suffix}`;
    await a.evaluate(async name => { testGrid.getWidget(0).setSettings({ timezone: 'Europe/London' }); await testGrid.getLayoutSession().save(); await testGrid.getLayoutSession().rename(testGrid.getLayoutSession().current().id, name); }, renamed);
    await b.locator('.tcw-layouts-dialog:visible').getByText(renamed, { exact: true }).waitFor();
    await b.locator('#mt5-layout-sync').filter({ hasText: 'có bản mới' }).waitFor();
    assert.equal(await b.evaluate(() => testGrid.getWidget(0).getSettings().timezone), 'Asia/Tokyo', 'remote changes do not replace an open local chart');
    const conflict = await b.evaluate(async () => {
      testGrid.getWidget(0).setSettings({ timezone: 'America/New_York' });
      try { await testGrid.getLayoutSession().save(); return null; } catch (error) { return error.message; }
    });
    assert.match(conflict, /máy khác/);
    assert.equal(await a.evaluate(async id => JSON.parse((await testStorage.load(id)).content).cells[0].settings.timezone, saved.id), 'Europe/London');
    const renamedByB = `${renamed} từ máy B`;
    await b.evaluate(async ({ id, name }) => testGrid.getLayoutSession().rename(id, name), { id: saved.id, name: renamedByB });
    assert.equal(await a.evaluate(async id => JSON.parse((await testStorage.load(id)).content).cells[0].settings.timezone, saved.id), 'Europe/London', 'renaming a stale chart preserves the newer saved content');
    assert.match(await b.evaluate(async () => { try { await testGrid.getLayoutSession().save(); return ''; } catch (error) { return error.message; } }), /máy khác/, 'rename must not grant a stale chart permission to overwrite newer content');
    await b.evaluate(() => testGrid.layoutsUI.dialog.close());
    await b.getByRole('button', { name: 'Mở bản máy chính', exact: true }).click();
    await b.waitForFunction(() => testGrid.getWidget(0).getSettings().timezone === 'Europe/London');
    assert.equal(await b.evaluate(() => testGrid.getLayoutSession().current().name), renamedByB);

    // Both devices open the same revision. Save As preserves the losing device's changes.
    await a.evaluate(() => testGrid.layoutsUI.openDialog());
    const forkName = `Bản riêng ${suffix}`;
    const fork = await b.evaluate(async name => {
      testGrid.getWidget(1).setSettings({ timezone: 'Asia/Singapore' });
      return testGrid.getLayoutSession().saveAs(name);
    }, forkName);
    await a.locator('.tcw-layouts-dialog:visible').getByText(forkName, { exact: true }).waitFor();
    await b.evaluate(async id => testGrid.getLayoutSession().remove(id), fork.id);
    await a.locator('.tcw-layouts-dialog:visible').getByText(forkName, { exact: true }).waitFor({ state: 'detached' });
    await a.evaluate(() => testGrid.layoutsUI.dialog.close());

    // Conflicting browser-only archives migrate to a second shared id, without overwriting the host.
    const original = await a.evaluate(id => testStorage.load(id), saved.id);
    const legacy = JSON.parse(original.content);
    legacy.cells[0].settings.timezone = 'Australia/Sydney';
    const seed = { ...original, content: JSON.stringify(legacy) };
    const c = await client(seed);
    const imported = await c.evaluate(() => testGrid.getLayoutSession().current());
    assert.notEqual(imported.id, saved.id);
    assert.equal(await c.evaluate(() => testGrid.getWidget(0).getSettings().timezone), 'Australia/Sydney');
    assert.equal(await a.evaluate(async id => JSON.parse((await testStorage.load(id)).content).cells[0].settings.timezone, saved.id), 'Europe/London');
    const before = await c.evaluate(async () => (await testGrid.getLayoutSession().list()).length);
    await c.reload();
    await c.waitForFunction(() => window.testReady);
    await c.evaluate(() => testReady.ready());
    assert.equal(await c.evaluate(async () => (await testGrid.getLayoutSession().list()).length), before);
    assert.ok(await c.evaluate(id => localStorage.getItem(`tcw:grid-layouts:item:${id}`), saved.id), 'browser archive is retained');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
