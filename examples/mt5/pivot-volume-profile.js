// SPDX-License-Identifier: MPL-2.0
// Adapted from Volume Profile, Pivot Anchored by DGT, © dgtrd (TradingView).
import { withAlpha } from '@tradecanvas/commons';
import { barIndexToX, CandlestickRenderer, getNumberParam, priceToYMapper } from '@tradecanvas/core';
import { newProfileOutput, pocBreached, updateProfiles } from './pivot-volume-profile-model.js';

const ID = 'pivot-volume-profile-dgt';
const NAME = 'Volume Profile, Pivot Anchored by DGT';
const CANDLE_COLORS = ['#4caf50', '#f23645', '#006400', '#910000', '#7fffd4', '#ff9800'];
const LABEL_SIZE = { tiny: 9, small: 11, normal: 13 };
const compactVolume = new Intl.NumberFormat('vi-VN', { notation: 'compact', maximumFractionDigits: 2 });
const numberText = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 });

const defaults = {
  pivotLength: 20, showProfile: true, inAreaColor: '#fbc02d', outsideAreaColor: '#434651', valueArea: 68,
  showPoc: true, pocColor: '#ff0000', extendPoc: 'none', showVah: true, vahColor: '#2962ff', showVal: true, valColor: '#2962ff',
  shadeArea: true, areaColor: '#2962ff', labelMode: 'pivot', labelSize: 'small',
  labelPrice: true, labelChange: true, labelVolume: true, highLabelColor: '#d4a5a5', lowLabelColor: '#8faadc', labelTextColor: '#ffffff',
  rows: 25, side: 'left', width: 30, shadeRange: true, rangeColor: '#2962ff',
  weightedCandles: true, volumeLength: 89, highThreshold: 1.618, lowThreshold: .618,
};
const toggle = label => ({ kind: 'boolean', label });
const color = label => ({ kind: 'color', label });
const integer = (label, min, max) => ({ kind: 'int', label, min, max });
const numeric = (label, min, max) => ({ kind: 'number', label, min, max, step: .1 });
const choice = (label, entries) => ({ kind: 'choice', label, options: entries.map(([value, label]) => ({ value, label })) });
const inputs = {
  pivotLength: integer('Số nến xác nhận mỗi phía pivot', 1, 2500),
  showProfile: toggle('Hiện thanh Volume Profile'), inAreaColor: color('Màu thanh trong Value Area'), outsideAreaColor: color('Màu thanh ngoài Value Area'),
  valueArea: numeric('Tỷ lệ Value Area (%)', 0, 100), showPoc: toggle('Hiện POC'), pocColor: color('Màu POC'),
  extendPoc: choice('Kéo dài POC', [['none', 'Không'], ['last', 'Đến nến cuối'], ['cross', 'Đến khi giá đóng cắt qua'], ['touch', 'Đến khi nến chạm']]),
  showVah: toggle('Hiện VAH'), vahColor: color('Màu VAH'), showVal: toggle('Hiện VAL'), valColor: color('Màu VAL'),
  shadeArea: toggle('Tô nền Value Area'), areaColor: color('Màu nền Value Area'),
  labelMode: choice('Nhãn mức giá', [['pivot', 'Pivot cao / thấp'], ['range', 'Đỉnh / đáy Profile'], ['area', 'VAH / VAL']]),
  labelSize: choice('Cỡ nhãn', [['tiny', 'Rất nhỏ'], ['small', 'Nhỏ'], ['normal', 'Vừa']]),
  labelPrice: toggle('Giá trên nhãn'), labelChange: toggle('Phần trăm thay đổi trên nhãn'), labelVolume: toggle('Volume lũy kế trên nhãn'),
  highLabelColor: color('Nền nhãn trên'), lowLabelColor: color('Nền nhãn dưới'), labelTextColor: color('Màu chữ nhãn'),
  rows: integer('Số hàng giá', 10, 100), side: choice('Vị trí thanh', [['left', 'Trái'], ['right', 'Phải']]), width: integer('Chiều rộng Profile (%)', 0, 100),
  shadeRange: toggle('Tô nền toàn vùng Profile'), rangeColor: color('Màu nền vùng Profile'),
  weightedCandles: toggle('Đổi màu nến theo volume'), volumeLength: integer('Chu kỳ SMA volume', 1, 5000),
  highThreshold: numeric('Ngưỡng volume cao × SMA', 1), lowThreshold: numeric('Ngưỡng volume thấp × SMA', .1),
};

function readSettings(config) {
  const settings = { ...defaults };
  for (const [key, input] of Object.entries(inputs)) {
    const raw = config.params[key];
    const { kind, min, max, options } = input;
    if (kind === 'int' || kind === 'number') {
      const value = getNumberParam(config, key, defaults[key]);
      settings[key] = Math.max(min, Math.min(max ?? Infinity, kind === 'int' ? Math.round(value) : value));
    } else if ((kind === 'boolean' && typeof raw === 'boolean') ||
      (kind === 'choice' && options.some(option => option.value === raw)) ||
      (kind === 'color' && typeof raw === 'string' && /^#[0-9a-f]{6}$/i.test(raw))) settings[key] = raw;
  }
  settings.valueArea /= 100;
  return settings;
}

function paintProfile(ctx, profile, geometry, settings, extendTo) {
  const { toX, toY, rect } = geometry;
  const { start, end, low, high, vah, val, poc, bins, lower, upper, step, peak } = profile;
  const left = toX(start), right = toX(end), plotRight = rect.x + rect.width;
  const inView = right >= rect.x && left <= plotRight;
  const band = (x, stop, lower, upper, fill) => {
    const a = toY(lower), b = toY(upper);
    ctx.fillStyle = fill;
    ctx.fillRect(x, Math.min(a, b), stop - x, Math.abs(a - b));
  };
  const line = (price, stop, color) => {
    const y = toY(price);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(stop, y); ctx.stroke();
  };
  if (inView) {
    if (settings.shadeRange) band(left, right, low, high, withAlpha(settings.rangeColor, .05));
    if (settings.shadeArea) band(left, right, val, vah, withAlpha(settings.areaColor, .11));
    if (settings.showProfile) {
      const colorInside = withAlpha(settings.inAreaColor, .65), colorOutside = withAlpha(settings.outsideAreaColor, .65);
      const maxBars = (end - start) * settings.width / 100;
      for (let row = 0; row < bins.length; row++) {
        const width = Math.floor(maxBars * bins[row] / peak);
        if (width <= 0) continue;
        const x1 = settings.side === 'right' ? toX(end - width) : left;
        const x2 = settings.side === 'right' ? right : toX(start + width);
        band(x1, x2, low + (row + .1) * step, low + (row + .9) * step, row >= lower && row <= upper ? colorInside : colorOutside);
      }
    }
    if (settings.showVah) line(vah, right, settings.vahColor);
    if (settings.showVal) line(val, right, settings.valColor);
  }
  if (!settings.showPoc || left > plotRight) return;
  const pocEnd = toX(extendTo);
  if (pocEnd < rect.x) return;
  const a = toY(poc - .1 * step), b = toY(poc + .1 * step);
  ctx.fillStyle = settings.pocColor;
  ctx.fillRect(left, Math.min(a, b), pocEnd - left, Math.max(1, Math.abs(a - b)));
}

function percentChange(profile, upper) {
  if (profile.pivot) {
    if (upper && profile.pivot.high !== null && profile.lastLow > 0) return (profile.pivot.high / profile.lastLow - 1) * 100;
    if (!upper && profile.pivot.low !== null && profile.lastHigh > 0) return (1 - profile.pivot.low / profile.lastHigh) * 100;
  } else if (profile.lastPivot) {
    if (upper && profile.lastPivot.low !== null && profile.lastLow > 0) return (profile.currentPrice / profile.lastLow - 1) * 100;
    if (!upper && profile.lastPivot.high !== null && profile.lastHigh > 0) return (1 - profile.currentPrice / profile.lastHigh) * 100;
  }
  return null;
}

function paintLabels(ctx, profile, { toX, toY, rect }, settings, chart, hitBoxes) {
  const pivotMode = settings.labelMode === 'pivot', areaMode = settings.labelMode === 'area';
  if (pivotMode && !profile.pivot) return;
  const x = toX(pivotMode ? profile.end : (profile.start + profile.end) / 2);
  if (x < rect.x || x > rect.x + rect.width) return;
  for (const upper of [true, false]) {
    const price = pivotMode ? (upper ? profile.pivot.high : profile.pivot.low)
      : areaMode ? (upper ? profile.vah : profile.val) : (upper ? profile.high : profile.low);
    if (price === null) continue;
    const y = toY(price);
    if (y < rect.y || y > rect.y + rect.height) continue;
    const color = upper ? settings.highLabelColor : settings.lowLabelColor;
    const change = percentChange(profile, upper);
    const lines = [], headline = [];
    if (settings.labelPrice) headline.push(chart.formatPrice(price));
    if (settings.labelChange && change !== null) headline.push(`${upper ? '↑' : '↓'} ${numberText.format(change)}%`);
    if (headline.length) lines.push(headline.join(' '));
    const focusedPivot = profile.pivot ?? profile.lastPivot;
    const highStats = profile.pivot ? upper : !upper;
    const hasStats = highStats ? focusedPivot.high !== null : focusedPivot.low !== null;
    if (settings.labelVolume && hasStats) lines.push(compactVolume.format(profile.volume));
    if (!lines.length && !pivotMode) continue;
    const size = LABEL_SIZE[settings.labelSize], lineHeight = size + 2;
    const width = lines.length ? Math.max(...lines.map(line => ctx.measureText(line).width)) + 10 : lineHeight;
    const height = Math.max(1, lines.length) * lineHeight + 4;
    const left = x - width / 2, top = upper ? y - height - 4 : y + 4;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 4, upper ? y - 5 : y + 5);
    ctx.lineTo(x + 4, upper ? y - 5 : y + 5); ctx.fill();
    if (lines.length) {
      ctx.fillRect(left, top, width, height);
      ctx.fillStyle = settings.labelTextColor;
      lines.forEach((line, i) => ctx.fillText(line, x, top + 2 + (i + .5) * lineHeight));
    }
    hitBoxes.push({ left, top, width, height, profile });
  }
}

function paintCandles(ctx, viewport, theme, renderer, meta) {
  let from = Math.max(0, viewport.visibleRange.from);
  const to = Math.min(viewport.visibleRange.to, meta.data.length - 1);
  for (let i = from + 1; i <= to + 1; i++) {
    const tone = meta.tones[from];
    if (i <= to && meta.tones[i] === tone) continue;
    if (tone >= 0) {
      const tint = CANDLE_COLORS[tone];
      renderer.render(ctx, meta.data, { ...viewport, visibleRange: { from, to: i - 1 } },
        { ...theme, candleUp: tint, candleDown: tint, candleUpWick: tint, candleDownWick: tint });
    }
    from = i;
  }
}

function tooltipText(chart, profile) {
  const price = value => chart.formatPrice(value);
  const candles = profile.end - profile.start;
  const areaWidth = (profile.vah - profile.val) / (profile.high - profile.low) * 100;
  return [
    `Tick volume: ${compactVolume.format(profile.volume)} · ${candles} nến`,
    `TB mỗi nến: ${compactVolume.format(profile.volume / candles)}`,
    `Đỉnh: ${price(profile.high)} · Đáy: ${price(profile.low)}`,
    `POC: ${price(profile.poc)}`,
    `VAH: ${price(profile.vah)} · VAL: ${price(profile.val)}`,
    `Độ rộng Value Area: ${numberText.format(areaWidth)}%`,
  ].join('\n');
}

export function installPivotVolumeProfile(widget) {
  const chart = widget.getChart(), host = widget.chartContainer;
  const candleRenderer = new CandlestickRenderer(), shapes = new Map();
  let tooltip;
  const hide = () => { if (tooltip) tooltip.hidden = true; };
  const move = event => {
    if (event.buttons || !shapes.size) return hide();
    const bounds = host.getBoundingClientRect(), x = event.clientX - bounds.left, y = event.clientY - bounds.top;
    const instances = chart.getActiveIndicators().filter(item => item.id === ID && item.shown);
    const hit = instances.flatMap(item => shapes.get(item.instanceId) ?? []).findLast(box =>
      x >= box.left && x <= box.left + box.width && y >= box.top && y <= box.top + box.height);
    if (!hit) return hide();
    if (!tooltip) {
      tooltip = document.createElement('div'); tooltip.className = 'mt5-pivot-profile-tooltip';
      tooltip.setAttribute('role', 'tooltip'); host.append(tooltip);
    }
    tooltip.textContent = tooltipText(chart, hit.profile);
    tooltip.hidden = false;
    tooltip.style.left = `${Math.max(0, Math.min(x + 10, bounds.width - tooltip.offsetWidth - 2))}px`;
    tooltip.style.top = `${Math.max(0, Math.min(y + 10, bounds.height - tooltip.offsetHeight - 2))}px`;
  };

  chart.registerIndicator({
    descriptor: { id: ID, name: NAME, shortName: 'Pivot VP · DGT', placement: 'overlay', category: 'volume', defaultConfig: defaults,
      plots: [], inputs, readsExchangeTimeZone: false },
    calculate(data, config) {
      const output = newProfileOutput();
      output.meta.instanceId = config.instanceId;
      output.meta.pane = config.pane;
      return updateProfiles(data, readSettings(config), output);
    },
    update(data, config, output, from) {
      if (!output.meta || from <= output.meta.lastClosed || data.length < output.series.length) return null;
      output.meta.pane = config.pane;
      return updateProfiles(data, output.meta.settings, output);
    },
    render(ctx, output, viewport, style, { theme }) {
      const meta = output.meta, settings = meta.settings;
      const geometry = { rect: viewport.chartRect, toX: i => barIndexToX(i, viewport), toY: priceToYMapper(viewport) };
      const all = meta.developing ? [...meta.profiles, meta.developing] : meta.profiles;
      const last = meta.data.length - 1, hitBoxes = [];
      shapes.set(meta.instanceId, hitBoxes);
      ctx.save();
      const { x, y, width, height } = geometry.rect;
      ctx.beginPath(); ctx.rect(x, y, width, height); ctx.clip();
      ctx.globalAlpha *= style.opacity ?? 1;
      for (const profile of all) {
        const formingExtends = profile.pocEnd === meta.lastClosed && last > 0 &&
          (settings.extendPoc === 'cross' || settings.extendPoc === 'touch') && !pocBreached(meta.data, last, profile.poc, settings.extendPoc);
        paintProfile(ctx, profile, geometry, settings, settings.extendPoc === 'last' || formingExtends ? last : profile.pocEnd);
      }
      if (settings.weightedCandles && !meta.pane && chart.getChartType() === 'candlestick') paintCandles(ctx, viewport, theme, candleRenderer, meta);
      ctx.font = `${LABEL_SIZE[settings.labelSize]}px ${theme.font.family}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const profile of all) paintLabels(ctx, profile, geometry, settings, chart, hitBoxes);
      ctx.restore();
    },
  });
  const remove = ({ payload }) => { shapes.delete(payload.instanceId); hide(); };
  host.addEventListener('pointermove', move);
  host.addEventListener('pointerleave', hide);
  chart.on('indicatorRemove', remove);
  return () => {
    host.removeEventListener('pointermove', move);
    host.removeEventListener('pointerleave', hide);
    chart.off('indicatorRemove', remove);
    shapes.clear();
    tooltip?.remove();
  };
}

const ALERTS = [['poc', 'Giá cắt POC'], ['vah', 'Giá cắt VAH'], ['val', 'Giá cắt VAL'], ['highVolume', 'Volume cao']];

export function pivotVolumeAlertItems(widget, { indicatorId, instanceId }) {
  if (indicatorId !== ID || !widget) return [];
  const chart = widget.getChart();
  if (!chart.getFeatures().alerts) return [];
  return ALERTS.map(([field, label]) => {
    const source = `${instanceId}:${field}`, highVolume = field === 'highVolume';
    const channel = highVolume ? source : 'price', target = highVolume ? undefined : source;
    const text = `${NAME} · ${label}`;
    const existing = chart.getAlerts().find(alert => alert.channel === channel && alert.target === target && alert.message === text);
    return { label: `Cảnh báo ${label}`, icon: 'bell', checked: Boolean(existing), onSelect() {
      if (existing) chart.removeAlert(existing.id);
      else if (chart.addAlert(highVolume ? .5 : 0, highVolume ? 'greaterThan' : 'crossing', text, channel, label,
        { onBarClose: true, ...(target && { target }) })) widget.toast(`Đã tạo cảnh báo ${label}`);
    } };
  });
}
