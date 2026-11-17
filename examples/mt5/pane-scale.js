import { AxisDragHandler } from '@tradecanvas/core';

function scaleRange(range, factor, log) {
  const min = log ? Math.log(range.min) : range.min;
  const max = log ? Math.log(range.max) : range.max;
  const center = min + (max - min) / 2;
  const half = Math.max((max - min) / 2 * factor, 1e-9);
  const next = log
    ? { min: Math.exp(center - half), max: Math.exp(center + half) }
    : { min: center - half, max: center + half };
  return Number.isFinite(next.min) && Number.isFinite(next.max) && next.max > next.min &&
    (!log || next.min > 0) ? next : range;
}

function panRange(range, viewport, deltaY) {
  const { logScale, invertScale, chartRect } = viewport;
  const min = logScale ? Math.log(range.min) : range.min;
  const max = logScale ? Math.log(range.max) : range.max;
  const shift = (max - min) * (invertScale ? -deltaY : deltaY) / chartRect.height;
  const next = logScale ? { min: Math.exp(min - shift), max: Math.exp(max - shift) }
    : { min: min - shift, max: max - shift };
  return Number.isFinite(next.min) && Number.isFinite(next.max) && next.max > next.min &&
    (!logScale || next.min > 0) ? next : range;
}

export function installPaneScale(chart) {
  const { container, panes } = chart;
  if (!(container instanceof HTMLElement) || typeof panes?.panels !== 'function') return;

  const manual = new Map();
  let gesture;
  let panePan;
  const readPanels = panes.panels.bind(panes);

  // TradeCanvas 2.12 has no public range setter for a pane. Its shared pane
  // viewport is where candles, the value axis and the crosshair read the scale.
  panes.panels = (...args) => {
    const panels = readPanels(...args);
    if (!manual.size) return panels;
    return panels.map(panel => {
      const priceRange = manual.get(panel.instanceId);
      if (!priceRange || (panel.viewport.logScale && priceRange.min <= 0)) return panel;
      return { ...panel, viewport: { ...panel.viewport, priceRange } };
    });
  };

  // The core calls its pan handler only after checking pane dividers, drawing
  // tools and selection. Route its vertical delta to the pane it started in.
  const pan = chart.interactionManager?.panHandler;
  if (typeof pan?.callback === 'function' && typeof pan.onPointerDown === 'function') {
    const begin = pan.onPointerDown.bind(pan);
    const move = pan.callback.bind(pan);
    pan.onPointerDown = point => {
      const panel = chart.buildPanelRenderInfos().find(({ viewport: { chartRect: rect } }) =>
        point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height);
      panePan = panel ? { panel, pending: 0, moving: false } : undefined;
      return begin(point);
    };
    pan.callback = (deltaX, deltaY) => {
      if (!panePan) return move(deltaX, deltaY);
      const { panel } = panePan;
      if (deltaY) {
        panePan.pending += deltaY;
        if (panePan.moving || Math.abs(panePan.pending) >= 3) {
          const range = manual.get(panel.instanceId) ?? panel.viewport.priceRange;
          manual.set(panel.instanceId, panRange(range, panel.viewport, panePan.pending));
          panePan.pending = 0;
          panePan.moving = true;
        }
      }
      return move(deltaX, 0);
    };
  }

  function hitAxis(event) {
    if (event.target instanceof Element && event.target.closest('button, input, select, [role="menu"], [role="dialog"]')) return;
    const bounds = container.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    return chart.buildPanelRenderInfos().find(({ viewport }) => {
      const { chartRect: plot, priceAxisWidth } = viewport;
      const axisStart = plot.x + plot.width;
      return plot.height > 0 && x >= axisStart && x < axisStart + priceAxisWidth &&
        y >= plot.y && y < plot.y + plot.height;
    });
  }

  const drag = new AxisDragHandler(factor => {
    const { paneId, log } = gesture;
    gesture.range = scaleRange(gesture.range, factor, log);
    manual.set(paneId, gesture.range);
    chart.requestRender();
  }, () => {});

  const point = event => ({ x: 0, y: event.clientY });
  const showCursor = active => container.toggleAttribute('data-pane-axis-scale', active);

  container.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || gesture) return;
    const panel = hitAxis(event);
    if (!panel) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    pan?.cancelMomentum();
    gesture = { pointerId: event.pointerId, paneId: panel.instanceId,
      range: panel.viewport.priceRange, log: panel.viewport.logScale };
    drag.begin('price', point(event));
    container.setPointerCapture(event.pointerId);
    showCursor(true);
  }, true);

  container.addEventListener('pointermove', event => {
    if (!gesture) {
      showCursor(Boolean(hitAxis(event)));
      return;
    }
    if (gesture.pointerId !== event.pointerId) return;
    event.stopImmediatePropagation();
    drag.move(point(event));
  }, true);

  function endGesture() {
    if (!gesture) return;
    const { pointerId } = gesture;
    drag.end();
    gesture = undefined;
    if (container.hasPointerCapture(pointerId)) container.releasePointerCapture(pointerId);
  }

  function finish(event) {
    if (gesture?.pointerId !== event.pointerId) return;
    endGesture();
    showCursor(event.type === 'pointerup' && Boolean(hitAxis(event)));
  }

  container.addEventListener('pointerup', finish, true);
  container.addEventListener('pointercancel', finish, true);
  container.addEventListener('lostpointercapture', finish);
  container.addEventListener('pointerleave', () => { if (!gesture) showCursor(false); });

  container.addEventListener('dblclick', event => {
    const panel = hitAxis(event);
    if (!panel) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (manual.delete(panel.instanceId)) chart.requestRender();
  }, true);

  chart.on('indicatorRemove', ({ payload }) => {
    manual.delete(payload.instanceId);
    if (panePan?.panel.instanceId === payload.instanceId) {
      pan?.cancelMomentum();
      panePan = undefined;
    }
  });
  const reset = () => {
    endGesture();
    pan?.cancelMomentum();
    panePan = undefined;
    showCursor(false);
    manual.clear();
  };
  chart.on('symbolChange', reset);
  chart.on('timeframeChange', reset);
}
