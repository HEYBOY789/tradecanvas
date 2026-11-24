import { withAlpha } from '@tradecanvas/commons';
import { barIndexToX, DrawingBase, priceToYMapper, resolveBarIndex } from '@tradecanvas/core';
import { buildVolumeProfile, candleEnd, groupLowerBars, profileLowerFrame } from './fixed-range-profile-model.js';

const NAME = 'Fixed Range Volume Profile';
const NO_LOWER_BARS = [];
const number = (label, value, min, max) => ({ kind: 'number', label, default: value, min, max, step: 1 });
const toggle = (label, value) => ({ kind: 'boolean', label, default: value });
const choice = (label, value, choices) => ({ kind: 'choice', label, default: value,
  choices: choices.map(([value, label]) => ({ value, label })) });
const color = (label, value) => ({ kind: 'text', label, default: value });
const options = {
  rowMode: choice('Chia hàng theo', 'rows', [['rows', 'Số hàng'], ['ticks', 'Tick mỗi hàng']]),
  rowSize: number('Kích thước hàng', 40, 1, 5000),
  volumeMode: choice('Hiển thị volume', 'total', [['total', 'Tổng'], ['split', 'Tăng / Giảm'], ['delta', 'Delta']]),
  valueArea: number('Value Area (%)', 70, 1, 100),
  source: choice('Khung tính', 'auto', [['auto', 'Tự động dùng khung nhỏ hơn'], ['chart', 'Khung biểu đồ']]),
  extendToLive: toggle('Kéo dài sang phải theo nến mới', false),
  showProfile: toggle('Hiện histogram', true),
  showValues: toggle('Hiện số volume trên hàng', false),
  profileSide: choice('Vị trí histogram', 'left', [['left', 'Trái'], ['right', 'Phải']]),
  profileWidth: number('Độ rộng histogram (%)', 33, 1, 100),
  shadeBox: toggle('Tô nền vùng đã chọn', false),
  showPoc: toggle('Hiện POC', true),
  showVah: toggle('Hiện VAH', true),
  showVal: toggle('Hiện VAL', true),
  showDevelopingPoc: toggle('Hiện POC theo từng nến', false),
  showDevelopingVa: toggle('Hiện VAH và VAL theo từng nến', false),
  upColor: color('Màu volume tăng / tổng', '#4f91df'),
  downColor: color('Màu volume giảm', '#e2706b'),
  vaUpColor: color('Màu volume tăng / tổng trong VA', '#38b8c8'),
  vaDownColor: color('Màu volume giảm trong VA', '#ef6461'),
  profileOpacity: number('Độ đậm histogram ngoài VA (%)', 35, 0, 100),
  vaOpacity: number('Độ đậm histogram trong VA (%)', 65, 0, 100),
  pocColor: color('Màu POC', '#f2a93b'),
  vahColor: color('Màu VAH', '#4aae8a'),
  valColor: color('Màu VAL', '#d68b9a'),
  valueColor: color('Màu số volume', '#e3e8f2'),
};
const hexColor = /^#[0-9a-f]{6}$/i;
const volumeText = new Intl.NumberFormat('vi-VN', { notation: 'compact', maximumFractionDigits: 1 });
const MAX_CACHED_RANGES = 24;

class FixedRangeProfile extends DrawingBase {
  descriptor = { type: 'volumeProfileRange', name: NAME, requiredAnchors: 2, fill: true, priceOnly: true, options };
  cache = new Map();
  history = new Map();

  constructor(widget, config, load) {
    super();
    this.widget = widget;
    this.chart = widget.getChart();
    this.frames = config.frames;
    this.server = config.server;
    this.load = load;
  }

  setDataGetter(getter, revision) {
    this.data = getter;
    this.revision = revision;
  }

  colors(state, key) {
    const value = this.option(state, key);
    return hexColor.test(value) ? value : options[key].default;
  }

  stopHistory(id) {
    const pending = this.history.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.controller.abort();
    this.history.delete(id);
  }

  lowerBars(id, bars, start, end, frame, info) {
    // The feed supplies the newest candle every second. Only fetch the sealed
    // part of the range, so lower candles never count the open candle twice.
    const closed = Math.min(end, bars.length - 2);
    if (closed < start) return NO_LOWER_BARS;
    const from = bars[start].time;
    const to = Math.min(candleEnd(bars[closed].time, frame), bars[closed + 1]?.time ?? Infinity);
    const lower = profileLowerFrame(frame, to - from, this.frames);
    if (!lower || to <= from) return NO_LOWER_BARS;
    const series = String(info.exchange || this.server) + '|' + this.widget.getSymbol() + '|' + lower;
    const previous = this.history.get(id);
    if (previous?.series === series && previous.from === from && previous.to === to &&
        (!previous.retryAt || Date.now() < previous.retryAt)) {
      return previous.bars;
    }
    const canExtend = previous?.series === series && previous.from === from && previous.to < to && previous.complete;
    const current = { series, from, to, controller: new AbortController(), bars: canExtend ? previous.bars : NO_LOWER_BARS,
      complete: false };
    this.stopHistory(id);
    if (this.history.size >= MAX_CACHED_RANGES) return NO_LOWER_BARS;
    this.history.set(id, current);
    const query = new URLSearchParams({ symbol: info.symbol || this.widget.getSymbol(), frame: lower,
      from: canExtend ? previous.to : from, to });
    current.timer = setTimeout(async () => {
      if (!this.chart.getDrawings().some(drawing => drawing.id === id)) {
        this.stopHistory(id);
        return;
      }
      try {
        const result = await this.load('/api/profile-bars?' + query, current.controller.signal);
        if (current.controller.signal.aborted) return;
        if (result.server !== (info.exchange || this.server)) {
          current.retryAt = Date.now() + 60_000;
          return;
        }
        current.bars = current.bars.concat(result.bars);
        current.complete = true;
        this.chart.requestRender();
      } catch {
        // The chart candles still cover the range when MT5 cannot supply that history.
        current.retryAt = Date.now() + 60_000;
      }
    }, 180);
    return current.bars;
  }

  profile(state, viewport) {
    const data = this.data?.();
    if (!data?.length || state.anchors.length < 2) return null;
    const onSeries = { ...viewport, data };
    const indexes = state.anchors.map(anchor => Math.floor(resolveBarIndex(anchor.time, onSeries)));
    const oldest = Math.min(...indexes), newest = Math.max(...indexes);
    const start = Math.max(0, oldest);
    const end = Math.min(data.length - 1, this.option(state, 'extendToLive') ? data.length - 1 : newest);
    if (start > end) return null;

    const info = this.chart.getSymbolInfo() ?? {};
    const minTick = info.minTick > 0 ? info.minTick : 10 ** -(info.pricePrecision ?? 2);
    const frame = this.widget.getTimeframe();
    const auto = this.option(state, 'source') === 'auto' && !this.chart.isReplayActive();
    if (!auto) this.stopHistory(state.id);
    const lower = auto ? this.lowerBars(state.id, data, start, end, frame, info) : NO_LOWER_BARS;
    const input = {
      rowMode: this.option(state, 'rowMode'), rowSize: this.option(state, 'rowSize'),
      valueArea: this.option(state, 'valueArea'),
      develop: this.option(state, 'showDevelopingPoc') || this.option(state, 'showDevelopingVa'),
    };
    const key = [start, end, minTick, frame, input.rowMode, input.rowSize, input.valueArea, input.develop].join('|');
    const revision = this.revision();
    const cached = this.cache.get(state.id);
    let profile = cached?.profile;
    if (!cached || cached.key !== key || cached.data !== data || cached.lower !== lower || cached.revision !== revision) {
      const bars = data.slice(start, end + 1);
      profile = buildVolumeProfile(bars, groupLowerBars(bars, lower, frame), minTick, input);
      if (this.cache.size >= MAX_CACHED_RANGES && !this.cache.has(state.id)) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(state.id, { key, data, lower, revision, profile });
    }
    if (!profile) return null;

    const y = priceToYMapper(viewport);
    const x = index => barIndexToX(viewport.data !== data && data[index]
      ? resolveBarIndex(data[index].time, viewport) : index, viewport);
    const a = y(profile.high), b = y(profile.low);
    const band = viewport.barWidth / 2;
    return { ...profile, x, y, indexes, start, left: x(start) - band, right: x(end) + band,
      top: Math.min(a, b), bottom: Math.max(a, b) };
  }

  handlePoints(state, viewport) {
    const p = this.profile(state, viewport);
    return p ? [{ x: p.x(p.indexes[0]), y: p.top }, { x: p.x(p.indexes[1]), y: p.bottom }]
      : super.handlePoints(state, viewport);
  }

  hitTest(point, state, viewport, tolerance) {
    const p = this.profile(state, viewport);
    return p !== null && point.x >= p.left - tolerance && point.x <= p.right + tolerance
      && point.y >= p.top - tolerance && point.y <= p.bottom + tolerance;
  }

  renderHistogram(ctx, state, p) {
    const mode = this.option(state, 'volumeMode');
    const right = this.option(state, 'profileSide') === 'right';
    const width = (p.right - p.left) * this.option(state, 'profileWidth') / 100;
    const scale = width / (mode === 'delta' ? p.maxDelta : p.maxVolume);
    if (!Number.isFinite(scale)) return;
    const upColor = this.colors(state, 'upColor');
    const downColor = this.colors(state, 'downColor');
    const vaUpColor = this.colors(state, 'vaUpColor');
    const vaDownColor = this.colors(state, 'vaDownColor');
    const textColor = this.colors(state, 'valueColor');
    const values = this.option(state, 'showValues');
    const opacity = this.option(state, 'profileOpacity') / 100;
    const vaOpacity = this.option(state, 'vaOpacity') / 100;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < p.count; i++) {
      const up = p.up[i], down = p.down[i];
      const delta = up - down;
      const size = (mode === 'delta' ? Math.abs(delta) : p.total[i]) * scale;
      if (size <= 0) continue;
      const inArea = i >= p.valueLow && i <= p.valueHigh;
      const a = p.y(p.edge(i)), b = p.y(p.edge(i + 1));
      const rowHeight = Math.abs(a - b);
      const top = Math.min(a, b);
      const height = Math.max(0.65, rowHeight - 0.5);
      const left = right ? p.right - size : p.left;
      const positive = mode !== 'delta' || delta >= 0;
      const primary = positive ? (inArea ? vaUpColor : upColor) : (inArea ? vaDownColor : downColor);
      const first = mode === 'split' ? up * scale : size;
      ctx.globalAlpha = inArea ? vaOpacity : opacity;
      ctx.fillStyle = primary;
      if (first > 0) ctx.fillRect(left, top, first, height);
      if (mode === 'split' && down > 0) {
        ctx.fillStyle = inArea ? vaDownColor : downColor;
        ctx.fillRect(left + first, top, down * scale, height);
      }
      if (values && rowHeight >= 12 && size > 16) {
        const text = mode === 'split' ? volumeText.format(up) + ' / ' + volumeText.format(down)
          : volumeText.format(mode === 'delta' ? delta : p.total[i]);
        if (ctx.measureText(text).width + 4 <= size) {
          ctx.globalAlpha = 1;
          ctx.fillStyle = textColor;
          ctx.fillText(text, left + size / 2, top + rowHeight / 2);
        }
      }
    }
  }

  renderDeveloping(ctx, p, field, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    let previous = false;
    for (let i = 0; i < p.developing.length; i++) {
      const levels = p.developing[i];
      if (!levels) { previous = false; continue; }
      const x = p.x(p.start + i), y = p.y(levels[field]);
      if (previous) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      previous = true;
    }
    ctx.stroke();
  }

  renderLevel(ctx, viewport, state, p, title, price, color) {
    const y = p.y(price);
    ctx.strokeStyle = color;
    ctx.lineWidth = state.style.lineWidth;
    ctx.setLineDash(state.style.lineStyle === 'dotted' ? [1, 3] : state.style.lineStyle === 'dashed' ? [5, 4] : []);
    this.strokeHorizontal(ctx, p.left, p.right, y);
    ctx.fillStyle = color;
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const text = title + ' ' + this.chart.formatPrice(price);
    const x = Math.max(viewport.chartRect.x + 2, Math.min(p.right + 4,
      viewport.chartRect.x + viewport.chartRect.width - ctx.measureText(text).width - 4));
    ctx.fillText(text, x, y - 2);
  }

  render(ctx, state, viewport, selected) {
    const p = this.profile(state, viewport);
    if (!p || p.right < viewport.chartRect.x || p.left > viewport.chartRect.x + viewport.chartRect.width) return;
    const width = p.right - p.left;
    const height = Math.max(1, p.bottom - p.top);
    const poc = this.colors(state, 'pocColor');
    const vah = this.colors(state, 'vahColor');
    const val = this.colors(state, 'valColor');
    ctx.save();
    if (this.option(state, 'shadeBox')) {
      ctx.fillStyle = withAlpha(state.style.fillColor || state.style.color, state.style.fillOpacity ?? .12);
      ctx.fillRect(p.left, p.top, width, height);
    }
    if (this.option(state, 'showProfile')) this.renderHistogram(ctx, state, p);
    this.applyGuideStyle(ctx, state.style.color);
    this.strokeCrispRect(ctx, p.left, p.top, width, height);
    ctx.globalAlpha = 1;
    if (this.option(state, 'showDevelopingPoc')) this.renderDeveloping(ctx, p, 'pocPrice', poc);
    if (this.option(state, 'showDevelopingVa')) {
      this.renderDeveloping(ctx, p, 'vah', vah);
      this.renderDeveloping(ctx, p, 'val', val);
    }
    if (this.option(state, 'showPoc')) this.renderLevel(ctx, viewport, state, p, 'POC', p.pocPrice, poc);
    if (this.option(state, 'showVah')) this.renderLevel(ctx, viewport, state, p, 'VAH', p.vah, vah);
    if (this.option(state, 'showVal')) this.renderLevel(ctx, viewport, state, p, 'VAL', p.val, val);
    ctx.restore();
    if (selected) this.renderAnchorHandles(ctx, state, viewport);
  }
}

export function installFixedRangeProfile(widget, config, load) {
  const tool = new FixedRangeProfile(widget, config, load);
  const chart = widget.getChart();
  chart.registerDrawingTool(tool);
  const remove = ({ payload: { id } }) => {
    tool.stopHistory(id);
    tool.cache.delete(id);
  };
  chart.on('drawingRemove', remove);
  return () => {
    chart.off('drawingRemove', remove);
    for (const id of tool.history.keys()) tool.stopHistory(id);
  };
}

// Drawing options store colours as strings. Keep the widget's change and
// template handlers by giving only these fields a native colour picker.
export function installFixedRangeColorFields() {
  const colors = new Map(Object.values(options).filter(option => option.kind === 'text').map(option => [option.label, option.default]));
  const selector = '.tcw-drawing-settings input[type="text"]';
  const update = () => {
    for (const input of document.querySelectorAll(selector)) {
      const fallback = colors.get(input.closest('label')?.querySelector('.tcw-settings-label')?.textContent);
      if (!fallback) continue;
      const value = hexColor.test(input.value) ? input.value : fallback;
      input.type = 'color';
      input.value = value;
      input.classList.add('mt5-profile-color');
    }
  };
  const observer = new MutationObserver(changes => {
    if (changes.some(change => Array.from(change.addedNodes).some(node => node.nodeType === 1 &&
      (node.matches(selector) || node.querySelector(selector))))) update();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
