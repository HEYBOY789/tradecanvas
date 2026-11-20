export const ORDER_TYPES = [['market', 'Market'], ['limit', 'Limit'], ['stop', 'Stop'], ['stopLimit', 'Stop Limit']];

const FX_CURRENCIES = new Set('AUD CAD CHF CNH CZK DKK EUR GBP HKD HUF JPY MXN NOK NZD PLN SEK SGD THB TRY USD ZAR'.split(' '));
const CENT_PIP = /^(XAU|XAG|XALUSD|XCU|XNI|XPB|XZN|UKOIL|USOIL|DXY)/;
const TENTH_PIP = /^(BTCUSD|ETHUSD|XPDUSD|XPTUSD|AUS200|FR40|USTEC|US500|STOXX50|UK100)/;
const WHOLE_PIP = /^(BTCAUD|BTCCNH|US30|DE30|HK50|JP225)/;

// Exness specifications. Broker suffixes such as "m" follow the instrument name.
export function pipSize(symbol) {
  const name = symbol?.toUpperCase() || '';
  if (CENT_PIP.test(name) || name.startsWith('BTCXAG')) return .01;
  if (TENTH_PIP.test(name)) return .1;
  if (WHOLE_PIP.test(name)) return 1;
  if (/^BTC(THB|ZAR|JPY)/.test(name)) return 10;
  if (name.startsWith('XNGUSD')) return .001;
  if (name.startsWith('BCXAU')) return .0001;
  const base = name.slice(0, 3), currency = name.slice(3, 6);
  if (base !== currency && FX_CURRENCIES.has(base) && FX_CURRENCIES.has(currency)) return currency === 'JPY' ? .01 : .0001;
}

export function roundPrice(value, quote) {
  const step = quote?.tickSize || 0.001;
  return Number((Math.round(value / step) * step).toFixed(quote?.digits ?? 8));
}

export function drawingOrder(chart, id, quote) {
  const drawing = chart.getDrawings().find(item => item.id === id && item.type === 'riskReward');
  if (!drawing || drawing.anchors.length < 2 || drawing.pane) throw new Error('Chọn hình Long/Short trên chart giá với đủ Entry và SL.');
  const options = chart.getDrawingOptions(id);
  const entry = drawing.anchors[0].price, stop = drawing.anchors[1].price;
  if (!(entry > 0) || !(stop > 0) || entry === stop) throw new Error('Entry và SL của hình vẽ phải khác nhau.');
  const side = stop < entry ? 'buy' : 'sell';
  const ratio = Number(options.rewardRatio ?? 2);
  return { side, type: 'limit', price: roundPrice(entry, quote), stopLoss: roundPrice(stop, quote),
    takeProfit: roundPrice(entry + (side === 'buy' ? 1 : -1) * Math.abs(entry - stop) * ratio, quote),
    quantityMode: options.riskMode === 'amount' ? 'riskAmount' : 'riskPercent', quantity: Number(options.risk ?? 1), drawingId: id };
}

export function orderIntent(draft, estimate) {
  if (!estimate || !(estimate.quantity > 0)) throw new Error('Chờ MT5 tính khối lượng hợp lệ.');
  const result = { side: draft.side, type: draft.type, quantity: estimate.quantity, price: draft.price };
  if (draft.type === 'stopLimit') result.stopPrice = draft.stopPrice;
  if (draft.type === 'stop') result.stopPrice = draft.price;
  if (draft.type !== 'market') result.timeInForce = draft.nativeTimeInForce || draft.timeInForce || 'gtc';
  if (draft.expiresAt != null) result.expiresAt = draft.expiresAt;
  if (draft.stopLoss != null) result.stopLoss = draft.stopLoss;
  if (draft.takeProfit != null) result.takeProfit = draft.takeProfit;
  return result;
}

function offsetDirection(side, role) {
  if (role === 'stopLoss') return side === 'buy' ? -1 : 1;
  if (role === 'takeProfit') return side === 'buy' ? 1 : -1;
  return 1;
}

export function priceFromUnit(value, mode, entry, side, role, quote) {
  const direction = offsetDirection(side, role);
  if (mode === 'pips') return roundPrice(entry + direction * value * quote.pipSize, quote);
  if (mode === 'ticks') return roundPrice(entry + direction * value * quote.tickSize, quote);
  if (mode === 'percent') return roundPrice(entry * (1 + direction * value / 100), quote);
  return roundPrice(value, quote);
}

export function valueInUnit(price, mode, entry, quote, side, role) {
  if (price == null) return '';
  if (mode !== 'price' && !Number.isFinite(entry)) return '';
  if (mode === 'pips') return Number(((price - entry) / quote.pipSize * offsetDirection(side, role)).toFixed(8));
  if (mode === 'ticks' && (role === 'price' || role === 'stopPrice')) return Number(((price - entry) / quote.tickSize).toFixed(3));
  if (mode === 'ticks') return Number((Math.abs(price - entry) / quote.tickSize).toFixed(3));
  if (mode === 'percent') return Number((Math.abs(price - entry) / entry * 100).toFixed(4));
  return price;
}

export function translatedOrder(row, entry, quote) {
  const delta = entry - (row.price ?? row.entryPrice);
  const result = { ...row, price: roundPrice(entry, quote) };
  for (const field of ['stopLoss', 'takeProfit', 'stopPrice']) if (row[field] != null) result[field] = roundPrice(row[field] + delta, quote);
  return result;
}

export function bracketSide(side, entry, price) {
  return (side === 'buy' ? price < entry : price > entry) ? 'stopLoss' : 'takeProfit';
}
