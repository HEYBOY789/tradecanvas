import { timeToX, xToTime } from '@tradecanvas/core';
import { timeLabel } from './order-time.js';

export function expiryChart(widget, read, change, disabled) {
  const chart = widget.getChart(), host = widget.chartContainer;
  const layer = document.createElement('div'); layer.className = 'mt5-expiry-layer'; host.append(layer);
  const lines = new Map(); let frame, drag = null, stopped = false;
  const reserved = event => event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || chart.getDrawingTool() || chart.isEraserMode() || chart.isZoomAreaMode();
  function down(event, row) {
    if (event.button !== 0 || reserved(event) || disabled() || drag) return;
    event.preventDefault(); event.stopImmediatePropagation();
    drag = { row: { ...row }, account: read().accountId, at: row.expiresAt, pointer: event.pointerId, start: event.clientX, moved: false };
    host.setPointerCapture(event.pointerId);
  }
  function move(event) {
    if (!drag || event.pointerId !== drag.pointer) return;
    event.preventDefault(); event.stopImmediatePropagation();
    drag.moved ||= Math.abs(event.clientX - drag.start) >= 3;
    const viewport = { ...chart.viewport.getState(), data: chart.getDisplayData() }, left = host.getBoundingClientRect().left;
    drag.at = Math.round((drag.row.expiresAt + xToTime(event.clientX - left, viewport) - xToTime(drag.start - left, viewport)) / 60000) * 60000;
  }
  async function up(event) {
    if (!drag || event.pointerId !== drag.pointer) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const dropped = drag; drag = null;
    if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
    if (dropped.moved && dropped.account === read().accountId) await change(dropped.row, dropped.at, dropped.account);
  }
  function cancel() { if (drag && host.hasPointerCapture(drag.pointer)) host.releasePointerCapture(drag.pointer); drag = null; }
  function key(event) { if (event.key === 'Escape') cancel(); }
  function render() {
    if (stopped) return;
    const current = read(), viewport = { ...chart.viewport.getState(), data: chart.getDisplayData() }, rect = viewport.chartRect, keys = new Set();
    if (drag && current.accountId !== drag.account) cancel();
    Object.assign(layer.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    for (const row of current.rows) {
      if (!Number.isFinite(row.expiresAt)) continue;
      const id = `${row.kind}:${row.id}`, at = drag?.row.kind === row.kind && drag?.row.id === row.id ? drag.at : row.expiresAt; keys.add(id);
      if (!lines.has(id)) {
        const line = document.createElement('div'); line.className = 'mt5-expiry-line';
        const tag = document.createElement('button'); tag.type = 'button'; tag.setAttribute('aria-label', `Kéo thời hạn ${row.kind === 'draft' ? 'lệnh nháp' : `lệnh ${row.id}`}`);
        const value = { line, tag, row }; tag.addEventListener('pointerdown', event => down(event, value.row)); line.append(tag); layer.append(line); lines.set(id, value);
      }
      const value = lines.get(id); value.row = row;
      const x = timeToX(at, viewport) - rect.x;
      value.line.style.left = `${Math.max(0, Math.min(rect.width - 3, x))}px`;
      value.tag.style.left = x < 0 ? '2px' : ''; value.tag.style.right = x < 0 ? 'auto' : '2px';
      value.line.dataset.offscreen = String(x < 0 || x > rect.width);
      value.tag.disabled = disabled();
      const status = { waiting: 'Đợi MT5', failed: 'Lỗi', uncertain: 'Chưa rõ kết quả', partial: 'Khớp một phần' }[row.expiryStatus];
      value.tag.title = row.expiryError || '';
      value.tag.textContent = `${status || 'Hết hạn'} ${row.kind === 'draft' ? '' : `#${row.id} · `}${timeLabel(at, widget.getSettings().timezone, widget.getTradePreferences?.().clock)}${x > rect.width ? ' →' : x < 0 ? ' ←' : ''}`;
    }
    for (const [id, value] of lines) if (!keys.has(id)) { value.line.remove(); lines.delete(id); }
    frame = requestAnimationFrame(render);
  }
  window.addEventListener('pointermove', move, true); window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', cancel); window.addEventListener('keydown', key); render();
  return { destroy() { stopped = true; cancel(); cancelAnimationFrame(frame); layer.remove();
    window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', cancel); window.removeEventListener('keydown', key); } };
}
