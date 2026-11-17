import { createOrderTicket } from './order-ticket.js';
import { drawingOrder, roundPrice } from './order-model.js';
import { orderProjection, pendingStopHandles } from './order-projection.js';
import { installTradePreferences } from './chart-preferences.js';
import { expiryChart } from './expiry-chart.js';
import { expiryFields, timeLabel } from './order-time.js';
import { tradeIssue, projectOrder } from './order-rules.js';

// Every command is preflighted and bound to the displayed account. The user
// chooses whether chart clicks require a preview or use One-click trading.
const uid = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), n => n.toString(16).padStart(2, '0')).join('');
const copy = value => JSON.parse(JSON.stringify(value));
const money = (value, currency) => `${Number(value).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} ${currency}`;

function element(tag, text, attrs = {}) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function button(text, click) {
  const node = element('button', text, { type: 'button' });
  node.addEventListener('click', click);
  return node;
}

function dialog(title, transient = true) {
  const node = element('dialog', null, { class: 'mt5-dialog' });
  node.setAttribute('aria-label', title);
  node.append(element('h2', title));
  document.body.append(node);
  if (transient) node.addEventListener('close', () => node.remove(), { once: true });
  return node;
}

export function createMt5Trading(getActiveWidget) {
  let key = sessionStorage.getItem('mt5:trading-key') || '';
  let state = null, timer, refreshing = null, busy = false, reviewOpen = false;
  let connected = false, message = '', armed = false, armedAccount = '', projection = null, syncingDrawing = false;
  const quickLots = new Map();
  const bracketModes = new WeakMap();
  const adapters = new Set();
  const badge = element('span', 'MT5: đang kết nối…', { id: 'mt5-trading-status', role: 'status' });
  const failure = element('div', null, { id: 'mt5-trading-error', role: 'alert' });
  const failureText = element('span');
  failure.hidden = true;
  failure.append(failureText, button('Đóng', () => { failure.hidden = true; }));
  document.querySelector('header').append(failure);
  const accountPanel = dialog('Tài khoản và lệnh MT5', false);
  accountPanel.id = 'mt5-account';
  const summary = element('p');
  const warning = element('p', null, { class: 'mt5-warning' });
  const lists = element('div');
  accountPanel.append(summary, warning, lists,
    button('Mã kết nối máy khác', pair), button('Đóng', () => accountPanel.close()));
  document.querySelector('header').append(badge,
    button('Đặt lệnh MT5', () => openTicket()),
    button('Vị thế MT5', () => { render(); accountPanel.showModal(); refresh(); }));
  const ticket = createOrderTicket({
    account: () => state?.account,
    quoteFor: symbol => state?.quotes[symbol],
    estimate: command => api('estimate', command),
    send: (intent, symbol, accountId) => review('place', intent, symbol, accountId),
    onChange(draft, source) {
      if (draft.quantityMode === 'lots') quickLots.set(draft.symbol, draft.quantity);
      const owner = ticket.read().widget;
      if (!owner || !draft.drawingId || source === 'drawing' || syncingDrawing || draft.type === 'market') return;
      const chart = owner.getChart();
      const drawing = chart.getDrawings().find(item => item.id === draft.drawingId);
      const risk = Math.abs(draft.price - draft.stopLoss);
      const ratio = Math.abs(draft.takeProfit - draft.price) / risk;
      if (!drawing || !draft.stopLoss || !draft.takeProfit || !Number.isFinite(ratio) || ratio < .1 || ratio > 100) return;
      syncingDrawing = true;
      try {
        chart.updateDrawing(drawing.id, { anchors: drawing.anchors.map((anchor, i) => ({ ...anchor, price: i ? draft.stopLoss : draft.price })),
          options: { rewardRatio: ratio, accountSize: state.account.balance,
            ...(draft.quantityMode === 'riskPercent' ? { riskMode: 'percent', risk: draft.quantity } : draft.quantityMode === 'riskAmount' ? { riskMode: 'amount', risk: draft.quantity } : {}) } });
      } finally { syncingDrawing = false; }
    },
    onClose() { projection?.destroy(); projection = null; },
    oneClick: () => armed && armedAccount === state?.account.id,
    setOneClick,
  });

  function setOneClick(value) {
    if (!state?.account || busy || reviewOpen) return;
    armed = value; armedAccount = state.account.id;
    try { sessionStorage.setItem(`mt5:one-click:${armedAccount}`, value ? '1' : '0'); } catch { /* This tab still keeps the explicit choice. */ }
    publish();
  }

  async function api(path, command) {
    const response = await fetch(`/api/trading/${path}`, {
      method: command ? 'POST' : 'GET',
      headers: { 'X-MT5-Key': key, ...(command ? { 'Content-Type': 'application/json' } : {}) },
      ...(command ? { body: JSON.stringify(command) } : {}),
      signal: AbortSignal.timeout(20000),
    });
    const result = await response.json();
    if (!response.ok || result.ok === false) throw new Error(result.error || 'Không gửi được yêu cầu MT5.');
    return result;
  }

  function report(error) {
    message = error?.message || String(error);
    badge.textContent = `MT5: ${message}`;
    // Quote polling must not erase a rejected edit before the user sees it.
    failureText.textContent = message;
    failure.hidden = false;
    render();
  }

  function publish() {
    for (const adapter of adapters) adapter.publish();
    render();
  }

  async function refresh(fresh = false) {
    if (fresh && refreshing) await refreshing;
    if (refreshing) return refreshing;
    if (!key) return;
    refreshing = (async () => {
      try {
        const symbols = [...new Set([...adapters].map(a => a.symbol()))];
        if (!symbols.length) return;
        const next = await api(`state?${new URLSearchParams({ symbols: symbols.join(',') })}`);
        if (armedAccount !== next.account.id) {
          const firstAccount = !armedAccount;
          armedAccount = next.account.id;
          armed = firstAccount && sessionStorage.getItem(`mt5:one-click:${armedAccount}`) === '1';
        }
        state = next;
        connected = true;
        badge.textContent = `MT5 ${state.account.demo ? 'Demo' : 'Thật'} · ${state.account.allowed ? 'Sẵn sàng' : 'Chưa cho phép giao dịch'}`;
        publish();
      } catch (error) {
        connected = false;
        for (const adapter of adapters) adapter.emit('connectionChange', 'disconnected');
        report(error);
      }
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  async function initialize() {
    if (!key) {
      const response = await fetch('/api/trading/session');
      if (response.ok) key = (await response.json()).key;
    }
    if (key) sessionStorage.setItem('mt5:trading-key', key);
    else badge.textContent = 'MT5: cần mã kết nối từ máy chủ';
    await refresh();
    clearInterval(timer);
    timer = setInterval(refresh, 1000);
  }

  function pair() {
    const modal = dialog('Kết nối giao dịch MT5');
    modal.append(element('p', 'Mã nằm trên chart mở ở máy MT5. Chỉ chia sẻ mã với thiết bị bạn dùng để đặt lệnh.'));
    const input = element('input', null, { type: 'password', autocomplete: 'off', 'aria-label': 'Mã kết nối MT5' });
    input.value = key;
    const status = element('p', null, { role: 'status' });
    modal.append(input, button('Hiện/ẩn mã', () => { input.type = input.type === 'password' ? 'text' : 'password'; }),
      button('Kết nối', async () => {
        const old = key;
        try {
          key = input.value.trim();
          // Authenticate without changing any orders.
          const symbol = getActiveWidget()?.getSymbol();
          await api(`state?${new URLSearchParams({ symbols: symbol || '' })}`);
          sessionStorage.setItem('mt5:trading-key', key);
          message = '';
          modal.close();
          refresh();
        } catch (error) { key = old; status.textContent = error.message; }
      }), button('Đóng', () => modal.close()), status);
    modal.showModal();
  }

  function render() {
    if (!state) {
      summary.textContent = 'Chưa kết nối giao dịch MT5.';
      warning.textContent = message;
      return;
    }
    const a = state.account;
    ticket.refresh();
    summary.textContent = `${a.demo ? 'DEMO' : 'TÀI KHOẢN THẬT'} · ${a.login} · ${a.server}\nSố dư ${money(a.balance, a.currency)} · Equity ${money(a.equity, a.currency)} · Margin tự do ${money(a.marginFree, a.currency)} · Lãi/lỗ ${money(a.profit, a.currency)}`;
    warning.textContent = [a.reason, message].filter(Boolean).join('\n');
    lists.replaceChildren();
    for (const [title, rows, position] of [['Vị thế đang mở', state.positions, true], ['Lệnh chờ', state.orders, false]]) {
      lists.append(element('h3', `${title} (${rows.length})`));
      if (!rows.length) { lists.append(element('p', 'Không có lệnh.')); continue; }
      const table = element('table');
      const headings = element('tr');
      for (const name of ['Ticket / Mã', 'Loại / Lot', 'Giá vào', 'SL / TP', position ? 'Lãi/lỗ' : '', 'Thao tác']) headings.append(element('th', name));
      table.append(headings);
      for (const row of rows) {
        const tr = element('tr');
        for (const text of [`${row.id} · ${row.symbol}`, `${row.side.toUpperCase()} ${row.type || ''} · ${row.quantity} lot`,
          row.entryPrice ?? row.price, `${row.stopLoss ?? '—'} / ${row.takeProfit ?? '—'}`,
          position ? money(row.profit, a.currency) : '']) tr.append(element('td', text));
        const actions = element('td');
        actions.append(button('Thời hạn', () => editExpiry(row, position ? 'position' : 'order')));
        if (row.expiresAt) actions.append(element('small', `${timeLabel(row.expiresAt, getActiveWidget()?.getSettings().timezone)} · ${row.expiryStatus || 'active'}${row.expiryError ? ` · ${row.expiryError}` : ''}`));
        if (position) actions.append(button('Sửa SL/TP', () => editPosition(row)), button('Đóng vị thế', () => review('close', { positionId: row.id, quantity: row.quantity }, row.symbol, a.id).catch(report)));
        else actions.append(button('Sửa giá', () => editOrder(row)), button('Hủy lệnh', () => review('cancel', { orderId: row.id }, row.symbol, a.id).catch(report)));
        tr.append(actions); table.append(tr);
      }
      lists.append(table);
    }
  }

  function field(form, label, name, value, attributes = {}) {
    const wrapper = element('label', label);
    const input = element('input', null, { name, type: 'number', step: 'any', ...attributes });
    input.value = value ?? '';
    wrapper.append(input); form.append(wrapper);
    return input;
  }

  function select(form, label, name, values) {
    const wrapper = element('label', label);
    const input = element('select', null, { name });
    for (const [value, text] of values) input.append(element('option', text, { value }));
    wrapper.append(input); form.append(wrapper);
    return input;
  }

  async function openTicket(owner = getActiveWidget(), initial = {}) {
    if (!key) { pair(); return; }
    await refresh();
    const symbol = owner?.getSymbol();
    const quote = state?.quotes[symbol];
    if (!quote || !connected) { report(new Error('Chưa có dữ liệu giao dịch cho mã này.')); return; }
    if (!ticket.open(owner, { quantity: quickLots.get(symbol) || quote.min, ...initial })) return;
    projection?.destroy();
    projection = orderProjection(owner, ticket.read, (field, value) => ticket.change(field, value, 'projection'), ticket.submit, ticket.close,
      () => bracketModes.get(owner)?.active, row => ticket.update(row, 'projection'), () => {
        ticket.update({ timeInForce: 'specified', expiresAt: ticket.read().draft.expiresAt || Date.now() + 3600000 });
      });
  }

  function editExpiry(row, kind, owner = getActiveWidget()) {
    const modal = dialog(`Thời hạn #${row.id}`), accountId = state.account.id;
    const zone = () => owner?.getSettings().timezone || 'UTC'; let at = row.expiresAt || Date.now() + 3600000;
    const status = element('p', '', { role: 'status', class: 'mt5-warning' });
    const fields = expiryFields({ zone,
      clock: value => { if (value) owner?.setTradePreferences({ clock: value }); return owner?.getTradePreferences?.().clock || '24h'; },
      change(value) { at = value; } });
    fields.render(at);
    const save = value => review('setExpiry', { kind, ticket: row.id, expiresAt: value }, row.symbol, accountId)
      .then(result => { if (result) modal.close(); }).catch(error => { status.textContent = error.message; });
    modal.append(fields.root, element('p', 'Host sẽ hủy lệnh chờ hoặc đóng vị thế khi tới hạn. Host và MT5 phải chạy; nếu mất kết nối thì xử lý khi kết nối lại.'),
      button('Lưu thời hạn', () => { try { at = fields.read(); void save(at); } catch (error) { status.textContent = error.message; } }),
      button('Bỏ thời hạn', () => save(null)), button('Đóng', () => modal.close()), status);
    modal.showModal();
  }

  function editPosition(row) {
    const accountId = state.account.id;
    const modal = dialog(`SL/TP · ${row.symbol} · ${row.id}`);
    const form = element('form', null, { class: 'mt5-fields' });
    const sl = field(form, 'Stop Loss', 'stopLoss', row.stopLoss);
    const tp = field(form, 'Take Profit', 'takeProfit', row.takeProfit);
    const status = element('p', null, { role: 'status' });
    form.append(element('button', 'Kiểm tra thay đổi', { type: 'submit' }), button('Đóng', () => modal.close()));
    form.addEventListener('submit', event => {
      event.preventDefault();
      review('modifyPosition', { positionId: row.id, stopLoss: sl.value ? Number(sl.value) : null, takeProfit: tp.value ? Number(tp.value) : null }, row.symbol, accountId)
        .then(result => { if (result) modal.close(); }).catch(error => { status.textContent = error.message; });
    });
    modal.append(element('p', 'Để trống để xóa mức SL/TP tương ứng.'), form, status); modal.showModal();
  }

  function editOrder(row) {
    const accountId = state.account.id;
    const modal = dialog(`Sửa giá · ${row.symbol} · ${row.id}`);
    const form = element('form', null, { class: 'mt5-fields' });
    const price = field(form, row.type === 'stopLimit' ? 'Giá Stop mới' : 'Giá mới', 'newPrice', row.stopPrice ?? row.price, { required: '' });
    const limit = row.type === 'stopLimit' ? field(form, 'Giá Limit mới', 'limitPrice', row.price, { required: '' }) : null;
    const sl = field(form, 'Stop Loss', 'stopLoss', row.stopLoss);
    const tp = field(form, 'Take Profit', 'takeProfit', row.takeProfit);
    const status = element('p', null, { role: 'status' });
    form.append(element('button', 'Kiểm tra thay đổi', { type: 'submit' }), button('Đóng', () => modal.close()));
    form.addEventListener('submit', event => {
      event.preventDefault();
      review('modifyOrder', { orderId: row.id, newPrice: Number(price.value), previousPrice: row.stopPrice ?? row.price,
        ...(limit ? { limitPrice: Number(limit.value) } : {}), stopLoss: sl.value ? Number(sl.value) : null,
        takeProfit: tp.value ? Number(tp.value) : null }, row.symbol, accountId)
        .then(result => { if (result) modal.close(); }).catch(error => { status.textContent = error.message; });
    });
    modal.append(form, status); modal.showModal();
  }

  async function review(action, intent, symbol, accountId = state?.account.id) {
    if (busy || reviewOpen) throw new Error('Hãy hoàn tất hoặc hủy yêu cầu đang mở.');
    if (action === 'place') { const issue = tradeIssue(intent, state?.quotes[symbol]); if (issue) throw new Error(issue); }
    if (action === 'modifyPosition') {
      const row = state?.positions.find(row => row.id === intent.positionId);
      const issue = row && tradeIssue({ ...row, ...intent }, state?.quotes[symbol], 'position'); if (issue) throw new Error(issue);
    }
    if (action === 'modifyOrder') {
      const row = state?.orders.find(row => row.id === intent.orderId);
      if (row) {
        const moved = { ...row, ...intent, price: row.type === 'stopLimit' ? intent.limitPrice ?? row.price : intent.newPrice,
          ...(row.type === 'stopLimit' ? { stopPrice: intent.newPrice } : {}) };
        const issue = tradeIssue(moved, state?.quotes[symbol], 'order'); if (issue) throw new Error(issue);
      }
    }
    const command = copy({ action, intent, symbol, account: accountId, requestId: uid() });
    if (armed && armedAccount === accountId) {
      busy = true; publish();
      try {
        await api('check', command);
        const result = await api('execute', command);
        message = result.partial ? 'MT5 khớp một phần. Kiểm tra khối lượng còn lại.' : 'MT5 đã tiếp nhận thao tác.';
        await refresh(true); return result;
      } catch (error) {
        message = `${error.message} Kiểm tra Vị thế MT5 trước khi tạo yêu cầu mới.`;
        throw new Error(message);
      } finally { busy = false; publish(); }
    }
    reviewOpen = true;
    let checked;
    try { checked = await api('check', command); }
    catch (error) { reviewOpen = false; throw error; }
    const modal = dialog('Xác nhận gửi tới MT5'); modal.id = 'mt5-review';
    const a = checked.account;
    const names = { place: 'Đặt lệnh', modifyOrder: 'Sửa giá lệnh chờ', cancel: 'Hủy lệnh chờ', modifyPosition: 'Sửa SL/TP', close: 'Đóng vị thế', setExpiry: 'Hẹn đóng / hủy lệnh' };
    const description = [`${a.demo ? 'DEMO' : 'TÀI KHOẢN THẬT'} · ${a.login} · ${a.server}`, `${names[action]} · ${symbol}`];
    if (intent.side) description.push(`${intent.side.toUpperCase()} ${intent.type.toUpperCase()} · ${intent.quantity} lot`);
    if (intent.positionId || intent.orderId) description.push(`Ticket ${intent.positionId || intent.orderId}`);
    if ('expiresAt' in intent) description.push(`Thời hạn: ${timeLabel(intent.expiresAt, getActiveWidget()?.getSettings().timezone, getActiveWidget()?.getTradePreferences?.().clock)}`);
    if (action === 'close') description.push(`Đóng ${intent.quantity} lot`);
    if (intent.type && intent.type !== 'market') description.push(`Giá ${intent.price}`);
    if (intent.type === 'stopLimit') description.push(`Giá kích hoạt Stop ${intent.stopPrice} → Limit ${intent.price}`);
    if (intent.newPrice != null) description.push(`Giá ${intent.previousPrice} → ${intent.newPrice}`);
    for (const [name, label] of [['stopLoss', 'SL'], ['takeProfit', 'TP']]) if (name in intent) description.push(`${label}: ${intent[name] ?? 'Xóa'}`);
    if (intent.type === 'market') description.push('Khớp theo Bid/Ask hiện tại của MT5 khi gửi.');
    modal.append(element('p', description.join('\n')));
    const status = element('p', null, { role: 'status', class: 'mt5-warning' });
    return new Promise(resolve => {
      let result = null;
      const cancel = button('Hủy', () => modal.close());
      const send = button('Gửi tới MT5', async () => {
        busy = true; send.disabled = true; cancel.disabled = true;
        try {
          result = await api('execute', command);
          message = result.partial ? 'MT5 khớp một phần. Kiểm tra khối lượng còn lại trong Vị thế MT5.' : 'MT5 đã tiếp nhận thao tác.';
          await refresh(true);
          modal.close();
        } catch (error) {
          // Never replay an execute call automatically: the terminal may already have accepted it.
          status.textContent = `${error.message} Kiểm tra Vị thế MT5 trước khi tạo yêu cầu mới.`;
          cancel.disabled = false;
          cancel.textContent = 'Đóng';
          refresh();
        } finally { busy = false; }
      });
      modal.append(send, cancel, status);
      modal.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
      modal.addEventListener('close', () => { reviewOpen = false; resolve(result); }, { once: true });
      modal.showModal();
    });
  }

  function attach(widget, activate, slot = 0) {
    const listeners = new Map();
    let disposed = false;
    const chart = widget.getChart();
    const preferences = installTradePreferences(widget, { oneClick: () => armed, setOneClick, slot,
      quote: () => connected ? state?.quotes[widget.getSymbol()] : null, accountId: () => state?.account.id });
    const mode = { active: false, account: state?.account.id, symbol: widget.getSymbol() };
    bracketModes.set(widget, mode);
    const bar = element('div', null, { class: 'mt5-quick-trade', 'aria-label': 'Giao dịch nhanh MT5' });
    const quickSell = button('', () => quickMarket('sell'));
    const quickBuy = button('', () => quickMarket('buy'));
    quickSell.dataset.side = 'sell'; quickBuy.dataset.side = 'buy';
    quickSell.setAttribute('aria-label', 'Bán nhanh MT5'); quickBuy.setAttribute('aria-label', 'Mua nhanh MT5');
    const lots = element('input', null, { type: 'number', step: 'any', 'aria-label': 'Số lot giao dịch nhanh' });
    const bracketButton = button('SL/TP', () => setBracketMode(!mode.active));
    bracketButton.className = 'mt5-bracket-mode';
    bracketButton.setAttribute('aria-label', 'Kéo SL/TP từ Entry');
    bracketButton.title = 'Bật: kéo từ Entry để đặt/đổi SL hoặc TP. Tắt: kéo Entry dời cả bộ. Esc để tắt.';
    const toolActive = () => Boolean(chart.getDrawingTool() || chart.isEraserMode() || chart.isZoomAreaMode());
    function setBracketMode(value) { mode.active = value && !toolActive(); bracketButton.setAttribute('aria-pressed', String(mode.active)); }
    function resetBracketMode() { setBracketMode(false); bracketButton.disabled = toolActive(); }
    function escapeBracketMode(event) { if (event.key === 'Escape') resetBracketMode(); }
    chart.on('drawingToolChange', resetBracketMode); chart.on('toolModeChange', resetBracketMode);
    window.addEventListener('keydown', escapeBracketMode);
    resetBracketMode();
    bar.append(quickSell, lots, quickBuy, bracketButton);
    widget.chartContainer.append(bar);
    const pendingStops = pendingStopHandles(widget, () => ({ orders: state?.orders.filter(row => row.symbol === widget.getSymbol()) || [],
      positions: state?.positions.filter(row => row.symbol === widget.getSymbol()) || [],
      draftPrices: ticket.read().widget === widget && ticket.read().draft?.type !== 'market'
        ? ['price', 'stopPrice', 'stopLoss', 'takeProfit'].map(field => ticket.read().draft?.[field]) : [],
      quote: state?.quotes[widget.getSymbol()], accountId: state?.account.id }), (target, moved, field, accountId) => {
      const row = target.row;
      if (target.kind === 'position') return review('modifyPosition', { positionId: row.id, [field]: moved[field] }, row.symbol, accountId).catch(report);
      const intent = { orderId: row.id, newPrice: moved.stopPrice ?? moved.price, previousPrice: row.stopPrice ?? row.price };
      if (row.type === 'stopLimit') intent.limitPrice = moved.price;
      if (field === 'price') {
        if (row.stopLoss != null) intent.stopLoss = moved.stopLoss;
        if (row.takeProfit != null) intent.takeProfit = moved.takeProfit;
      } else intent[field] = moved[field];
      return review('modifyOrder', intent, row.symbol, accountId).catch(report);
    }, () => busy || reviewOpen, activate, () => mode.active, report, target => editExpiry(target.row, target.kind, widget));
    const deadlines = expiryChart(widget, () => ({ accountId: state?.account.id, rows: [
      ...[...(state?.orders || []), ...(state?.positions || [])].filter(row => row.symbol === widget.getSymbol() && row.expiresAt)
        .map(row => ({ ...row, kind: row.entryPrice != null ? 'position' : 'order' })),
      ...(ticket.read().widget === widget && ticket.read().draft?.expiresAt ? [{ ...ticket.read().draft, kind: 'draft', id: 'draft' }] : []),
    ] }), (row, at, accountId) => {
      if (row.kind === 'draft') { ticket.change('expiresAt', at); return; }
      return review('setExpiry', { kind: row.kind, ticket: row.id, expiresAt: at }, row.symbol, accountId).catch(report);
    }, () => busy || reviewOpen);
    lots.addEventListener('input', () => {
      const symbol = widget.getSymbol(); quickLots.set(symbol, Number(lots.value));
      try { sessionStorage.setItem(`mt5:quick-lots:${state?.account.id}:${symbol}`, lots.value); } catch { /* Keep the visible value. */ }
      if (ticket.read().widget === widget && ticket.read().draft) { ticket.change('quantityMode', 'lots'); ticket.change('quantity', Number(lots.value)); }
    });
    function positionBar() {
      const rect = chart.getPlotRect();
      bar.style.left = `${rect.x + 7}px`;
      bar.style.top = `${chart.getLegendBottom() + (chart.legendStack?.height || 0) + 5}px`;
    }
    async function quickMarket(side) {
      const symbol = widget.getSymbol(), q = state?.quotes[symbol];
      if (!q) { if (!key) pair(); return; }
      const quantity = Number(lots.value);
      if (!armed) { await openTicket(widget, { side, type: 'market', quantity, quantityMode: 'lots' }); return; }
      try { await review('place', { side, type: 'market', quantity, price: side === 'buy' ? q.ask : q.bid }, symbol, state.account.id); }
      catch (error) { report(error); }
    }
    const adapter = {
      name: 'MetaTrader 5', symbol: () => widget.getSymbol(),
      on(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
      off(type, fn) { listeners.get(type)?.delete(fn); },
      emit(type, data) { for (const fn of listeners.get(type) || []) fn({ type, data, timestamp: Date.now() }); },
      getConnectionState: () => connected ? 'connected' : 'disconnected',
      connect() { adapters.add(adapter); adapter.publish(); refresh(); },
      disconnect() { adapters.delete(adapter); disposed = true; listeners.clear(); },
      dispose() { adapter.disconnect(); },
      publish() {
        if (disposed) return;
        const symbol = adapter.symbol(), q = state?.quotes[symbol];
        if (mode.account !== state?.account.id || mode.symbol !== symbol) {
          mode.account = state?.account.id; mode.symbol = symbol; resetBracketMode();
        }
        if (q) {
          if (!quickLots.has(symbol)) {
            const saved = Number(sessionStorage.getItem(`mt5:quick-lots:${state.account.id}:${symbol}`));
            quickLots.set(symbol, saved >= q.min && saved <= q.max ? saved : q.min);
          }
          if (document.activeElement !== lots) lots.value = quickLots.get(symbol);
          lots.min = q.min; lots.max = q.max; lots.step = q.step;
          quickSell.replaceChildren(element('strong', Number(q.bid).toFixed(q.digits)), element('span', 'SELL'));
          quickBuy.replaceChildren(element('strong', Number(q.ask).toFixed(q.digits)), element('span', 'BUY'));
        }
        for (const control of [quickSell, quickBuy]) {
          control.disabled = busy || reviewOpen || !connected || (armed && !state?.account.allowed);
          control.title = armed ? `${state?.account.login} · Gửi lệnh Market ngay · ${quickLots.get(symbol)} lot` : 'Mở phiếu đặt lệnh';
        }
        bar.dataset.oneClick = String(armed);
        preferences.publish();
        positionBar();
        adapter.emit('orders', state?.orders.filter(row => row.symbol === adapter.symbol()) || []);
        adapter.emit('positions', state?.positions.filter(row => row.symbol === adapter.symbol()) || []);
        adapter.emit('connectionChange', adapter.getConnectionState());
      },
      async placeOrder(intent) { await review('place', intent, adapter.symbol()); return { ...intent, id: 'submitted' }; },
      async modifyOrder(intent) {
        const row = state?.orders.find(row => row.id === intent.orderId && row.symbol === adapter.symbol());
        if (!row) throw new Error('Lệnh chờ không còn tồn tại.');
        const moved = projectOrder(row, 'price', intent.newPrice, state.quotes[row.symbol], 'order');
        await review('modifyOrder', { orderId: row.id, newPrice: moved.stopPrice ?? moved.price,
          previousPrice: row.stopPrice ?? row.price, ...(row.type === 'stopLimit' ? { limitPrice: moved.price } : {}),
          ...(row.stopLoss != null ? { stopLoss: moved.stopLoss } : {}), ...(row.takeProfit != null ? { takeProfit: moved.takeProfit } : {}) }, adapter.symbol());
      },
      async cancelOrder(intent) { await review('cancel', intent, adapter.symbol()); },
      async modifyPosition(intent) {
        const row = state?.positions.find(row => row.id === intent.positionId);
        let moved = row;
        for (const field of ['stopLoss', 'takeProfit']) if (row && intent[field] != null) moved = projectOrder(moved, field, intent[field], state.quotes[row.symbol], 'position');
        const guarded = { ...intent };
        for (const field of ['stopLoss', 'takeProfit']) if (row && intent[field] != null) guarded[field] = moved[field];
        await review('modifyPosition', guarded, adapter.symbol());
      },
      async closePosition(intent) {
        const row = state?.positions.find(row => row.id === intent.positionId && row.symbol === adapter.symbol());
        await review('close', { ...intent, quantity: row?.quantity }, adapter.symbol());
      },
      async reversePosition() { throw new Error('Đóng vị thế rồi đặt lệnh ngược chiều trong bảng MT5.'); },
    };
    chart.setTradingConfig({ positionLabel: '{side} {qty} lot · {entry}', lineButtons: { reverse: false, trailStop: false } });
    chart.connectExecution(adapter);
    // The native trading handler precedes drawing placement in 2.x. Let the
    // existing tool own this press, then restore trading before the next paint.
    // Listen to mousedown too: the chart's mouse handler follows pointerdown.
    function preserveToolPress(event) {
      if (event.button != null && event.button !== 0) return;
      if (!toolActive() && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) return;
      chart.setTradingConfig({ enabled: false });
      setTimeout(() => { if (!disposed) chart.setTradingConfig({ enabled: true }); }, 0);
    }
    widget.chartContainer.addEventListener('mousedown', preserveToolPress, true);
    widget.chartContainer.addEventListener('touchstart', preserveToolPress, true);
    const onError = event => report(event.payload?.cause || event.payload?.message || 'Lỗi giao dịch MT5.');
    chart.on('executionError', onError);
    const drawingUpdate = event => {
      const current = ticket.read();
      if (syncingDrawing || current.widget !== widget || current.draft?.drawingId !== event.payload.id) return;
      try {
        const next = drawingOrder(chart, event.payload.id, current.quote);
        ticket.update({ price: next.price, stopLoss: next.stopLoss, takeProfit: next.takeProfit, side: next.side }, 'drawing');
      } catch (error) { report(error); }
    };
    const drawingRemove = event => { if (ticket.read().widget === widget && ticket.read().draft?.drawingId === event.payload.id) ticket.close(); };
    chart.on('drawingUpdate', drawingUpdate); chart.on('drawingRemove', drawingRemove); chart.on('resize', positionBar);
    return () => {
      if (ticket.read().widget === widget) ticket.close(true);
      chart.off('executionError', onError); chart.off('drawingUpdate', drawingUpdate); chart.off('drawingRemove', drawingRemove); chart.off('resize', positionBar);
      chart.off('drawingToolChange', resetBracketMode); chart.off('toolModeChange', resetBracketMode);
      window.removeEventListener('keydown', escapeBracketMode); bracketModes.delete(widget);
      widget.chartContainer.removeEventListener('mousedown', preserveToolPress, true);
      widget.chartContainer.removeEventListener('touchstart', preserveToolPress, true);
      pendingStops.destroy(); deadlines.destroy(); preferences.destroy(); bar.remove(); chart.disconnectExecution();
    };
  }

  function chartMenuItems(owner, context) {
    if (!owner || context.price == null || !['price', 'priceAxis', 'priceAxisAdd', 'plot'].includes(context.area)) return [];
    const symbol = owner.getSymbol(), q = state?.quotes[symbol];
    if (!q) return [{ label: 'Kết nối giao dịch MT5…', onSelect: pair }];
    const price = roundPrice(context.price, q), quantity = quickLots.get(symbol) || q.min;
    const entries = ['buy', 'sell'].map(side => {
      const type = side === 'buy' ? price <= q.ask ? 'limit' : 'stop' : price >= q.bid ? 'limit' : 'stop';
      const intent = { side, type, price, quantity, timeInForce: q.expirationMode == null || q.expirationMode & 1 ? 'gtc' : 'day' };
      return { label: `${side === 'buy' ? 'Mua' : 'Bán'} ${type === 'limit' ? 'Limit' : 'Stop'} ${quantity} lot tại ${price}`,
        onSelect: () => { if (armed) void review('place', intent, symbol).catch(report); else void openTicket(owner, intent); } };
    });
    entries.push({ label: `Mua Stop Limit tại ${price}…`, onSelect: () => void openTicket(owner, { side: 'buy', type: 'stopLimit', price, stopPrice: price }) },
      { label: `Bán Stop Limit tại ${price}…`, onSelect: () => void openTicket(owner, { side: 'sell', type: 'stopLimit', price, stopPrice: price }) });
    for (const order of state.orders.filter(row => row.symbol === symbol).slice(0, 6)) entries.push({
      label: `Sửa giá / SL / TP lệnh ${order.id}…`, onSelect: () => editOrder(order),
    });
    return entries;
  }

  function drawingMenuItems(owner, context) {
    if (!owner || context.type !== 'riskReward' || context.selected.length !== 1) return [];
    return [{ label: 'Tạo lệnh giới hạn MT5 từ vị thế…', icon: 'receipt', onSelect: async () => {
      try {
        if (!key) { pair(); return; }
        await refresh();
        const initial = drawingOrder(owner.getChart(), context.id, state.quotes[owner.getSymbol()]);
        await openTicket(owner, initial);
      } catch (error) { report(error); }
    } }];
  }

  initialize().catch(report);
  return { attach, chartMenuItems, drawingMenuItems, symbolChanged() { quickLots.clear(); publish(); refresh(); } };
}
