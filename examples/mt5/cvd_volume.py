# This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
# If a copy of the MPL was not distributed with this file, see https://mozilla.org/MPL/2.0/.
# Intrabar polarity adapted from CVD - Cumulative Volume Delta Candles, © TradingView.

"""Read MT5 intrabars and aggregate their directional volume into chart bars."""

import time

import numpy as np

AUTO_TARGETS = frozenset(map(str, (4, 8, 16, 32, 64, 12, 24, 50, 100, 250)))
TICK_FRAMES = frozenset(('1T', '10T', '100T', '1000T', '1s', '5s', '10s', '15s', '30s', '45s'))
TARGETS = AUTO_TARGETS | TICK_FRAMES | {'1m'}
UNITS = {'m': 60, 'h': 3600, 'd': 86400, 'w': 604800, 'M': 2592000}
MAX_INTRABARS = 200_000
MAX_TICKS = 1_000_000
TICK_BLOCK = 3600
TICK_LOOKBACK = 7 * 86400


def seconds(frame):
    return int(frame[:-1]) * UNITS[frame[-1]]


def lower_frame(frame, target, frames):
    width = seconds(frame)
    candidates = [name for name in frames if seconds(name) < width and width % seconds(name) == 0]
    if frame.endswith('M'):
        candidates = [name for name in candidates if seconds(name) <= UNITS['d']]
    if not candidates:
        return frame
    return min(candidates, key=lambda name: abs(width / seconds(name) - target))


def ends_for(starts, frame):
    if frame.endswith('M'):
        months = starts.astype('datetime64[s]').astype('datetime64[M]')
        return (months + int(frame[:-1])).astype('datetime64[s]').astype(np.int64)
    return starts + seconds(frame)


def signed_volume(rows, volume_field):
    volume = rows[volume_field].astype(np.float64)
    close = rows['close']
    sign = np.sign(close - rows['open'])
    if not len(sign):
        return volume
    if sign[0] == 0:
        sign[0] = 1
    ties = sign[1:] == 0
    sign[1:][ties] = np.sign(np.diff(close))[ties]
    sign[1:][(sign[1:] == 0) & (volume[:-1] == 0)] = 1
    previous = np.maximum.accumulate(np.where(sign != 0, np.arange(len(sign)), 0))
    return sign[previous] * volume


def aggregate(rows, starts, ends, cutoff, volume_field, ticks=False):
    signed = signed_volume(rows, volume_field)
    group = np.searchsorted(starts, rows['time'], side='right') - 1
    candidate = group.clip(min=0)
    in_window = (group >= 0) & (rows['time'] < ends[candidate]) & (starts[candidate] >= cutoff)
    group = group[in_window]
    values = signed[in_window]
    size = len(starts)
    positive = np.maximum(values, 0)
    negative = np.minimum(values, 0)
    up = np.bincount(group, weights=positive, minlength=size)
    down = np.bincount(group, weights=negative, minlength=size)
    count = np.bincount(group, minlength=size)
    max_up = np.zeros(size)
    max_down = np.zeros(size)
    np.maximum.at(max_up, group, positive)
    np.minimum.at(max_down, group, negative)
    multiplier = 1 if ticks else 1000
    return [[int(starts[i]) * multiplier, float(up[i]), float(down[i]), float(max_up[i]), float(max_down[i]), int(count[i])]
            for i in np.flatnonzero(count)]


class RecentTicks:
    """Keep the latest live read and refresh its last second as one unit."""

    def __init__(self):
        self.key = None

    def read(self, mt5, symbol, trade_volume, start, end, cache_key=None):
        start = max(start, end - TICK_LOOKBACK)
        flags = mt5.COPY_TICKS_TRADE if trade_volume else mt5.COPY_TICKS_INFO

        def fetch(left, right):
            rows = mt5.copy_ticks_range(symbol, left, right, flags)
            if rows is None:
                return None
            return rows[(rows['time_msc'] >= left * 1000) & (rows['time_msc'] < right * 1000)]

        covered = end
        rows = None
        if cache_key is not None and cache_key == self.key and self.start <= start < self.end <= end and end - self.end < TICK_BLOCK:
            boundary = max(start, self.end - 1)
            tail = fetch(boundary, end)
            if tail is None and mt5.last_error()[0] == -4:  # No tick history in this short tail.
                tail = self.rows[self.rows['time_msc'] >= boundary * 1000]
            if tail is not None:
                keep = self.rows[(self.rows['time_msc'] >= start * 1000) & (self.rows['time_msc'] < boundary * 1000)]
                rows = np.concatenate((keep, tail))
                covered = start

        if rows is None:
            blocks = []
            size = 0
            while covered > start and size < MAX_TICKS:
                left = max(start, covered - TICK_BLOCK)
                block = fetch(left, covered)
                if block is not None and len(block):
                    blocks.append(block)
                    size += len(block)
                covered = left
            if blocks:
                rows = np.concatenate(blocks[::-1]) if len(blocks) > 1 else blocks[0]

        if rows is not None and len(rows) > MAX_TICKS:
            rows = rows[-MAX_TICKS:].copy()
            covered = int(rows[0]['time_msc']) // 1000 + 1
        if cache_key is not None and rows is not None and len(rows):
            self.key, self.start, self.end, self.rows = cache_key, covered, end, rows
        return rows, covered


def tick_intrabars(raw, starts, ends, frame, real_volume):
    price = raw['last'] if real_volume else raw['bid']
    group = np.searchsorted(starts, raw['time_msc'], side='right') - 1
    valid = (group >= 0) & (raw['time_msc'] < ends[group.clip(min=0)]) & (price > 0) & np.isfinite(price)
    if not valid.any():
        return np.empty(0, dtype=[('time', '<i8'), ('open', '<f8'), ('close', '<f8'), ('volume', '<f8')])

    ticks = raw[valid]
    group = group[valid]
    price = price[valid]
    count = int(frame[:-1])
    if frame.endswith('T'):
        indexes = np.arange(len(ticks))
        first = np.maximum.accumulate(np.where(np.r_[True, group[1:] != group[:-1]], indexes, 0))
        child = (indexes - first) // count
    else:
        child = (ticks['time_msc'] - starts[group]) // (count * 1000)

    first = np.r_[0, 1 + np.flatnonzero((group[1:] != group[:-1]) | (child[1:] != child[:-1]))]
    last = np.r_[first[1:] - 1, len(ticks) - 1]
    volume = np.where(ticks['volume_real'] > 0, ticks['volume_real'], ticks['volume']) if real_volume else None
    out = np.empty(len(first), dtype=[('time', '<i8'), ('open', '<f8'), ('close', '<f8'), ('volume', '<f8')])
    out['time'] = ticks['time_msc'][first]
    out['open'], out['close'] = price[first], price[last]
    out['volume'] = np.add.reduceat(volume, first) if real_volume else last - first + 1
    return out


def read_cvd(mt5, symbol, frame, parents, targets, frames, real_volume, tick_reader=None, live_key=None):
    if parents is None or not len(parents):
        return {}
    starts = parents['time'].astype(np.int64)
    ends = ends_for(starts, frame)
    field = 'real_volume' if real_volume else 'tick_volume'
    targets = tuple(map(str, targets))
    raw_ticks = None
    tick_coverage = None
    if TICK_FRAMES.intersection(targets):
        # Include the previous actual chart bar to seed polarity across requests,
        # even if a weekend or a daily trading break separates those two bars.
        previous = mt5.copy_rates_from(symbol, frames[frame], int(starts[0]) - 1, 1)
        seed = previous['time'] if previous is not None and len(previous) else np.array([], dtype=np.int64)
        tick_starts = np.concatenate((seed, starts)) * 1000
        tick_ends = ends_for(tick_starts // 1000, frame) * 1000
        end = min(int(ends[-1]), int(time.time()) + 1)
        if end > int(tick_starts[0]) // 1000:
            reader = tick_reader if tick_reader is not None else RecentTicks()
            raw_ticks, covered = reader.read(mt5, symbol, real_volume, int(tick_starts[0]) // 1000, end, live_key)
            tick_coverage = {'from': covered * 1000, 'to': end * 1000}

    by_frame = {}
    result = {}
    for target in targets:
        lower = lower_frame(frame, int(target), frames) if target in AUTO_TARGETS else target
        if lower not in by_frame:
            if lower in TICK_FRAMES:
                rows = []
                if raw_ticks is not None:
                    intrabars = tick_intrabars(raw_ticks, tick_starts, tick_ends, lower, real_volume)
                    rows = aggregate(intrabars, starts * 1000, ends * 1000, covered * 1000, 'volume', ticks=True)
                by_frame[lower] = dict(frame=lower, volume=field, rows=rows, coverage=tick_coverage)
                result[target] = by_frame[lower]
                continue
            end = int(ends[-1]) - 1
            cutoff = max(int(starts[0]), end - (MAX_INTRABARS - 1) * seconds(lower))
            rates = parents if lower == frame else mt5.copy_rates_range(symbol, frames[lower], cutoff, end)
            rows = []
            if rates is not None and len(rates):
                first = int(rates[0]['time'])
                seed = mt5.copy_rates_from(symbol, frames[lower], first - 1, 32)
                source = rates if seed is None or not len(seed) else np.concatenate((seed, rates))
                # If broker history begins inside the first parent, leave that parent blank.
                if (seed is None or not len(seed)) and first > cutoff:
                    cutoff = first
                rows = aggregate(source, starts, ends, cutoff, field)
            by_frame[lower] = dict(frame=lower, volume=field, rows=rows,
                                   coverage={'from': cutoff * 1000, 'to': (end + 1) * 1000})
        result[target] = by_frame[lower]
    return result
