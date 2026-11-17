const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chromium } = require('playwright');
const { mkdir } = require('node:fs/promises');
const { tradingPage, setOneClick } = require('./trading-fixture.cjs');

async function labels(page) {
  return page.evaluate(async () => {
    const w = testGrid.getWidget(0), chart = w.getChart(), display = w.orderDisplay;
    chart.requestRender();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return chart.tradingManager.tagRects().map(rect => display?.hit({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })).filter(Boolean);
  });
}
async function setup(browser) {
  const result = await tradingPage(browser), { page, fixture } = result;
  fixture.positions = Array.from({ length: 5 }, (_, index) => ({ ...fixture.positions[0], id: String(123 + index),
    entryPrice: 3800 + index / 10, stopLoss: 3790 + index / 10, takeProfit: 3820 + index / 10,
    profit: 10 + index, expiresAt: index === 2 ? Date.UTC(2027, 0, 5, 16, 30) : null }));
  fixture.orders = [];
  await page.waitForFunction(() => testGrid.getWidget(0).getChart().getPositions().length === 5);
  await page.evaluate(async () => {
    const chart = testGrid.getWidget(0).getChart(); chart.setAutoScale(false); chart.viewport.setPriceRange(3770, 3840); chart.requestRender();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  return result;
}
async function point(page, label) {
  return page.evaluate(box => {
    const rect = testGrid.getWidget(0).chartContainer.getBoundingClientRect();
    return { x: rect.left + box.x + 10, y: rect.top + box.y + box.height / 2 };
  }, label);
}

test('hover and selection focus the complete trade, reveal ticket/time, and do not submit orders', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await setup(browser);
    let list = await labels(page);
    assert.equal(list.length, 15, 'each live Entry, SL and TP is identifiable');
    const entry = list.find(row => row.key === 'position:125:price');
    assert.equal(entry.text, 'BUY · 0.02 · +12.00 USD');
    const at = await point(page, entry); await page.mouse.move(at.x, at.y);
    await page.getByRole('tooltip').filter({ hasText: '#125' }).waitFor();
    const tip = await page.getByRole('tooltip').textContent();
    assert.match(tip, /2027-01-05/); assert.match(tip, /Entry/); assert.match(tip, /3820/);
    fixture.positions[2].profit = 21.4;
    await page.waitForFunction(() => document.querySelector('.mt5-order-tooltip').textContent.includes('+21.40 USD'));
    list = await labels(page);
    assert.ok(list.filter(row => row.owner === 'position:125').every(row => row.opacity === 1));
    assert.ok(list.filter(row => row.owner !== 'position:125').every(row => row.opacity < .5));
    await page.mouse.click(at.x, at.y); await page.mouse.move(15, 15);
    list = await labels(page);
    assert.ok(list.filter(row => row.owner !== 'position:125').every(row => row.opacity < .5), 'click pins selection');
    const lineOwner = await page.evaluate(lineY => {
      const w = testGrid.getWidget(0); return w.orderDisplay.hit({ x: w.getChart().viewport.getState().chartRect.x + 30, y: lineY }).owner;
    }, list.find(row => row.key === 'position:127:price').lineY);
    assert.equal(lineOwner, 'position:125', 'the selected ticket owns its crowded group of price lines');
    const empty = await page.evaluate(() => {
      const w = testGrid.getWidget(0), r = w.chartContainer.getBoundingClientRect(), p = w.getChart().viewport.getState().chartRect;
      return { x: r.left + p.x + 20, y: r.top + p.y + p.height - 40 };
    });
    await page.mouse.click(empty.x, empty.y);
    assert.ok((await labels(page)).every(row => row.opacity === 1), 'blank chart click clears selection');
    await page.mouse.click(at.x, at.y); await page.mouse.move(15, 15);
    await page.keyboard.press('Escape');
    assert.ok((await labels(page)).every(row => row.opacity === 1));
    await page.mouse.click(at.x, at.y); await page.mouse.move(15, 15);
    fixture.account.id = 'second-mock-account';
    await page.waitForFunction(() => {
      const w = testGrid.getWidget(0), d = w.orderDisplay;
      return w.getChart().tradingManager.tagRects().every(r => d.hit({ x: r.x + r.width / 2, y: r.y + r.height / 2 })?.opacity === 1);
    });
    await page.mouse.click(at.x, at.y); await page.mouse.move(15, 15);
    fixture.positions = fixture.positions.filter(row => row.id !== '125');
    await page.waitForFunction(() => testGrid.getWidget(0).getChart().getPositions().length === 4);
    assert.ok(!(await labels(page)).some(row => row.owner === 'position:125'));
    assert.ok((await labels(page)).every(row => row.opacity === 1), 'closing the selected ticket clears focus');
    assert.equal(fixture.checked.length, 0); assert.equal(fixture.executed.length, 0); assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});

test('left-dragging a crowded pending Entry preserves its bracket and direct TP drag changes only that exit', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await tradingPage(browser);
    fixture.positions = [];
    fixture.orders = Array.from({ length: 5 }, (_, index) => ({ ...fixture.orders[0], id: String(321 + index),
      price: 3750 + index / 10, stopLoss: 3740 + index / 10, takeProfit: 3770 + index / 10 }));
    await page.waitForFunction(() => testGrid.getWidget(0).getChart().getOrders().length === 5 && !testGrid.getWidget(0).getChart().getPositions().length);
    await page.evaluate(() => { const chart = testGrid.getWidget(0).getChart(); chart.setAutoScale(false); chart.viewport.setPriceRange(3700, 3860); chart.requestRender(); });
    await setOneClick(page);
    const entry = (await labels(page)).find(row => row.field === 'price' && Math.abs(row.y + row.height / 2 - row.lineY) > 10);
    const original = { ...fixture.orders.find(row => row.id === entry.id) };
    async function moved(label, dy) {
      const at = await point(page, label), response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/trading/execute');
      await page.mouse.move(at.x, at.y); await page.mouse.down(); await page.mouse.move(at.x, at.y + dy, { steps: 6 }); await page.mouse.up();
      await response; await page.waitForFunction(() => !document.querySelector('[aria-label="Mua nhanh MT5"]').disabled);
    }
    await moved(entry, 10);
    const changed = fixture.orders.find(row => row.id === entry.id), delta = changed.price - original.price;
    assert.equal(fixture.executed.at(-1).intent.orderId, entry.id);
    assert.ok(delta < 0 && delta > -5, 'drag distance starts at the actual Entry rather than the displaced label');
    assert.ok(Math.abs(changed.stopLoss - original.stopLoss - delta) < .002);
    assert.ok(Math.abs(changed.takeProfit - original.takeProfit - delta) < .002);
    const prior = { ...changed };
    await moved((await labels(page)).find(row => row.owner === entry.owner && row.field === 'takeProfit'), -10);
    assert.equal(changed.price, prior.price); assert.equal(changed.stopLoss, prior.stopLoss); assert.ok(changed.takeProfit > prior.takeProfit);
    assert.equal(fixture.executed.length, 2); assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});

test('crowded trade labels fit phone, laptop and wide charts in both themes and three looks', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await setup(browser);
    const directory = 'artifacts/order-display'; await mkdir(directory, { recursive: true });
    for (const width of [390, 1366, 1920]) for (const theme of ['dark', 'light']) for (const look of ['print', 'studio', 'terminal']) {
      await page.mouse.move(10, 10); await page.keyboard.press('Escape');
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.evaluate(async ({ theme, look }) => {
        testGrid.setTheme(theme); testGrid.setUI(look);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, { theme, look });
      const list = await labels(page); assert.equal(list.length, 15);
      const bounds = await page.evaluate(() => testGrid.getWidget(0).getChart().viewport.getState().chartRect);
      for (const box of list) {
        assert.ok(box.x >= bounds.x && box.x + box.width <= bounds.x + bounds.width,
          JSON.stringify({ width, theme, look, box: { x: box.x, width: box.width, key: box.key }, bounds }));
        assert.ok(box.y >= bounds.y && box.y + box.height <= bounds.y + bounds.height);
        for (const other of list) if (box.key !== other.key) assert.ok(box.x + box.width <= other.x || other.x + other.width <= box.x ||
          box.y + box.height <= other.y || other.y + other.height <= box.y, `${width} ${theme} ${look}: overlapping labels`);
      }
      const at = await point(page, list.find(row => row.key === 'position:125:price'));
      await page.mouse.move(at.x, at.y); await page.getByRole('tooltip').filter({ hasText: '#125' }).waitFor();
      await page.screenshot({ path: `${directory}/${width}-${theme}-${look}.png` });
    }
    assert.equal(fixture.checked.length, 0); assert.equal(fixture.executed.length, 0); assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});

test('dragging a displaced label uses its price anchor and close buttons keep the correct ticket', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, fixture } = await setup(browser); await setOneClick(page);
    const entry = (await labels(page)).find(row => row.field === 'price' && Math.abs(row.y + row.height / 2 - row.lineY) > 10);
    assert.ok(entry, 'at least one Entry label has been displaced');
    const at = await point(page, entry);
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/trading/execute');
    await page.mouse.move(at.x, at.y); await page.mouse.down({ button: 'middle' });
    await page.mouse.move(at.x, at.y + 15, { steps: 5 });
    assert.equal(fixture.executed.length, 0); await page.mouse.up({ button: 'middle' }); await response;
    const command = fixture.executed.at(-1);
    assert.equal(command.intent.positionId, entry.id);
    assert.ok(command.intent.stopLoss < fixture.positions.find(row => row.id === entry.id).entryPrice);
    assert.ok(!('takeProfit' in command.intent), 'displaced label does not reverse the intended exit');
    await page.waitForFunction(() => !document.querySelector('[aria-label="Mua nhanh MT5"]').disabled);
    await setOneClick(page, false);
    const close = await page.evaluate(id => {
      const w = testGrid.getWidget(0), rect = w.chartContainer.getBoundingClientRect();
      const button = w.getChart().tradingManager.buttons.find(row => row.action.type === 'closePosition' && row.action.positionId === id);
      return { x: rect.left + button.x + button.size / 2, y: rect.top + button.y + button.size / 2 };
    }, entry.id);
    await page.mouse.click(close.x, close.y); await page.locator('#mt5-review').waitFor();
    assert.equal(fixture.checked.at(-1).intent.positionId, entry.id); assert.equal(fixture.checked.at(-1).action, 'close');
    assert.equal(fixture.executed.length, 1); assert.deepEqual(fixture.errors, []);
  } finally { await browser.close(); }
});
