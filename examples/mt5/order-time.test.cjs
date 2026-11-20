const assert = require('node:assert/strict');
const { test } = require('node:test');
test('expiry uses chart timezone, explicit AM/PM and rejects DST ambiguity', async () => {
  const { wallTime, parseWallTime } = await import('./order-time.js');
  const at = Date.UTC(2026, 10, 17, 16, 30);
  assert.deepEqual(wallTime(at, 'Asia/Ho_Chi_Minh', '12h'), { date: '2026-11-17', time: '11:30', period: 'PM' });
  assert.equal(parseWallTime('2026-11-17', '11:30', 'PM', 'Asia/Ho_Chi_Minh', '12h'), at);
  assert.equal(parseWallTime('2026-11-17', '23:30', 'AM', 'GMT+7'), at);
  assert.equal(parseWallTime('2026-11-17', '23:30', 'AM', '420'), at);
  assert.equal(parseWallTime('2026-11-17', '22:15', 'AM', 'GMT+5:45'), at);
  const local = new Date(at);
  assert.equal(wallTime(at, 'local').time, [local.getHours(), local.getMinutes()].map(value => String(value).padStart(2, '0')).join(':'));
  assert.equal(parseWallTime('2026-11-18', '12:00', 'AM', 'UTC', '12h'), Date.UTC(2026, 10, 18));
  assert.throws(() => parseWallTime('2026-03-08', '02:30', 'AM', 'America/New_York'), /DST/);
  assert.throws(() => parseWallTime('2026-11-01', '01:30', 'AM', 'America/New_York'), /DST/);
});
