import { SESSION_DST_ZONES } from './session-dst.js';

const STORAGE_KEY = 'mt5:texmoonbeam-sessions:v1';
const GREEN = '#4caf50';
const RED = '#f23645';
const AQUA = '#00bcd4';
const BLUE = '#2196f3';
const styles = ['solid', 'dotted', 'dashed'];
const timeZones = [
  'GMT-12', 'GMT-11', 'GMT-10', 'GMT-9:30', 'GMT-9', 'GMT-8', 'GMT-7', 'GMT-6',
  'GMT-5', 'GMT-4', 'GMT-3:30', 'GMT-3', 'GMT-2', 'GMT-1', 'GMT',
  'GMT+1', 'GMT+2', 'GMT+3', 'GMT+3:30', 'GMT+4', 'GMT+4:30', 'GMT+5',
  'GMT+5:30', 'GMT+5:45', 'GMT+6', 'GMT+6:30', 'GMT+7', 'GMT+8', 'GMT+8:45',
  'GMT+9', 'GMT+9:30', 'GMT+10', 'GMT+10:30', 'GMT+11', 'GMT+12', 'GMT+12:45',
  'GMT+13', 'GMT+14', 'Asia/Ho_Chi_Minh', 'Asia/Tokyo', 'Europe/London', 'America/New_York',
];

export const PERIODS = [
  ['monday', 'Thứ Hai', 'Mon', 'M', true],
  ['previousDay', 'Ngày trước', 'Prev Day', 'PD', true],
  ['currentWeek', 'Tuần hiện tại', 'Weekly', 'W', false],
  ['previousWeek', 'Tuần trước', 'Prev Week', 'PW', true],
  ['currentMonth', 'Tháng hiện tại', 'Month', 'Mth', false],
  ['previousMonth', 'Tháng trước', 'Prev Month', 'PMth', true],
  ['weekOpen', 'Mở cửa tuần', 'Week Open', 'WO', false, true],
  ['monthOpen', 'Mở cửa tháng', 'Month Open', 'MthO', false, true],
];

export const SESSIONS = [
  ['asia', 'Châu Á', '22:00', '07:00', GREEN],
  ['london', 'London', '08:00', '17:00', RED],
  ['newYork', 'New York', '13:00', '21:00', AQUA],
];

export const FIBONACCI_LEVELS = [
  ['p000', 0], ['p236', 23.6], ['p382', 38.2], ['p500', 50], ['p618', 61.8], ['p786', 78.6], ['p100', 100],
];
export const PREVIOUS_PERIODS = ['previousDay', 'previousWeek', 'previousMonth'];
const FIBONACCI_COLORS = { p000: RED, p236: '#f23645', p382: '#ff9800', p500: '#089981', p618: '#0097a7', p786: '#5f63df', p100: GREEN };

const customTimes = [['00:00', '23:45'], ['00:15', '23:45'], ['12:00', '14:00']];

export const DEFAULTS = {
  shortLabels: true, labelSize: 'small', zone: 'GMT+1', alerts: false,
  history: false, borderWidth: 1, borderStyle: 'solid', transparency: 80,
  fibonacci: {
    levels: Object.fromEntries(FIBONACCI_LEVELS.map(([id]) => [id, true])),
    colors: { ...FIBONACCI_COLORS },
    direction: 'Low → High', width: 1, style: 'solid', label: true, history: false, labelOutlineColor: '#0c1016', labelOutlineWidth: 1,
  },
  periods: Object.fromEntries(PERIODS.map(([id, , , , enabled, open]) => [id, {
    enabled, label: enabled, extend: false, width: 1, style: 'solid', labelOutlineColor: '#0c1016', labelOutlineWidth: 1, lineBorderColor: '#0c1016', lineBorderWidth: 0,
    ...(open ? { openColor: BLUE } : {
      offset: 0, highColor: GREEN, lowColor: RED,
      fibonacci: PREVIOUS_PERIODS.includes(id),
      fibonacciLevels: Object.fromEntries(FIBONACCI_LEVELS.map(([level]) => [level, true])),
      fibonacciColors: { ...FIBONACCI_COLORS }, fibonacciDirection: 'Low → High',
    }),
  }])),
  sessions: Object.fromEntries(SESSIONS.map(([id, , start, end, color]) => [id, {
    enabled: true, start, end, color, openColor: color, extend: false, showOpen: false,
    fibonacci: true, ...(SESSION_DST_ZONES[id] ? { autoDst: false } : {}),
  }])),
  custom: Array.from({length: 6}, (_, i) => {
    const [start, end] = customTimes[i % customTimes.length];
    return { enabled: false, label: '', type: 'high', start, end, days: '23456',
      color: '#000000', extend: false, history: false, style: 'solid' };
  }),
};

function migratePeriodFibonacci(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const periods = { ...snapshot.periods };
  for (const [id, , , , , open] of PERIODS) {
    const options = periods[id] ?? {};
    periods[id] = {
      ...options,
      labelOutlineColor: options.labelOutlineColor ?? snapshot.fibonacci?.labelOutlineColor,
      labelOutlineWidth: options.labelOutlineWidth ?? snapshot.fibonacci?.labelOutlineWidth,
      ...(!open ? {
        fibonacci: options.mid === true ? true : options.fibonacci,
        fibonacciLevels: options.mid === true ? { ...(options.fibonacciLevels ?? snapshot.fibonacci?.levels), p500: true } : options.fibonacciLevels ?? snapshot.fibonacci?.levels,
        fibonacciColors: options.fibonacciColors ?? snapshot.fibonacci?.colors,
        fibonacciDirection: options.fibonacciDirection ?? snapshot.fibonacci?.direction,
      } : {}),
    };
  }
  return { ...snapshot, periods };
}

export function createSessionSettings(validateZone) {
  const dialog = document.getElementById('sessions-dialog');
  const form = document.getElementById('sessions-form');
  const fields = [];
  const value = structuredClone(DEFAULTS);
  let editing;
  let saved;
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { /* Default settings. */ }
  saved = migratePeriodFibonacci(saved);
  // Previous versions stored the header toggle as `active`.
  let placement = {
    present: saved?.placement?.present !== false,
    visible: saved?.placement?.visible ?? saved?.active !== false,
  };

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...value, placement })); } catch { /* Use the current settings. */ }
  }

  function element(parent, tag, text) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    parent.append(node);
    return node;
  }

  function group(parent, title, open = false) {
    const section = element(parent, 'details');
    section.open = open;
    element(section, 'summary', title);
    return element(section, 'div');
  }

  function field(parent, path, title, type, options = {}) {
    const label = element(parent, 'label', title);
    const input = element(label, type === 'select' ? 'select' : 'input');
    if (type === 'select') {
      for (const option of options) input.add(new Option(option, option));
    } else {
      input.type = type;
      Object.assign(input, options);
    }
    const get = (root = value) => path.reduce((state, key) => state?.[key], root);
    const put = (next, root = value) => {
      const parent = path.slice(0, -1).reduce((state, key) => state[key], root);
      parent[path.at(-1)] = next;
    };
    const write = (savedValue, target = input) => {
      if (type === 'checkbox') target.checked = savedValue;
      else target.value = savedValue;
    };
    const read = (target = input) => type === 'checkbox' ? target.checked : type === 'number' ? target.valueAsNumber : target.value.trim();
    const validate = stored => {
      if (typeof stored !== typeof get()) return undefined;
      // Validate a detached control, keeping an open editor's draft intact.
      const probe = input.cloneNode(true);
      write(stored, probe);
      const parsed = read(probe);
      return probe.validity.valid && (type !== 'select' || options.includes(parsed)) &&
        (type !== 'number' || Number.isFinite(parsed)) ? parsed : undefined;
    };
    const restore = root => {
      const parsed = validate(get(root || {}));
      if (parsed !== undefined) put(parsed);
      write(get());
    };
    restore(saved);
    fields.push({ get, put, read, write, validate });
    return input;
  }

  function checks(parent, path, controls) {
    for (const [key, title] of controls) field(parent, [...path, key], title, 'checkbox');
  }

  function hours(parent, path) {
    field(parent, [...path, 'start'], 'Bắt đầu', 'time', { required: true });
    field(parent, [...path, 'end'], 'Kết thúc', 'time', { required: true });
  }

  function lineStyle(parent, path, widthKey = 'width', styleKey = 'style', min = .05) {
    field(parent, [...path, widthKey], 'Độ dày', 'number', { min, max: min ? '4' : '', step: .05, required: true });
    field(parent, [...path, styleKey], 'Kiểu nét', 'select', styles);
  }

  function fibonacciLevels(parent, levelsPath, colorsPath) {
    const levelControls = FIBONACCI_LEVELS.map(([id, percent]) => {
      const title = `${String(percent).replace('.', ',')}%`;
      const row = element(parent, 'div');
      row.className = 'sessions-fibo-level';
      const checkbox = field(row, [...levelsPath, id], title, 'checkbox');
      const color = field(row, [...colorsPath, id], 'Màu', 'color');
      color.setAttribute('aria-label', `Màu mức ${title}`);
      return checkbox;
    });
    const shortcuts = element(parent, 'div');
    shortcuts.className = 'sessions-fibo-shortcuts';
    for (const [title, checked] of [['Hiện tất cả', true], ['Tắt tất cả', false]]) {
      const button = element(shortcuts, 'button', title);
      button.type = 'button';
      button.addEventListener('click', () => {
        for (const input of levelControls) input.checked = checked;
      });
    }
  }

  const general = group(form, 'Chung', true);
  checks(general, [], [['shortLabels', 'Viết tắt nhãn'], ['alerts', 'Báo khi giá cắt mức']]);
  field(general, ['labelSize'], 'Cỡ nhãn', 'select', ['tiny', 'small', 'normal', 'large', 'huge']);
  const zoneOptions = [...timeZones];
  if (typeof saved?.zone === 'string' && !zoneOptions.includes(saved.zone)) {
    try {
      validateZone(saved.zone);
      zoneOptions.push(saved.zone);
    } catch { /* Use the default for an invalid saved zone. */ }
  }
  const zone = field(general, ['zone'], 'Múi giờ phiên', 'select', zoneOptions);
  zone.required = true;
  for (const option of zone.options) {
    if (option.value === 'GMT+7') option.textContent = 'GMT+7 (Việt Nam)';
  }
  zone.addEventListener('change', () => zone.setCustomValidity(''));

  const fibonacci = group(form, 'Fibonacci phiên trước', true);
  fibonacciLevels(fibonacci, ['fibonacci', 'levels'], ['fibonacci', 'colors']);
  field(fibonacci, ['fibonacci', 'direction'], 'Chiều Fibo (0% → 100%)', 'select', ['Low → High', 'High → Low']);
  checks(fibonacci, ['fibonacci'], [['label', 'Hiện số Fibo'], ['history', 'Giữ Fibo phiên cũ']]);
  field(fibonacci, ['fibonacci', 'labelOutlineColor'], 'Màu viền số Fibo', 'color');
  field(fibonacci, ['fibonacci', 'labelOutlineWidth'], 'Độ dày viền số Fibo', 'number', { min: 0, max: 4, step: .05, required: true });
  lineStyle(fibonacci, ['fibonacci']);

  const sessions = group(form, 'Phiên giao dịch', true);
  checks(sessions, [], [['history', 'Giữ hộp phiên cũ']]);
  lineStyle(sessions, [], 'borderWidth', 'borderStyle', 0);
  field(sessions, ['transparency'], 'Độ trong nền (%)', 'number', { min: 0, max: 100, required: true });
  for (const [id, title] of SESSIONS) {
    const controls = group(sessions, title);
    const path = ['sessions', id];
    checks(controls, path, [['enabled', 'Hiện hộp'], ['extend', 'Kéo dài sang phải'], ['showOpen', 'Giá mở phiên']]);
    checks(controls, path, [['fibonacci', 'Fibo phiên trước']]);
    if (SESSION_DST_ZONES[id]) {
      field(controls, [...path, 'autoDst'], 'Tự đổi giờ mùa đông/hè', 'checkbox');
      const hint = element(controls, 'small', `Nhập giờ mùa hè. Mùa đông tự +1 giờ theo lịch ${title} khi dùng GMT/UTC cố định. Tính theo ngày từng nến, kể cả lịch sử; múi giờ địa phương có DST được tính bù.`);
      hint.className = 'sessions-dst-hint';
    }
    hours(controls, path);
    field(controls, [...path, 'color'], 'Màu hộp', 'color');
    field(controls, [...path, 'openColor'], 'Màu giá mở', 'color');
  }

  const periods = group(form, 'Mức ngày, tuần và tháng');
  for (const [id, title, , , , open] of PERIODS) {
    const controls = group(periods, title);
    const path = ['periods', id];
    checks(controls, path, [['enabled', 'Hiện mức'], ['extend', 'Kéo dài sang phải'], ['label', 'Hiện nhãn']]);
    field(controls, [...path, 'labelOutlineColor'], 'Màu viền chữ', 'color');
    field(controls, [...path, 'labelOutlineWidth'], 'Độ dày viền chữ', 'number', { min: 0, max: 4, step: .05, required: true });
    field(controls, [...path, 'lineBorderColor'], 'Màu viền đường', 'color');
    field(controls, [...path, 'lineBorderWidth'], 'Độ dày viền đường', 'number', { min: 0, max: 4, step: .05, required: true });
    lineStyle(controls, path);
    if (open) {
      field(controls, [...path, 'openColor'], 'Màu giá mở', 'color');
    } else {
      field(controls, [...path, 'offset'], 'Dời nhãn và đầu nét (số nến)', 'number', { step: 1, required: true });
      for (const [key, title] of [['highColor', 'Màu High'], ['lowColor', 'Màu Low']]) {
        field(controls, [...path, key], title, 'color');
      }
      const fibonacci = group(controls, 'Fibonacci');
      checks(fibonacci, path, [['fibonacci', 'Hiện Fibo']]);
      fibonacciLevels(fibonacci, [...path, 'fibonacciLevels'], [...path, 'fibonacciColors']);
      field(fibonacci, [...path, 'fibonacciDirection'], 'Chiều Fibo (0% → 100%)', 'select', ['Low → High', 'High → Low']);
    }
  }

  const custom = group(form, '6 mức tùy chỉnh');
  for (let i = 0; i < DEFAULTS.custom.length; i++) {
    const controls = group(custom, `Mức ${i + 1}`);
    const path = ['custom', i];
    checks(controls, path, [['enabled', 'Hiện mức'], ['extend', 'Kéo dài sang phải'], ['history', 'Giữ mức cũ']]);
    hours(controls, path);
    field(controls, [...path, 'days'], 'Ngày (1=CN, 2=T2 … 7=T7)', 'text', { pattern: '[1-7]{1,7}', required: true });
    field(controls, [...path, 'type'], 'Giá', 'select', ['high', 'low', 'open']);
    field(controls, [...path, 'label'], 'Nhãn', 'text', { maxLength: 60 });
    field(controls, [...path, 'color'], 'Màu', 'color');
    field(controls, [...path, 'style'], 'Kiểu nét', 'select', styles);
  }

  function normalize(snapshot) {
    snapshot = migratePeriodFibonacci(snapshot);
    if (typeof snapshot?.zone === 'string' && !zoneOptions.includes(snapshot.zone)) {
      try {
        validateZone(snapshot.zone);
        zoneOptions.push(snapshot.zone);
        zone.add(new Option(snapshot.zone, snapshot.zone));
      } catch { /* Use the default zone for an invalid saved one. */ }
    }
    const next = structuredClone(DEFAULTS);
    for (const control of fields) {
      const parsed = control.validate(control.get(snapshot));
      if (parsed !== undefined) control.put(parsed, next);
    }
    return next;
  }

  function remember(snapshot) {
    Object.assign(value, normalize(snapshot));
    save();
  }

  dialog.addEventListener('close', () => { editing = undefined; });
  document.getElementById('sessions-cancel').addEventListener('click', () => dialog.close());
  form.addEventListener('invalid', ({ target }) => {
    for (let section = target.closest('details'); section; section = section.parentElement.closest('details')) {
      section.open = true;
    }
  }, true);
  document.getElementById('sessions-save').addEventListener('click', () => {
    try { validateZone(zone.value.trim()); }
    catch { zone.setCustomValidity('Chọn một múi giờ hợp lệ trong danh sách.'); }
    if (!form.reportValidity()) return;
    const next = structuredClone(editing?.value ?? value);
    for (const control of fields) control.put(control.read(), next);
    const apply = editing?.apply;
    dialog.close();
    if (apply) apply(next);
    else remember(next);
  });
  form.addEventListener('submit', event => event.preventDefault());
  return {
    value,
    normalize,
    remember,
    get placement() { return placement; },
    setPlacement(next) {
      if (placement.present === next.present && placement.visible === next.visible) return;
      placement = next;
      save();
    },
    open(snapshot = value, apply) {
      editing = { value: normalize(snapshot), apply };
      for (const control of fields) control.write(control.get(editing.value));
      zone.setCustomValidity('');
      dialog.showModal();
    },
  };
}
