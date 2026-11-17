export function installTradePreferences(widget, { oneClick, setOneClick, quote, slot = 0, accountId }) {
  const chart = widget.getChart();
  const savedKey = `mt5:chart-trade-view:${slot}`;
  let values = { bid: false, ask: false, clock: '24h' }, saved;
  let modal = null, snapshot, keep = false, armedBefore, initialAccount;
  const notify = () => widget.root.dispatchEvent(new Event('mt5PreferencesChange', { bubbles: true }));
  function save() { try { localStorage.setItem(savedKey, JSON.stringify(values)); } catch { /* Layout capture still retains it. */ } }
  try { saved = JSON.parse(localStorage.getItem(savedKey)); } catch { /* Defaults. */ }
  function set(patch) {
    values = { bid: typeof patch.bid === 'boolean' ? patch.bid : values.bid,
      ask: typeof patch.ask === 'boolean' ? patch.ask : values.ask, clock: ['12h', '24h'].includes(patch.clock) ? patch.clock : values.clock };
    if (!modal) { save(); notify(); }
    publish();
  }
  function publish() {
    const q = quote(); chart.setBidAsk(q ? { ...(values.bid ? { bid: q.bid } : {}), ...(values.ask ? { ask: q.ask } : {}) } : null);
  }
  widget.getTradePreferences = () => ({ ...values }); widget.setTradePreferences = set;
  if (saved) set(saved);
  function toggle(parent, label, value, change) {
    const row = document.createElement('label'); row.className = 'tcw-settings-row'; row.textContent = label;
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = value; input.setAttribute('aria-label', label);
    input.addEventListener('change', () => change(input.checked)); row.append(input); parent.append(row);
  }
  function observe() {
    const next = widget.portal.querySelector('.tcw-set');
    if (!next && modal) {
      if (!keep) { set(snapshot); if (initialAccount === accountId()) setOneClick(armedBefore); }
      else { save(); notify(); }
      modal = null; return;
    }
    if (!next) return;
    if (modal !== next) {
      modal = next; snapshot = { ...values }; armedBefore = oneClick(); initialAccount = accountId(); keep = false;
      next.addEventListener('click', event => { if (event.target.closest('[data-act="ok"]')) keep = true; }, true);
    }
    const panel = next.querySelector('.tcw-set-panel'), tab = next.querySelector('[role=tab][aria-selected=true]')?.dataset.tab;
    if (!panel || panel.querySelector('.mt5-view-settings')) return;
    const section = document.createElement('div'); section.className = 'tcw-settings-section mt5-view-settings';
    if (tab === 'symbol') {
      const target = [...panel.querySelectorAll('.tcw-settings-section')].find(node => /Giá cuối|Last price/i.test(node.getAttribute('aria-label') || '')) || panel;
      toggle(section, 'Đường giá Bid', values.bid, bid => set({ bid }));
      toggle(section, 'Đường giá Ask', values.ask, ask => set({ ask }));
      target.append(section);
    } else if (tab === 'trading') {
      toggle(section, 'One-click trading', oneClick(), setOneClick);
      const text = document.createElement('small'); text.textContent = 'Bật: gửi ngay khi bấm hoặc thả đường lệnh. Tắt: xem và xác nhận trước khi gửi.';
      section.append(text); panel.prepend(section);
    } else return;
  }
  const observer = new MutationObserver(observe); observer.observe(widget.portal, { childList: true, subtree: true });
  return { publish, destroy() { observer.disconnect(); delete widget.getTradePreferences; delete widget.setTradePreferences; } };
}
