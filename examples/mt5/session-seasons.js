import { zoneOffsetMinutes } from '@tradecanvas/commons';

// The custom Asian range follows London so it can end at the European open.
export const SESSION_SEASON_ZONES = { asia: 'Europe/London', london: 'Europe/London', newYork: 'America/New_York' };
const WINTER_OFFSET_MINUTES = { asia: { start: 0, end: 60 }, london: { start: 60, end: 60 }, newYork: { start: 60, end: 60 } };
const summerOffsets = new Map();
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
  const offset = WINTER_OFFSET_MINUTES[id] ?? { start: 0, end: 0 };
  return { ...options, start, end,
    // Seed once from the saved hours; either pair can then be edited independently.
    winterStart: validTime(snapshot?.winterStart) ? snapshot.winterStart : suggestedWinter(start, offset.start),
    winterEnd: validTime(snapshot?.winterEnd) ? snapshot.winterEnd : suggestedWinter(end, offset.end),
  };
}

// The bar's timestamp chooses the pair. Entered times stay in the session's
// configured timezone, so no second clock shift is applied to either pair.
export function sessionSchedule(id, options) {
  const zone = SESSION_SEASON_ZONES[id];
  if (!zone) return () => options;
  const winter = { ...options, start: options.winterStart ?? options.start, end: options.winterEnd ?? options.end };
  return time => {
    const year = new Date(time).getUTCFullYear(), summerKey = `${zone}:${year}`;
    if (!summerOffsets.has(summerKey)) summerOffsets.set(summerKey, zoneOffsetMinutes(zone, Date.UTC(year, 6, 15, 12)));
    return zoneOffsetMinutes(zone, time) === summerOffsets.get(summerKey) ? options : winter;
  };
}
