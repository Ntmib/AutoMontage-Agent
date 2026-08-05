const test = require('node:test');
const assert = require('node:assert/strict');

const { parseVideoProbe } = require('../scripts/media-probe');

function validProbe(overrides = {}) {
  return JSON.stringify({
    streams: [{
      codec_type: 'video',
      width: 1920,
      height: 1080,
      r_frame_rate: '25/1',
      duration: '14.0',
      ...overrides,
    }],
    format: { duration: '14.0' },
  });
}

test('video probe parses finite geometry, FPS and duration', () => {
  assert.deepEqual(parseVideoProbe(validProbe(), 'source probe'), {
    width: 1920,
    height: 1080,
    fps: 25,
    duration: 14,
  });
});

test('video probe fails cleanly on empty, malformed or missing video JSON', () => {
  for (const input of ['', '{broken', '{"streams":[],"format":{"duration":"1"}}']) {
    assert.throws(() => parseVideoProbe(input, 'source probe'), /source probe/);
  }
});

test('video probe rejects invalid FPS and non-positive durations', () => {
  for (const rate of ['25/0', 'N/A', 'NaN', 'Infinity', '0/1']) {
    assert.throws(() => parseVideoProbe(validProbe({ r_frame_rate: rate }), 'source probe'), /source probe.*FPS/);
  }
  for (const duration of ['0', '-1', 'N/A', 'NaN', 'Infinity']) {
    const input = JSON.stringify({
      streams: [{ codec_type: 'video', width: 10, height: 10, r_frame_rate: '25/1' }],
      format: { duration },
    });
    assert.throws(() => parseVideoProbe(input, 'source probe'), /source probe.*duration/);
  }
});
