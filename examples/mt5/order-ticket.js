import { ORDER_TYPES, orderIntent, priceFromUnit, roundPrice, translatedOrder, valueInUnit } from './order-model.js';
import { tradeIssue } from './order-rules.js';
import { expiryFields, wallTime, parseWallTime } from './order-time.js';

const format = (value, digits = 2) => value == null ? '—' : Number(value).toLocaleString('vi-VN', { maximumFractionDigits: digits });
function node(tag, text, attributes = {}) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}
function button(text, click, attributes = {}) {
  const element = node('button', text, { type: 'button', ...attributes });
  element.addEventListener('click', click); return element;
}
function select(label, name, options) {
  const element = node('select', null, { name, 'aria-label': label });
  for (const [value, text] of options) element.append(node('option', text, { value }));
  return element;
}

export function createOrderTicket({ account, quoteFor, estimate: calculate, send, onChange, onClose, oneClick, setOneClick }) {
  const root = node('aside', null, { id: 'mt5-ticket', 'aria-label': 'Phiếu đặt lệnh MT5', hidden: '' });
  document.getElementById('workspace').append(root);
  const title = node('strong');
  const header = node('div', null, { class: 'order-ticket-header' });
  const settings = node('details', null, { class: 'order-ticket-settings' });
  settings.append(node('summary', 'Cài đặt'));
  const clickLabel = node('label', 'One-click trading');
  const clickInput = node('input', null, { type: 'checkbox', 'aria-label': 'One-click trading' });
  clickInput.addEventListener('change', () => { setOneClick(clickInput.checked); render(); });
  clickLabel.prepend(clickInput);
  settings.append(clickLabel, node('p', 'Khi bật: bấm giao dịch, sửa, hủy hoặc đóng lệnh sẽ gửi trực tiếp tới MT5.'));
  header.append(title, settings, button('×', close, { class: 'order-ticket-close', 'aria-label': 'Đóng phiếu đặt lệnh' }));
  const accountLine = node('div', null, { class: 'order-ticket-account' });
  const form = node('form', null, { class: 'order-ticket-form' });
  const sides = node('div', null, { class: 'order-ticket-sides' });
  const sell = button('', () => setSide('sell'), { 'aria-label': 'Chọn Bán', 'data-side': 'sell' });
  const buy = button('', () => setSide('buy'), { 'aria-label': 'Chọn Mua', 'data-side': 'buy' });
  const spread = node('span', null, { class: 'order-ticket-spread' });
  sides.append(sell, spread, buy);
  const tabs = node('div', null, { class: 'order-ticket-tabs', role: 'tablist', 'aria-label': 'Loại lệnh' });
  const types = new Map();
  for (const [value, text] of ORDER_TYPES) {
    const tab = button(text, () => change('type', value), { role: 'tab', 'data-order-type': value });
    types.set(value, tab); tabs.append(tab);
  }
  // Keep the familiar names on controls for accessible labels and API-neutral tests.
  const qtyMode = select('Đơn vị khối lượng', 'quantityMode', [['lots', 'Lot'], ['notional', 'Giá trị quy đổi'],
    ['balancePercent', '% số dư (giá trị)'], ['riskAmount', 'Rủi ro (tiền)'], ['riskPercent', 'Rủi ro (% số dư)']]);
  const quantity = node('input', null, { name: 'quantity', type: 'number', min: '0', step: 'any', required: '', 'aria-label': 'Khối lượng' });
  const qtyResult = node('span', null, { class: 'order-ticket-muted' });
  const qtyRow = node('div', null, { class: 'order-ticket-number' }); qtyRow.append(quantity, qtyResult);
  qtyMode.addEventListener('change', () => change('quantityMode', qtyMode.value));
  quantity.addEventListener('input', () => change('quantity', Number(quantity.value)));
  const priceControls = new Map();
  function priceControl(name, label, exit = false) {
    const group = node('div', null, { class: 'order-ticket-price-group' });
    const head = node('div', null, { class: 'order-ticket-field-head' });
    const caption = node('span', label);
    const units = select(`${label}: đơn vị`, `${name}Unit`, [['price', 'Giá'], ['ticks', 'Ticks'], ['percent', '% giá']]);
    if (!exit) units.lastChild.remove();
    const input = node('input', null, { type: 'number', step: 'any', name, 'aria-label': label });
    const toggle = exit ? node('input', null, { type: 'checkbox', role: 'switch', 'aria-label': `Bật ${label}` }) : null;
    head.append(caption, units); if (toggle) head.append(toggle);
    const row = node('div', null, { class: 'order-ticket-number' });
    const converted = node('span', null, { class: 'order-ticket-muted' }); row.append(input, converted);
    group.append(head, row);
    const control = { group, caption, input, units, toggle, converted };
    priceControls.set(name, control);
    input.addEventListener('input', () => {
      const current = currentQuote(), entry = entryPrice();
      if (!input.value) { if (exit) change(name, null); return; }
      const value = Number(input.value);
      const price = exit ? priceFromUnit(value, units.value, entry, draft.side, name, current)
        : units.value === 'ticks' ? roundPrice(marketPrice() + value * current.tickSize, current) : roundPrice(value, current);
      change(name, price);
    });
    units.addEventListener('change', () => render());
    toggle?.addEventListener('change', () => {
      const q = currentQuote();
      const distance = Math.max(q.stops || 0, Math.abs(q.ask - q.bid) * 3, entryPrice() * .001);
      const sign = (draft.side === 'buy' ? 1 : -1) * (name === 'stopLoss' ? -1 : 1);
      change(name, toggle.checked ? roundPrice(entryPrice() + sign * distance, q) : null);
    });
    return group;
  }
  const triggerGroup = priceControl('stopPrice', 'Giá Stop (kích hoạt)');
  const entryGroup = priceControl('price', 'Giá Limit');
  const exits = node('section', null, { class: 'order-ticket-exits' });
  exits.append(node('h3', 'Thoát lệnh'), priceControl('takeProfit', 'Take Profit', true), priceControl('stopLoss', 'Stop Loss', true));
  const tif = select('Thời hạn lệnh', 'timeInForce', [['gtc', 'Không thời hạn · GTC'], ['day', 'Cuối ngày (múi giờ chart)'], ['specified', 'Chọn ngày giờ']]);
  const expiry = expiryFields({ zone: () => widget?.getSettings().timezone || 'UTC',
    clock: value => { if (value) widget?.setTradePreferences({ clock: value }); return widget?.getTradePreferences?.().clock || '24h'; },
    change: value => change('expiresAt', value) });
  tif.addEventListener('change', () => {
    change('timeInForce', tif.value);
    const zone = widget.getSettings().timezone;
    const day = wallTime(Date.now() + 86400000, zone).date;
    change('expiresAt', tif.value === 'gtc' ? null : tif.value === 'day' ? parseWallTime(day, '00:00', 'AM', zone) : Date.now() + 3600000);
  });
  const tifGroup = node('label', 'Thời hạn lệnh', { class: 'order-ticket-tif' }); tifGroup.append(tif);
  const expiryNote = node('small', 'Đóng vị thế / hủy lệnh khi tới hạn. Máy host và MT5 phải đang chạy; kết quả khớp theo giá broker tại thời điểm gửi.');
  tifGroup.append(expiry.root, expiryNote);
  const receipt = node('section', null, { class: 'order-ticket-receipt' });
  receipt.append(node('h3', 'Thông tin lệnh'));
  const amounts = new Map();
  for (const [id, label] of [['margin', 'Ký quỹ ước tính'], ['risk', 'Rủi ro tại SL'], ['reward', 'Lợi nhuận tại TP'],
    ['ratio', 'Tỷ lệ lời / lỗ'], ['tickValue', 'Giá trị tick'], ['notional', 'Giá trị quy đổi'], ['leverage', 'Đòn bẩy tài khoản']]) {
    const row = node('div'); const value = node('strong'); row.append(node('span', label), value); receipt.append(row); amounts.set(id, value);
  }
  const hint = node('p', null, { class: 'order-ticket-muted' });
  hint.textContent = 'Bật SL/TP trên chart rồi kéo từ Entry để đặt/đổi mức. Tắt nút để kéo Entry dời cả bộ và giữ R:R. Kéo trực tiếp SL/TP để đổi riêng mức đó. Ước tính chưa gồm phí, swap và trượt giá.';
  const issue = node('p', null, { class: 'order-ticket-error', role: 'status' });
  const permission = node('p', null, { class: 'order-ticket-warning' });
  const submitButton = node('button', null, { type: 'submit', class: 'order-ticket-submit' });
  const presets = node('details', null, { class: 'order-ticket-presets' }); presets.append(node('summary', 'Mẫu lệnh'));
  const presetList = select('Mẫu lệnh đã lưu', 'preset', [['', 'Chọn mẫu lệnh']]);
  const presetName = node('input', null, { type: 'text', maxlength: '60', placeholder: 'Tên mẫu', 'aria-label': 'Tên mẫu lệnh' });
  presets.append(presetList, presetName, button('Lưu mẫu', savePreset), button('Xóa mẫu', removePreset));
  presetList.addEventListener('change', () => loadPreset(presetList.value));
  const content = node('div', null, { class: 'order-ticket-content' });
  content.append(sides, tabs, qtyMode, qtyRow, triggerGroup, entryGroup, exits, tifGroup, presets, receipt, hint, permission, issue);
  form.append(content, submitButton);
  root.append(header, accountLine, form);
  const mount = () => {
    const workspace = document.getElementById('workspace'), fullscreen = document.fullscreenElement;
    const target = fullscreen && !fullscreen.contains(workspace) ? fullscreen : workspace;
    if (root.parentElement !== target) target.append(root);
    root.dataset.floating = String(target !== workspace);
  };
  document.addEventListener('fullscreenchange', mount);
  let draft = null, widget = null, estimate = null, estimateTimer, sequence = 0, sending = false, lastQuote = '';
  let problem = '', initialAccount = '', calculating = false, themeObserver;
  function currentQuote() { return quoteFor(draft?.symbol); }
  function marketPrice() { const q = currentQuote(); return draft?.side === 'sell' ? q?.bid : q?.ask; }
  function entryPrice() { return draft?.type === 'market' ? marketPrice() : draft?.price; }
  function change(field, value, source = 'form') {
    if (!draft || sending) return;
    if (field === 'quantityMode') {
      const lots = estimate?.quantity || currentQuote().min;
      draft.quantity = value === 'lots' ? lots : value === 'riskPercent' ? 1 : value === 'riskAmount' ? 10 : value === 'balancePercent' ? 1 : estimate?.notional || 100;
    }
    if (field === 'price' && source === 'projection') Object.assign(draft, translatedOrder(draft, value, currentQuote()));
    draft[field] = value;
    if (field === 'type' && value === 'stopLimit' && !(draft.stopPrice > 0)) draft.stopPrice = draft.price;
    if (field === 'type' && draft.type !== 'market' && !Number.isFinite(draft.price)) draft.price = marketPrice();
    onChange(draft, source); schedule(); render();
  }
  function setSide(value) {
    if (!draft || sending || draft.side === value) return;
    const entry = entryPrice();
    for (const field of ['stopLoss', 'takeProfit']) if (draft[field] != null) draft[field] = roundPrice(2 * entry - draft[field], currentQuote());
    change('side', value);
  }
  function validate() {
    if (!(draft.quantity > 0)) throw new Error('Nhập khối lượng hoặc mức rủi ro lớn hơn 0.');
    if (draft.timeInForce !== 'gtc' && !draft.expiresAt) throw new Error('Chọn ngày giờ hết hạn.');
    draft.nativeTimeInForce = draft.expiresAt ? (currentQuote().expirationMode & 4 ? 'specified' : 'gtc') : draft.timeInForce;
    const issue = tradeIssue(draft, currentQuote()); if (issue) throw new Error(issue);
  }
  function schedule(keepEstimate = false) {
    clearTimeout(estimateTimer); const version = ++sequence;
    if (!keepEstimate) estimate = null;
    problem = '';
    try { validate(); } catch (error) { problem = error.message; render(); return; }
    const snapshot = { ...draft };
    estimateTimer = setTimeout(async () => {
      calculating = true;
      try {
        const result = await calculate({ account: initialAccount, symbol: snapshot.symbol, intent: snapshot });
        if (version !== sequence || !draft) return;
        estimate = result; problem = '';
      } catch (error) { if (version !== sequence || !draft) return; estimate = null; problem = error.message; }
      finally { calculating = false; }
      render();
    }, 140);
  }
  function render() {
    if (!draft) return;
    const a = account(), q = currentQuote();
    if (!q || !a) return;
    root.dataset.theme = widget?.root?.dataset.tcwTheme || 'dark';
    title.textContent = draft.symbol;
    accountLine.textContent = `${a.demo ? 'DEMO' : 'THẬT'} · ${a.login} · ${a.server}`;
    sell.replaceChildren(node('strong', format(q.bid, q.digits)), node('span', 'Bán / Sell'));
    buy.replaceChildren(node('strong', format(q.ask, q.digits)), node('span', 'Mua / Buy'));
    sell.setAttribute('aria-pressed', String(draft.side === 'sell')); buy.setAttribute('aria-pressed', String(draft.side === 'buy'));
    spread.textContent = `${format((q.ask - q.bid) / q.tickSize, 1)} ticks`;
    for (const [id, tab] of types) {
      tab.setAttribute('aria-selected', String(draft.type === id));
      tab.disabled = sending || (q.orderMode != null && !(q.orderMode & { market: 1, limit: 2, stop: 4, stopLimit: 8 }[id]));
      tab.title = tab.disabled && !sending ? 'Broker không hỗ trợ loại lệnh này cho mã đang chọn.' : '';
    }
    qtyMode.value = draft.quantityMode;
    if (document.activeElement !== quantity) quantity.value = draft.quantity;
    quantity.step = draft.quantityMode === 'lots' ? q.step : 'any';
    quantity.min = draft.quantityMode === 'lots' ? q.min : 0;
    quantity.max = draft.quantityMode === 'lots' ? q.max : '';
    qtyResult.textContent = estimate ? `${format(estimate.quantity, 8)} lot` : 'Đang tính…';
    for (const [field, control] of priceControls) {
      const exit = Boolean(control.toggle);
      control.group.hidden = field === 'price' ? draft.type === 'market' : field === 'stopPrice' ? draft.type !== 'stopLimit' : false;
      if (field === 'price') control.caption.textContent = draft.type === 'stop' ? 'Giá Stop' : 'Giá Limit';
      if (exit) control.toggle.checked = draft[field] != null;
      control.input.disabled = sending || (exit && draft[field] == null);
      const entry = exit ? entryPrice() : marketPrice();
      const value = exit ? valueInUnit(draft[field], control.units.value, entry, q)
        : control.units.value === 'ticks' ? Number(((draft[field] - entry) / q.tickSize).toFixed(3)) : draft[field];
      if (document.activeElement !== control.input) control.input.value = value ?? '';
      control.input.step = control.units.value === 'price' ? q.tickSize : 'any';
      control.converted.textContent = draft[field] == null ? 'Chưa đặt' : control.units.value === 'price'
        ? `${format(Math.abs(draft[field] - entry) / q.tickSize, 1)} ticks` : format(draft[field], q.digits);
    }
    tifGroup.hidden = false; tif.value = draft.timeInForce;
    expiry.root.hidden = draft.timeInForce === 'gtc'; expiryNote.hidden = draft.timeInForce === 'gtc';
    if (draft.expiresAt) expiry.render(draft.expiresAt);
    for (const [id, value] of amounts) value.textContent = id === 'ratio' ? estimate?.ratio == null ? '—' : `${format(estimate.ratio)} : 1`
      : id === 'leverage' ? `1:${format(a.leverage, 0)}` : estimate?.[id] == null ? '—' : `${format(estimate[id], id === 'tickValue' ? 6 : 2)} ${a.currency}`;
    clickInput.checked = oneClick();
    permission.textContent = initialAccount !== a.id ? 'Tài khoản đã thay đổi. Mở lại phiếu đặt lệnh.' : a.reason || '';
    issue.textContent = problem;
    submitButton.dataset.side = draft.side;
    submitButton.disabled = sending || !estimate || Boolean(problem) || initialAccount !== a.id;
    submitButton.replaceChildren(node('strong', sending ? 'Đang gửi…' : `${draft.side === 'buy' ? 'Mua / Buy' : 'Bán / Sell'}${oneClick() ? ' · 1 nhấp' : ''}`),
      node('span', `${estimate ? format(estimate.quantity, 8) : '…'} lot ${draft.symbol} · ${ORDER_TYPES.find(([id]) => id === draft.type)?.[1]}`));
  }
  async function submit() {
    if (!draft || sending || !estimate || problem) return;
    try { validate(); } catch (error) { problem = error.message; render(); return; }
    const intent = orderIntent(draft, estimate);
    sending = true; render();
    try {
      const result = await send(intent, draft.symbol, initialAccount);
      if (result) { sending = false; close(); }
    } catch (error) { problem = error.message; }
    finally { sending = false; render(); }
  }
  form.addEventListener('submit', event => { event.preventDefault(); void submit(); });
  function close(force = false) {
    if (sending && force !== true) return;
    sequence++; clearTimeout(estimateTimer); draft = null; estimate = null; root.hidden = true;
    themeObserver?.disconnect();
    document.getElementById('workspace').classList.remove('has-order-ticket'); onClose();
  }
  function presetKey() { return `mt5:order-presets:v1:${initialAccount}:${draft.symbol}`; }
  function readPresets() { try { const value = JSON.parse(localStorage.getItem(presetKey()) || '[]'); return Array.isArray(value) ? value : []; } catch { return []; } }
  function listPresets() { presetList.replaceChildren(node('option', 'Chọn mẫu lệnh', { value: '' }), ...readPresets().map(item => node('option', item.name, { value: item.name }))); }
  function savePreset() {
    const name = presetName.value.trim(); if (!name || !draft) return;
    const q = currentQuote(), entry = entryPrice();
    const value = { name, side: draft.side, type: draft.type, quantityMode: draft.quantityMode, quantity: draft.quantity, timeInForce: draft.timeInForce,
      priceOffset: (draft.price - marketPrice()) / q.tickSize,
      triggerOffset: ((draft.stopPrice || draft.price) - marketPrice()) / q.tickSize,
      slTicks: draft.stopLoss == null ? null : Math.abs(draft.stopLoss - entry) / q.tickSize,
      tpTicks: draft.takeProfit == null ? null : Math.abs(draft.takeProfit - entry) / q.tickSize };
    try { localStorage.setItem(presetKey(), JSON.stringify([...readPresets().filter(item => item.name !== name), value].slice(-12))); listPresets(); presetList.value = name; }
    catch { problem = 'Trình duyệt chưa lưu được mẫu lệnh.'; render(); }
  }
  function removePreset() { if (!presetList.value) return; try { localStorage.setItem(presetKey(), JSON.stringify(readPresets().filter(item => item.name !== presetList.value))); listPresets(); } catch { /* Current draft remains intact. */ } }
  function loadPreset(name) {
    const preset = readPresets().find(item => item.name === name); if (!preset || !draft) return;
    const q = currentQuote();
    Object.assign(draft, { side: preset.side, type: preset.type, quantityMode: preset.quantityMode, quantity: preset.quantity, timeInForce: preset.timeInForce });
    draft.price = roundPrice(marketPrice() + preset.priceOffset * q.tickSize, q);
    draft.stopPrice = roundPrice(marketPrice() + preset.triggerOffset * q.tickSize, q);
    const sign = draft.side === 'buy' ? 1 : -1;
    draft.stopLoss = preset.slTicks == null ? null : roundPrice(entryPrice() - sign * preset.slTicks * q.tickSize, q);
    draft.takeProfit = preset.tpTicks == null ? null : roundPrice(entryPrice() + sign * preset.tpTicks * q.tickSize, q);
    presetName.value = name; onChange(draft, 'form'); schedule(); render();
  }
  return {
    open(owner, initial) {
      if (sending) return false;
      widget = owner; initialAccount = account().id;
      mount();
      themeObserver?.disconnect(); themeObserver = new MutationObserver(render);
      themeObserver.observe(owner.root, { attributes: true, attributeFilter: ['data-tcw-theme', 'data-tcw-ui'] });
      const q = quoteFor(owner.getSymbol());
      draft = { symbol: owner.getSymbol(), side: 'buy', type: 'market', price: q.ask, quantityMode: 'lots', quantity: q.min,
        stopLoss: null, takeProfit: null, timeInForce: (q.expirationMode == null || q.expirationMode & 1) ? 'gtc' : 'day', ...initial };
      root.hidden = false; document.getElementById('workspace').classList.add('has-order-ticket');
      for (const control of priceControls.values()) control.units.value = 'price';
      lastQuote = ''; listPresets(); schedule(); render(); return true;
    },
    change, close, submit,
    update(patch, source = 'form') { if (!draft || sending) return; Object.assign(draft, patch); onChange(draft, source); schedule(); render(); },
    read: () => ({ draft, widget, quote: currentQuote(), estimate, sending, accountId: account()?.id }),
    refresh() {
      if (!draft) return;
      const q = currentQuote();
      const signature = JSON.stringify([q?.bid, q?.ask, account()?.balance, account()?.id]);
      if (signature !== lastQuote && !sending && !calculating) { lastQuote = signature; schedule(true); }
      render();
    },
  };
}
