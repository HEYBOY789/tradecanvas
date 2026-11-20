import { offsetAt, timeParts } from '@tradecanvas/commons';

// Wire times are UTC milliseconds. Only form/display values use the chart zone.
function chartZone(zone) {
  const match = /^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(zone || '');
  if (match) return (match[1] === '-' ? -1 : 1) * (+match[2] * 60 + +(match[3] || 0));
  if (/^-?\d+$/.test(zone)) return Number(zone);
  if (zone === 'local' || zone === null) return null;
  return zone === 'exchange' || !zone ? 'UTC' : zone;
}
const pad = value => String(value).padStart(2, '0');
export function wallTime(epoch, zone = 'UTC', clock = '24h') {
  const { year, month, day, hours, minutes } = timeParts(epoch, chartZone(zone));
  return { date: `${year}-${pad(month)}-${pad(day)}`, time: `${pad(clock === '12h' ? hours % 12 || 12 : hours)}:${pad(minutes)}`, period: hours >= 12 ? 'PM' : 'AM' };
}
export function parseWallTime(date, text, period, zone = 'UTC', clock = '24h') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(text)) throw new Error('Nhập ngày và giờ dạng HH:mm.');
  let [hour, minute] = text.split(':').map(Number);
  if (minute > 59 || hour > (clock === '12h' ? 12 : 23) || (clock === '12h' && hour < 1)) throw new Error('Giờ không hợp lệ.');
  if (clock === '12h') hour = hour % 12 + (period === 'PM' ? 12 : 0);
  const time = `${pad(hour)}:${pad(minute)}`;
  const guess = Date.parse(`${date}T${time}:00Z`);
  if (!Number.isFinite(guess)) throw new Error('Ngày hết hạn không hợp lệ.');
  const timezone = chartZone(zone);
  // Candidate offsets include both sides of a DST transition. Nonexistent or
  // ambiguous local times require an unambiguous UTC/offset zone selection.
  const offsets = new Set([-36, 0, 36].map(h => offsetAt(timezone, guess + h * 3600000)));
  const candidates = [...offsets].map(offset => guess - offset * 60000).filter(at => {
    const value = wallTime(at, zone); return value.date === date && value.time === time;
  });
  if (candidates.length !== 1) throw new Error('Giờ này trùng hoặc không tồn tại do DST. Chọn UTC/offset rõ ràng.');
  return candidates[0];
}
export function timeLabel(epoch, zone = 'UTC', clock = '24h') {
  if (!epoch) return 'Không thời hạn';
  const value = wallTime(epoch, zone, clock);
  return `${value.date} ${value.time}${clock === '12h' ? ` ${value.period}` : ''} · ${zone}`;
}

export function expiryFields({ zone, clock, change }) {
  const root = document.createElement('div'); root.className = 'mt5-expiry-fields';
  function input(type, label) { const wrapper = document.createElement('label'); wrapper.textContent = label;
    const node = document.createElement('input'); node.type = type; node.setAttribute('aria-label', label); wrapper.append(node); root.append(wrapper); return node; }
  const date = input('date', 'Ngày hết hạn'), time = input('text', 'Giờ hết hạn'); time.placeholder = 'HH:mm';
  const format = document.createElement('select'); format.setAttribute('aria-label', 'Định dạng giờ');
  for (const [value, label] of [['24h', '24 giờ'], ['12h', 'AM / PM']]) format.add(new Option(label, value));
  const period = document.createElement('select'); period.setAttribute('aria-label', 'AM / PM');
  for (const value of ['AM', 'PM']) period.add(new Option(value, value));
  const label = document.createElement('small'), error = document.createElement('p'); error.className = 'order-ticket-error'; error.setAttribute('role', 'status');
  root.append(format, period, label, error); let epoch = null, signature = '';
  function render(value = epoch) {
    epoch = value;
    const key = `${value}|${zone()}|${clock()}`;
    if (key === signature) return; signature = key;
    format.value = clock(); period.hidden = clock() !== '12h'; label.textContent = `Múi giờ chart: ${zone()}`;
    if (value) { const p = wallTime(value, zone(), clock()); date.value = p.date; time.value = p.time; period.value = p.period; }
  }
  function read() { return parseWallTime(date.value, time.value, period.value, zone(), clock()); }
  for (const node of [date, time, period]) node.addEventListener('change', () => {
    try { const value = read(); error.textContent = ''; change(value); epoch = value; signature = ''; render(); }
    catch (issue) { error.textContent = issue.message; change(NaN); }
  });
  format.addEventListener('change', () => { clock(format.value); signature = ''; render(); });
  return { root, render, read };
}
