// Every trading endpoint is intercepted. These browser fixtures cannot send an MT5 order.
exports.tradingPage = async function tradingPage(browser, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1740, height: 1050 } });
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  const errors = [], checked = [], executed = [], estimates = [];
  const account = { id: 'mock-account', login: 'TEST-ONLY', server: 'Mock Broker', demo: true, currency: 'USD',
    balance: 10000, equity: 10010, marginFree: 9000, profit: 10, leverage: 100, allowed: true, reason: '' };
  const fixture = { account, errors, checked, executed, estimates, fail: false, delay: 0, checkError: '', pauseNextState: false, releaseState: null,
    positions: [{ id: '123', symbol: 'XAUUSDm', side: 'buy', entryPrice: 3800, quantity: .02, stopLoss: 3790, takeProfit: 3820, profit: 10 }],
    orders: [{ id: '321', symbol: 'XAUUSDm', side: 'buy', type: 'limit', price: 3750, quantity: .01, stopLoss: 3740, takeProfit: 3770 }] };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/trading/**', async route => {
    const url = new URL(route.request().url()); let result;
    if (url.pathname.endsWith('/session')) result = { key: 'test-key' };
    else if (url.pathname.endsWith('/state')) {
      const quotes = Object.fromEntries((url.searchParams.get('symbols') || 'XAUUSDm').split(',').map(symbol => [symbol,
        { bid: 3800, ask: 3800.01, min: .01, max: 200, step: .01, tickSize: .001, digits: 3, orderMode: 127, expirationMode: 15 }]));
      result = { account, positions: fixture.positions, orders: fixture.orders, quotes };
      if (fixture.pauseNextState) {
        fixture.pauseNextState = false;
        const snapshot = JSON.stringify(result);
        await new Promise(resolve => { fixture.releaseState = resolve; });
        fixture.releaseState = null;
        await route.fulfill({ contentType: 'application/json', body: snapshot }); return;
      }
    } else if (url.pathname.endsWith('/estimate')) {
      const command = route.request().postDataJSON(); estimates.push(command);
      const i = command.intent, entry = i.type === 'market' ? i.side === 'buy' ? 3800.01 : 3800 : i.price;
      const riskPerLot = i.stopLoss == null ? null : Math.abs(entry - i.stopLoss) * 100;
      let quantity = i.quantity;
      if (i.quantityMode === 'riskPercent') quantity = Math.floor((account.balance * i.quantity / 100) / riskPerLot * 100) / 100;
      if (i.quantityMode === 'riskAmount') quantity = Math.floor(i.quantity / riskPerLot * 100) / 100;
      const risk = riskPerLot == null ? null : riskPerLot * quantity;
      const reward = i.takeProfit == null ? null : Math.abs(i.takeProfit - entry) * 100 * quantity;
      result = { quantity, entry, currency: 'USD', risk, reward, ratio: risk && reward ? reward / risk : null,
        margin: quantity * 100, marginFree: account.marginFree, leverage: account.leverage, tickValue: quantity * .1, notional: quantity * 100 * entry };
    } else if (url.pathname.endsWith('/check')) {
      const command = route.request().postDataJSON(); checked.push(command);
      if (fixture.checkError) { await route.fulfill({ status: 400, json: { error: fixture.checkError } }); return; }
      result = { ok: true, account, request: command };
    } else if (url.pathname.endsWith('/execute')) {
      const command = route.request().postDataJSON(); executed.push(command);
      if (fixture.delay) await new Promise(resolve => setTimeout(resolve, fixture.delay));
      if (fixture.fail) result = { ok: false, uncertain: true, error: 'Mock unknown outcome' };
      else {
        if (command.action === 'close') fixture.positions = [];
        if (command.action === 'cancel') fixture.orders = [];
        if (command.action === 'modifyPosition') Object.assign(fixture.positions.find(row => row.id === command.intent.positionId), command.intent);
        if (command.action === 'modifyOrder') {
          const row = fixture.orders.find(row => row.id === command.intent.orderId);
          if (row.type === 'stopLimit') { row.stopPrice = command.intent.newPrice; row.price = command.intent.limitPrice ?? row.price; }
          else { row.price = command.intent.newPrice; if (row.type === 'stop') row.stopPrice = row.price; }
          Object.assign(row, Object.fromEntries(Object.entries(command.intent).filter(([key]) => ['stopLoss', 'takeProfit'].includes(key))));
        }
        result = { ok: true, order: '999', deal: '888' };
      }
    } else { errors.push(`Unexpected trading route ${url.pathname}`); await route.abort('blockedbyclient'); return; }
    await route.fulfill({ json: result });
  });
  await page.route('**/app.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace('installGridLayoutPersistence(grid);',
      'installGridLayoutPersistence(grid); window.testGrid = grid; window.testReady = layoutOperations;') });
  });
  await page.goto(options.url || process.env.TRADECANVAS_URL || 'http://127.0.0.1:8773/');
  await page.waitForFunction(() => window.testReady && testGrid.getWidget(0).getChart().getPositions().length === 1);
  await page.evaluate(async () => { await testReady.ready(); testGrid.getLayoutSession().setAutoSave(false); testGrid.setLayout('1x1'); });
  return { page, context, fixture };
};
