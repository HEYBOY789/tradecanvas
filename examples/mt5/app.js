import { ChartWidgetGrid } from '@tradecanvas/chart/widget';
import { isPriceLevelAlert, priceToY } from '@tradecanvas/core';
import { createCvd } from './cvd.js';
import { installPaneScale } from './pane-scale.js';
import { createGridPriceLink, installPaneCrosshair } from './pane-crosshair.js';
import { installChartLayoutPersistence, installGridLayoutPersistence, mt5LayoutStorage } from './layout-persistence.js';
import { installLayoutTransfer } from './layout-transfer.js';
import { createSessionLevels, sessionClock } from './session-levels.js';
import { createSessionSettings } from './session-settings.js';
import { createMt5Trading } from './mt5-trading.js';
import { supertrendAlertItems, supertrendPine } from './supertrend-pine.js';
import { installPivotVolumeProfile, pivotVolumeAlertItems } from './pivot-volume-profile.js';

const status = document.getElementById('status');
const refreshInterval = 1000;
const alertBanner = document.getElementById('sessions-alert');
const sessionSettings = createSessionSettings(sessionClock);

function showAlert(message) {
  alertBanner.textContent = message;
  alertBanner.hidden = !message;
}

function showStatus(message, connected = false) {
  status.textContent = message;
  status.dataset.connected = connected;
}

function priceAlertMenuItems(widget, { area, price }) {
  if (!widget || !Number.isFinite(price) || (area !== 'plot' && area !== 'priceAxis')) return [];
  const chart = widget.getChart();
  const viewport = chart.viewport.getState();
  const y = priceToY(price, viewport);
  // Match the chart's alert drag radius, in screen pixels at any zoom.
  let closest = 6;
  let target;
  for (const alert of chart.getAlerts()) {
    if (!isPriceLevelAlert(alert)) continue;
    const line = priceToY(alert.price, viewport);
    if (line < viewport.chartRect.y || line > viewport.chartRect.y + viewport.chartRect.height) continue;
    const distance = Math.abs(line - y);
    if (distance <= closest) { closest = distance; target = alert; }
  }
  if (!target) return [];
  const { id, price: level } = target;
  return [{ label: `Xóa cảnh báo tại ${chart.formatPrice(level)}`, icon: 'trash', danger: true, onSelect: () => chart.removeAlert(id) }];
}

async function getJSON(path, signal) {
  const response = await fetch(path, { signal, cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Chưa đọc được dữ liệu MT5.');
  return data;
}

function createFeed(config, symbols, sessionLevels) {
  const cursors = new Map();
  const lifetime = new AbortController();
  const seriesKey = ({ symbol, timeframe }) => `${symbol.toUpperCase()}|${timeframe}`;
  const cvd = createCvd((request, targets) => getBars(request, lifetime.signal, undefined, targets));

  async function getBars({ symbol, timeframe, before, countBack }, signal, cursor, targets = cvd.targets({ symbol, timeframe })) {
    const query = new URLSearchParams({ symbol: symbols.get(symbol.toUpperCase())?.symbol || symbol, frame: timeframe });
    if (before != null) {
      query.set('before', before);
      query.set('count', Math.min(countBack, config.pageSize));
    } else if (sessionLevels.needsPeriods({ symbol, timeframe })) {
      query.set('periods', '1');
    }
    if (cursor) {
      query.set('since', cursor.time);
      query.set('broker', cursor.server);
    }
    if (targets.length) query.set('cvd', targets.join(','));
    return getJSON(`/api/bars?${query}`, signal);
  }

  function remember(key, { server, bars }) {
    cursors.set(key, { server, time: bars.at(-1).time });
    showStatus(`${server} · Dữ liệu MT5`, true);
  }

  const feed = {
    name: 'MetaTrader 5',
    supportedTimeframes: config.frames,
    async resolveSymbol(symbol) {
      return symbols.get(symbol.toUpperCase()) ?? null;
    },
    async getBars(request) {
      try {
        const result = await getBars(request, request.signal);
        if (request.signal.aborted) return [];
        cvd.accept(request, result);
        if (request.before != null) return result.bars;
        remember(seriesKey(request), result);
        sessionLevels.accept(request, result, false);
        return result.bars.slice(-request.countBack);
      } catch (error) {
        if (!request.signal.aborted && request.before == null) showStatus(error.message);
        throw error;
      }
    },
    subscribeBars(request, subscriber) {
      const controller = new AbortController();
      const key = seriesKey(request);
      let timer = setTimeout(refresh, refreshInterval);

      async function refresh() {
        try {
          const result = await getBars(request, controller.signal, cursors.get(key));
          if (controller.signal.aborted) return;
          if (result.reset) {
            // Re-read history if the source changed or the cursor fell out of range.
            subscriber.connection('disconnected');
            return;
          }
          remember(key, result);
          cvd.accept(request, result);
          sessionLevels.accept(request, result, true);
          for (let i = 0; i < result.bars.length; i++) {
            subscriber.bar(result.bars[i], i < result.bars.length - 1);
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          showStatus(error.message);
          subscriber.connection('disconnected');
          return;
        }
        timer = setTimeout(refresh, refreshInterval);
      }

      return () => {
        clearTimeout(timer);
        controller.abort();
      };
    },
  };
  return { feed, cvd, close: () => lifetime.abort() };
}

async function start() {
  let config;
  try {
    config = await getJSON('/api/config');
  } catch (error) {
    showStatus(error.message);
    setTimeout(start, refreshInterval);
    return;
  }

  const symbols = new Map(config.symbols.map(info => [info.symbol.toUpperCase(), info]));
  let grid;
  const trading = createMt5Trading(() => grid?.getWidget(active));
  const frames = [config.frame, '15m', '1h', '4h', '1d', '1w', '1m', '30m', '1M'];
  let active = 0;
  const cells = frames.map((timeframe, index) => {
    const cell = { message: '' };
    function connection() {
      if (cell.connection) return cell.connection;
      const sessions = createSessionLevels(sessionSettings, message => {
        cell.message = message;
        if (active === index) showAlert(message);
      }, index === 0);
      const source = createFeed(config, symbols, sessions);
      cell.connection = { ...source, sessions };
      return cell.connection;
    }
    cell.connect = connection;
    // Each widget receives its own feed when the grid builds or reopens a cell.
    cell.options = {
      get feed() { return connection().feed; },
      timeframe,
      indicatorMenuItems: context => [...connection().sessions.menuItems(context), ...supertrendAlertItems(cell.widget, context),
        ...pivotVolumeAlertItems(cell.widget, context)],
      onSymbolChange: () => trading.symbolChanged(),
      drawingMenuItems: context => trading.drawingMenuItems(cell.widget, context),
      chartMenuItems: context => [...priceAlertMenuItems(cell.widget, context), ...trading.chartMenuItems(cell.widget, context)],
    };
    // Preserve the first chart's browser settings and dock from the single chart.
    if (index === 0) Object.assign(cell.options, { persistSettings: true, features: { dock: true } });
    return cell;
  });
  const widgetOptions = {
    symbol: config.symbol,
    timeframe: config.frame,
    symbols: config.symbols,
    timeframes: config.frames,
    historyLimit: config.pageSize,
    historyPageSize: config.pageSize,
    customTimeframes: false,
    intervalTyping: false,
    locale: 'vi',
    theme: 'dark',
    plugins: [{ kind: 'indicator', plugin: supertrendPine }],
    trading: true,
    accountPanel: false,
    persistSettings: true,
    features: { 'statusBar.market': false, orderTicket: false, bracketOrders: false,
      'menu.chart.order': false, 'toolbar.trade': false },
    chartOptions: { timeZone: 'Asia/Ho_Chi_Minh', numberLocale: 'vi-VN' },
  };
  const linkCrosshair = createGridPriceLink(() => grid);
  const layoutStorage = await mt5LayoutStorage();
  grid = new ChartWidgetGrid(document.getElementById('chart'), {
    layout: '1x1', sync: { symbol: true },
    widget: widgetOptions, cells: cells.map(cell => cell.options),
    layouts: { storage: layoutStorage },
    onActiveChange(index) {
      active = index;
      showAlert(cells[index].message);
    },
    onChartAdd(widget, index) {
      const cell = cells[index];
      cell.widget = widget;
      const { cvd, close, sessions } = cell.connect();
      const closeTrading = trading.attach(widget, () => grid?.setActive(index), index);
      const closePivotProfile = installPivotVolumeProfile(widget);
      cell.message = '';
      sessions.attach(widget);
      cvd.attach(widget);
      installPaneScale(widget.getChart());
      const priceLink = linkCrosshair(widget);
      installPaneCrosshair(widget.getChart(), priceLink);
      installChartLayoutPersistence(widget, sessionSettings, sessions, index === 0);
      const destroy = widget.destroy.bind(widget);
      widget.destroy = () => {
        priceLink.report(null);
        close();
        closeTrading();
        closePivotProfile();
        destroy();
        cell.connection = undefined;
        cell.widget = undefined;
      };
    },
  });
  layoutStorage.bind(grid.getLayoutSession());
  const layoutOperations = installGridLayoutPersistence(grid);
  layoutStorage.attach(grid, layoutOperations);
  installLayoutTransfer(grid, document.getElementById('chart'), layoutStorage, { ...config, maxCharts: frames.length }, layoutOperations);
}

start().catch(error => showStatus(`Không thể mở biểu đồ: ${error.message}`));
