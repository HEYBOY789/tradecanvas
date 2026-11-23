import { PRICE_SOURCES, isPriceSource, sourcePrice } from '@tradecanvas/commons';
import { barIndexToX, getIntParam, getNumberParam, plotShown, priceToY, renderPlots } from '@tradecanvas/core';

export const SUPERTREND_PINE_ID = 'supertrend-pine-v4';

const defaults = { period: 10, priceSource: 'hl2', multiplier: 3, wilderATR: true, showSignals: true, highlight: true };
const colors = ['#4caf50', '#f23645'];
const plots = [
  { key: 'up', title: 'Up Trend', color: 0 },
  { key: 'down', title: 'Down Trend', color: 1 },
  { key: 'buy', title: 'UpTrend Begins', color: 0, kind: 'markers', shape: 'dot' },
  { key: 'sell', title: 'DownTrend Begins', color: 1, kind: 'markers', shape: 'dot' },
];
const fills = [
  { between: ['ohlc4', 'up'], color: 0, opacity: .16 },
  { between: ['ohlc4', 'down'], color: 1, opacity: .16 },
];

function trueRange(data, index) {
  const { high, low } = data[index];
  const close = data[index - 1]?.close;
  return close === undefined ? high - low : Math.max(high - low, Math.abs(high - close), Math.abs(low - close));
}

function calculateFrom(data, config, output, from) {
  const period = getIntParam(config, 'period', defaults.period);
  const multiplier = getNumberParam(config, 'multiplier', defaults.multiplier);
  const { priceSource, wilderATR, showSignals, highlight } = { ...defaults, ...config.params };
  const source = isPriceSource(priceSource) ? priceSource : defaults.priceSource;
  const { series, values, meta: { states } } = output;
  // Pine's atr() seeds from high-low on bar zero. The standalone tr used
  // in sma(tr, period) has no first value because there is no previous close.
  const first = wilderATR ? period - 1 : period;
  let previous = states[from - 1];
  for (let i = from; i < states.length; i++) values.delete(states[i].time);
  states.length = series.length = data.length;
  for (let i = from; i < data.length; i++) {
    const bar = data[i], priorClose = data[i - 1]?.close;
    const range = i === 0 && !wilderATR ? 0 : trueRange(data, i);
    let sum = previous?.sum ?? 0;
    if (wilderATR && i > first) {
      sum += (range - sum) / period;
    } else {
      sum += range;
      if (i === first && wilderATR) sum /= period;
      if (!wilderATR && i > period) sum -= trueRange(data, i - period);
    }
    let up, down, point = null;
    const oldTrend = previous?.trend ?? 1;
    let trend = oldTrend;
    if (i >= first) {
      const offset = multiplier * (wilderATR ? sum : sum / period);
      const middle = sourcePrice(bar, source);
      up = middle - offset;
      down = middle + offset;
      const priorUp = previous?.up ?? up, priorDown = previous?.down ?? down;
      if (priorClose > priorUp) up = Math.max(up, priorUp);
      if (priorClose < priorDown) down = Math.min(down, priorDown);
      if (trend === -1 && bar.close > priorDown) trend = 1;
      else if (trend === 1 && bar.close < priorUp) trend = -1;
      point = trend === 1 ? { trend, up } : { trend, down };
      if (highlight) point.ohlc4 = sourcePrice(bar, 'ohlc4');
      if (previous && trend !== oldTrend) point[trend === 1 ? 'buy' : 'sell'] = trend === 1 ? up : down;
      values.set(bar.time, point);
    }
    states[i] = previous = { time: bar.time, sum, up, down, trend };
    series[i] = point;
  }
  output.meta.showSignals = showSignals;
  return output;
}

function drawSignalLabels(ctx, output, viewport, style, theme) {
  const from = Math.max(0, viewport.visibleRange.from);
  const to = Math.min(output.series.length - 1, viewport.visibleRange.to);
  const rect = viewport.chartRect;
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.clip();
  ctx.font = `bold 10px ${theme.font.family}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const buyWidth = Math.ceil(ctx.measureText('Buy').width) + 10;
  const sellWidth = Math.ceil(ctx.measureText('Sell').width) + 10;
  for (let i = from; i <= to; i++) {
    const point = output.series[i];
    const buy = point?.buy !== undefined;
    const price = buy ? point.buy : point?.sell;
    if (price === undefined || style.plots?.[buy ? 'buy' : 'sell']?.visible === false) continue;
    const x = barIndexToX(i, viewport), y = priceToY(price, viewport);
    if (x < rect.x || x > rect.x + rect.width || y < rect.y || y > rect.y + rect.height) continue;
    const width = buy ? buyWidth : sellWidth;
    const height = 16, gap = 5;
    const top = buy ? y + gap : y - gap - height;
    const color = style.colors[buy ? 0 : 1] ?? colors[buy ? 0 : 1];
    ctx.fillStyle = color;
    ctx.fillRect(x - width / 2, top, width, height);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - 4, buy ? top : top + height);
    ctx.lineTo(x + 4, buy ? top : top + height);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(buy ? 'Buy' : 'Sell', x, top + height / 2);
  }
  ctx.restore();
}

export const supertrendPine = {
  descriptor: {
    id: SUPERTREND_PINE_ID, name: 'Supertrend (Pine v4)', shortName: 'Supertrend (Pine v4)',
    placement: 'overlay', category: 'trend', defaultConfig: defaults,
    inputs: {
      period: { kind: 'int', label: 'Chu kỳ ATR', min: 1 },
      priceSource: { kind: 'choice', label: 'Nguồn giá', options: PRICE_SOURCES },
      multiplier: { kind: 'number', label: 'Hệ số ATR', step: .1 },
      wilderATR: { kind: 'boolean', label: 'Dùng Wilder ATR (tắt để dùng SMA)' },
      showSignals: { kind: 'boolean', label: 'Hiện nhãn Buy/Sell' },
      highlight: { kind: 'boolean', label: 'Tô vùng xu hướng' },
    },
    defaultStyle: { colors, lineWidths: [2], plots: { buy: { size: 5 }, sell: { size: 5 } } },
    plots,
    readsExchangeTimeZone: false,
  },
  calculate(data, config) {
    return calculateFrom(data, config, { values: new Map(), series: [], meta: { states: [] } }, 0);
  },
  update(data, config, previous, from) {
    if (!previous.meta?.states || from > previous.series.length || from > data.length) return null;
    return calculateFrom(data, config, previous, from);
  },
  render(ctx, output, viewport, style, { theme }) {
    const visibleFills = fills.filter((_, i) => plotShown(plots[i], style));
    renderPlots(ctx, output, viewport, style, plots, visibleFills);
    if (output.meta.showSignals) drawSignalLabels(ctx, output, viewport, style, theme);
  },
};

const ALERTS = [
  ['crossingUp', 'SuperTrend Buy', 'SuperTrend Buy!'],
  ['crossingDown', 'SuperTrend Sell', 'SuperTrend Sell!'],
  ['crossing', 'SuperTrend Direction Change', 'SuperTrend has changed direction!'],
];

export function supertrendAlertItems(widget, { indicatorId, instanceId }) {
  if (indicatorId !== SUPERTREND_PINE_ID || !widget) return [];
  const chart = widget.getChart();
  if (!chart.getFeatures().alerts) return [];
  const channel = `${instanceId}:trend`;
  return ALERTS.map(([condition, label, message]) => {
    const alert = chart.getAlerts().find(item => item.channel === channel && item.condition === condition && item.message === message);
    return { label: `Cảnh báo ${label}`, checked: Boolean(alert), icon: 'bell', onSelect() {
      if (alert) chart.removeAlert(alert.id);
      else if (chart.addAlert(0, condition, message, channel, label, { onBarClose: true })) widget.toast(`Đã tạo cảnh báo ${label}`);
    } };
  });
}
