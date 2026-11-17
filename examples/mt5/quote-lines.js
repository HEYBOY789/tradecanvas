import { CurrentPriceLine } from '@tradecanvas/core';

// The native last-price line is MT5 Bid. Ask shares its visibility, dash and
// width, with the second last-price color reserved for Ask rather than a fall.
export function installQuoteLines(widget, read) {
  const chart = widget.getChart(), bid = chart.currentPriceLine, lines = chart.priceLines;
  const askLine = new CurrentPriceLine();
  const original = { bidLine: bid.renderLine, bidTag: bid.renderTag, levels: lines.levels, render: lines.render, tags: lines.renderAxisTags };
  let highLowOnly = false;
  function syncBid() {
    const q = read().quote;
    if (q?.bid > 0 && !chart.isReplayActive()) bid.setPrice(q.bid);
  }
  function bidTheme(theme) {
    const look = theme.style?.lastPrice || chart.getStyle().lastPrice;
    return { ...theme, style: { ...theme.style, lastPrice: { ...look, down: look.up } } };
  }
  bid.renderLine = function(ctx, viewport, theme) { syncBid(); original.bidLine.call(this, ctx, viewport, bidTheme(theme)); };
  bid.renderTag = function(ctx, viewport, theme) { syncBid(); original.bidTag.call(this, ctx, viewport, bidTheme(theme)); };
  lines.levels = function(data, viewport) {
    const showAsk = read().ask && chart.getStyle().lastPrice.visible;
    return original.levels.call(this, data, viewport).filter(level => level.kind !== 'bid' &&
      (level.kind !== 'ask' || (!highLowOnly && showAsk)));
  };
  lines.render = function(ctx, viewport, theme, data) {
    highLowOnly = true;
    try { original.render.call(this, ctx, viewport, theme, data); } finally { highLowOnly = false; }
    const ask = this.levels(data, viewport).find(level => level.kind === 'ask');
    if (!ask) return;
    const look = theme.style?.lastPrice || chart.getStyle().lastPrice;
    askLine.setPrice(ask.price);
    ctx.save();
    try { askLine.renderLine(ctx, viewport, { ...theme, style: { ...theme.style, lastPrice: { ...look, up: look.down } } }); }
    finally { ctx.restore(); }
  };
  lines.renderAxisTags = function(ctx, viewport, theme, data, at) {
    const look = theme.style?.lastPrice || chart.getStyle().lastPrice;
    original.tags.call(this, ctx, viewport, { ...theme, candleDown: look.down }, data, at);
  };
  return {
    publish() {
      syncBid();
      const { quote, ask } = read();
      chart.setBidAsk(quote && ask && chart.getStyle().lastPrice.visible ? { ask: quote.ask } : null);
    },
    destroy() {
      bid.renderLine = original.bidLine; bid.renderTag = original.bidTag;
      lines.levels = original.levels; lines.render = original.render; lines.renderAxisTags = original.tags;
    },
  };
}
