const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chromium } = require('playwright');
const { mkdir } = require('node:fs/promises');
const { tradingPage } = require('./trading-fixture.cjs');

async function settings(page) {
  await page.evaluate(() => testGrid.getWidget(0).chartSettings.openSettings('symbol'));
  const modal = page.locator('.tcw-set'); await modal.waitFor();
  return { modal, section: modal.getByRole('group', { name: 'Giá cuối', exact: true }) };
}

test('the native price-line switch owns Bid and the single optional Ask checkbox', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser);
    const { modal, section } = await settings(page);
    assert.equal(await modal.getByLabel('Đường giá Bid', { exact: true }).count(), 0);
    await section.getByLabel('Màu Bid', { exact: true }).waitFor(); await section.getByLabel('Màu Ask', { exact: true }).waitFor();
    assert.equal(await section.locator('input[type=checkbox]').count(), 1);
    const ask = section.getByLabel('Đường giá Ask', { exact: true }); await ask.check();
    await section.getByRole('switch', { name: 'Đường giá', exact: true }).uncheck();
    await ask.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => testGrid.getWidget(0).getChart().getBidAsk() == null);
    await section.getByRole('switch', { name: 'Đường giá', exact: true }).check();
    await ask.waitFor(); assert.equal(await ask.isChecked(), true);
    await page.waitForFunction(() => testGrid.getWidget(0).getChart().getBidAsk()?.ask === 3800.01);
    assert.deepEqual(await page.evaluate(() => testGrid.getWidget(0).getChart().getBidAsk()), { ask: 3800.01 });
    await modal.locator('[data-act=ok]').click();
    assert.equal(fixture.checked.length, 0); assert.equal(fixture.executed.length, 0); assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});

test('high/low lines keep working and replay shows the historical price rather than the live quote', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser);
    const before = await page.evaluate(async () => {
      const w = testGrid.getWidget(0), c = w.getChart(); w.setTradePreferences({ ask: true }); w.setSettings({ highLowLines: true });
      c.requestRender(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return c.priceLines.levels(c.getData(), c.viewport.getState()).map(row => row.kind);
    });
    assert.deepEqual(before.sort(), ['ask', 'high', 'low']);
    const replay = await page.evaluate(async () => {
      const c = testGrid.getWidget(0).getChart(), bars = [...c.getData()];
      const startIndex = bars.findIndex(row => Math.abs(row.close - 3800) > 1);
      c.replayStart({ startIndex }); c.replayPause(); c.requestRender();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { active: c.isReplayActive(), price: c.currentPriceLine.getPrice(), expected: bars[c.getReplayBarIndex()].close,
        levels: c.priceLines.levels(c.getData(), c.viewport.getState()).map(row => row.kind) };
    });
    assert.equal(replay.active, true); assert.equal(replay.price, replay.expected); assert.equal(replay.levels.includes('ask'), false);
    await page.evaluate(() => testGrid.getWidget(0).getChart().replayStop());
    await page.waitForFunction(() => {
      const c = testGrid.getWidget(0).getChart(); return c.currentPriceLine.getPrice() === 3800 && c.priceLines.levels(c.getData(), c.viewport.getState()).some(row => row.kind === 'ask');
    });
    assert.equal(fixture.checked.length, 0); assert.equal(fixture.executed.length, 0); assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});

test('Bid and Ask actually render once each with shared dash/width and independent fixed colors', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser);
    await page.evaluate(() => {
      const w = testGrid.getWidget(0), c = w.getChart();
      w.setTradePreferences({ bid: false, ask: true }); // Legacy layouts must not disable the default Bid.
      c.setAutoScale(false); c.viewport.setPriceRange(3795, 3805);
      c.applyOverrides({ 'lastPrice.visible': true, 'lastPrice.upColor': '#123456', 'lastPrice.downColor': '#abcdef', 'lastPrice.style': 'dashed', 'lastPrice.width': 3 });
      c.currentPriceLine.setPrice(3800, 4000);
    });
    const painted = await page.evaluate(async () => {
      const c = testGrid.getWidget(0).getChart(), lines = [], native = CanvasRenderingContext2D.prototype.stroke;
      CanvasRenderingContext2D.prototype.stroke = function(...args) {
        if (['#123456', '#abcdef'].includes(this.strokeStyle)) lines.push({ color: this.strokeStyle, width: this.lineWidth, dash: this.getLineDash() });
        return native.apply(this, args);
      };
      try {
        c.requestRender(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return { lines, bid: c.currentPriceLine.getPrice(), bidColor: c.currentPriceLine.getTag()?.color,
          levels: c.priceLines.levels(c.getData(), c.viewport.getState()) };
      } finally { CanvasRenderingContext2D.prototype.stroke = native; }
    });
    const bid = painted.lines.filter(row => row.color === '#123456'), ask = painted.lines.filter(row => row.color === '#abcdef');
    assert.ok(bid.length > 0 && ask.length > 0, JSON.stringify(painted));
    assert.ok([...bid, ...ask].every(row => row.width === 3)); assert.deepEqual(bid[0].dash, ask[0].dash); assert.ok(ask[0].dash.length > 0);
    assert.equal(painted.bid, 3800); assert.equal(painted.bidColor, '#123456', 'Bid color stays fixed even below previous close');
    assert.equal(painted.levels.filter(row => row.kind === 'bid').length, 0, 'no duplicate Bid quote overlay');
    assert.equal(painted.levels.filter(row => row.kind === 'ask').length, 1);
    assert.equal(fixture.executed.length, 0); assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});

test('quote settings fit phone, laptop and wide screens in both themes and three looks', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser);
    await mkdir('artifacts/quote-settings', { recursive: true });
    for (const width of [390, 1366, 1920]) for (const theme of ['dark', 'light']) for (const look of ['print', 'studio', 'terminal']) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.evaluate(({ theme, look }) => { testGrid.setTheme(theme); testGrid.setUI(look); }, { theme, look });
      const { modal, section } = await settings(page);
      await section.getByLabel('Đường giá Ask', { exact: true }).check();
      await section.scrollIntoViewIfNeeded();
      const metrics = await modal.locator('.tcw-set-panel').evaluate(root => ({ client: root.clientWidth, scroll: root.scrollWidth }));
      assert.ok(metrics.scroll <= metrics.client + 1, `${width} ${theme} ${look}: horizontal overflow`);
      await page.screenshot({ path: `artifacts/quote-settings/${width}-${theme}-${look}.png` });
      await modal.locator('[data-act=cancel]').click(); await modal.waitFor({ state: 'detached' });
    }
    assert.equal(fixture.executed.length, 0); assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});
