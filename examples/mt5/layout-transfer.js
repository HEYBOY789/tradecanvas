import { cleanLayoutName, DEFAULT_GRID_SYNC, GRID_SHAPES, readGridLayout, readWidgetLayout } from '@tradecanvas/chart/widget';

const FORMAT = 'mt5-tradecanvas-layout';

function readLayoutFile(text, config) {
  let value;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error('File không phải JSON bố cục hợp lệ.'); }
  let name = 'Bố cục đã nhập';
  if (value?.format === FORMAT) {
    if (value.version !== 1) throw new Error('Phiên bản file bố cục chưa được hỗ trợ.');
    if (typeof value.name === 'string') name = cleanLayoutName(value.name) ?? name;
    value = value.layout;
  } else if (typeof value?.content === 'string') {
    if (typeof value.name === 'string') name = cleanLayoutName(value.name) ?? name;
    try { value = JSON.parse(value.content); }
    catch { throw new Error('Nội dung bố cục trong file không hợp lệ.'); }
  }
  if (readWidgetLayout(value)) {
    value = { v: 1, kind: 'grid', layout: '1x1', active: 0,
      sync: { ...DEFAULT_GRID_SYNC, symbol: true }, cells: [value] };
  }
  const checked = readGridLayout(value);
  if (!checked) throw new Error('File không chứa bố cục TradeCanvas hợp lệ.');
  const shape = GRID_SHAPES[checked.layout];
  const count = shape.areas?.length ?? shape.cols * shape.rows;
  if (checked.cells.length < count || checked.cells.length > config.maxCharts) {
    throw new Error('Số ô chart trong file không khớp bố cục được hỗ trợ.');
  }
  const symbols = new Set(config.symbols.map(info => info.symbol.toUpperCase()));
  for (const cell of checked.cells) {
    if (!symbols.has(cell.symbol.toUpperCase())) throw new Error(`Mã ${cell.symbol} chưa có trong Market Watch MT5.`);
    if (!config.frames.includes(cell.timeframe)) throw new Error(`MT5 chưa hỗ trợ khung ${cell.timeframe} trong file.`);
  }
  // Keep the raw viewer settings and Sessions fields. The normal layout loader
  // validates them through its setters while restoring each chart.
  return { name, layout: value };
}

export function installLayoutTransfer(grid, container, storage, config, operations) {
  const bar = container.querySelector('.tcw-grid-bar');
  const root = container.querySelector('.tcw-grid');
  const session = grid.getLayoutSession();
  const controls = document.createElement('div');
  controls.className = 'tcw-grid-group';
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', 'Xuất và nhập bố cục');
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.hidden = true;
  input.setAttribute('aria-label', 'File bố cục JSON');
  container.appendChild(input);

  const button = label => {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'tcw-btn';
    node.textContent = label;
    controls.appendChild(node);
    return node;
  };
  const exportButton = button('Xuất bố cục');
  const importButton = button('Nhập bố cục');
  bar.insertBefore(controls, bar.querySelector('.tcw-layouts-btn'));
  const toast = (message, kind = 'info') => grid.getActiveWidget().toast(message, kind);

  exportButton.addEventListener('click', async () => {
    exportButton.disabled = true;
    try {
      await operations.ready();
      const name = session.current()?.name ?? 'Bố cục MT5';
      const file = { format: FORMAT, version: 1, name, layout: grid.captureLayout() };
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      const filename = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/, '').slice(0, 80);
      anchor.download = `tradecanvas-${filename || 'bo-cuc'}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      toast('Chưa xuất được bố cục. Hãy thử lại.', 'error');
    } finally {
      exportButton.disabled = false;
    }
  });
  importButton.addEventListener('click', () => {
    input.value = '';
    input.click();
  });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    root.inert = true;
    root.setAttribute('aria-busy', 'true');
    importButton.textContent = 'Đang nhập…';
    let previous;
    let previousId;
    let previousRevision;
    let importedId;
    let opening = false;
    try {
      const imported = readLayoutFile(await file.text(), config);
      await operations.ready();
      previous = grid.captureLayout();
      previousId = session.current()?.id;
      previousRevision = storage.getRevision?.(previousId);
      const random = crypto.getRandomValues(new Uint32Array(4));
      importedId = `import-${Array.from(random, value => value.toString(16).padStart(8, '0')).join('')}`;
      const lead = imported.layout.cells[imported.layout.active] ?? imported.layout.cells[0];
      await storage.save({ id: importedId, kind: 'grid', name: imported.name,
        updatedAt: Date.now(), content: JSON.stringify(imported.layout),
        symbol: lead.symbol, timeframe: lead.timeframe });
      opening = true;
      if (!await session.open(importedId)) throw new Error('Chưa mở được bố cục đã nhập.');
      toast(`Đã nhập bố cục “${imported.name}”.`);
    } catch (error) {
      if (opening) {
        try {
          if (previousId) await session.open(previousId);
          await grid.restoreLayout(previous);
          storage.keepRevision?.(previousId, previousRevision);
          session.changed();
        } catch {
          toast('Chưa khôi phục được chart trước khi nhập. Bố cục đã lưu vẫn có trong danh sách.', 'error');
        }
      }
      if (importedId) {
        try { await storage.remove(importedId); } catch { /* Preserve the original import error. */ }
      }
      toast(error.message || 'Chưa nhập được bố cục.', 'error');
    } finally {
      root.inert = false;
      root.removeAttribute('aria-busy');
      importButton.textContent = 'Nhập bố cục';
      input.value = '';
    }
  });
}
