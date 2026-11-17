// Port of the visual levels and cross conditions by © Texmoonbeam (Pine Script v5).
import { priceToY, timeToX } from '@tradecanvas/core';
import { indicatorSource, parseIndicatorSource } from '@tradecanvas/commons';
import { FIBONACCI_LEVELS, PERIODS, SESSIONS } from './session-settings.js';

export const SESSIONS_INDICATOR_ID = 'texmoonbeam-sessions';
export const SESSIONS_PANEL_ID = 'texmoonbeam-sessions-panel';
const CVD_ID = 'mt5-cvd-candle';
const SETTINGS_PARAM = 'sessionSettings';
const DAY = 86_400_000;
const MINUTE = 60_000;
const EVERY_DAY = '1234567';
const FONT_SIZE = { tiny: 9, small: 11, normal: 13, large: 15, huge: 19 };
const DASH = { solid: [], dotted: [2, 3], dashed: [6, 4] };

function utcParts(time) {
  const date = new Date(time);
  return { day: Math.floor(time / DAY), minute: date.getUTCHours() * 60 + date.getUTCMinutes() };
}

export function sessionClock(zone) {
  const match = /^(?:GMT|UTC)(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$/i.exec(zone);
  if (match) {
    const [, sign, hour = '0', minute = '0'] = match;
    if (+hour > 23 || +minute > 59) throw new RangeError('Invalid GMT offset');
    const offset = (sign === '-' ? -1 : 1) * (+hour * 60 + +minute) * MINUTE;
    return time => utcParts(time + offset);
  }
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  return time => {
    const { year, month, day, hour, minute } = Object.fromEntries(
      formatter.formatToParts(time).map(({ type, value }) => [type, +value]),
    );
    return { day: Date.UTC(year, month - 1, day) / DAY, minute: hour * 60 + minute };
  };
}

function minutes(time) {
  const [hours, mins] = time.split(':').map(Number);
  return hours * 60 + mins;
}

function sessionDay({ day, minute }, start, end, days) {
  if (start < end && (minute < start || minute >= end)) return null;
  if (start > end && minute < start && minute >= end) return null;
  let tradingDay = day + (start >= end && start !== 0 && minute >= start ? 1 : 0);
  const included = index => days.includes(String(new Date(index * DAY).getUTCDay() + 1));
  if (!included(tradingDay)) return null;
  if (start === end) {
    if ([...EVERY_DAY].every(digit => days.includes(digit))) return 0;
    // A 24-hour window remains one range through consecutive included weekdays.
    while (included(tradingDay - 1)) tradingDay--;
  }
  return tradingDay;
}

export function sessionRanges(bars, clock, options, history) {
  const start = minutes(options.start);
  const end = minutes(options.end);
  const days = options.days ?? EVERY_DAY;
  const ranges = [];
  let current;
  let lastDay;
  for (let i = 0; i < bars.length; i++) {
    const key = sessionDay(clock[i], start, end, days);
    if (key === null) continue;
    const bar = bars[i];
    if (!current || key !== lastDay) {
      current = { start: bar.time, end: bar.time, open: bar.open, high: bar.high, low: bar.low,
        day: key, firstIndex: i, lastIndex: i };
      if (!history || options.extend) ranges.length = 0;
      ranges.push(current);
      lastDay = key;
    } else {
      current.end = bar.time;
      current.lastIndex = i;
      current.high = Math.max(current.high, bar.high);
      current.low = Math.min(current.low, bar.low);
    }
  }
  return ranges;
}

export function fibonacciLines(range, prefix, settings, options = settings.fibonacci) {
  if (!options || !(range.high > range.low)) return [];
  const span = range.high - range.low;
  return FIBONACCI_LEVELS.filter(([id]) => options.levels[id]).map(([id, percent]) => ({
    id: `${prefix}:fibonacci:${id}`, start: range.start ?? range.time, end: range.end,
    endExclusive: range.endExclusive === true,
    price: options.direction === 'High → Low' ? range.high - span * percent / 100 : range.low + span * percent / 100,
    color: options.colors[id], name: `${String(percent).replace('.', ',')}%`,
    options, fibonacci: true,
  }));
}

export function closedSessionRanges(bars, timeline, clock, options, history = false) {
  if (!timeline.length) return [];
  const start = minutes(options.start);
  const end = minutes(options.end);
  const days = options.days ?? EVERY_DAY;
  const activeDay = sessionDay(clock.at(-1), start, end, days);
  const ranges = sessionRanges(timeline, clock, { ...options, extend: false }, true);
  const completed = ranges.filter(item => item.day !== activeDay);
  const candidates = history ? completed : completed.slice(-1);
  const source = new Map(bars.map(bar => [bar.time, bar]));
  return candidates.flatMap(range => {
    const following = timeline[range.lastIndex + 1];
    if (!following || (range.firstIndex === 0 && clock[0].minute !== start)) return [];
    const members = timeline.slice(range.firstIndex, range.lastIndex + 1).map(bar => source.get(bar.time));
    // A partial history page or an unfinished CVD backfill cannot establish session extremes.
    if (members.some(bar => !bar)) return [];
    return [{ start: range.start, end: range.end,
      high: Math.max(...members.map(bar => bar.high)), low: Math.min(...members.map(bar => bar.low)) }];
  });
}

export function previousSessionRange(bars, timeline, clock, options) {
  return closedSessionRanges(bars, timeline, clock, options).at(-1) ?? null;
}

export function periodLines(periods, settings) {
  if (!periods) return [];
  const monday = periods.day.findLast(bar => bar && new Date(bar.tradingDay ?? bar.time).getUTCDay() === 1);
  const anchors = {
    monday, previousDay: periods.day.at(-2),
    currentWeek: periods.week.at(-1), previousWeek: periods.week.at(-2),
    currentMonth: periods.month.at(-1), previousMonth: periods.month.at(-2),
    weekOpen: periods.week.at(-1), monthOpen: periods.month.at(-1),
  };
  const result = [];
  for (const [id, , long, short, , open] of PERIODS) {
    const bar = anchors[id];
    const options = settings.periods[id];
    if (!bar) continue;
    const add = (part, price, color, name) => {
      result.push({ id: `${id}:${part}`, start: bar.time, price, color, name, options });
    };
    if (open) {
      if (options.enabled) add('open', bar.open, options.openColor, settings.shortLabels ? short : long);
      continue;
    }
    if (options.enabled) {
      add('high', bar.high, options.highColor, settings.shortLabels ? `${short}H` : `${long} High`);
      add('low', bar.low, options.lowColor, settings.shortLabels ? `${short}L` : `${long} Low`);
      if (options.mid) {
        add('mid', (bar.high + bar.low) / 2, options.midColor, settings.shortLabels ? `${short}.5` : `${long} 0.5`);
      }
    }
    if (options.enabled && options.fibonacci) {
      const prefix = settings.shortLabels ? short : long;
      const fibonacci = { ...options, levels: options.fibonacciLevels,
        colors: options.fibonacciColors, direction: options.fibonacciDirection };
      result.push(...fibonacciLines(bar, prefix, settings, fibonacci).map(line => ({
        ...line, periodId: id, name: `${prefix} ${line.name}`,
      })));
    }
  }
  return result;
}

// Use the same broker period boundaries, but measure the target's OHLC.
// Keep missing periods in place so PDH never silently becomes an older day.
export function sourcePeriods(periods, timeline, bars) {
  if (!periods) return null;
  const values = new Map(bars.map(bar => [bar.time, bar]));
  return Object.fromEntries(Object.entries(periods).map(([unit, anchors]) => [unit,
    anchors.map((anchor, index) => {
      if (!timeline.length || timeline[0].time > anchor.time) return null;
      const end = anchors[index + 1]?.time ?? Infinity;
      const covered = timeline.filter(bar => bar.time >= anchor.time && bar.time < end);
      if (!covered.length || covered.some(bar => !values.has(bar.time))) return null;
      const source = covered.map(bar => values.get(bar.time));
      return { ...anchor, open: source[0].open, close: source.at(-1).close,
        high: Math.max(...source.map(bar => bar.high)), low: Math.min(...source.map(bar => bar.low)) };
    }),
  ]));
}

function drawLine(ctx, y, start, end, color, width, style) {
  if (width <= 0 || !Number.isFinite(y) || end < start) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(DASH[style]);
  ctx.beginPath();
  ctx.moveTo(start, y);
  ctx.lineTo(end, y);
  ctx.stroke();
}

function drawLabel(ctx, rect, x, y, text, color, align = 'right', outlineColor) {
  if (!text || x < rect.x || x > rect.x + rect.width || y < rect.y || y > rect.y + rect.height) return;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'bottom';
  if (outlineColor) {
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;
    ctx.setLineDash([]);
    ctx.strokeStyle = outlineColor;
    ctx.strokeText(text, x, y - 2);
    ctx.restore();
  }
  ctx.fillText(text, x, y - 2);
}

function sessionEdges(range, viewport, options) {
  const rect = viewport.chartRect;
  const right = rect.x + rect.width;
  const halfBar = (viewport.barWidth + viewport.barSpacing) / 2;
  const start = timeToX(range.start, viewport) - halfBar;
  const end = timeToX(range.end, viewport) + halfBar;
  return [Math.max(rect.x, start), Math.min(right, options.extend ? right : end)];
}

function drawSessions(ctx, viewport, bars, settings) {
  const toLocal = sessionClock(settings.zone);
  const clock = bars.map(bar => toLocal(bar.time));
  const rect = viewport.chartRect;
  const timeline = viewport.data ?? bars;
  const timelineClock = timeline === bars ? clock : timeline.map(bar => toLocal(bar.time));
  const fibonacci = [];
  for (const [id, title] of SESSIONS) {
    const options = settings.sessions[id];
    if (options.fibonacci && FIBONACCI_LEVELS.some(([level]) => settings.fibonacci.levels[level])) {
      for (const previous of closedSessionRanges(bars, timeline, timelineClock, options, settings.fibonacci.history)) {
        fibonacci.push(...fibonacciLines(previous, `${title}:${previous.start}`, settings));
      }
    }
    if (!options.enabled) continue;
    for (const range of sessionRanges(bars, clock, options, settings.history)) {
      const [start, end] = sessionEdges(range, viewport, options);
      if (end <= start) continue;
      const highY = priceToY(range.high, viewport);
      const lowY = priceToY(range.low, viewport);
      const top = Math.min(highY, lowY);
      const height = Math.max(1, Math.abs(highY - lowY));
      ctx.globalAlpha = (100 - settings.transparency) / 100;
      ctx.fillStyle = options.color;
      ctx.fillRect(start, top, end - start, height);
      ctx.globalAlpha = 1;
      if (settings.borderWidth) {
        ctx.strokeStyle = options.color;
        ctx.globalAlpha = 1 - settings.transparency / 110;
        ctx.lineWidth = settings.borderWidth;
        ctx.setLineDash(DASH[settings.borderStyle]);
        ctx.strokeRect(start, top, end - start, height);
        ctx.globalAlpha = 1;
      }
      if (options.showOpen) {
        const y = priceToY(range.open, viewport);
        drawLine(ctx, y, start, end, `${options.openColor}bf`, settings.borderWidth, settings.borderStyle);
        drawLabel(ctx, rect, end - 3, y, settings.shortLabels ? 'O' : 'Open', options.openColor);
      }
    }
  }
  for (const options of settings.custom) {
    if (!options.enabled) continue;
    for (const range of sessionRanges(bars, clock, options, options.history)) {
      const [start, end] = sessionEdges(range, viewport, options);
      const y = priceToY(range[options.type], viewport);
      drawLine(ctx, y, start, end, options.color, settings.borderWidth, options.style);
      if (end > start) drawLabel(ctx, rect, end - 3, y, options.label, options.color);
    }
  }
  return fibonacci;
}

function drawPeriods(ctx, viewport, bars, lines) {
  const rect = viewport.chartRect;
  const right = rect.x + rect.width;
  for (const line of lines) {
    const { options } = line;
    if (line.fibonacci && !line.periodId) {
      drawFibonacci(ctx, viewport, line);
      continue;
    }
    const periodId = line.id.split(':')[0];
    if (line.id.endsWith(':mid') && lines.some(other => other.periodId === periodId && other.id.endsWith(':p500'))) continue;
    const start = Math.max(rect.x, timeToX(line.start, viewport));
    const barStep = viewport.barWidth + viewport.barSpacing;
    const anchor = timeToX(bars.at(-1).time, viewport) + (options.offset ?? 0) * barStep;
    const end = Math.min(right, options.extend ? right : anchor);
    const y = priceToY(line.price, viewport);
    drawLine(ctx, y, start, end, line.color, options.width, options.style);
    if (end >= start && options.label) drawLabel(ctx, rect, Math.min(anchor + 4, right - 4), y, line.name, line.color, 'right', options.labelOutlineColor);
  }
}

function drawFibonacci(ctx, viewport, line) {
  const { chartRect: rect } = viewport;
  const halfBar = (viewport.barWidth + viewport.barSpacing) / 2;
  const start = Math.max(rect.x, timeToX(line.start, viewport) - halfBar);
  const end = Math.min(rect.x + rect.width, timeToX(line.end, viewport) + (line.endExclusive ? -halfBar : halfBar));
  const y = priceToY(line.price, viewport);
  if (!(end > start) || y < rect.y || y > rect.y + rect.height) return;
  drawLine(ctx, y, start, end, line.color, line.options.width, line.options.style);
  if (!line.options.label) return;
  ctx.save();
  try {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;
    ctx.setLineDash([]);
    ctx.strokeStyle = line.options.labelOutlineColor;
    ctx.fillStyle = line.color;
    const x = (start + end) / 2;
    ctx.strokeText(line.name, x, y);
    ctx.fillText(line.name, x, y);
  } finally {
    ctx.restore();
  }
}

export function createSessionLevels(settings, notify, persistDefaults = true) {
  let widget;
  let chart;
  let latest;
  const optionCache = new Map();

  function matches({ symbol, timeframe }) {
    return widget && widget.getSymbol().toUpperCase() === symbol.toUpperCase() && widget.getTimeframe() === timeframe;
  }

  const isSession = id => id === SESSIONS_INDICATOR_ID || id === SESSIONS_PANEL_ID;
  const instances = () => chart.getActiveIndicators().filter(item => isSession(item.id));
  const shown = () => instances().find(item => item.shown);
  const cvds = () => chart.getActiveIndicators().filter(item => item.id === CVD_ID);
  const paneOf = instanceId => chart.getIndicatorPanes().find(pane => pane.instanceIds.includes(instanceId));
  const cvdInPane = instanceId => {
    const pane = paneOf(instanceId);
    return pane && cvds().find(item => pane.instanceIds.includes(item.instanceId));
  };

  function optionsFor(instanceId) {
    const encoded = chart.getIndicatorConfig(instanceId)?.params[SETTINGS_PARAM];
    const cached = optionCache.get(instanceId);
    if (cached && cached.encoded === encoded) return cached.value;
    let snapshot;
    try { snapshot = JSON.parse(encoded); } catch { /* Migrate the previous shared settings. */ }
    const value = settings.normalize(snapshot ?? settings.value);
    optionCache.set(instanceId, { encoded, value });
    return value;
  }

  function initializeSettings(instanceId) {
    const config = chart.getIndicatorConfig(instanceId);
    if (config && !config.params[SETTINGS_PARAM]) {
      chart.updateIndicator(instanceId, { [SETTINGS_PARAM]: JSON.stringify(settings.value) });
    }
  }

  function bindSource(instanceId, cvd) {
    const source = cvd ? indicatorSource(cvd.instanceId, 'close') : 'close';
    if (chart.getIndicatorConfig(instanceId)?.params.source !== source) chart.updateIndicator(instanceId, { source });
  }

  function addPanel(cvd, merge = false) {
    if (merge) {
      const existing = instances().find(item => item.id === SESSIONS_PANEL_ID &&
        paneOf(cvd.instanceId)?.instanceIds.includes(item.instanceId));
      if (existing) {
        chart.setIndicatorVisible(existing.instanceId, true);
        return existing.instanceId;
      }
    }
    return chart.addIndicator(SESSIONS_PANEL_ID,
      { source: cvd ? indicatorSource(cvd.instanceId, 'close') : 'close' }, undefined,
      merge ? { pane: paneOf(cvd.instanceId)?.instanceId ?? cvd.instanceId } : undefined);
  }

  function syncPlacement() {
    const active = instances().filter(item => item.id === SESSIONS_INDICATOR_ID);
    const visible = active.some(item => item.visible);
    if (persistDefaults) settings.setPlacement({ present: active.length > 0, visible });
    if (!shown()) {
      latest = null;
      notify('');
    }
  }

  const indicator = (panel = false) => ({
    descriptor: {
      id: panel ? SESSIONS_PANEL_ID : SESSIONS_INDICATOR_ID,
      name: panel ? 'All-In-One Sessions · Ô riêng / CVD' : 'All-In-One Sessions · Phiên & Mức',
      shortName: panel ? 'Sessions · Ô riêng' : 'Phiên & Mức',
      placement: panel ? 'panel' : 'overlay', defaultConfig: panel ? { source: 'close' } : {},
      ...(panel ? { inputs: { source: { source: true } }, plots: [
        { key: 'high', title: 'High', color: 0 }, { key: 'low', title: 'Low', color: 1 },
      ] } : {}),
    },
    calculate(data, { instanceId, params }) {
      if (!panel) return { values: new Map(), meta: { data, instanceId } };
      const sourceId = parseIndicatorSource(params.source)?.instanceId;
      const output = sourceId && chart.getIndicatorOutput(sourceId, { drawn: true });
      const bars = sourceId ? data.flatMap(bar => {
        const value = output?.values.get(bar.time);
        return value && ['open', 'high', 'low', 'close'].every(key => Number.isFinite(value[key]))
          ? [{ time: bar.time, open: value.open, high: value.high, low: value.low, close: value.close }] : [];
      }) : data;
      const values = new Map(bars.map(({ time, open, high, low, close }) => [time, { open, high, low, close }]));
      return { values, series: data.map(bar => values.get(bar.time) ?? null), meta: { data, bars, instanceId, sourceId } };
    },
    render(ctx, output, axes) {
      const { data, bars: computed, instanceId, sourceId } = output.meta ?? {};
      if (!data?.length || !instances().some(item => item.instanceId === instanceId && item.shown)) return;
      const options = optionsFor(instanceId);
      const timeline = chart.getDisplayData();
      const viewport = { ...axes, data: timeline };
      const replay = chart.isReplayActive();
      const target = !panel && cvdInPane(instanceId);
      const targetValues = target && chart.getIndicatorOutput(target.instanceId, { drawn: true })?.values;
      const bars = target ? timeline.flatMap(bar => {
        const value = targetValues?.get(bar.time);
        return value ? [{ ...value, time: bar.time }] : [];
      }) : computed ?? (replay ? data : timeline);
      if (!bars.length) return;
      const rect = viewport.chartRect;
      ctx.save();
      try {
        ctx.beginPath();
        ctx.rect(rect.x, rect.y, rect.width, rect.height);
        ctx.clip();
        ctx.font = `${FONT_SIZE[options.labelSize]}px Inter, Segoe UI, sans-serif`;
        const lines = /(?:[smh]|T)$/.test(widget.getTimeframe()) ? drawSessions(ctx, viewport, bars, options) : [];
        if (!replay && latest && matches(latest)) {
          const periods = sourceId || target ? sourcePeriods(latest.periods, timeline, bars) : latest.periods;
          lines.push(...periodLines(periods, options));
        }
        drawPeriods(ctx, viewport, bars, lines);
      } finally {
        ctx.restore();
      }
    },
  });

  return {
    prepareLayout(content) {
      if (!Array.isArray(content?.chart?.indicators)) return content;
      const fallback = settings.normalize(content.sessions ?? settings.value);
      return { ...content, chart: { ...content.chart, indicators: content.chart.indicators.map(item =>
        isSession(item.id) && !item.params?.[SETTINGS_PARAM]
          ? { ...item, params: { ...item.params, [SETTINGS_PARAM]: JSON.stringify(fallback) } } : item) } };
    },
    menuItems({ instanceId, indicatorId }) {
      if (!chart) return [];
      if (indicatorId === CVD_ID) return [{ label: 'Thêm Sessions vào ô này', onSelect: () => {
        addPanel(cvds().find(item => item.instanceId === instanceId), true);
      } }];
      if (!isSession(indicatorId)) return [];
      const items = [];
      if (indicatorId === SESSIONS_INDICATOR_ID) items.push({ label: 'Tạo ô Sessions riêng',
        onSelect: () => addPanel(cvds()[0]) });
      for (const [index, cvd] of cvds().entries()) {
        if (cvdInPane(instanceId)?.instanceId === cvd.instanceId) continue;
        items.push({ label: `Ghép vào CVD Candle${cvds().length > 1 ? ` ${index + 1}` : ''}`, onSelect: () => {
          if (indicatorId === SESSIONS_INDICATOR_ID) addPanel(cvd, true);
          else {
            bindSource(instanceId, cvd);
            chart.moveIndicatorToPane(instanceId, paneOf(cvd.instanceId)?.instanceId ?? cvd.instanceId);
          }
        } });
      }
      if (indicatorId === SESSIONS_PANEL_ID && chart.canMoveIndicatorToPane(instanceId, 'new')) {
        items.push({ label: 'Tách Sessions ra ô riêng', onSelect: () => chart.moveIndicatorToPane(instanceId, 'new') });
      }
      return items;
    },
    needsPeriods(request) {
      if (!chart) return settings.placement.present && settings.placement.visible;
      return matches(request) && Boolean(shown());
    },
    attach(owner) {
      widget = owner;
      chart = owner.getChart();
      // The grouped session form owns these inputs. All native entry points
      // (legend name, gear, object tree and menu) call this widget method.
      const openSettings = owner.openIndicatorSettings.bind(owner);
      owner.openIndicatorSettings = instanceId => {
        if (isSession(chart.getIndicatorConfig(instanceId)?.id)) {
          settings.open(optionsFor(instanceId), snapshot => {
            const config = chart.getIndicatorConfig(instanceId);
            if (!config || !isSession(config.id)) return;
            chart.updateIndicator(instanceId, { [SETTINGS_PARAM]: JSON.stringify(snapshot) });
            if (persistDefaults && config.id === SESSIONS_INDICATOR_ID) settings.remember(snapshot);
            if (latest) latest.signals = null;
            notify('');
            chart.requestRender();
          });
          return;
        }
        return openSettings(instanceId);
      };
      chart.registerIndicator(indicator());
      chart.registerIndicator(indicator(true));
      chart.on('indicatorAdd', ({ payload }) => {
        if (isSession(payload.id)) initializeSettings(payload.instanceId);
        if (payload.id === SESSIONS_PANEL_ID && chart.getIndicatorConfig(payload.instanceId)?.params.source === 'close') {
          bindSource(payload.instanceId, cvdInPane(payload.instanceId) ?? cvds()[0]);
        }
        if (isSession(payload.id)) syncPlacement();
      });
      chart.on('indicatorRemove', ({ payload }) => {
        optionCache.delete(payload.instanceId);
        syncPlacement();
      });
      chart.on('indicatorChange', ({ payload }) => {
        if (payload.change === 'pane' && chart.getIndicatorConfig(payload.instanceId)?.id === SESSIONS_PANEL_ID) {
          const target = cvdInPane(payload.instanceId);
          if (target || !paneOf(payload.instanceId)) bindSource(payload.instanceId, target);
        }
        if (payload.change === 'visible' && instances().some(item => item.instanceId === payload.instanceId)) syncPlacement();
      });
      if (settings.placement.present && !instances().some(item => item.id === SESSIONS_INDICATOR_ID)) {
        const id = chart.addIndicator(SESSIONS_INDICATOR_ID);
        if (id && !settings.placement.visible) chart.setIndicatorVisible(id, false);
      }
    },
    accept(request, { periods, server, bars }, live) {
      if (!periods || !matches(request) || !shown()) return;
      const current = bars.at(-1);
      const prior = latest && latest.server === server && matches(latest) ? latest : null;
      const alertInstances = instances().filter(item => item.id === SESSIONS_INDICATOR_ID && item.shown &&
        !paneOf(item.instanceId) && optionsFor(item.instanceId).alerts);
      const signals = alertInstances.length && !chart.isReplayActive() ? new Map() : null;
      const fired = live && prior?.time === current.time ? prior.fired : new Set();
      const crossed = [];
      if (signals) {
        for (const item of alertInstances) for (const line of periodLines(periods, optionsFor(item.instanceId))) {
          if (line.fibonacci) continue;
          const signalId = `${item.instanceId}:${line.id}`;
          const delta = current.close - line.price;
          const previous = prior?.signals?.get(signalId);
          signals.set(signalId, delta);
          if (live && !fired.has(signalId) && ((previous <= 0 && delta > 0) || (previous >= 0 && delta < 0))) {
            fired.add(signalId);
            crossed.push(line.name);
          }
        }
      }
      if (!prior) notify('');
      if (crossed.length) notify(`${request.symbol} · Cắt mức ${crossed.join(', ')}`);
      latest = { ...request, server, periods, time: current.time, signals, fired };
      chart.requestRender();
    },
  };
}
