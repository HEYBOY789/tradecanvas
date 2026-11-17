import { DEFAULT_GRID_SYNC, localStorageLayouts, readGridLayout, readWidgetLayout } from '@tradecanvas/chart/widget';
import { sharedLayoutStorage } from './shared-layouts.js';

const ACTIVE_LAYOUT_KEY = 'mt5:active-layout:v1';
const MIGRATED_KEY = 'mt5:grid-layouts-migrated:v1';
const VIEW_SETTINGS = ['timezone', 'numberLocale', 'crosshairCursor'];

function parse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

export async function mt5LayoutStorage() {
  const storage = localStorageLayouts('tcw:grid-layouts:');
  try {
    if (localStorage.getItem(MIGRATED_KEY)) return sharedLayoutStorage(storage);
    const legacy = localStorageLayouts();
    for (const entry of legacy.list()) {
      if (storage.load(entry.id)) continue;
      const saved = legacy.load(entry.id);
      const cell = parse(saved?.content);
      if (!readWidgetLayout(cell)) continue;
      const content = { v: 1, kind: 'grid', layout: '1x1',
        sync: { ...DEFAULT_GRID_SYNC, symbol: true }, active: 0, cells: [cell] };
      storage.save({ ...saved, kind: 'grid', content: JSON.stringify(content) });
    }
    localStorage.setItem(MIGRATED_KEY, '1');
  } catch (error) {
    console.warn('Layout migration:', error.message);
  }
  return sharedLayoutStorage(storage);
}

export function installChartLayoutPersistence(widget, sessions, sessionLevels, primary) {
  const layouts = widget.layouts;

  const preferences = content => {
    if (content.settings) {
      widget.setSettings(Object.fromEntries(VIEW_SETTINGS
        .filter(key => typeof content.settings[key] === 'string')
        .map(key => [key, content.settings[key]])));
    }
    if (primary && content.sessions && typeof content.sessions === 'object') sessions.remember(content.sessions);
  };

  // The native layout format omits the viewer's timezone and number format.
  // This app saves those preferences and the custom Sessions form per layout.
  const capture = layouts.captureLayout.bind(layouts);
  layouts.captureLayout = () => {
    const content = capture();
    const settings = widget.getSettings();
    return { ...content,
      settings: { ...content.settings, ...Object.fromEntries(VIEW_SETTINGS.map(key => [key, settings[key]])) },
      ...(primary ? { sessions: structuredClone(sessions.value) } : {}),
    };
  };

  const restore = layouts.restoreLayout.bind(layouts);
  layouts.restoreLayout = async content => {
    await restore(sessionLevels.prepareLayout(content));
    preferences(content);
  };

  const apply = layouts.applyLayoutContent.bind(layouts);
  layouts.applyLayoutContent = async text => {
    const content = parse(text);
    if (!content) return apply(text);
    const valid = await apply(JSON.stringify(sessionLevels.prepareLayout(content)));
    // The native reader filters these extra fields. Read them only after it
    // has accepted and restored the layout, then use the validated setters.
    if (valid) preferences(content);
    return valid;
  };
}

export function installGridLayoutPersistence(grid) {
  const session = grid.getLayoutSession();
  let pending = Promise.resolve();
  // The grid reader validates each chart but drops viewer settings. Restore
  // those fields through the same per-chart setters as a standalone layout.
  grid.applyLayoutContent = async text => {
    const raw = parse(text);
    const content = readGridLayout(raw);
    if (!content) return false;
    content.cells = content.cells.map((cell, index) => {
      const source = raw.cells[index];
      const settings = { ...cell.settings };
      for (const key of VIEW_SETTINGS) {
        if (typeof source.settings?.[key] === 'string') settings[key] = source.settings[key];
      }
      return { ...cell, settings, sessions: source.sessions };
    });
    await grid.restoreLayout(content);
    return true;
  };

  const remember = () => {
    const current = session.current();
    if (current) {
      try { localStorage.setItem(ACTIVE_LAYOUT_KEY, current.id); } catch { /* The current layout stays open. */ }
    }
  };
  for (const name of ['open', 'save', 'saveAs']) {
    const operation = session[name].bind(session);
    session[name] = (...args) => {
      const task = operation(...args).then(result => {
        if (result) remember();
        return result;
      });
      pending = task.then(() => {}, () => {});
      return task;
    };
  }
  let last;
  try { last = localStorage.getItem(ACTIVE_LAYOUT_KEY); } catch { /* Open the most recently saved layout. */ }
  const reopen = async () => {
    if (last && await session.open(last)) return;
    const [recent] = await session.list();
    if (recent) await session.open(recent.id);
  };
  const reopening = reopen().catch(error => console.warn('Layout restore:', error.message));
  return {
    async ready() {
      await reopening;
      let current;
      do {
        current = pending;
        await current;
      } while (current !== pending);
    },
  };
}
