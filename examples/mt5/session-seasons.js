export const SESSION_SEASONS = ['Mùa hè', 'Mùa đông'];
const WINTER_OFFSET_MINUTES = { asia: 0, london: 60, newYork: 60 };
const validTime = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);

function suggestedWinter(time, offset) {
  const [hour, minute] = time.split(':').map(Number);
  const shifted = (hour * 60 + minute + offset) % 1440;
  return `${String(Math.floor(shifted / 60)).padStart(2, '0')}:${String(shifted % 60).padStart(2, '0')}`;
}

export function withSessionSeasons(id, snapshot, defaults) {
  const options = { ...defaults, ...snapshot };
  delete options.autoDst;
  const start = validTime(snapshot?.start) ? snapshot.start : defaults.start;
  const end = validTime(snapshot?.end) ? snapshot.end : defaults.end;
  const offset = WINTER_OFFSET_MINUTES[id] ?? 0;
  return { ...options, start, end,
    season: SESSION_SEASONS.includes(snapshot?.season) ? snapshot.season : SESSION_SEASONS[0],
    // Seed once from the saved hours; either pair can then be edited independently.
    winterStart: validTime(snapshot?.winterStart) ? snapshot.winterStart : suggestedWinter(start, offset),
    winterEnd: validTime(snapshot?.winterEnd) ? snapshot.winterEnd : suggestedWinter(end, offset),
  };
}

export function sessionHours(options) {
  return options.season === SESSION_SEASONS[1]
    ? { ...options, start: options.winterStart, end: options.winterEnd }
    : options;
}
