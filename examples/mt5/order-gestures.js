import { priceToY, yToPrice } from '@tradecanvas/core';
import { bracketSide, roundPrice, translatedOrder } from './order-model.js';

// One pointer owner handles entry, bracket and individual-stop drags. Drafts
// edit only their model; a live trade changes only after the drop is submitted.
export function tradeGestures(widget, options) {
  const chart = widget.getChart(), host = widget.chartContainer;
  const layer = document.createElement('div'); layer.className = options.draft ? 'mt5-projection' : 'mt5-projection mt5-live-stops'; host.append(layer);
  const controls = new Map();
  let frame, timer, stopped = false, drag = null;
  const names = { price: 'Entry', stopPrice: 'Stop', stopLoss: 'SL', takeProfit: 'TP' };
  function geometry(event, quote) {
    const bounds = host.getBoundingClientRect(), viewport = chart.viewport.getState(), rect = viewport.chartRect;
    const x = event.clientX - bounds.left, y = event.clientY - bounds.top;
    return { x, y, rect, viewport, inside: x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height,
      price: roundPrice(yToPrice(Math.max(rect.y, Math.min(rect.y + rect.height, y)), viewport), quote) };
  }
  function begin(event, target, field) {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (options.disabled?.() || drag) return;
    options.activate?.();
    // Preventing the native pan also prevents its default focus change. The
    // form must stop treating an old input as actively typed while dragging.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const current = options.read();
    drag = { target: { ...target, row: { ...target.row } }, field,
      bracket: field === 'price' && event.shiftKey, pointer: event.pointerId,
      account: current.accountId, quote: current.quote, entry: target.row.price ?? target.row.entryPrice,
      price: target.row[field] ?? target.row.entryPrice, startY: event.clientY, moved: false, finished: false };
    host.setPointerCapture(event.pointerId);
  }
  function down(event) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || !host.contains(event.target)) return;
    const owned = [...controls.values()].find(value => value.tag === event.target || value.tag.contains(event.target));
    if (owned) { begin(event, owned.target, owned.field); return; }
    if (event.target.closest('button,input,select,textarea')) return;
    const current = options.read(); if (!current.quote) return;
    const point = geometry(event, current.quote); if (!point.inside) return;
    if (!options.draft && current.blockedPrices?.some(price => price > 0 && Math.abs(priceToY(price, point.viewport) - point.y) <= 7)) return;
    const hit = current.targets.flatMap(target => {
      const fields = [...(target.canMoveEntry || event.shiftKey ? ['price'] : []),
        ...(target.row.type === 'stopLimit' ? ['stopPrice'] : []), 'stopLoss', 'takeProfit'];
      return fields.flatMap(field => {
        const price = field === 'price' ? target.row.price ?? target.row.entryPrice : target.row[field];
        return price > 0 ? [{ target, field, distance: Math.abs(priceToY(price, point.viewport) - point.y) }] : [];
      });
    }).filter(item => item.distance <= 7).sort((a, b) => a.distance - b.distance)[0];
    if (hit) begin(event, hit.target, hit.field);
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
      options.change(field, drag.price);
    }
  }
  function preview() {
    if (!drag || !drag.moved) return null;
    const field = drag.bracket ? bracketSide(drag.target.row.side, drag.entry, drag.price) : drag.field;
    const row = field === 'price' ? translatedOrder(drag.target.row, drag.price, drag.quote) : { ...drag.target.row, [field]: drag.price };
    return { field, row };
  }
  async function up(event) {
    if (!drag || drag.finished || drag.pointer !== event.pointerId) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
    const dropped = drag, proposed = preview();
    if (!proposed || dropped.target.kind === 'draft') { drag = null; return; }
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
    layer.hidden = !current.quote;
    const proposed = preview(), keys = new Set();
    if (proposed && drag.target.kind !== 'draft') options.preview?.(drag.target, proposed.row);
    if (current.quote) for (const target of current.targets) {
      const active = drag?.target.key === target.key;
      const row = active && proposed ? proposed.row : target.row;
      const fields = target.kind === 'draft' ? ['price', 'stopPrice', 'stopLoss', 'takeProfit']
        : target.kind === 'order' ? ['stopLoss', 'takeProfit'] : active && proposed ? [proposed.field] : [];
      for (const field of fields) {
        const price = field === 'stopPrice' && row.type !== 'stopLimit' ? null : row[field];
        if (!(price > 0)) continue;
        const key = `${target.key}:${field}`; keys.add(key);
        const value = control(target, field); value.target = target;
        value.tag.disabled = Boolean(options.disabled?.() || drag?.finished);
        const y = priceToY(price, viewport) - rect.y;
        value.line.hidden = !Number.isFinite(y) || y < 0 || y > rect.height;
        value.line.style.top = `${y}px`;
        value.tag.textContent = target.kind === 'draft' ? `${names[field]} ${price.toFixed(current.quote.digits)}${field === 'price' ? ` · ${current.quantity ?? '…'} lot` : ''}`
          : `${names[field]} #${row.id} · ${price.toFixed(current.quote.digits)}`;
        if (field === 'price' && target.kind === 'draft') {
          const send = value.line.querySelector('.mt5-projection-send');
          send.textContent = `${row.side === 'buy' ? 'Mua' : 'Bán'} ${row.type === 'stopLimit' ? 'Stop Limit' : row.type}`;
          send.dataset.side = row.side; send.disabled = Boolean(current.sending || !current.quantity);
        }
      }
    }
    for (const [key, value] of controls) if (!keys.has(key)) { value.line.remove(); controls.delete(key); }
    frame = requestAnimationFrame(render);
  }
  // A draft owns an entry that happens to overlap a live order. Window capture
  // gives that temporary editor priority over the widget's native drag handler.
  const downHost = window;
  downHost.addEventListener('pointerdown', down, true);
  window.addEventListener('pointermove', move, true); window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', cancel, true); window.addEventListener('keydown', keyboard, true);
  render();
  return { destroy() {
    stopped = true; cancel(); cancelAnimationFrame(frame); clearTimeout(timer); layer.remove();
    downHost.removeEventListener('pointerdown', down, true); window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', cancel, true); window.removeEventListener('keydown', keyboard, true);
  } };
}
