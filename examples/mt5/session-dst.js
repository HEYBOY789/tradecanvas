const DAY = 86400000, MINUTE = 60000;
export const SESSION_DST_ZONES = { london: 'Europe/London', newYork: 'America/New_York' };
const formatters = new Map(), days = new Map(), summers = new Map();

function offsetAt(time, zone) {
  const fixed = /^(?:GMT|UTC)(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$/i.exec(zone);
  if (fixed) return (fixed[1] === '-' ? -1 : 1) * (Number(fixed[2] || 0) * 60 + Number(fixed[3] || 0));
  if (!formatters.has(zone)) formatters.set(zone, new Intl.DateTimeFormat('en-GB', { timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  const p = Object.fromEntries(formatters.get(zone).formatToParts(time).map(part => [part.type, Number(part.value)]));
  return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(time / MINUTE) * MINUTE) / MINUTE;
}

// Most dates need two offset reads once. Only a clock-change date needs a
// minute search, keeping large histories cheap without rounding a transition.
function marketDay(time, zone) {
  const day = Math.floor(time / DAY), key = `${zone}:${day}`;
  if (!days.has(key)) {
    const start = day * DAY, before = offsetAt(start, zone), after = offsetAt(start + DAY - MINUTE, zone);
    let change = Infinity;
    if (before !== after) {
      let low = 0, high = 1440;
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (offsetAt(start + middle * MINUTE, zone) === before) low = middle;
        else high = middle;
      }
      change = start + high * MINUTE;
    }
    days.set(key, { before, after, change });
  }
  return days.get(key);
}

// Normalize each bar into the entered summer schedule, including its date.
// Its actual timestamp stays intact for drawing and completed-session Fibo.
export function seasonalSessionClock(bars, clock, session, displayZone = 'GMT') {
  const market = SESSION_DST_ZONES[session];
  if (!market || market === displayZone) return clock;
  let lastDay, marketClock, summer;
  return bars.map((bar, index) => {
    const day = Math.floor(bar.time / DAY);
    if (day !== lastDay) {
      lastDay = day; marketClock = marketDay(bar.time, market);
      const year = new Date(bar.time).getUTCFullYear(), key = `${market}:${displayZone}:${year}`;
      if (!summers.has(key)) {
        const reference = Date.UTC(year, 6, 15, 12);
        summers.set(key, { market: offsetAt(reference, market), display: offsetAt(reference, displayZone) });
      }
      summer = summers.get(key);
    }
    const local = clock[index].day * 1440 + clock[index].minute;
    const displayOffset = local - Math.floor(bar.time / MINUTE);
    const offset = bar.time < marketClock.change ? marketClock.before : marketClock.after;
    const shift = summer.market - offset + displayOffset - summer.display;
    const normalized = local - shift;
    return { day: Math.floor(normalized / 1440), minute: (normalized % 1440 + 1440) % 1440 };
  });
}
