import { installQuoteLines } from './quote-lines.js';

export function installTradePreferences(widget, { oneClick, setOneClick, quote, slot = 0, accountId }) {
  const chart = widget.getChart();
  const savedKey = `mt5:chart-trade-view:${slot}`;
  let values = { ask: false, clock: '24h' }, saved;
  let modal = null, snapshot, keep = false, armedBefore, initialAccount;
  const quotes = installQuoteLines(widget, () => ({ quote: quote(), ask: values.ask }));
  const notify = () => widget.root.dispatchEvent(new Event('mt5PreferencesChange', { bubbles: true }));
  function save() { try { localStorage.setItem(savedKey, JSON.stringify(values)); } catch { /* Layout capture still retains it. */ } }
  try { saved = JSON.parse(localStorage.getItem(savedKey)); } catch { /* Defaults. */ }
  function set(patch) {
    values = { ask: typeof patch.ask === 'boolean' ? patch.ask : values.ask, clock: ['12h', '24h'].includes(patch.clock) ? patch.clock : values.clock };
    if (!modal) { save(); notify(); }
    publish();
  }
  function publish() {
    quotes.publish();
    const row = widget.portal.querySelector('.mt5-ask-setting');
    if (row) { row.hidden = !chart.getStyle().lastPrice.visible; row.querySelector('input').checked = values.ask; }
  }
  widget.getTradePreferences = () => ({ ...values }); widget.setTradePreferences = set;
  if (saved) set(saved);
  function toggle(parent, label, value, change) {
    const row = document.createElement('label'); row.className = 'tcw-settings-row'; row.textContent = label;
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = value; input.setAttribute('aria-label', label);
    input.addEventListener('change', () => change(input.checked)); row.append(input); parent.append(row);
    return row;
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
    if (!panel) return;
    if (tab === 'symbol') {
      const target = [...panel.querySelectorAll('.tcw-settings-section')].find(node => /Giá cuối|Last price/i.test(node.getAttribute('aria-label') || ''));
      if (!target) return;
      const rows = target.querySelectorAll(':scope > .tcw-settings-row');
      for (const [index, name] of [[1, 'Màu Bid'], [2, 'Màu Ask']]) {
        const label = rows[index]?.querySelector('.tcw-settings-label'), input = rows[index]?.querySelector('input[type=color]');
        if (label && label.textContent !== name) label.textContent = name;
        if (input?.getAttribute('aria-label') !== name) input?.setAttribute('aria-label', name);
      }
      if (!target.querySelector('.mt5-ask-setting')) {
        const row = toggle(target, 'Đường giá Ask', values.ask, ask => set({ ask })); row.classList.add('mt5-ask-setting', 'mt5-view-settings');
      }
      const askRow = target.querySelector('.mt5-ask-setting');
      askRow.hidden = !chart.getStyle().lastPrice.visible;
      askRow.querySelector('input').checked = values.ask;
    } else if (tab === 'trading') {
      if (panel.querySelector('.mt5-view-settings')) return;
      const section = document.createElement('div'); section.className = 'tcw-settings-section mt5-view-settings';
      toggle(section, 'One-click trading', oneClick(), setOneClick);
      const text = document.createElement('small'); text.textContent = 'Bật: gửi ngay khi bấm hoặc thả đường lệnh. Tắt: xem và xác nhận trước khi gửi.';
      section.append(text); panel.prepend(section);
    } else return;
  }
  const observer = new MutationObserver(observe); observer.observe(widget.portal, { childList: true, subtree: true });
  function lookChanged() { publish(); observe(); }
  chart.on('styleChange', lookChanged); chart.on('themeChange', lookChanged);
  return { publish, destroy() {
    observer.disconnect(); chart.off('styleChange', lookChanged); chart.off('themeChange', lookChanged); quotes.destroy();
    delete widget.getTradePreferences; delete widget.setTradePreferences;
  } };
}
