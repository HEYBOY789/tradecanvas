import { tradeGestures } from './order-gestures.js';

export function orderProjection(widget, read, change, submit, cancel, bracketMode, update) {
  return tradeGestures(widget, {
    draft: true, disabled: () => read().sending, change, submit, cancel, bracketMode, update,
    read() {
      const current = read(), draft = current.draft;
      return { quote: current.quote, accountId: current.accountId, quantity: current.estimate?.quantity, sending: current.sending,
        targets: draft && draft.type !== 'market' && widget.getSymbol() === draft.symbol
          ? [{ key: 'draft', kind: 'draft', row: draft, canMoveEntry: true }] : [] };
    },
  });
}

export function pendingStopHandles(widget, read, complete, disabled, activate, bracketMode, error) {
  const chart = widget.getChart();
  return tradeGestures(widget, {
    disabled, activate, bracketMode, error,
    read() {
      const current = read();
      return { quote: current.quote, accountId: current.accountId, blockedPrices: current.draftPrices,
        targets: [
          ...current.orders.map(row => ({ key: `order:${row.id}`, kind: 'order', row, canMoveEntry: true })),
          ...(current.positions || []).map(row => ({ key: `position:${row.id}`, kind: 'position', row, canMoveEntry: false })),
        ] };
    },
    preview(target, row) {
      const source = target.kind === 'order' ? read().orders : read().positions;
      const visible = target.kind === 'order' ? chart.getOrders() : chart.getPositions();
      const current = visible.find(item => item.id === row.id);
      if (current && ['price', 'stopPrice', 'stopLoss', 'takeProfit'].every(field => current[field] === row[field])) return;
      const changed = source.map(item => item.id === row.id ? row : item);
      if (target.kind === 'order') chart.setOrders(changed); else chart.setPositions(changed);
    },
    restore() { if (!widget.root.isConnected) return; const current = read(); chart.setOrders(current.orders); chart.setPositions(current.positions || []); },
    complete,
  });
}
