import { roundPrice, translatedOrder } from './order-model.js';

export const stopDistance = q => Math.max(q?.stops || 0, q?.tickSize || .001);
export const closingQuote = (row, q) => row.side === 'buy' ? q.bid : q.ask;
const reference = (row, q, kind) => kind === 'position' || row.type === 'market' ? closingQuote(row, q) : row.price;
const pendingDirection = (side, type) => (side === 'buy') !== (type === 'limit') ? 1 : -1;
const pendingQuote = (side, q) => side === 'buy' ? q.ask : q.bid;

export function defaultPendingPrice(side, type, q) {
  // Leave room for tick rounding and small quote movements while the draft opens.
  const distance = stopDistance(q) + Math.max(q.ask - q.bid, q.tickSize || .001);
  return roundPrice(pendingQuote(side, q) + pendingDirection(side, type) * distance, q);
}

export function pendingPriceIssue(side, type, price, q) {
  if (!(price > 0)) return 'Giá đặt phải lớn hơn 0.';
  const gap = stopDistance(q), epsilon = (q.tickSize || .001) / 100;
  const direction = pendingDirection(side, type);
  if ((price - pendingQuote(side, q)) * direction >= gap - epsilon) return '';
  return `${side === 'buy' ? 'Buy' : 'Sell'} ${type === 'limit' ? 'Limit' : 'Stop'} phải ${direction > 0 ? 'cao hơn' : 'thấp hơn'} ${side === 'buy' ? 'Ask' : 'Bid'} ít nhất ${gap}.`;
}

export function tradeIssue(row, q, kind = 'draft', now = Date.now()) {
  if (!q || !(q.bid > 0) || !(q.ask >= q.bid)) return 'Chưa có Bid/Ask hợp lệ.';
  if (kind === 'draft' && q.orderMode != null && !(q.orderMode & { market: 1, limit: 2, stop: 4, stopLimit: 8 }[row.type])) return 'Broker không hỗ trợ loại lệnh này.';
  if (kind === 'draft' && row.type !== 'market' && q.expirationMode != null &&
      !(q.expirationMode & { gtc: 1, day: 2, specified: 4 }[row.nativeTimeInForce || row.timeInForce || 'gtc'])) return 'Broker không hỗ trợ thời hạn này.';
  const buy = row.side === 'buy', gap = stopDistance(q), epsilon = (q.tickSize || .001) / 100;
  const ge = (a, b) => a >= b - epsilon, le = (a, b) => a <= b + epsilon;
  if (kind !== 'position' && row.type !== 'market') {
    const price = row.type === 'stopLimit' ? row.stopPrice : row.price;
    const issue = pendingPriceIssue(row.side, row.type, price, q);
    if (issue) return issue;
    if (row.type === 'stopLimit' && !(buy ? le(row.price, price) : ge(row.price, price))) return 'Giá Limit: Buy phải ≤ Stop; Sell phải ≥ Stop.';
  }
  const entry = reference(row, q, kind);
  if (['stopLoss', 'takeProfit'].some(field => row[field] != null && !(row[field] > 0))) return 'Giá SL/TP phải lớn hơn 0.';
  if (row.stopLoss != null && !(buy ? le(row.stopLoss, entry - gap) : ge(row.stopLoss, entry + gap))) return `SL phải ${buy ? 'thấp hơn' : 'cao hơn'} ${kind === 'position' || row.type === 'market' ? buy ? 'Bid' : 'Ask' : 'Entry'} ít nhất ${gap}.`;
  if (row.takeProfit != null && !(buy ? ge(row.takeProfit, entry + gap) : le(row.takeProfit, entry - gap))) return `TP phải ${buy ? 'cao hơn' : 'thấp hơn'} ${kind === 'position' || row.type === 'market' ? buy ? 'Bid' : 'Ask' : 'Entry'} ít nhất ${gap}.`;
  if (kind === 'draft' && row.expiresAt != null && (!Number.isFinite(row.expiresAt) || row.expiresAt <= now)) return 'Thời hạn phải ở tương lai theo múi giờ chart.';
  return '';
}

function flip(row, q) {
  const entry = row.price;
  const result = { ...row, side: row.side === 'buy' ? 'sell' : 'buy' };
  for (const field of ['stopLoss', 'takeProfit']) if (row[field] != null) result[field] = roundPrice(2 * entry - row[field], q);
  return result;
}

export function projectOrder(original, field, value, q, kind = 'draft') {
  const gap = Math.max(stopDistance(q), kind === 'draft' ? 0 : q.freeze || 0);
  let row = field === 'price' ? translatedOrder(original, value, q) : { ...original, [field]: roundPrice(value, q) };
  if (kind === 'draft' && row.type !== 'market') {
    const buy = row.side === 'buy';
    if (field === 'price' || field === 'stopPrice') {
      const at = row.type === 'stopLimit' ? row.stopPrice : row.price;
      const wanted = row.type === 'limit' ? at >= q.bid + gap ? 'sell' : at <= q.ask - gap ? 'buy' : row.side
        : at >= q.ask + gap ? 'buy' : at <= q.bid - gap ? 'sell' : row.side;
      if (wanted !== row.side) row = flip(row, q);
    } else if ((field === 'stopLoss' && (buy ? value > row.price : value < row.price)) ||
               (field === 'takeProfit' && (buy ? value < row.price : value > row.price))) {
      row = flip(original, q); row[field] = roundPrice(value, q);
      const above = row.price >= q.ask + gap;
      row.type = (row.side === 'buy') === above ? 'stop' : 'limit';
      row.stopPrice = row.type === 'stop' ? row.price : null;
    }
    if (row.type === 'stopLimit') row.price = row.side === 'buy' ? Math.min(row.price, row.stopPrice) : Math.max(row.price, row.stopPrice);
    return row;
  }
  // A placed order cannot change its MT5 type in-place; a filled position
  // cannot reverse. Clamp only the dragged level to the broker-valid side.
  const buy = row.side === 'buy';
  if (field === 'stopLoss' || field === 'takeProfit') {
    const at = reference(row, q, kind), above = (field === 'takeProfit') === buy;
    row[field] = roundPrice(above ? Math.max(value, at + gap) : Math.min(value, at - gap), q);
  } else if (kind === 'order') {
    const at = buy ? q.ask : q.bid, above = buy !== (row.type === 'limit');
    if (row.type === 'stopLimit') {
      const stop = roundPrice(buy ? Math.max(row.stopPrice, at + gap, row.price) : Math.min(row.stopPrice, at - gap, row.price), q);
      row = field === 'price' ? translatedOrder(original, original.price + stop - original.stopPrice, q) : { ...row, stopPrice: stop };
    } else {
      const price = roundPrice(above ? Math.max(value, at + gap) : Math.min(value, at - gap), q);
      row = field === 'price' ? translatedOrder(original, price, q) : { ...row, [field]: price };
    }
  }
  return row;
}
