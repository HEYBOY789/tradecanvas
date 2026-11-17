import { priceToY } from '@tradecanvas/core';
import { tradeLabel, layoutTradeLabels } from './order-label-layout.js';
import { timeLabel } from './order-time.js';

const DIM = .24, BUTTON = 20;
const fields = ['price', 'stopLoss', 'takeProfit'];

// This adapter owns the MT5 label layout, focus and hit geometry together.
// Native prices, execution events and price-axis badges stay with TradeCanvas.
export function installOrderDisplay(widget, read) {
  const chart = widget.getChart(), manager = chart.tradingManager, host = widget.chartContainer;
  const original = { render: manager.render, positions: manager.positionRenderer.renderLines, orders: manager.orderRenderer.renderLines,
    positionTags: manager.positionRenderer.tags, orderTags: manager.orderRenderer.tags };
  const tooltip = document.createElement('div'); tooltip.className = 'mt5-order-tooltip'; tooltip.setAttribute('role', 'tooltip'); tooltip.hidden = true; host.append(tooltip);
  let boxes = [], hovered = null, selected = null, pressed = false, lastAccount, lastSymbol, config, tooltipPoint, tooltipKey;
  const focused = () => hovered || selected;
  const tools = () => chart.getDrawingTool() || chart.isEraserMode() || chart.isZoomAreaMode();
  const reserved = event => event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || tools();
  const contains = (box, point) => point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;
  const hit = point => [...boxes].reverse().find(box => contains(box, point)) || null;
  function local(event) {
    const rect = host.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  function lineHit(point) {
    const rect = chart.viewport.getState().chartRect;
    if (!contains(rect, point)) return null;
    return boxes.map(box => ({ box, distance: Math.abs(box.lineY - point.y) }))
      .filter(row => row.distance <= 6).sort((a, b) => Number(b.box.owner === selected) - Number(a.box.owner === selected) || a.distance - b.distance)[0]?.box || null;
  }
  function updateFocus(next) {
    if (hovered === next) return;
    hovered = next; chart.requestRender();
  }
  function showTooltip(box, point) {
    if (!box || pressed || tools()) { tooltip.hidden = true; return; }
    tooltipPoint = point; tooltipKey = box.key;
    const row = box.row, digits = read().quote?.digits ?? config?.pricePrecision ?? 3;
    const price = value => value > 0 ? Number(value).toFixed(digits) : '—';
    const type = box.kind === 'order' ? ` ${row.type === 'stopLimit' ? 'STOP LIMIT' : row.type.toUpperCase()}` : '';
    const text = [`#${row.id} · ${row.symbol || widget.getSymbol()} · ${row.side.toUpperCase()}${type} · ${row.quantity} lot`,
      `Entry ${price(row.price ?? row.entryPrice)} · SL ${price(row.stopLoss)} · TP ${price(row.takeProfit)}`,
      ...(row.stopPrice ? [`Stop ${price(row.stopPrice)}`] : []),
      ...(Number.isFinite(row.profit) ? [`P/L ${row.profit >= 0 ? '+' : ''}${row.profit.toFixed(2)} ${read().currency}`] : []),
      timeLabel(row.expiresAt, widget.getSettings().timezone, widget.getTradePreferences?.().clock)].join('\n');
    if (tooltip.textContent !== text) tooltip.textContent = text;
    tooltip.hidden = false;
    const width = tooltip.offsetWidth, height = tooltip.offsetHeight;
    tooltip.style.left = `${Math.max(4, Math.min(host.clientWidth - width - 4, point.x - width - 14))}px`;
    tooltip.style.top = `${Math.max(4, Math.min(host.clientHeight - height - 4, point.y - height - 14))}px`;
  }
  function move(event) {
    if (!host.contains(event.target) || reserved(event)) { if (!pressed) updateFocus(null); tooltip.hidden = true; return; }
    if (pressed) { tooltip.hidden = true; return; }
    const point = local(event), box = hit(point) || lineHit(point);
    updateFocus(box?.owner || null); showTooltip(box, point);
  }
  function down(event) {
    if (!host.contains(event.target) || reserved(event) || ![0, 1].includes(event.button)) return;
    if (event.target.closest('button,input,select,textarea')) return;
    const point = local(event), box = hit(point) || lineHit(point);
    if (!contains(chart.viewport.getState().chartRect, point)) return;
    selected = box?.owner || null; hovered = selected; pressed = Boolean(box); tooltip.hidden = true; chart.requestRender();
  }
  function up() { pressed = false; }
  function leave() { if (!pressed) { updateFocus(null); tooltip.hidden = true; } }
  function clear(event) {
    if (event?.type === 'keydown' && event.key !== 'Escape') return;
    selected = hovered = null; pressed = false; tooltip.hidden = true; chart.requestRender();
  }

  // The pinned 2.13.1 renderer supplies line drawing and execution hit boxes.
  // Wrap only this chart instance; restoring these functions needs no rebuild.
  manager.positionRenderer.tags = manager.orderRenderer.tags = () => [];
  manager.positionRenderer.renderLines = function(ctx, rows, currentPrice, viewport, effective, drag) {
    config = effective;
    for (const row of rows) {
      const owner = `position:${row.id}`, active = focused();
      ctx.save(); ctx.globalAlpha = active && active !== owner ? DIM : 1;
      original.positions.call(this, ctx, [row], active === owner ? currentPrice : null, viewport, effective, drag); ctx.restore();
    }
  };
  manager.orderRenderer.renderLines = function(ctx, rows, viewport, effective, drag) {
    config = effective;
    for (const row of rows) {
      ctx.save(); ctx.globalAlpha = focused() && focused() !== `order:${row.id}` ? DIM : 1;
      original.orders.call(this, ctx, [row], viewport, effective, drag); ctx.restore();
    }
  };
  function specs(ctx, viewport, current) {
    const result = [], metadata = new Map([...(current.positions || []).map(row => [`position:${row.id}`, row]), ...(current.orders || []).map(row => [`order:${row.id}`, row])]);
    for (const [kind, rows] of [['position', chart.getPositions()], ['order', chart.getOrders()]]) for (const visible of rows) {
      const owner = `${kind}:${visible.id}`, row = { ...metadata.get(owner), ...visible };
      for (const field of [...fields, ...(row.type === 'stopLimit' ? ['stopPrice'] : [])]) {
        const price = field === 'price' ? row.price ?? row.entryPrice : row[field];
        if (!(price > 0)) continue;
        const lineY = priceToY(price, viewport);
        if (lineY < viewport.chartRect.y || lineY > viewport.chartRect.y + viewport.chartRect.height) continue;
        const color = field === 'stopLoss' ? config.positionColors?.loss || '#f23645' : field === 'takeProfit' ? config.positionColors?.profit || '#089981'
          : kind === 'position' ? config.positionColors?.entry || '#4c8dff' : config.orderColors?.[row.side] || (row.side === 'buy' ? '#2962ff' : '#f23645');
        const action = field === 'price' && config.lineButtons?.[kind === 'position' ? 'close' : 'cancel'] !== false
          ? kind === 'position' ? { type: 'closePosition', positionId: row.id } : { type: 'cancelOrder', orderId: row.id }
          : kind === 'position' && ['stopLoss', 'takeProfit'].includes(field) && config.lineButtons?.removeStops !== false
            ? { type: 'removeStop', positionId: row.id, which: field } : null;
        const text = tradeLabel(row, kind, field, current.currency);
        result.push({ key: `${owner}:${field}`, owner, kind, id: row.id, field, price, lineY, row, text, color, action,
          width: Math.ceil(ctx.measureText(text).width) + 14 + (action ? BUTTON : 0) });
      }
    }
    return result;
  }
  function draw(ctx, box, theme) {
    const { x, y, width, height, color, action } = box, middle = y + height / 2;
    ctx.save();
    ctx.fillStyle = theme.background; ctx.fillRect(x, y, width, height);
    ctx.globalAlpha = box.opacity;
    ctx.strokeStyle = color; ctx.lineWidth = box.owner === focused() ? 1.5 : 1;
    ctx.strokeRect(x + .5, y + .5, width - 1, height - 1);
    const textWidth = Math.max(0, width - 12 - (action ? BUTTON : 0));
    let text = box.text;
    while (text.length && ctx.measureText(text).width > textWidth) text = text.slice(0, -1);
    if (text !== box.text && text.length > 1) text = `${text.slice(0, -1)}…`;
    ctx.save(); ctx.beginPath(); ctx.rect(x + 4, y + 1, textWidth + 3, height - 2); ctx.clip();
    ctx.fillStyle = theme.text;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.fillText(text, x + 6, middle); ctx.restore();
    if (box.field === 'price' && box.kind === 'position' && Number.isFinite(box.row.profit)) {
      const prefix = `${tradeLabel({ ...box.row, profit: undefined }, 'position', 'price', '')} · `;
      if (text.length > prefix.length) {
        ctx.save(); ctx.beginPath(); ctx.rect(x + 4, y + 1, textWidth + 3, height - 2); ctx.clip();
        ctx.fillStyle = box.row.profit < 0 ? config.positionColors?.loss || '#f23645' : config.positionColors?.profit || '#089981';
        ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.fillText(text.slice(prefix.length), x + 6 + ctx.measureText(prefix).width, middle); ctx.restore();
      }
    }
    if (action && width >= BUTTON) {
      const left = x + width - BUTTON;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left, y + height); ctx.stroke();
      ctx.strokeStyle = theme.text; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(left + 6, middle - 4); ctx.lineTo(left + 14, middle + 4); ctx.moveTo(left + 14, middle - 4); ctx.lineTo(left + 6, middle + 4); ctx.stroke();
    }
    ctx.restore();
  }
  function record(box) {
    const { x, y, width, height, lineY, action } = box;
    if (action && width >= BUTTON) manager.buttons.push({ x: x + width - BUTTON, y: y + (height - BUTTON) / 2, size: BUTTON, action });
    manager.drawnTags.push({ x, y, width, height });
    const grab = box.kind === 'order' && box.field === 'price' ? { kind: 'order', orderId: box.id }
      : box.kind === 'position' && ['stopLoss', 'takeProfit'].includes(box.field) ? { kind: 'stop', positionId: box.id, which: box.field } : null;
    if (grab) manager.tagBoxes.push({ x, y, width, height, lineY, grab });
  }
  manager.render = function(ctx, viewport, theme) {
    const current = read(), symbol = widget.getSymbol();
    const owners = new Set([...chart.getPositions().map(row => `position:${row.id}`), ...chart.getOrders().map(row => `order:${row.id}`)]);
    if (current.accountId !== lastAccount || symbol !== lastSymbol || tools()) { selected = hovered = null; tooltip.hidden = true; }
    lastAccount = current.accountId; lastSymbol = symbol;
    if (!owners.has(selected)) selected = null;
    if (!owners.has(hovered)) { hovered = null; tooltip.hidden = true; }
    original.render.call(this, ctx, viewport, theme);
    boxes = [];
    if (!manager.config.enabled) { tooltip.hidden = true; return; }
    config ||= manager.config;
    ctx.save(); ctx.font = `11px ${theme.font.family}`;
    const rect = viewport.chartRect;
    boxes = layoutTradeLabels(specs(ctx, viewport, current), { x: rect.x + 12, y: rect.y + 2,
      width: Math.max(0, rect.width - 20 - manager.tagInset), height: Math.max(0, rect.height - 4) });
    for (const box of boxes) { box.opacity = focused() && focused() !== box.owner ? DIM : 1; record(box); }
    if (!tooltip.hidden && tooltipPoint) showTooltip(boxes.find(box => box.key === tooltipKey), tooltipPoint);
    ctx.restore();
  };
  chart.plugins.register({ kind: 'overlay', plugin: {
    descriptor: { id: 'mt5-order-labels', name: 'MT5 order labels', layer: 'ui' },
    render(ctx, { viewport, theme }) {
      const rect = viewport.chartRect;
      ctx.save(); ctx.font = `11px ${theme.font.family}`; ctx.setLineDash([]);
      ctx.beginPath(); ctx.rect(rect.x, rect.y, rect.width, rect.height); ctx.clip();
      // All connectors go under all cards; the UI layer also keeps the
      // crosshair and unrelated price lines from striking through their text.
      for (const box of boxes) {
        const middle = box.y + box.height / 2;
        if (Math.abs(middle - box.lineY) <= 1) continue;
        ctx.save(); ctx.globalAlpha = box.opacity; ctx.strokeStyle = box.color; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(box.x - 10, box.lineY); ctx.lineTo(box.x - 4, box.lineY);
        ctx.lineTo(box.x - 4, middle); ctx.lineTo(box.x, middle); ctx.stroke(); ctx.restore();
      }
      for (const box of boxes) draw(ctx, box, theme);
      ctx.restore();
    },
  } });
  window.addEventListener('pointermove', move, true); window.addEventListener('pointerdown', down, true);
  window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', clear, true); window.addEventListener('keydown', clear, true);
  host.addEventListener('pointerleave', leave); chart.on('drawingToolChange', clear); chart.on('toolModeChange', clear);
  const api = { hit: point => hit(point) || lineHit(point), destroy() {
    manager.render = original.render; manager.positionRenderer.renderLines = original.positions; manager.orderRenderer.renderLines = original.orders;
    manager.positionRenderer.tags = original.positionTags; manager.orderRenderer.tags = original.orderTags;
    chart.plugins.unregister('overlay:mt5-order-labels');
    window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerdown', down, true);
    window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', clear, true); window.removeEventListener('keydown', clear, true);
    host.removeEventListener('pointerleave', leave); chart.off('drawingToolChange', clear); chart.off('toolModeChange', clear);
    tooltip.remove(); delete widget.orderDisplay; chart.requestRender();
  } };
  widget.orderDisplay = api; chart.requestRender(); return api;
}
