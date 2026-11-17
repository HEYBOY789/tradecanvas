const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chromium } = require('playwright');

test('layout files round-trip the grid, parked cells, drawings, timezones and indicator settings', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const contexts = [];
  try {
    async function page() {
      const context = await browser.newContext({ viewport: { width: 1740, height: 1050 }, acceptDownloads: true });
      contexts.push(context);
      const page = await context.newPage();
      await require('./market-fixture.cjs').mockMarket(page);
      page.setDefaultTimeout(10000);
      await page.route('**/app.js', async route => {
        const response = await route.fetch();
        const marker = 'installGridLayoutPersistence(grid);';
        await route.fulfill({ response, body: (await response.text()).replace(marker, `${marker}\nwindow.testGrid = grid; window.testReady = layoutOperations; window.testStorage = layoutStorage;`) });
      });
      await page.goto(process.env.TRADECANVAS_URL || 'http://127.0.0.1:8772/');
      await page.waitForFunction(() => window.testGrid?.getWidget(0).getChart().getData().length > 20);
      await page.evaluate(async () => { await testReady.ready(); testGrid.getLayoutSession().setAutoSave(false); });
      return page;
    }
    const source = await page();
    const errors = [];
    source.on('pageerror', error => errors.push(error.message));
    await source.evaluate(() => testGrid.setLayout('1x3'));
    await source.evaluate(() => Promise.all(testGrid.getWidgets().map((widget, index) => widget.setTimeframe(['5m', '15m', '1h'][index]))));
    await source.waitForFunction(() => testGrid.getWidgets().every(widget => widget.getChart().getData().length > 20));
    await source.evaluate(() => {
      const zones = ['Asia/Tokyo', 'UTC', 'America/New_York'];
      testGrid.getWidgets().forEach((widget, index) => {
        widget.setSettings({ timezone: zones[index] });
        const chart = widget.getChart();
        chart.clearDrawings();
        const sessions = chart.getActiveIndicators().find(item => item.id === 'texmoonbeam-sessions');
        const settings = JSON.parse(sessions.params.sessionSettings);
        settings.zone = `GMT+${index + 1}`;
        settings.periods.previousDay.fibonacciLevels.p382 = index !== 1;
        settings.periods.previousDay.fibonacciColors.p382 = ['#123456', '#abcdef', '#112233'][index];
        settings.periods.previousDay.labelOutlineColor = '#aa3344';
        chart.updateIndicator(sessions.instanceId, { sessionSettings: JSON.stringify(settings) });
        const cvd = chart.getActiveIndicators().find(item => item.id === 'mt5-cvd-candle');
        chart.updateIndicator(cvd.instanceId, { average: true, averageLength: 11 + index });
      });
      const chart = testGrid.getWidget(0).getChart();
      const bar = chart.getData().at(-10);
      chart.addDrawing({ type: 'horizontalLine', anchors: [{ time: bar.time, price: bar.close }], style: { color: '#aabbcc', lineWidth: 2 } });
      testGrid.setLayout('1x2');
      testGrid.setActive(1);
    });
    await source.evaluate(() => testGrid.getLayoutSession().saveAs('Bố cục thử/XAU'));
    const downloadReady = source.waitForEvent('download');
    await source.getByRole('button', { name: 'Xuất bố cục', exact: true }).click();
    const download = await downloadReady;
    assert.equal(download.suggestedFilename(), 'tradecanvas-Bố cục thử-XAU.json');
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const file = Buffer.concat(chunks);
    const exported = JSON.parse(file.toString('utf8'));
    assert.equal(exported.format, 'mt5-tradecanvas-layout');
    assert.equal(exported.layout.cells.length, 3, 'parked charts are included');
    assert.equal(exported.layout.cells[0].chart.drawings.length, 1);

    const target = await page();
    target.on('pageerror', error => errors.push(error.message));
    const original = await target.evaluate(() => testGrid.getLayoutSession().saveAs('Bố cục ban đầu'));
    const originalContent = await target.evaluate(async id => (await testStorage.load(id)).content, original.id);
    async function upload(buffer, filename = 'bo-cuc.json') {
      const chooserReady = target.waitForEvent('filechooser');
      await target.getByRole('button', { name: 'Nhập bố cục', exact: true }).click();
      const chooser = await chooserReady;
      await chooser.setFiles({ name: filename, mimeType: 'application/json', buffer });
      await target.waitForFunction(() => !document.querySelector('.tcw-grid').inert);
    }
    await upload(file);
    await target.waitForFunction(() => testGrid.getLayoutSession().current()?.name === 'Bố cục thử/XAU');
    const imported = await target.evaluate(() => testGrid.getLayoutSession().current());
    assert.notEqual(imported.id, original.id);
    assert.equal(await target.evaluate(async id => (await testStorage.load(id)).content, original.id), originalContent);
    await target.reload();
    await target.waitForFunction(id => window.testGrid?.getLayoutSession().current()?.id === id, imported.id);
    assert.equal(await target.evaluate(() => testGrid.getLayout()), '1x2');
    assert.equal(await target.evaluate(() => testGrid.getActiveIndex()), 1);
    await target.evaluate(() => testGrid.setLayout('1x3'));
    await target.waitForFunction(() => testGrid.getWidget(2).getSettings().timezone === 'America/New_York');
    const state = await target.evaluate(() => testGrid.getWidgets().map(widget => {
      const chart = widget.getChart();
      const active = chart.getActiveIndicators();
      const sessions = JSON.parse(active.find(item => item.id === 'texmoonbeam-sessions').params.sessionSettings);
      return { frame: widget.getTimeframe(), zone: widget.getSettings().timezone, sessionsZone: sessions.zone,
        color: sessions.periods.previousDay.fibonacciColors.p382,
        level: sessions.periods.previousDay.fibonacciLevels.p382,
        outline: sessions.periods.previousDay.labelOutlineColor,
        average: active.find(item => item.id === 'mt5-cvd-candle').params.averageLength,
        drawings: chart.getDrawings() };
    }));
    assert.deepEqual(state.map(cell => [cell.frame, cell.zone, cell.sessionsZone, cell.color, cell.level, cell.outline, cell.average]), [
      ['5m', 'Asia/Tokyo', 'GMT+1', '#123456', true, '#aa3344', 11],
      ['15m', 'UTC', 'GMT+2', '#abcdef', false, '#aa3344', 12],
      ['1h', 'America/New_York', 'GMT+3', '#112233', true, '#aa3344', 13],
    ]);
    assert.equal(state[0].drawings[0].style.color, '#aabbcc');
    assert.equal(state[0].drawings[0].type, 'horizontalLine');

    await upload(Buffer.from('{broken-json'));
    await target.getByText('File không phải JSON bố cục hợp lệ.', { exact: true }).waitFor();
    assert.equal(await target.evaluate(() => testGrid.getLayoutSession().current().id), imported.id);
    assert.equal(await target.evaluate(() => testGrid.getWidgets().length), 3);
    const unknown = structuredClone(exported);
    unknown.layout.cells[0].symbol = '__MISSING__';
    await upload(Buffer.from(JSON.stringify(unknown)));
    await target.getByText('Mã __MISSING__ chưa có trong Market Watch MT5.', { exact: true }).waitFor();
    assert.equal(await target.evaluate(() => testGrid.getLayoutSession().current().id), imported.id);

    // A file saved in the original single-chart format still imports.
    await upload(Buffer.from(JSON.stringify(exported.layout.cells[0])), 'legacy.json');
    await target.waitForFunction(() => testGrid.getLayout() === '1x1' && testGrid.getLayoutSession().current()?.name === 'Bố cục đã nhập');
    assert.equal(await target.evaluate(() => testGrid.getWidget(0).getSettings().timezone), 'Asia/Tokyo');

    const beforeFailure = await target.evaluate(async () => {
      const session = testGrid.getLayoutSession();
      session.setAutoSave(false);
      testGrid.getWidget(0).setSettings({ timezone: 'Europe/London' });
      const previousId = session.current().id;
      const restore = testGrid.restoreLayout.bind(testGrid);
      let first = true;
      testGrid.restoreLayout = async content => {
        await restore(content);
        if (first) {
          first = false;
          // Another device saves while this import is in progress.
          const remote = (await (await fetch(`/api/layouts?id=${previousId}`)).json()).layout;
          const layout = JSON.parse(remote.content);
          layout.cells[0].settings.timezone = 'UTC';
          await fetch('/api/layouts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MT5-Layouts': '1' },
            body: JSON.stringify({ action: 'save', layout: { ...remote, content: JSON.stringify(layout) }, revision: remote.revision }) });
          throw new Error('Test interrupted import');
        }
      };
      return { id: session.current().id, count: (await session.list()).length };
    });
    await upload(file);
    await target.getByText('Test interrupted import', { exact: true }).waitFor();
    assert.equal(await target.evaluate(() => testGrid.getLayoutSession().current().id), beforeFailure.id);
    assert.equal(await target.evaluate(() => testGrid.getLayout()), '1x1');
    assert.equal(await target.evaluate(() => testGrid.getWidget(0).getSettings().timezone), 'Europe/London');
    assert.equal(await target.evaluate(async () => (await testGrid.getLayoutSession().list()).length), beforeFailure.count);
    assert.equal(await target.evaluate(async id => JSON.parse((await testStorage.load(id)).content).cells[0].settings.timezone, beforeFailure.id), 'UTC');
    assert.match(await target.evaluate(async () => { try { await testGrid.getLayoutSession().save(); return ''; } catch (error) { return error.message; } }), /máy khác/);
    assert.deepEqual(errors, []);
  } finally {
    for (const context of contexts) await context.close();
    await browser.close();
  }
});
