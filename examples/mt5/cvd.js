// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, see https://mozilla.org/MPL/2.0/.
// Based on CVD - Cumulative Volume Delta Candles v8, © TradingView.
// https://www.tradingview.com/script/NlM312nK-CVD-Cumulative-Volume-Delta-Candles/

import { AroonIndicator, ParabolicSARIndicator, SupertrendIndicator, barIndexToX, priceToY } from '@tradecanvas/core';

const ID = 'mt5-cvd-candle';
const DAY = 86_400_000;
const sourceColors = { up: '#00ff00', down: '#ff0080', upDiv: '#008080', downDiv: '#800000' };
const precision = {
  'Nhiều nến nhất': 4, 'Nhiều nến': 8, 'Cân bằng': 16, 'Chi tiết': 32, 'Chi tiết nhất': 64,
  '~12 nến con': 12, '~24 nến con': 24, '~50 nến con': 50, '~100 nến con': 100, '~250 nến con': 250,
};
const calculationFrames = {
  '1 tick': '1T', '10 ticks': '10T', '100 ticks': '100T', '1000 ticks': '1000T',
  '1 giây': '1s', '5 giây': '5s', '10 giây': '10s', '15 giây': '15s', '30 giây': '30s', '45 giây': '45s',
  '1 phút': '1m',
};
const modes = {
  step: 'Theo khung lớn tự động', none: 'Không đặt lại', fixed: 'Theo khung lớn cố định',
  clock: 'Theo giờ cố định', session: 'Đầu ngày giao dịch MT5', visible: 'Nến đầu đang thấy', trend: 'Khi đổi xu hướng',
};
const trends = { Supertrend: SupertrendIndicator, Aroon: AroonIndicator, 'Parabolic SAR': ParabolicSARIndicator };
const defaults = {
  reset: modes.step, fixedFrame: '1d', hour: 9, minute: 30, trend: 'Supertrend', length: 14, multiplier: 3,
  calculationFrame: 'Tự động', precision: 'Cân bằng', mode: 'Volume delta', candles: true, divergenceColor: true, total: false, totalOpacity: 80,
  line: false, average: false, averageLength: 20, divergenceBg: false, resetBg: true, zero: true,
  info: true, infoSize: 'small', infoY: 'bottom', infoX: 'right',
  upColor: sourceColors.up, downColor: sourceColors.down, upDivColor: sourceColors.upDiv,
  downDivColor: sourceColors.downDiv, upTotalColor: sourceColors.upDiv, downTotalColor: sourceColors.downDiv,
  upLineColor: sourceColors.up, downLineColor: sourceColors.down, upAverageColor: sourceColors.upDiv,
  downAverageColor: sourceColors.downDiv, divergenceBgColor: '#ff8000', resetBgColor: '#808080',
  infoBgColor: '#808080', infoTextColor: '#ffffff',
};
const choice = (label, options) => ({ label, kind: 'choice', options });
const integer = (label, min, max) => ({ label, kind: 'int', min, max });
const color = label => ({ label, kind: 'color' });
const inputs = {
  reset: choice('Đặt CVD về 0', Object.values(modes)),
  fixedFrame: choice('Khung reset cố định', ['5m', '10m', '15m', '20m', '30m', '1h', '2h', '3h', '4h', '6h', '8h', '12h', '1d', '1w', '1M', '12M']),
  hour: integer('Giờ reset (UTC MT5)', 0, 23), minute: integer('Phút reset', 0, 59),
  trend: choice('Chỉ báo xu hướng', Object.keys(trends)), length: integer('Chu kỳ xu hướng', 2, 2000),
  multiplier: { label: 'Hệ số Supertrend', kind: 'number', min: 0.25, step: 0.25 },
  calculationFrame: choice('Khung tính CVD', ['Tự động', ...Object.keys(calculationFrames)]),
  precision: choice('Độ phân giải khi chọn Tự động', Object.keys(precision)),
  mode: choice('Cách tính delta', ['Volume delta', 'Volume delta %']),
  candles: { label: 'Nến CVD' }, divergenceColor: { label: 'Đổi màu khi phân kỳ' },
  total: { label: 'Viền tổng volume' }, totalOpacity: integer('Độ trong thân tổng volume (%)', 0, 100),
  line: { label: 'Đường CVD' }, average: { label: 'Đường trung bình CVD' }, averageLength: integer('Chu kỳ SMA', 2, 2000),
  divergenceBg: { label: 'Nền phân kỳ' }, resetBg: { label: 'Nền reset' }, zero: { label: 'Đường 0' },
  info: { label: 'Bảng thông tin intrabar' }, infoSize: choice('Cỡ chữ bảng', ['tiny', 'small', 'normal', 'large', 'huge', 'auto']),
  infoY: choice('Bảng theo chiều dọc', ['top', 'middle', 'bottom']), infoX: choice('Bảng theo chiều ngang', ['left', 'center', 'right']),
  upColor: color('Nến CVD tăng'), downColor: color('Nến CVD giảm'), upDivColor: color('Phân kỳ delta dương'),
  downDivColor: color('Phân kỳ delta âm'), upTotalColor: color('Tổng volume dương'), downTotalColor: color('Tổng volume âm'),
  upLineColor: color('Đường CVD dương'), downLineColor: color('Đường CVD âm'), upAverageColor: color('Trung bình dương'),
  downAverageColor: color('Trung bình âm'), divergenceBgColor: color('Màu nền phân kỳ'), resetBgColor: color('Màu nền reset'),
  infoBgColor: color('Nền bảng thông tin'), infoTextColor: color('Chữ bảng thông tin'),
};

function targetOf(params) {
  return calculationFrames[params?.calculationFrame] ?? String(precision[params?.precision] ?? precision[defaults.precision]);
}

function frameMs(frame) {
  const unit = { m: 60_000, h: 3_600_000, d: DAY, w: 7 * DAY, M: 30 * DAY }[frame.at(-1)];
  return Number(frame.slice(0, -1)) * unit;
}

function stepFrame(frame) {
  const ms = frameMs(frame);
  if (ms <= 60_000) return '1h';
  if (ms < 3 * 3_600_000) return '1d';
  if (ms <= 12 * 3_600_000) return '1w';
  if (ms < 7 * DAY) return '1M';
  return '12M';
}

function periodKey(time, frame) {
  if (frame === '1w') {
    const day = Math.floor(time / DAY);
    return day - new Date(time).getUTCDay(); // Native MT5 W1 starts on Sunday.
  }
  if (frame.endsWith('M')) {
    const date = new Date(time);
    return Math.floor((date.getUTCFullYear() * 12 + date.getUTCMonth()) / Number(frame.slice(0, -1)));
  }
  return Math.floor(time / frameMs(frame));
}

function crossings(data, params) {
  const trend = trends[params.trend];
  const calc = new trend();
  const { series } = calc.calculate(data, { params: { period: Number(params.length), multiplier: Number(params.multiplier) } });
  const polarity = series.map((point, i) => {
    if (!point) return null;
    if (params.trend === 'Aroon') return point.up - point.down;
    if (params.trend === 'Parabolic SAR') return data[i].close - point.value;
    return point.trend;
  });
  return polarity.map((value, i) => {
    const prior = polarity[i - 1];
    if (value == null || prior == null) return 0;
    return value > 0 && prior <= 0 ? 1 : value < 0 && prior >= 0 ? -1 : 0;
  });
}

function resetPlan(data, frame, params, left) {
  if (params.reset === modes.trend) {
    const trend = crossings(data, params);
    return { description: `Reset · ${params.trend}`, at: i => trend[i], trend: true };
  }
  if (params.reset === modes.none) return { description: 'Cộng dồn liên tục', at: () => 0 };
  if (params.reset === modes.visible) {
    return { description: 'Reset · nến đầu đang thấy', at: i => data[i].time >= left && (i === 0 || data[i - 1].time < left) };
  }
  if (params.reset === modes.clock) {
    if (frameMs(frame) >= DAY) return { error: 'Giờ reset cố định chỉ dùng trên khung intraday.' };
    const offset = (Number(params.hour) * 60 + Number(params.minute)) * 60_000;
    const hhmm = [params.hour, params.minute].map(value => String(value).padStart(2, '0')).join(':');
    return { description: `Reset · ${hhmm} UTC MT5`, at(i) {
      const open = data[i].time;
      const mark = Math.floor(open / DAY) * DAY + offset;
      return open <= mark && mark < open + frameMs(frame);
    } };
  }
  const fixed = params.reset === modes.fixed;
  const session = params.reset === modes.session;
  const higher = fixed ? params.fixedFrame : session ? '1d' : stepFrame(frame);
  if (fixed && frameMs(higher) <= frameMs(frame)) return { error: 'Khung reset phải lớn hơn khung biểu đồ.' };
  return { description: session ? 'Reset · đầu ngày giao dịch MT5' : `Reset · ${higher}`,
    at: i => i > 0 && periodKey(data[i].time, higher) !== periodKey(data[i - 1].time, higher) };
}

export function calculateCvd(data, source, frame, params = defaults, left = -Infinity, replay = false) {
  const plan = resetPlan(data, frame, params, left);
  const series = new Array(data.length).fill(null);
  const values = new Map();
  const meta = { params, plan, frame, lower: source?.frame, volume: source?.volume, count: 0, intrabars: 0,
    last: null, loading: 0, unavailable: 0, visuals: new Array(data.length).fill(null) };
  if (!source || plan.error) return { values, series, meta };
  const percent = params.mode === 'Volume delta %';
  const averageLength = Number(params.averageLength);
  const averageWindow = [];
  let cumulative = 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < data.length - Number(replay); i++) {
    const bar = data[i];
    const reset = plan.at(i);
    const sample = source.rows.get(bar.time);
    if (!sample || reset) {
      cumulative = sum = count = 0;
      averageWindow.length = 0;
    }
    if (!sample) {
      if (source.rows.has(bar.time)) meta.unavailable++;
      else meta.loading++;
      continue;
    }
    const [, up, down, maxUp, maxDown, children] = sample;
    meta.count++;
    meta.intrabars += children;
    const delta = up + down;
    const total = up - down;
    if (percent && !total) continue;
    const open = cumulative;
    const close = open + (percent ? delta / total : delta);
    const high = Math.max(open + (percent ? 0 : maxUp), close);
    const low = Math.min(open + (percent ? 0 : maxDown), close);
    cumulative = close;
    sum += close;
    count++;
    if (params.reset === modes.none) {
      averageWindow.push(close);
      if (averageWindow.length > averageLength) sum -= averageWindow.shift();
      count = averageWindow.length;
    }
    const average = !reset && (params.reset !== modes.none || count === averageLength) ? sum / count : undefined;
    const totalClose = params.total && !percent ? open + total * Math.sign(delta) : undefined;
    const divergence = delta !== 0 && Math.sign(delta) !== Math.sign(bar.close - bar.open);
    const item = { open, high, low, close, average, totalClose };
    series[i] = item;
    values.set(bar.time, item);
    meta.visuals[i] = { delta, divergence, reset };
    meta.last = { delta, total, up, down, maxUp, maxDown, children, close };
  }
  return { values, series, meta };
}

function candle(ctx, viewport, x, body, open, high, low, close, fill, opacity = 1) {
  const y = value => priceToY(value, viewport);
  const top = Math.min(y(open), y(close));
  const height = Math.max(1, Math.abs(y(open) - y(close)));
  ctx.strokeStyle = ctx.fillStyle = fill;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y(high));
  ctx.lineTo(x, y(low));
  ctx.stroke();
  ctx.globalAlpha = opacity;
  ctx.fillRect(x - body / 2, top, body, height);
  ctx.globalAlpha = 1;
  if (opacity < 1) ctx.strokeRect(x - body / 2, top, body, height);
}

function segment(ctx, x0, y0, x1, y1, stroke) {
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function infoBox(ctx, viewport, meta, bars) {
  const { params, lower, volume, count, intrabars, plan, last } = meta;
  if (!params.info && !plan.error) return;
  const average = count ? intrabars / count : 0;
  const format = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 });
  const source = volume === 'real_volume' ? 'Trade volume MT5' : 'Tick volume MT5';
  const rows = plan.error ? [plan.error] : !lower ? ['Đang đọc volume intrabar từ MT5…'] : [
    `${plan.description} · ${source}`,
    `Nến con ${lower} · TB ${format.format(average)}/nến · ${count}/${bars} nến`,
    ...(meta.loading ? [`Đang tải bù ${meta.loading} nến lịch sử…`] : []),
    ...(meta.unavailable ? [`MT5 chưa có nến con cho ${meta.unavailable} nến`] : []),
    last ? `Δ ${format.format(last.delta)} · ↑ ${format.format(last.up)} · ↓ ${format.format(last.down)}` : 'Chưa có volume ở đoạn này',
    ...(lower === meta.frame ? ['Khung nhỏ nhất MT5 · 1 nến con'] : []),
  ];
  const rect = viewport.chartRect;
  const size = { tiny: 9, small: 11, normal: 12, large: 14, huge: 16, auto: 11 }[params.infoSize] ?? 11;
  const pad = 5;
  const rowHeight = size + 4;
  ctx.font = `${size}px Inter, Segoe UI, sans-serif`;
  const width = Math.min(rect.width - 18, Math.max(...rows.map(row => ctx.measureText(row).width)) + pad * 2);
  const height = rows.length * rowHeight + pad * 2;
  if (width <= 0 || height > rect.height - 16) return;
  const x = rect.x + (params.infoX === 'left' ? 8 : params.infoX === 'center' ? (rect.width - width) / 2 : rect.width - width - 8);
  const y = rect.y + (params.infoY === 'top' ? 8 : params.infoY === 'middle' ? (rect.height - height) / 2 : rect.height - height - 8);
  ctx.fillStyle = plan.error || (lower && average < 5) ? '#831f32' : params.infoBgColor;
  ctx.globalAlpha = 0.91;
  ctx.fillRect(x, y, width, height);
  ctx.globalAlpha = 1;
  ctx.fillStyle = params.infoTextColor;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  rows.forEach((row, i) => ctx.fillText(row, x + pad, y + pad + rowHeight * i, width - pad * 2));
}

function render(ctx, { series, meta }, viewport) {
  if (!meta) return;
  const { params, plan } = meta;
  const rect = viewport.chartRect;
  const from = Math.max(0, Math.floor(viewport.visibleRange.from));
  const to = Math.min(series.length - 1, Math.ceil(viewport.visibleRange.to));
  const body = Math.max(1, viewport.barWidth);
  const stride = body + viewport.barSpacing;
  ctx.save();
  try {
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.clip();
    if (params.zero && viewport.priceRange.min <= 0 && viewport.priceRange.max >= 0) {
      ctx.setLineDash([2, 3]);
      const zero = priceToY(0, viewport);
      segment(ctx, rect.x, zero, rect.x + rect.width, zero, '#808080');
      ctx.setLineDash([]);
    }
    for (let i = from; i <= to; i++) {
      const item = series[i];
      if (!item) continue;
      const { open, high, low, close, totalClose, average } = item;
      const { delta, reset, divergence } = meta.visuals[i];
      const x = barIndexToX(i, viewport);
      if ((reset && params.resetBg) || (divergence && params.divergenceBg)) {
        ctx.globalAlpha = 0.1;
        ctx.fillStyle = reset && params.resetBg ? params.resetBgColor : params.divergenceBgColor;
        ctx.fillRect(x - stride / 2, rect.y, stride, rect.height);
        ctx.globalAlpha = 1;
      }
      const up = delta > 0;
      const color = params.divergenceColor && divergence ? (up ? params.upDivColor : params.downDivColor) : (up ? params.upColor : params.downColor);
      if (totalClose !== undefined) candle(ctx, viewport, x, body, open, Math.max(open, totalClose), Math.min(open, totalClose),
        totalClose, up ? params.upTotalColor : params.downTotalColor, 1 - Number(params.totalOpacity) / 100);
      if (params.candles) candle(ctx, viewport, x, body, open, high, low, close, color);
      const prior = series[i - 1];
      if (params.line && prior) segment(ctx, x - stride, priceToY(prior.close, viewport), x, priceToY(close, viewport), close > 0 ? params.upLineColor : params.downLineColor);
      if (params.average && prior?.average !== undefined && average !== undefined) segment(ctx, x - stride, priceToY(prior.average, viewport),
        x, priceToY(average, viewport), average > 0 ? params.upAverageColor : params.downAverageColor);
      if (plan.trend && reset) {
        ctx.textBaseline = 'top';
        ctx.textAlign = 'center';
        ctx.font = '10px Segoe UI, sans-serif';
        ctx.fillStyle = reset > 0 ? params.upColor : params.downColor;
        ctx.fillText(reset > 0 ? '▲' : '▼', x, rect.y + 3);
      }
    }
    infoBox(ctx, viewport, meta, series.length);
  } finally {
    ctx.restore();
  }
}

export function createCvd(load) {
  let widget;
  let chart;
  let server;
  let seriesId;
  let left;
  let queued = false;
  let hydrationQueued = false;
  const cache = new Map();
  const pending = new Set();
  const identity = ({ symbol, timeframe }) => `${symbol.toUpperCase()}/${timeframe}`;
  const current = () => ({ symbol: widget.getSymbol(), timeframe: widget.getTimeframe() });
  const instances = () => chart?.getActiveIndicators().filter(item => item.id === ID && item.visible) ?? [];

  function scheduleHydrate() {
    if (!chart || hydrationQueued) return;
    hydrationQueued = true;
    requestAnimationFrame(() => {
      hydrationQueued = false;
      hydrate();
    });
  }

  function accept(request, result, missingOnly = false) {
    if (!result.cvd || (widget && identity(request) !== identity(current()))) return;
    if (missingOnly && (server !== result.server || seriesId !== identity(request))) return;
    if (server !== result.server || seriesId !== identity(request)) {
      cache.clear();
      server = result.server;
      seriesId = identity(request);
    }
    for (const [target, feed] of Object.entries(result.cvd)) {
      const source = cache.get(target) ?? { frame: feed.frame, volume: feed.volume, rows: new Map() };
      const samples = new Map(feed.rows.map(row => [row[0], row]));
      for (const { time } of result.bars) {
        if (missingOnly && source.rows.get(time)) continue;
        const sample = samples.get(time);
        // A bounded read has not inspected bars before its coverage boundary.
        // Leave those unknown so history loading can move backwards into them.
        if (sample || !feed.coverage || (time >= feed.coverage.from && time < feed.coverage.to)) {
          source.rows.set(time, sample ?? null);
        }
      }
      cache.set(target, source);
    }
    scheduleHydrate();
  }

  function hydrate() {
    const request = current();
    const key = identity(request);
    if (seriesId !== key) return;
    const data = chart.getData();
    for (const target of new Set(instances().map(item => targetOf(item.params)))) {
      const source = cache.get(target);
      const job = `${key}/${target}`;
      if (!data.some(bar => !source?.rows.has(bar.time)) || pending.has(job)) continue;
      pending.add(job);
      const run = async () => {
        while (true) {
          if (identity(current()) !== key || !instances().some(item => targetOf(item.params) === target)) return;
          const timeline = chart.getData();
          const end = timeline.findLastIndex(bar => !cache.get(target)?.rows.has(bar.time));
          if (end < 0) return;
          const range = timeline.slice(Math.max(0, end + 1 - 600), end + 1);
          const missing = range.filter(bar => !cache.get(target)?.rows.has(bar.time));
          const result = await load({ ...request, before: range.at(-1).time + 1000, countBack: range.length }, [target]);
          accept(request, result, true);
          if (identity(current()) === key) {
            for (const item of instances().filter(item => targetOf(item.params) === target)) chart.updateIndicator(item.instanceId, {});
          }
          // Retry on the next feed update if the broker made no progress.
          if (!missing.some(bar => cache.get(target)?.rows.has(bar.time))) return;
        }
      };
      run().catch(error => {
        if (error.name !== 'AbortError') console.warn('CVD history:', error.message);
      }).finally(() => pending.delete(job));
    }
  }

  return {
    accept,
    targets(request) {
      if (!widget) return [targetOf(defaults)];
      return identity(request) === identity(current()) ? [...new Set(instances().map(item => targetOf(item.params)))] : [];
    },
    attach(owner) {
      widget = owner;
      chart = widget.getChart();
      chart.registerIndicator({
        descriptor: { id: ID, name: 'CVD - Cumulative Volume Delta Candles', shortName: 'CVD Candle', placement: 'panel',
          category: 'volume', defaultConfig: defaults, inputs, scale: { zero: true } },
        calculate(data, config) {
          const params = { ...defaults, ...config.params };
          const request = current();
          const source = seriesId === identity(request) ? cache.get(targetOf(params)) : undefined;
          const visible = chart.getVisibleTimeRange()?.from ?? data[0]?.time;
          return calculateCvd(data, source, request.timeframe, params, visible, chart.isReplayActive());
        },
        render,
      });
      chart.on('indicatorChange', scheduleHydrate);
      chart.on('indicatorAdd', scheduleHydrate);
      chart.on('historyLoad', scheduleHydrate);
      chart.on('visibleRangeChange', () => {
        if (queued) return;
        const next = chart.getVisibleTimeRange()?.from;
        if (next === left) return;
        left = next;
        queued = true;
        requestAnimationFrame(() => {
          queued = false;
          for (const item of instances().filter(item => item.params.reset === modes.visible)) chart.updateIndicator(item.instanceId, {});
        });
      });
      if (!instances().length) chart.addIndicator(ID);
    },
  };
}
