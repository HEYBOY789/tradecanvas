const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chromium } = require('playwright');

test('Fibonacci checkboxes and all/none buttons stay independent and survive reload', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1700, height: 1050 } });
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/app.js', async route => {
      const response = await route.fetch();
      const marker = 'installGridLayoutPersistence(grid);';
      await route.fulfill({ response, body: (await response.text()).replace(marker, `${marker}\nwindow.testGrid = grid;`) });
    });
    await page.goto(process.env.TRADECANVAS_URL || 'http://127.0.0.1:8772/');
    await page.waitForFunction(() => window.testGrid?.getWidget(0).getChart().getData().length > 20);
    await page.evaluate(() => {
      const chart = testGrid.getWidget(0).getChart();
      const cvd = chart.getActiveIndicators().find(item => item.id === 'mt5-cvd-candle');
      chart.addIndicator('texmoonbeam-sessions-panel', { source: `ind:${cvd.instanceId}:close` }, undefined, { pane: cvd.instanceId });
    });
    const dialog = page.getByRole('dialog', { name: 'All-In-One Sessions' });
    const group = dialog.locator('details').filter({ has: page.locator('summary', { hasText: /^Fibonacci phiên trước$/ }) });
    async function open(kind) {
      const id = await page.evaluate(kind => testGrid.getWidget(0).getChart().getActiveIndicators().find(item => item.id === kind).instanceId, kind);
      await page.locator(`.tcw-ind-legend-row[data-instance="${id}"] .tcw-ind-legend-name`).click();
      await dialog.waitFor();
      if (!await group.evaluate(element => element.open)) await group.locator('summary').click();
    }
    const percentages = ['23,6%', '38,2%', '50%', '61,8%', '78,6%'];
    const selected = async () => {
      const values = [];
      for (const percent of percentages) if (await group.getByLabel(percent, { exact: true }).isChecked()) values.push(percent);
      return values;
    };
    const main = 'texmoonbeam-sessions';
    const panel = 'texmoonbeam-sessions-panel';
    await open(main);
    assert.deepEqual(await selected(), percentages);
    assert.equal(await group.getByLabel('Kéo Fibo sang phải', { exact: true }).count(), 0);
    await group.getByRole('button', { name: 'Tắt tất cả', exact: true }).click();
    assert.deepEqual(await selected(), []);
    await group.getByLabel('50%', { exact: true }).check();
    await group.getByLabel('Giữ Fibo phiên cũ', { exact: true }).check();
    await group.getByLabel('38,2%', { exact: true }).check();
    await group.getByLabel('Màu mức 38,2%', { exact: true }).fill('#eebb44');
    await group.getByLabel('Màu viền số Fibo', { exact: true }).fill('#112233');
    await group.getByLabel('Chiều Fibo (0% → 100%)').selectOption('High → Low');
    await dialog.getByRole('button', { name: 'Áp dụng', exact: true }).click();
    await open(panel);
    assert.equal(await group.getByLabel('Giữ Fibo phiên cũ', { exact: true }).isChecked(), false);
    assert.deepEqual(await selected(), percentages, 'price settings do not leak to the CVD instance');
    await group.getByRole('button', { name: 'Tắt tất cả', exact: true }).click();
    await group.getByLabel('23,6%', { exact: true }).check();
    await group.getByLabel('Màu mức 23,6%', { exact: true }).fill('#aabbcc');
    await group.getByLabel('Màu viền số Fibo', { exact: true }).fill('#332211');
    await dialog.getByRole('button', { name: 'Áp dụng', exact: true }).click();
    const layout = await page.evaluate(() => testGrid.getLayoutSession().saveAs('Fibonacci levels'));
    await page.reload();
    await page.waitForFunction(id => window.testGrid?.getLayoutSession().current()?.id === id, layout.id);
    await open(main);
    assert.equal(await group.getByLabel('Giữ Fibo phiên cũ', { exact: true }).isChecked(), true);
    assert.deepEqual(await selected(), ['38,2%', '50%']);
    assert.equal(await group.getByLabel('Chiều Fibo (0% → 100%)').inputValue(), 'High → Low');
    assert.equal(await group.getByLabel('Màu mức 38,2%', { exact: true }).inputValue(), '#eebb44');
    assert.equal(await group.getByLabel('Màu viền số Fibo', { exact: true }).inputValue(), '#112233');
    await dialog.getByRole('button', { name: 'Hủy', exact: true }).click();
    await open(panel);
    assert.deepEqual(await selected(), ['23,6%']);
    assert.equal(await group.getByLabel('Màu mức 23,6%', { exact: true }).inputValue(), '#aabbcc');
    assert.equal(await group.getByLabel('Màu viền số Fibo', { exact: true }).inputValue(), '#332211');
    await group.getByRole('button', { name: 'Hiện tất cả', exact: true }).click();
    assert.deepEqual(await selected(), percentages);
    await dialog.getByRole('button', { name: 'Áp dụng', exact: true }).click();
    await page.waitForResponse(response => {
      const query = new URL(response.url()).searchParams;
      return response.ok() && query.has('since') && query.get('periods') === '1';
    });
    const labels = await page.evaluate(async () => {
      const widget = testGrid.getWidget(0);
      const chart = widget.getChart();
      const query = new URLSearchParams({ symbol: widget.getSymbol(), frame: widget.getTimeframe(), count: 1, periods: 1 });
      const result = await (await fetch(`/api/bars?${query}`)).json();
      const previous = result.periods.day.at(-2);
      chart.setAutoScale(false);
      chart.viewport.setPriceRange(previous.low - 1, previous.high + 1);
      const engine = chart.indicatorEngine;
      const draws = engine.overlayDraws;
      const labels = [];
      engine.overlayDraws = function (...args) {
        return draws.apply(this, args).map(draw => ctx => {
          const fill = ctx.fillText;
          ctx.fillText = function (text, ...params) {
            if (/^\d+(?:,\d+)?%$/.test(text)) labels.push(text);
            return fill.call(this, text, ...params);
          };
          try { return draw(ctx); } finally { ctx.fillText = fill; }
        });
      };
      try {
        chart.requestRender();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      } finally { engine.overlayDraws = draws; }
      return labels;
    });
    if (process.env.TRADECANVAS_SCREENSHOT) await page.screenshot({ path: process.env.TRADECANVAS_SCREENSHOT });
    assert.ok(labels.includes('38,2%') && labels.includes('50%'), `selected levels are painted on the chart: ${JSON.stringify(labels)}`);
    assert.ok(labels.every(text => !/23,6%|61,8%|78,6%/.test(text)), 'unchecked levels are absent from the price chart');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
