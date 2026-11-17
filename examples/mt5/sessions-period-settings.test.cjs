const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chromium } = require('playwright');

test('each period keeps its own Fibonacci controls, line settings and outlined labels', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1700, height: 1050 } });
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      if (sessionStorage.getItem('period-test-seeded')) return;
      localStorage.setItem('mt5:texmoonbeam-sessions:v1', JSON.stringify({
        fibonacci: { levels: { p236: false, p382: false, p500: true, p618: false, p786: false },
          colors: { p500: '#00aabb' }, direction: 'High → Low', labelOutlineColor: '#223344' },
        periods: { previousDay: { mid: true } },
      }));
      sessionStorage.setItem('period-test-seeded', '1');
    });
    await page.route('**/app.js', async route => {
      const response = await route.fetch();
      const marker = 'installGridLayoutPersistence(grid);';
      await route.fulfill({ response, body: (await response.text()).replace(marker, `${marker}\nwindow.testGrid = grid;`) });
    });
    await page.goto(process.env.TRADECANVAS_URL || 'http://127.0.0.1:8772/');
    await page.waitForFunction(() => window.testGrid?.getWidget(0).getChart().getData().length > 20);
    const dialog = page.getByRole('dialog', { name: 'All-In-One Sessions' });
    const section = title => dialog.locator('details').filter({ has: page.locator('summary', { hasText: new RegExp(`^${title}$`) }) }).last();
    async function expand(target) {
      if (!await target.evaluate(element => element.open)) await target.locator(':scope > summary').click();
    }
    async function open() {
      await page.locator('.tcw-ind-legend-row[data-instance*="texmoonbeam-sessions"] .tcw-ind-legend-name').click();
      await expand(section('Mức ngày, tuần và tháng'));
    }
    async function period(title) {
      const target = section(title);
      await expand(target);
      const fib = target.locator('details').filter({ has: page.locator('summary', { hasText: /^Fibonacci$/ }) });
      await expand(fib);
      return { target, fib };
    }
    await open();
    const day = await period('Ngày trước');
    assert.equal(await day.fib.getByLabel('50%', { exact: true }).isChecked(), true);
    assert.equal(await day.fib.getByLabel('38,2%', { exact: true }).isChecked(), false);
    assert.equal(await day.fib.getByLabel('Màu mức 50%', { exact: true }).inputValue(), '#00aabb');
    assert.equal(await day.target.getByLabel('Màu viền chữ', { exact: true }).inputValue(), '#223344');
    await day.fib.getByRole('button', { name: 'Tắt tất cả', exact: true }).click();
    await day.fib.getByLabel('61,8%', { exact: true }).check();
    await day.fib.getByLabel('Màu mức 61,8%', { exact: true }).fill('#aabbcc');
    await day.target.getByLabel('Màu viền chữ', { exact: true }).fill('#556677');
    await day.target.getByLabel('Kéo dài sang phải', { exact: true }).check();
    await day.target.getByLabel('Độ dày', { exact: true }).fill('3');
    await day.target.getByLabel('Kiểu nét').selectOption('dashed');
    await day.target.getByLabel('Dời nhãn và đầu nét (số nến)', { exact: true }).fill('12');
    const week = await period('Tuần trước');
    await week.fib.getByRole('button', { name: 'Tắt tất cả', exact: true }).click();
    await week.fib.getByLabel('78,6%', { exact: true }).check();
    await week.target.getByLabel('Màu viền chữ', { exact: true }).fill('#778899');
    const month = await period('Tháng trước');
    await month.fib.getByRole('button', { name: 'Tắt tất cả', exact: true }).click();
    await month.fib.getByLabel('23,6%', { exact: true }).check();
    await month.target.getByLabel('Màu viền chữ', { exact: true }).fill('#990011');
    await dialog.getByRole('button', { name: 'Áp dụng', exact: true }).click();
    const layout = await page.evaluate(() => testGrid.getLayoutSession().saveAs('Period Fibonacci'));
    await page.reload();
    await page.waitForFunction(id => window.testGrid?.getLayoutSession().current()?.id === id, layout.id);
    await open();
    for (const [title, selected, outline] of [
      ['Ngày trước', '61,8%', '#556677'], ['Tuần trước', '78,6%', '#778899'], ['Tháng trước', '23,6%', '#990011'],
    ]) {
      const { target, fib } = await period(title);
      for (const percent of ['23,6%', '38,2%', '50%', '61,8%', '78,6%']) {
        assert.equal(await fib.getByLabel(percent, { exact: true }).isChecked(), percent === selected, `${title} ${percent}`);
      }
      assert.equal(await target.getByLabel('Màu viền chữ', { exact: true }).inputValue(), outline);
    }
    const restored = await period('Ngày trước');
    assert.equal(await restored.target.getByLabel('Kéo dài sang phải', { exact: true }).isChecked(), true);
    assert.equal(await restored.target.getByLabel('Dời nhãn và đầu nét (số nến)', { exact: true }).inputValue(), '12');
    await dialog.getByRole('button', { name: 'Hủy', exact: true }).click();
    await page.waitForResponse(response => response.ok() && new URL(response.url()).searchParams.has('since'));
    const rendered = await page.evaluate(async () => {
      const widget = testGrid.getWidget(0);
      const chart = widget.getChart();
      const query = new URLSearchParams({ symbol: widget.getSymbol(), frame: widget.getTimeframe(), count: 1, periods: 1 });
      const data = await (await fetch(`/api/bars?${query}`)).json();
      const previous = data.periods.day.at(-2);
      chart.setAutoScale(false);
      chart.viewport.setPriceRange(previous.low - 1, previous.high + 1);
      const engine = chart.indicatorEngine;
      const draws = engine.overlayDraws;
      const text = [];
      const lines = [];
      engine.overlayDraws = function (...args) {
        return draws.apply(this, args).map(draw => ctx => {
          const methods = { strokeText: ctx.strokeText, fillText: ctx.fillText, beginPath: ctx.beginPath,
            moveTo: ctx.moveTo, lineTo: ctx.lineTo, stroke: ctx.stroke };
          let path = [];
          ctx.beginPath = function () { path = []; return methods.beginPath.call(this); };
          ctx.moveTo = function (x, y) { path.push([x, y]); return methods.moveTo.call(this, x, y); };
          ctx.lineTo = function (x, y) { path.push([x, y]); return methods.lineTo.call(this, x, y); };
          ctx.stroke = function () {
            if (this.strokeStyle === '#aabbcc') lines.push({ path: [...path], width: this.lineWidth });
            return methods.stroke.call(this);
          };
          for (const method of ['strokeText', 'fillText']) ctx[method] = function (value, ...params) {
            if (/^PD(?:H|L|\.5| )/.test(value)) text.push({ method, value,
              color: method === 'strokeText' ? this.strokeStyle : this.fillStyle });
            return methods[method].call(this, value, ...params);
          };
          try { return draw(ctx); } finally { Object.assign(ctx, methods); }
        });
      };
      try {
        chart.requestRender();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      } finally { engine.overlayDraws = draws; }
      return { text, lines, right: chart.viewport.getState().chartRect.x + chart.viewport.getState().chartRect.width };
    });
    for (const value of ['PDH', 'PDL', 'PD.5', 'PD 61,8%']) {
      assert.ok(rendered.text.some(text => text.method === 'strokeText' && text.value === value && text.color === '#556677'), value);
    }
    assert.ok(rendered.text.some(text => text.method === 'fillText' && text.value === 'PD 61,8%' && text.color === '#aabbcc'));
    assert.ok(rendered.lines.some(line => line.width === 3 && Math.abs(line.path[1][0] - rendered.right) < 1), 'period extension applies to Fibo');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
