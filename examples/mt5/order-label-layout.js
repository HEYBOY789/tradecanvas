const HEIGHT = 22, GAP = 3, COLUMN_GAP = 12;
const quantity = value => Number(value).toLocaleString('en-US', { maximumFractionDigits: 8, useGrouping: false });

export function tradeLabel(row, kind, field, currency) {
  const size = quantity(row.quantity);
  if (field !== 'price') return `${{ stopLoss: 'SL', takeProfit: 'TP', stopPrice: 'STOP' }[field]} · ${size}`;
  const side = row.side.toUpperCase();
  if (kind === 'order') return `${side} ${row.type === 'stopLimit' ? 'STOP LIMIT' : row.type.toUpperCase()} · ${size}`;
  const profit = Number.isFinite(row.profit) ? ` · ${row.profit >= 0 ? '+' : ''}${row.profit.toFixed(2)} ${currency}` : '';
  return `${side} · ${size}${profit}`;
}

// Labels move inside the plot; lineY always remains the actual price. Extra
// columns keep dense groups reachable even when an indicator shrinks the pane.
export function layoutTradeLabels(items, bounds) {
  if (!items.length || bounds.width <= 0 || bounds.height <= 0) return [];
  const height = Math.min(HEIGHT, bounds.height);
  const capacity = Math.max(1, Math.floor((bounds.height + GAP) / (height + GAP)));
  const columns = Math.ceil(items.length / capacity);
  const gap = Math.min(COLUMN_GAP, bounds.width / (columns * 2));
  const columnWidth = (bounds.width - gap * (columns - 1)) / columns;
  const ordered = [...items].sort((a, b) => a.lineY - b.lineY || a.key.localeCompare(b.key));
  const result = [];
  for (let column = 0; column < columns; column++) {
    const rows = ordered.slice(column * capacity, (column + 1) * capacity);
    const tops = rows.map(row => Math.max(bounds.y, Math.min(bounds.y + bounds.height - height, row.lineY - height / 2)));
    for (let i = 1; i < tops.length; i++) tops[i] = Math.max(tops[i], tops[i - 1] + height + GAP);
    tops[tops.length - 1] = Math.min(tops.at(-1), bounds.y + bounds.height - height);
    for (let i = tops.length - 2; i >= 0; i--) tops[i] = Math.min(tops[i], tops[i + 1] - height - GAP);
    rows.forEach((row, i) => {
      const width = Math.min(row.width, columnWidth), right = bounds.x + bounds.width - column * (columnWidth + gap);
      result.push({ ...row, x: right - width, y: tops[i], width, height });
    });
  }
  return result;
}
