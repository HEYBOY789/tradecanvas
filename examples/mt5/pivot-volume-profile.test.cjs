const assert = require('node:assert/strict');
const { test } = require('node:test');

const makeBar = (i, close, volume = 10) => ({ time: i * 60000, open: close - .5, high: close + 1, low: close - 1, close, volume });
const settings = { pivotLength: 1, rows: 10, valueArea: .68, showPoc: true, showVah: true, showVal: true,
  extendPoc: 'touch', volumeLength: 3, weightedCandles: true, highThreshold: 1.618, lowThreshold: .618 };

test('profiles leave the closing pivot volume to the next range and prefer the upper row on a value-area tie', async () => {
  const { buildProfile } = await import('./pivot-volume-profile-model.js');
  const data = [{ high: 0, low: 0, volume: 10 }, { high: 1.5, low: 1.5, volume: 25 },
    { high: 2.5, low: 2.5, volume: 10 }, { high: 4, low: 4, volume: 2 }, { high: 4, low: 0, volume: 999 }];
  const profile = buildProfile(data, 0, 4, 4, .68);
  assert.deepEqual(Array.from(profile.bins), [10, 25, 10, 2]);
  assert.deepEqual([profile.volume, profile.poc, profile.val, profile.vah], [47, 1.5, 1, 3]);
  assert.equal(buildProfile(data, 0, 0, 4, .68), null);
  assert.equal(buildProfile(data.map(bar => ({ ...bar, volume: 0 })), 0, 4, 4, .68), null);
});

test('Pine-style candle distribution puts each intersected price row in the histogram', async () => {
  const { buildProfile } = await import('./pivot-volume-profile-model.js');
  const bars = [{ low: 0, high: 4, volume: 40 }, { low: 1.25, high: 2.25, volume: 12 }, { low: 0, high: 4, volume: 100 }];
  assert.deepEqual(Array.from(buildProfile(bars, 0, 2, 4, .68).bins), [10, 22, 22, 10]);
});

test('the last closed bar on the right confirms the pivot and the forming range can update independently', async () => {
  const { newProfileOutput, updateProfiles } = await import('./pivot-volume-profile-model.js');
  const data = [11, 13, 10, 14, 10, 13, 11].map((price, i) => makeBar(i, price, i === 5 ? 60 : 10));
  const output = updateProfiles(data, settings, newProfileOutput());
  assert.deepEqual(output.meta.profiles.map(p => [p.start, p.end]), [[1, 2], [2, 3], [3, 4]]);
  assert.deepEqual([output.meta.developing.start, output.meta.developing.end], [4, 6]);
  assert.equal(output.meta.tones[5], 2);
  assert.equal(output.meta.tones[6], 4);
  const changed = [...data.slice(0, 6), makeBar(6, 12, 18)];
  updateProfiles(changed, settings, output);
  assert.equal(output.meta.developing.start, 4);
  const appended = [...changed, makeBar(7, 14)];
  const incremental = updateProfiles(appended, settings, output);
  assert.deepEqual(incremental, updateProfiles(appended, settings, newProfileOutput()));
  assert.deepEqual([incremental.meta.developing.start, incremental.meta.developing.end], [5, 7]);
});

test('POC Touch stops at a wick while Cross keeps extending until the close changes sides', async () => {
  const { pocBreached } = await import('./pivot-volume-profile-model.js');
  const data = [{ close: 11 }, { close: 11, low: 9, high: 12 }, { close: 9, low: 8, high: 11 }];
  assert.equal(pocBreached(data, 1, 10, 'touch'), true);
  assert.equal(pocBreached(data, 1, 10, 'cross'), false);
  assert.equal(pocBreached(data, 2, 10, 'cross'), true);
});
