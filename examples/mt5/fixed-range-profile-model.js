const MINUTE = 60_000;
const FRAME_MINUTES = { m: 1, h: 60, d: 1440, w: 10080, M: 44640 };
const LOWER_FRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d'];
const MAX_ROWS = 5000;
const MAX_PROFILE_BARS = 5000;

function frameMs(frame) {
  const match = /^(\d+)([mhdwM])$/.exec(frame);
  return match ? Number(match[1]) * FRAME_MINUTES[match[2]] * MINUTE : 0;
}

export function candleEnd(time, frame) {
  if (frame === '1M') {
    const date = new Date(time);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  }
  return time + frameMs(frame);
}

export function profileLowerFrame(frame, duration, available) {
  const chartMs = frameMs(frame);
  return LOWER_FRAMES.find(candidate => {
    const step = frameMs(candidate);
    const aligned = chartMs >= FRAME_MINUTES.d * MINUTE || chartMs % step === 0;
    return available.includes(candidate) && aligned && step < chartMs && Math.ceil(duration / step) < MAX_PROFILE_BARS;
  });
}

export function groupLowerBars(bars, lower, frame) {
  const groups = new Map();
  let index = 0;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const end = Math.min(candleEnd(bar.time, frame), bars[i + 1]?.time ?? Infinity);
    while (index < lower.length && lower[index].time < bar.time) index++;
    let subtotal = 0;
    const start = index;
    while (index < lower.length && lower[index].time < end) subtotal += lower[index++].volume;
    // Falling back for any missing minutes avoids understating volume or counting it twice.
    if (subtotal > 0 && subtotal === bar.volume) groups.set(bar.time, lower.slice(start, index));
  }
  return groups;
}

export function valueAreaOf(rows, percent) {
  let poc = 0;
  let total = 0;
  for (let i = 0; i < rows.length; i++) {
    total += rows[i];
    if (rows[i] > rows[poc]) poc = i;
  }
  const target = total * (percent / 100);
  const tolerance = total * 1e-12;
  let valueLow = poc, valueHigh = poc, held = rows[poc];
  while (held + tolerance < target && (valueLow > 0 || valueHigh + 1 < rows.length)) {
    const below = valueLow > 0 ? rows[valueLow - 1] : -Infinity;
    const above = valueHigh + 1 < rows.length ? rows[valueHigh + 1] : -Infinity;
    const chooseAbove = above > below || (above === below && valueHigh - poc <= poc - valueLow);
    const next = chooseAbove ? above : below;
    if (held + next > target + tolerance) break;
    held += next;
    if (chooseAbove) valueHigh++;
    else valueLow--;
  }
  return { poc, valueLow, valueHigh };
}

function rowGrid(bars, minTick, options) {
  let low = Infinity, high = -Infinity;
  for (const bar of bars) {
    low = Math.min(low, bar.low);
    high = Math.max(high, bar.high);
  }
  if (!Number.isFinite(low) || !Number.isFinite(high) || high < low) return null;
  const base = Math.floor(low / minTick + 1e-6);
  const span = Math.max(1, Math.ceil(high / minTick - 1e-6) - base);
  const size = Math.max(1, Math.round(options.rowSize ?? 40));
  let ticksPerRow = size;
  if (options.rowMode !== 'ticks') {
    const smaller = Math.max(1, Math.floor(span / size));
    const larger = Math.ceil(span / size);
    const deviation = ticks => Math.abs(Math.ceil(span / ticks) - size);
    ticksPerRow = deviation(smaller) <= deviation(larger) ? smaller : larger;
  }
  ticksPerRow = Math.max(ticksPerRow, Math.ceil(span / MAX_ROWS));
  const count = low === high ? 1 : Math.ceil(span / ticksPerRow);
  const edge = row => low === high ? low : (base + Math.min(row * ticksPerRow, span)) * minTick;
  return { count, ticksPerRow, edge, low, high, base, minTick };
}

// Keep a separate difference array for the rows entirely inside a candle.
// Only its two edge rows need individual work when it spans many price rows.
function addVolume(bar, grid, sums, fullRows) {
  if (!(bar.volume > 0)) return;
  const { count, ticksPerRow, edge, base, minTick } = grid;
  const relativeTicks = price => price / minTick - base;
  const first = Math.min(count - 1, Math.max(0, Math.floor((relativeTicks(bar.low) + 1e-6) / ticksPerRow)));
  const last = Math.min(count - 1, Math.max(first, Math.ceil((relativeTicks(bar.high) - 1e-6) / ticksPerRow) - 1));
  if (first === last) {
    sums[first] += bar.volume;
    return;
  }
  const density = bar.volume / (bar.high - bar.low);
  sums[first] += Math.max(0, edge(first + 1) - bar.low) * density;
  sums[last] += Math.max(0, bar.high - edge(last)) * density;
  const full = ticksPerRow * minTick * density;
  fullRows[first + 1] += full;
  fullRows[last] -= full;
}

export function buildVolumeProfile(bars, lowerByBar, minTick, options) {
  const grid = rowGrid(bars, minTick, options);
  if (!grid) return null;
  const { count, edge } = grid;
  const sums = [new Float64Array(count), new Float64Array(count)];
  const fullRows = [new Float64Array(count), new Float64Array(count)];
  const up = new Float64Array(count), down = new Float64Array(count), total = new Float64Array(count);
  const developing = options.develop ? [] : null;
  const percent = options.valueArea ?? 70;
  const levelsOf = ({ poc, valueLow, valueHigh }) => ({
    pocPrice: (edge(poc) + edge(poc + 1)) / 2,
    val: edge(valueLow),
    vah: edge(valueHigh + 1),
  });
  function updateRows() {
    let upFill = 0, downFill = 0;
    for (let i = 0; i < count; i++) {
      upFill += fullRows[0][i];
      downFill += fullRows[1][i];
      up[i] = Math.max(0, sums[0][i] + upFill);
      down[i] = Math.max(0, sums[1][i] + downFill);
      total[i] = up[i] + down[i];
    }
    return valueAreaOf(total, percent);
  }
  let levels;
  for (const chartBar of bars) {
    const source = lowerByBar.get(chartBar.time) ?? [chartBar];
    const single = bars.length === 1 && source.length === 1;
    for (const bar of source) {
      const positive = single ? bar.close > bar.open : bar.close >= bar.open;
      const side = positive ? 0 : 1;
      addVolume(bar, grid, sums[side], fullRows[side]);
    }
    if (developing) {
      levels = updateRows();
      developing.push(total[levels.poc] > 0 ? levelsOf(levels) : null);
    }
  }
  levels ??= updateRows();
  const maxVolume = total[levels.poc];
  if (!(maxVolume > 0)) return null;
  let maxDelta = 0;
  for (let i = 0; i < count; i++) maxDelta = Math.max(maxDelta, Math.abs(up[i] - down[i]));
  return { ...grid, ...levels, ...levelsOf(levels), up, down, total, maxVolume, maxDelta, developing };
}
