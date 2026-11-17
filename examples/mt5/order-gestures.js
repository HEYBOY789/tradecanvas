import { priceToY, yToPrice } from '@tradecanvas/core';
import { bracketSide, roundPrice } from './order-model.js';
import { projectOrder, tradeIssue } from './order-rules.js';

// One pointer owner handles entry, bracket and individual-stop drags. Drafts
// edit only their model; a live trade changes only after the drop is submitted.
export function tradeGestures(widget, options) {
  const chart = widget.getChart(), host = widget.chartContainer;
  const layer = document.createElement('div'); layer.className = options.draft ? 'mt5-projection' : 'mt5-projection mt5-live-stops'; host.append(layer);
  const controls = new Map();
  let frame, timer, stopped = false, drag = null, inset = 0, middleClick = false;
  const names = { price: 'Entry', stopPrice: 'Stop', stopLoss: 'SL', takeProfit: 'TP' };
  const toolActive = () => Boolean(chart.getDrawingTool() || chart.isEraserMode() || chart.isZoomAreaMode());
  const reserved = event => event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || toolActive();
  function geometry(event, quote) {
    const bounds = host.getBoundingClientRect(), viewport = chart.viewport.getState(), rect = viewport.chartRect;
    const x = event.clientX - bounds.left, y = event.clientY - bounds.top;
    return { x, y, rect, viewport, inside: x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height,
      price: roundPrice(yToPrice(Math.max(rect.y, Math.min(rect.y + rect.height, y)), viewport), quote) };
  }
  function begin(event, target, field) {
    if ((event.button !== 0 && !(event.button === 1 && field === 'price')) || reserved(event)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (options.disabled?.() || drag) return;
    middleClick = event.button === 1;
    options.activate?.();
    // Preventing the native pan also prevents its default focus change. The
    // form must stop treating an old input as actively typed while dragging.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const current = options.read();
    drag = { target: { ...target, row: { ...target.row } }, field,
      bracket: field === 'price' && (event.button === 1 || options.bracketMode?.()), pointer: event.pointerId,
      account: current.accountId, quote: current.quote, entry: target.row.price ?? target.row.entryPrice,
      price: target.row[field] ?? target.row.entryPrice, startY: event.clientY, moved: false, finished: false };
    host.setPointerCapture(event.pointerId);
  }
  function entryLabel(point, targets) {
    const manager = chart.tradingManager;
    const contains = rect => point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
    const handle = manager.tagBoxes?.find(contains);
    if (handle) return handle.grab.kind === 'order'
      ? targets.find(target => target.kind === 'order' && target.row.id === handle.grab.orderId) : null;
    const rect = manager.tagRects().find(contains);
    if (!rect) return null;
    // Filled Entry labels have no native drag handle. Their close/reverse
    // button identifies the position even when several entries share a price.
    const button = manager.buttons?.find(button => ['closePosition', 'reversePosition'].includes(button.action.type) &&
      button.x >= rect.x && button.x + button.size <= rect.x + rect.width && button.y >= rect.y && button.y + button.size <= rect.y + rect.height);
    return button && targets.find(target => target.kind === 'position' && target.row.id === button.action.positionId);
  }
  function down(event) {
    if (event.button === 1) middleClick = false;
    if ((event.button !== 0 && event.button !== 1) || reserved(event) || !host.contains(event.target)) return;
    const owned = [...controls.values()].find(value => value.tag === event.target || value.tag.contains(event.target));
    const current = options.read(); if (!current.quote) return;
    const point = geometry(event, current.quote);
    if (!options.draft && chart.tradingManager.isOverButton({ x: point.x, y: point.y })) return;
    if (owned) { begin(event, owned.target, owned.field); return; }
    if (event.target.closest('button,input,select,textarea')) return;
    if (!point.inside) return;
    if (!options.draft && current.blockedPrices?.some(price => price > 0 && Math.abs(priceToY(price, point.viewport) - point.y) <= 7)) return;
    if (event.button === 1 && !options.draft) {
      const target = entryLabel(point, current.targets);
      if (target) { begin(event, target, 'price'); return; }
    }
    const hit = current.targets.flatMap(target => {
      const fields = [...(target.canMoveEntry || event.button === 1 || options.bracketMode?.() ? ['price'] : []),
        ...(target.row.type === 'stopLimit' ? ['stopPrice'] : []), 'stopLoss', 'takeProfit'];
      return fields.flatMap(field => {
        const price = field === 'price' ? target.row.price ?? target.row.entryPrice : target.row[field];
        return price > 0 ? [{ target, field, distance: Math.abs(priceToY(price, point.viewport) - point.y) }] : [];
      });
    }).filter(item => item.distance <= 7).sort((a, b) => a.distance - b.distance)[0];
    if (hit) begin(event, hit.target, hit.field);
  }
  function middleDefault(event) {
    if (event.button !== 1 || !middleClick) return;
    // Stop browser autoscroll/auxiliary clicks only for an owned order drag.
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.type === 'auxclick') middleClick = false;
  }
  function move(event) {
    if (!drag || drag.finished || drag.pointer !== event.pointerId) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const point = geometry(event, drag.quote);
    if (!(point.price > 0)) return;
    drag.moved ||= Math.abs(event.clientY - drag.startY) >= 2;
    drag.price = point.price;
    if (drag.target.kind === 'draft' && drag.moved) {
      const field = drag.bracket ? bracketSide(drag.target.row.side, drag.entry, drag.price) : drag.field;
      const proposed = projectOrder(drag.target.row, field, drag.price, drag.quote, 'draft');
      if (options.update) options.update(proposed); else options.change(field, drag.price);
    }
  }
  function preview() {
    if (!drag || !drag.moved) return null;
    const field = drag.bracket ? bracketSide(drag.target.row.side, drag.entry, drag.price) : drag.field;
    const row = projectOrder(drag.target.row, field, drag.price, drag.quote, drag.target.kind);
    return { field, row };
  }
  async function up(event) {
    if (!drag || drag.finished || drag.pointer !== event.pointerId) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
    const dropped = drag, proposed = preview();
    if (!proposed) { drag = null; return; }
    if (dropped.target.kind === 'draft') { drag = null; return; }
    const issue = tradeIssue(proposed.row, options.read().quote, dropped.target.kind);
    if (issue) { drag = null; options.error?.(new Error(issue)); options.restore?.(); return; }
    dropped.finished = true;
    try {
      if (options.read().accountId === dropped.account) await options.complete(dropped.target, proposed.row, proposed.field, dropped.account);
    } finally { if (drag === dropped) drag = null; options.restore?.(); }
  }
  function cancel(event) {
    if (!drag || drag.finished || (event?.pointerId != null && event.pointerId !== drag.pointer)) return;
    const current = drag; drag = null;
    if (host.hasPointerCapture(current.pointer)) host.releasePointerCapture(current.pointer);
    options.restore?.();
  }
  function keyboard(event) {
    if (event.key === 'Escape' && drag && !drag.finished) { event.preventDefault(); cancel(); return; }
    if (!options.draft || event.repeat || event.target.closest('input,select,textarea,button,[contenteditable="true"]')) return;
    if (event.key === 'Escape') options.cancel?.();
    if (event.key === 'Enter' && host.contains(event.target)) { event.preventDefault(); options.submit?.(); }
  }
  function control(target, field) {
    const key = `${target.key}:${field}`;
    if (controls.has(key)) return controls.get(key);
    const line = document.createElement('div'); line.className = `mt5-projection-line mt5-projection-${field}`;
    const tag = document.createElement('button'); tag.type = 'button'; tag.className = 'mt5-projection-tag';
    tag.setAttribute('aria-label', target.kind === 'draft' ? `Kéo ${names[field]} lệnh nháp` : `Kéo ${names[field]} lệnh ${target.row.id}`);
    if (field === 'price') tag.title = 'Giữ nút giữa chuột rồi kéo để đặt/đổi SL hoặc TP. Chuột trái kéo dời giá khi tắt chế độ SL/TP.';
    const value = { line, tag, target, field };
    tag.addEventListener('pointerdown', event => begin(event, value.target, field)); line.append(tag);
    if (target.kind === 'draft' && field === 'price') {
      const send = document.createElement('button'); send.type = 'button'; send.className = 'mt5-projection-send'; send.setAttribute('aria-label', 'Gửi lệnh nháp từ chart');
      send.addEventListener('click', () => options.submit());
      const close = document.createElement('button'); close.type = 'button'; close.className = 'mt5-projection-cancel'; close.textContent = '×'; close.setAttribute('aria-label', 'Hủy lệnh nháp'); close.addEventListener('click', () => options.cancel());
      line.append(send, close);
    }
    layer.append(line); controls.set(key, value); return value;
  }
  function render() {
    if (stopped) return;
    const current = options.read();
    if (drag && (current.accountId !== drag.account || !current.targets.some(target => target.key === drag.target.key))) {
      drag = null; options.restore?.();
    }
    if (!current.targets.length && !controls.size && !options.draft) { layer.hidden = true; timer = setTimeout(render, 100); return; }
    const viewport = chart.viewport.getState(), rect = viewport.chartRect;
    Object.assign(layer.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    layer.hidden = !current.quote || toolActive();
    const proposed = preview(), keys = new Set();
    const livePrices = options.draft ? [...chart.getOrders(), ...chart.getPositions()].flatMap(row =>
      [row.price ?? row.entryPrice, row.stopPrice, row.stopLoss, row.takeProfit]).filter(price => price > 0) : [];
    if (proposed && drag.target.kind !== 'draft') options.preview?.(drag.target, proposed.row);
    if (current.quote) for (const target of current.targets) {
      const active = drag?.target.key === target.key;
      const row = active && proposed ? proposed.row : target.row;
      const fields = ['price', ...(row.type === 'stopLimit' ? ['stopPrice'] : []), 'stopLoss', 'takeProfit'];
      for (const field of fields) {
        const price = field === 'price' ? row.price ?? row.entryPrice : row[field];
        if (!(price > 0)) continue;
        const key = `${target.key}:${field}`; keys.add(key);
        const value = control(target, field); value.target = target;
        value.line.classList.toggle('mt5-live-entry', field === 'price' && target.kind !== 'draft');
        value.line.classList.toggle('mt5-native-level', target.kind !== 'draft');
        value.tag.disabled = Boolean(options.disabled?.() || drag?.finished);
        const y = priceToY(price, viewport) - rect.y;
        // An identical native line already crosses the plot, beneath its own
        // label. Drawing this DOM line over it would strike through that text.
        value.line.style.borderTopColor = options.draft && livePrices.some(level => Math.abs(priceToY(level, viewport) - rect.y - y) < 2) ? 'transparent' : '';
        value.line.hidden = !Number.isFinite(y) || y < 0 || y > rect.height;
        value.line.style.top = `${y}px`;
        value.tag.textContent = target.kind === 'draft' ? `${names[field]} ${price.toFixed(current.quote.digits)}${field === 'price' ? ` · ${current.quantity ?? '…'} lot` : ''}`
          : `${names[field]} #${row.id} · ${price.toFixed(current.quote.digits)}`;
        if (field === 'price' && target.kind === 'draft') {
          const send = value.line.querySelector('.mt5-projection-send');
          send.textContent = `${row.side === 'buy' ? 'Mua' : 'Bán'} ${row.type === 'stopLimit' ? 'Stop Limit' : row.type}`;
          send.dataset.side = row.side; send.disabled = Boolean(current.sending || !current.quantity || tradeIssue(row, current.quote));
        }
      }
    }
    for (const [key, value] of controls) if (!keys.has(key)) { value.line.remove(); controls.delete(key); }
    if (options.draft) {
      const entry = controls.get('draft:price');
      const next = entry && !entry.line.hidden ? Math.min(rect.width * .55,
        [...entry.line.querySelectorAll(':scope > button')].reduce((sum, button) => sum + button.getBoundingClientRect().width, 10)) : 0;
      if (Math.abs(next - inset) > 1) { inset = next; chart.tradingManager.setTagInset(inset); chart.requestRender(); }
    }
    frame = requestAnimationFrame(render);
  }
  // A draft owns an entry that happens to overlap a live order. Window capture
  // gives that temporary editor priority over the widget's native drag handler.
  const downHost = window;
  downHost.addEventListener('pointerdown', down, true);
  window.addEventListener('mousedown', middleDefault, true); window.addEventListener('auxclick', middleDefault, true);
  window.addEventListener('pointermove', move, true); window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', cancel, true); window.addEventListener('keydown', keyboard, true);
  render();
  return { destroy() {
    stopped = true; cancel(); cancelAnimationFrame(frame); clearTimeout(timer); layer.remove();
    if (options.draft) { chart.tradingManager.setTagInset(0); chart.requestRender(); }
    downHost.removeEventListener('pointerdown', down, true); window.removeEventListener('pointermove', move, true);
    window.removeEventListener('mousedown', middleDefault, true); window.removeEventListener('auxclick', middleDefault, true);
    window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', cancel, true); window.removeEventListener('keydown', keyboard, true);
  } };
}
