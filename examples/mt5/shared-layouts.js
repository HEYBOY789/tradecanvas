import { readGridLayout } from '@tradecanvas/chart/widget';

const ACTIVE_KEY = 'mt5:active-layout:v1';
const MIGRATION_KEY = 'mt5:shared-layouts-migrated:v1';

function fingerprint(text) {
  // A compact change detector for the local migration marker; the server
  // independently uses SHA-256 to make the actual migration idempotent.
  let a = 2166136261, b = 5381;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ text.charCodeAt(i);
  }
  return `${text.length}:${a >>> 0}:${b >>> 0}`;
}

export async function sharedLayoutStorage(local) {
  const base = new Map(), loaded = new Map();
  let catalog, grid, operations, status, reload, fork, timer;
  let inflight = null, failure = '', stopped = false;
  let migrating = false;

  async function request(query = '', command) {
    try {
      const response = await fetch(`/api/layouts${query}`, {
        ...(command ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MT5-Layouts': '1' }, body: JSON.stringify(command) } : {}),
        signal: AbortSignal.timeout(15000),
      });
      const result = await response.json();
      if (!response.ok) {
        const error = new Error(result.error || 'Chưa lưu được bố cục lên máy chính.');
        error.status = response.status;
        throw error;
      }
      failure = '';
      return result;
    } catch (error) {
      failure = error.status === 409 ? error.message : 'Mất kết nối kho bố cục trên máy chính. Thay đổi chưa được lưu.';
      render();
      throw error;
    }
  }

  function render() {
    if (!status || !grid) return;
    const current = grid.getLayoutSession().current();
    const remote = catalog?.layouts.find(item => item.id === current?.id);
    const changed = current && (!base.has(current.id) || base.get(current.id) !== remote?.revision);
    status.textContent = failure || (changed
      ? remote ? 'Bố cục đang mở có bản mới từ máy khác.' : 'Bố cục đang mở đã bị xóa ở máy khác.'
      : grid.getLayoutSession().isDirty() ? 'Thay đổi chart chưa được lưu lên máy chính.'
        : 'Bố cục lưu trên máy chính · Đã đồng bộ');
    status.dataset.error = String(Boolean(failure || changed));
    reload.hidden = !changed || !remote;
    fork.hidden = !changed;
  }

  async function updateCatalog(refreshUI = true, fresh = false) {
    if (inflight && fresh) await inflight.catch(() => {});
    if (inflight) return inflight;
    inflight = (async () => {
      const next = await request();
      const changed = catalog && (catalog.generation !== next.generation || catalog.storeId !== next.storeId);
      if (catalog && catalog.storeId !== next.storeId) base.clear();
      catalog = next;
      render();
      if (changed && refreshUI && grid) {
        // UI refresh calls session.list() again. Run after the in-flight
        // catalog promise has settled so a visible menu never waits on itself.
        setTimeout(() => {
          if (stopped) return;
          const ui = grid.layoutsUI;
          if (ui?.dialog.isOpen()) void ui.dialog.refresh().catch(() => {});
          if (ui?.menu.isOpen() && grid.layoutsButton) {
            ui.menu.close();
            void ui.openMenu(grid.layoutsButton);
          }
        }, 0);
      }
      return catalog.layouts;
    })().finally(() => { inflight = null; });
    return inflight;
  }

  const storage = {
    getRevision(id) { return base.get(id); },
    keepRevision(id, revision) { if (id && Number.isInteger(revision)) base.set(id, revision); render(); },
    async list() { return updateCatalog(false); },
    async load(id) {
      const result = await request(`?${new URLSearchParams({ id })}`);
      if (result.layout) loaded.set(id, result.layout);
      return result.layout;
    },
    async save(layout) {
      const last = loaded.get(layout.id);
      // Native rename loads the latest content and keeps updatedAt intact.
      // It must not advance a stale, still-open chart's content revision.
      const rename = last && layout.content === last.content && layout.updatedAt === last.updatedAt && layout.name !== last.name;
      const revision = rename ? last.revision : base.get(layout.id) ?? null;
      const result = await request('', { action: 'save', layout, revision });
      if (!rename || base.get(layout.id) === last.revision) base.set(layout.id, result.layout.revision);
      Object.assign(layout, { updatedAt: result.layout.updatedAt });
      loaded.set(layout.id, result.layout);
      await updateCatalog(true, true);
    },
    async remove(id) {
      const revision = base.get(id) ?? catalog?.layouts.find(item => item.id === id)?.revision ?? null;
      await request('', { action: 'remove', id, revision });
      base.delete(id); loaded.delete(id);
      await updateCatalog(true, true);
    },
    bind(session) {
      const open = session.open.bind(session);
      session.open = async id => {
        const opened = await open(id);
        if (opened && loaded.has(id)) base.set(id, loaded.get(id).revision);
        render();
        return opened;
      };
    },
    attach(owner, ready) {
      grid = owner; operations = ready;
      const group = document.createElement('div');
      group.className = 'tcw-grid-group mt5-layout-sync';
      status = document.createElement('span');
      status.id = 'mt5-layout-sync'; status.setAttribute('role', 'status');
      reload = document.createElement('button');
      reload.type = 'button'; reload.className = 'tcw-btn'; reload.textContent = 'Mở bản máy chính';
      reload.addEventListener('click', async () => {
        reload.disabled = true;
        try {
          await operations.ready();
          const id = grid.getLayoutSession().current()?.id;
          if (id) await grid.getLayoutSession().open(id);
        } catch (error) { grid.getActiveWidget().toast(error.message, 'error'); }
        finally { reload.disabled = false; render(); }
      });
      fork = document.createElement('button');
      fork.type = 'button'; fork.className = 'tcw-btn'; fork.textContent = 'Lưu thành bản mới';
      fork.addEventListener('click', () => grid.layoutsUI.promptSaveAs());
      group.append(status, reload, fork);
      document.querySelector('.tcw-grid-bar').append(group);
      render();
      const poll = async () => {
        if (stopped) return;
        try { await updateCatalog(); } catch { /* Keep edits in the current chart; never claim a local save. */ }
        if (!stopped) timer = setTimeout(poll, 1000);
      };
      timer = setTimeout(poll, 1000);
      const destroy = grid.destroy.bind(grid);
      grid.destroy = () => { stopped = true; clearTimeout(timer); destroy(); };
    },
  };

  await updateCatalog(false);
  let remembered = {};
  try { remembered = JSON.parse(localStorage.getItem(MIGRATION_KEY) || '{}'); } catch { /* Retain local originals. */ }
  if (!remembered || typeof remembered !== 'object' || Array.isArray(remembered)) remembered = {};
  if (remembered.storeId !== catalog.storeId) remembered = { storeId: catalog.storeId, entries: {} };
  if (!remembered.entries || typeof remembered.entries !== 'object' || Array.isArray(remembered.entries)) remembered.entries = {};
  // Original browser records remain untouched. Server-side migration is also
  // idempotent, so interrupted imports and cleared browser flags remain safe.
  for (const entry of await local.list()) {
    const saved = await local.load(entry.id);
    let content;
    try { content = JSON.parse(saved?.content); } catch { continue; }
    if (!readGridLayout(content)) continue;
    const signature = fingerprint(JSON.stringify([saved.name, saved.content]));
    if (remembered.entries[entry.id]?.fingerprint === signature) continue;
    migrating = true;
    const result = await request('', { action: 'migrate', layout: saved });
    Object.defineProperty(remembered.entries, entry.id, { value: { fingerprint: signature, id: result.id }, enumerable: true, configurable: true, writable: true });
    try {
      if (localStorage.getItem(ACTIVE_KEY) === entry.id && result.layout) localStorage.setItem(ACTIVE_KEY, result.id);
      localStorage.setItem(MIGRATION_KEY, JSON.stringify(remembered));
    } catch { /* Server migration records prevent duplicates even without browser storage. */ }
  }
  if (migrating) await updateCatalog(false);
  return storage;
}
