import { LayerType } from '@tradecanvas/commons';
import { CrosshairHandler, barIndexToX, priceToY, xToBarIndex, yToPrice } from '@tradecanvas/core';

function contains(rect, point) {
  return point.x >= rect.x && point.x <= rect.x + rect.width &&
    point.y >= rect.y && point.y <= rect.y + rect.height;
}

function horizontalOnly(theme) {
  const horizontal = theme.style?.crosshair.horizontal ?? {
    visible: true, color: theme.crosshair, style: 'solid', width: 1,
  };
  return {
    ...theme,
    style: { ...theme.style, crosshair: { horizontal, vertical: { visible: false } } },
  };
}

export function createGridPriceLink(getGrid) {
  let hover;
  return widget => ({
    report(price) {
      if (price === null && hover?.widget !== widget) return;
      const symbol = widget.getSymbol();
      if (hover?.widget === widget && hover.symbol === symbol && hover.price === price) return;
      hover = price === null ? undefined : { widget, symbol, price };
      const grid = getGrid();
      if (!grid?.getSync().crosshair) return;
      for (const other of grid.getWidgets()) {
        if (other !== widget) other.getChart().engine.requestRender(LayerType.Hover);
      }
    },
    read() {
      if (!hover || hover.widget === widget || !getGrid()?.getSync().crosshair) return null;
      if (hover.symbol !== widget.getSymbol() || hover.symbol !== hover.widget.getSymbol()) return null;
      return hover.price;
    },
  });
}

export function installPaneCrosshair(chart, priceLink) {
  const engine = chart.engine;
  if (typeof engine?.renderPanelCrosshair !== 'function') return;
  const renderHoveredPane = engine.renderPanelCrosshair;
  const vertical = new CrosshairHandler();
  vertical.setMode('normal');
  const horizontal = new CrosshairHandler();
  horizontal.setMode('normal');

  // TradeCanvas 2.12 draws crosshairs only inside the hovered pane. This top
  // render pass shares the time column, using its native stroke and theme.
  engine.renderPanelCrosshair = function (ctx, state) {
    const source = state.crosshairHandler;
    const position = source?.getPosition();
    const plot = state.viewport.chartRect;
    const onPrice = position && plot.height > 0 && contains(plot, position);
    // The native event only fires when the bar changes. Read the cursor each
    // hover frame to follow vertical motion within one candle too.
    if (priceLink) {
      const price = onPrice && source.drawsLines() && state.theme.style?.crosshair.horizontal.visible !== false
        ? yToPrice(position.y, state.viewport) : null;
      priceLink.report(Number.isFinite(price) ? price : null);
    }
    if (!source?.drawsLines()) return;
    let slot = source.getSyncedSlot();
    if (!position && slot !== null && priceLink) {
      const price = priceLink.read();
      if (price !== null) {
        const point = { x: barIndexToX(slot, state.viewport), y: priceToY(price, state.viewport) };
        if (plot.height > 0 && contains(plot, point)) {
          horizontal.onPointerMove(point);
          horizontal.render(ctx, state.viewport, horizontalOnly(state.theme));
        }
      }
    }
    const panels = state.panels.filter(panel => panel.viewport.chartRect.height >= 8);
    if (!panels.length) return;
    if (position) {
      const hovered = panels.find(panel => contains(panel.rect, position));
      if (!onPrice && !hovered) return;
      slot = source.getMode() === 'magnet'
        ? xToBarIndex(position.x, state.viewport)
        : (position.x - plot.x - state.viewport.barWidth / 2 + state.viewport.offset) /
          (state.viewport.barWidth + state.viewport.barSpacing);
      if (hovered) {
        renderHoveredPane.call(this, ctx, { ...state, theme: horizontalOnly(state.theme) });
      }
    }
    if (slot === null) return;
    vertical.setSyncedSlot(slot);
    // The native price pass already draws its column when the pointer is on it.
    if (position && !onPrice) vertical.render(ctx, state.viewport, state.theme);
    for (const panel of panels) {
      vertical.render(ctx, { ...panel.viewport, chartRect: panel.rect }, state.theme);
    }
  };
}
