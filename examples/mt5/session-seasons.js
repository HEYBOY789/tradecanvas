export const SESSION_SEASON_ZONES = { london: 'Europe/London', newYork: 'America/New_York' };
const WINTER_OFFSET_MINUTES = { asia: 0, london: 60, newYork: 60 };
const DAY = 86400000, MINUTE = 60000;
const formatters = new Map(), days = new Map(), summerOffsets = new Map();
const validTime = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);

function suggestedWinter(time, offset) {
  const [hour, minute] = time.split(':').map(Number);
  const shifted = (hour * 60 + minute + offset) % 1440;
  return `${String(Math.floor(shifted / 60)).padStart(2, '0')}:${String(shifted % 60).padStart(2, '0')}`;
}

export function withSessionSeasons(id, snapshot, defaults) {
  const options = { ...defaults, ...snapshot };
  delete options.autoDst;
  delete options.season;
  const start = validTime(snapshot?.start) ? snapshot.start : defaults.start;
  const end = validTime(snapshot?.end) ? snapshot.end : defaults.end;
  const offset = WINTER_OFFSET_MINUTES[id] ?? 0;
  return { ...options, start, end,
    // Seed once from the saved hours; either pair can then be edited independently.
    winterStart: validTime(snapshot?.winterStart) ? snapshot.winterStart : suggestedWinter(start, offset),
    winterEnd: validTime(snapshot?.winterEnd) ? snapshot.winterEnd : suggestedWinter(end, offset),
  };
}

function offsetAt(time, zone) {
  if (!formatters.has(zone)) formatters.set(zone, new Intl.DateTimeFormat('en-GB', { timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  const parts = Object.fromEntries(formatters.get(zone).formatToParts(time).map(part => [part.type, Number(part.value)]));
  return (Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - Math.floor(time / MINUTE) * MINUTE) / MINUTE;
}

function calendarDay(time, zone) {
  const day = Math.floor(time / DAY), key = `${zone}:${day}`;
  if (!days.has(key)) {
    const start = day * DAY, before = offsetAt(start, zone), after = offsetAt(start + DAY - MINUTE, zone);
    let change = Infinity;
    if (before !== after) {
      let low = 0, high = DAY / MINUTE;
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (offsetAt(start + middle * MINUTE, zone) === before) low = middle;
        else high = middle;
      }
      change = start + high * MINUTE;
    }
    const year = new Date(time).getUTCFullYear(), summerKey = `${zone}:${year}`;
    if (!summerOffsets.has(summerKey)) summerOffsets.set(summerKey, offsetAt(Date.UTC(year, 6, 15, 12), zone));
    days.set(key, { before, after, change, summer: summerOffsets.get(summerKey) });
  }
  return days.get(key);
}

// The bar's timestamp chooses the pair. Entered times stay in the session's
// configured timezone, so no second clock shift is applied to either pair.
export function sessionSchedule(id, options) {
  const zone = SESSION_SEASON_ZONES[id];
  if (!zone) return () => options;
  const winter = { ...options, start: options.winterStart ?? options.start, end: options.winterEnd ?? options.end };
  let lastDay, calendar;
  return time => {
    const day = Math.floor(time / DAY);
    if (day !== lastDay) { lastDay = day; calendar = calendarDay(time, zone); }
    const offset = time < calendar.change ? calendar.before : calendar.after;
    return offset === calendar.summer ? options : winter;
  };
}
