// SPDX-License-Identifier: MPL-2.0
// Adapted from Volume Profile, Pivot Anchored by DGT, © dgtrd (TradingView).

export function buildProfile(data, start, end, rows, share) {
  if (end <= start) return null;
  let low = Infinity, high = -Infinity, volume = 0;
  for (let i = start; i <= end; i++) {
    low = Math.min(low, data[i].low);
    high = Math.max(high, data[i].high);
    if (i < end) volume += data[i].volume || 0;
  }
  const step = (high - low) / rows;
  if (!(step > 0) || !(volume > 0)) return null;

  // Both pivot candles define the price bounds. Volume belongs to [start, end),
  // so a closing pivot's volume is counted in the next profile only.
  const changes = new Float64Array(rows + 1);
  const rowOf = price => Math.min(rows - 1, Math.max(0, Math.floor((price - low) / step + 1e-10)));
  for (let i = start; i < end; i++) {
    const bar = data[i];
    if (!(bar.volume > 0)) continue;
    const allocation = bar.high === bar.low ? bar.volume : bar.volume * step / (bar.high - bar.low);
    changes[rowOf(bar.low)] += allocation;
    changes[rowOf(bar.high) + 1] -= allocation;
  }
  const bins = new Float64Array(rows);
  let running = 0, total = 0, peak = 0, pocRow = 0;
  for (let row = 0; row < rows; row++) {
    running += changes[row];
    const amount = Math.max(0, running);
    bins[row] = amount;
    total += amount;
    if (amount > peak) { peak = amount; pocRow = row; }
  }
  const target = total * share;
  let accumulated = peak, lower = pocRow, upper = pocRow;
  while (accumulated < target) {
    const above = bins[upper + 1] ?? 0, below = bins[lower - 1] ?? 0;
    if (above <= 0 && below <= 0) break;
    // On a tie the Pine profile expands into the higher row first.
    if (above >= below) { accumulated += above; upper++; }
    else { accumulated += below; lower--; }
  }
  return { start, end, low, high, volume, bins, peak, lower, upper, step,
    poc: low + (pocRow + .5) * step, vah: low + (upper + 1) * step, val: low + lower * step };
}

function confirmedPivot(data, at, length) {
  const index = at - length;
  if (index < length) return null;
  const bar = data[index];
  let high = true, low = true;
  for (let offset = 1; offset <= length && (high || low); offset++) {
    const left = data[index - offset], right = data[index + offset];
    // The last occurrence of an equal extreme is the pivot of a flat top/bottom.
    if (left.high > bar.high || right.high >= bar.high) high = false;
    if (left.low < bar.low || right.low <= bar.low) low = false;
  }
  return high || low ? { index, high: high ? bar.high : null, low: low ? bar.low : null } : null;
}

export function pocBreached(data, index, poc, mode) {
  const side = Math.sign(data[index - 1].close - poc), bar = data[index];
  if (mode === 'cross') return side !== Math.sign(bar.close - poc);
  return side !== Math.sign(bar.low - poc) || side !== Math.sign(bar.high - poc);
}

function advanceExtensions(extensions, data, index, mode) {
  let kept = 0;
  for (const profile of extensions) {
    if (pocBreached(data, index, profile.poc, mode)) continue;
    profile.pocEnd = index;
    extensions[kept++] = profile;
  }
  extensions.length = kept;
}

// Keep this order paired with CANDLE_COLORS in the renderer.
function candleTone(bar, average, settings) {
  if (!settings.weightedCandles || !(bar.volume > 0)) return -1;
  const direction = bar.open < bar.close ? 0 : 1;
  if (average === null) return direction;
  if (bar.volume > average * settings.highThreshold) return 2 + direction;
  if (bar.volume < average * settings.lowThreshold) return 4 + direction;
  return direction;
}

export function newProfileOutput() {
  return { values: new Map(), series: [], meta: {
    lastClosed: -1, profiles: [], extensions: [], pivot: null, lastHigh: null, lastLow: null,
    volumeSum: 0, tones: [], developing: null,
  } };
}

export function updateProfiles(data, settings, output) {
  const meta = output.meta, last = data.length - 1;
  const { pivotLength, rows, valueArea, extendPoc, volumeLength } = settings;
  const extendUntilBreach = settings.showPoc && (extendPoc === 'cross' || extendPoc === 'touch');
  const volumeLeaving = index => data[index - volumeLength]?.volume || 0;
  // Only commit a pivot after the last bar of its right-hand window closes.
  // Live ticks can then update the developing profile without rewriting history.
  for (let i = meta.lastClosed + 1; i < last; i++) {
    meta.volumeSum += (data[i].volume || 0) - volumeLeaving(i);
    const average = i + 1 >= volumeLength ? meta.volumeSum / volumeLength : null;
    meta.tones[i] = candleTone(data[i], average, settings);
    const pivot = confirmedPivot(data, i, pivotLength);
    if (pivot) {
      const prior = meta.pivot;
      if (pivot.high !== null) meta.lastHigh = pivot.high;
      if (pivot.low !== null) meta.lastLow = pivot.low;
      meta.pivot = pivot;
      const profile = prior && buildProfile(data, prior.index, pivot.index, rows, valueArea);
      if (profile) {
        profile.pivot = pivot;
        profile.lastHigh = meta.lastHigh;
        profile.lastLow = meta.lastLow;
        profile.pocEnd = profile.end;
        meta.profiles.push(profile);
        if (extendUntilBreach) meta.extensions.push(profile);
      }
    }
    if (extendUntilBreach && meta.extensions.length) advanceExtensions(meta.extensions, data, i, extendPoc);
    meta.lastClosed = i;
  }

  const before = output.series.length;
  if (before) output.series[before - 1] = null;
  output.series.length = data.length;
  output.series.fill(null, before);
  output.values.clear();
  meta.data = data;
  meta.settings = settings;
  if (last < 0) return output;
  const current = data[last];
  const sum = meta.volumeSum + (current.volume || 0) - volumeLeaving(last);
  meta.tones[last] = candleTone(current, data.length >= volumeLength ? sum / volumeLength : null, settings);
  const developing = meta.pivot && buildProfile(data, meta.pivot.index, last, rows, valueArea);
  meta.developing = developing && { ...developing, pivot: null, lastPivot: meta.pivot,
    currentPrice: current.close, pocEnd: last, lastHigh: meta.lastHigh, lastLow: meta.lastLow };
  const point = { highVolume: meta.tones[last] === 2 || meta.tones[last] === 3 ? 1 : 0 };
  if (developing) Object.assign(point, {
    ...(settings.showPoc && { poc: developing.poc }),
    ...(settings.showVah && { vah: developing.vah }),
    ...(settings.showVal && { val: developing.val }),
  });
  output.series[last] = point;
  output.values.set(current.time, point);
  return output;
}
