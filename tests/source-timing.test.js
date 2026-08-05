const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveSourceTiming } = require('../scripts/source-timing');

test('preserves fractional NTSC FPS and rounds duration frames up', () => {
  assert.deepEqual(
    resolveSourceTiming({ fps: 30000 / 1001, duration: 10.01 }),
    { fps: 30000 / 1001, durationInFrames: Math.ceil(10.01 * (30000 / 1001)) },
  );
  assert.deepEqual(
    resolveSourceTiming({ fps: 24000 / 1001, duration: 8 }),
    { fps: 24000 / 1001, durationInFrames: Math.ceil(8 * (24000 / 1001)) },
  );
});

test('rejects invalid source FPS and duration', () => {
  for (const fps of [0, -1, NaN, Infinity]) {
    assert.throws(
      () => resolveSourceTiming({ fps, duration: 1 }),
      /Source FPS must be a positive finite number/,
    );
  }
  for (const duration of [0, -1, NaN, Infinity]) {
    assert.throws(
      () => resolveSourceTiming({ fps: 25, duration }),
      /Source duration must be a positive finite number/,
    );
  }
});

test('caps a positive integer frames override at available source frames', () => {
  assert.deepEqual(
    resolveSourceTiming({ fps: 25, duration: 2.01, framesOverride: 999 }),
    { fps: 25, durationInFrames: 51 },
  );
  assert.deepEqual(
    resolveSourceTiming({ fps: 25, duration: 2.01, framesOverride: 12 }),
    { fps: 25, durationInFrames: 12 },
  );
  for (const framesOverride of [0, -1, 1.5, NaN, Infinity, 10_000_001]) {
    assert.throws(
      () => resolveSourceTiming({ fps: 25, duration: 1, framesOverride }),
      /--frames/,
    );
  }
});
