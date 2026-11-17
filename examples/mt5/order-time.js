// Wire times are UTC milliseconds. Only form/display values use the chart zone.
function parts(epoch, zone) {
  const match = /^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(zone || '');
  const offset = match ? (match[1] === '-' ? -1 : 1) * (+match[2] * 60 + +(match[3] || 0)) * 60000 : 0;
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: match ? 'UTC' : zone === 'exchange' || !zone ? 'UTC' : zone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return Object.fromEntries(formatter.formatToParts(epoch + offset).map(p => [p.type, p.value]));
}
export function wallTime(epoch, zone = 'UTC', clock = '24h') {
  const p = parts(epoch, zone), hour = +p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${String(clock === '12h' ? hour % 12 || 12 : hour).padStart(2, '0')}:${p.minute}`, period: hour >= 12 ? 'PM' : 'AM' };
}
export function parseWallTime(date, text, period, zone = 'UTC', clock = '24h') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(text)) throw new Error('Nhập ngày và giờ dạng HH:mm.');
  let [hour, minute] = text.split(':').map(Number);
  if (minute > 59 || hour > (clock === '12h' ? 12 : 23) || (clock === '12h' && hour < 1)) throw new Error('Giờ không hợp lệ.');
  if (clock === '12h') hour = hour % 12 + (period === 'PM' ? 12 : 0);
  const wanted = `${date} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const guess = Date.parse(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  // Candidate offsets include both sides of a DST transition. Nonexistent or
  // ambiguous local times require an unambiguous UTC/offset zone selection.
  const offsets = new Set([-36, 0, 36].map(h => {
    const at = guess + h * 3600000, p = parts(at, zone);
    return Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`) - at;
  }));
  const candidates = [...offsets].map(offset => guess - offset).filter(at => {
    const value = wallTime(at, zone); return `${value.date} ${value.time}` === wanted;
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
