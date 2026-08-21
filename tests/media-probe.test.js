const test = require('node:test');
const assert = require('node:assert/strict');

const { parseMediaProbeJson, parseVideoProbe } = require('../scripts/media-probe');

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

test('media probe distinguishes still images and reports audio, VFR timing, and rotation', () => {
  const probe = JSON.stringify({
    streams: [
      {
        codec_type: 'video',
        width: 1080,
        height: 1920,
        avg_frame_rate: '24000/1001',
        r_frame_rate: '30/1',
        side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }],
      },
      { codec_type: 'audio' },
    ],
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '12.5' },
  });
  assert.deepEqual(parseMediaProbeJson(probe), {
    mediaKind: 'video',
    width: 1080,
    height: 1920,
    fps: 24000 / 1001,
    durationSec: 12.5,
    hasAudio: true,
    rotation: 270,
  });

  assert.deepEqual(parseMediaProbeJson(JSON.stringify({
    streams: [{ codec_type: 'video', width: 640, height: 480, r_frame_rate: '25/1' }],
    format: { format_name: 'png_pipe' },
  })), {
    mediaKind: 'image',
    width: 640,
    height: 480,
    fps: 0,
    durationSec: 0,
    hasAudio: false,
    rotation: 0,
  });
});

test('media probe rejects malformed JSON, attached-picture-only media, and invalid geometry', () => {
  for (const input of [
    '',
    '{broken',
    JSON.stringify({ streams: [], format: { format_name: 'mov', duration: '1' } }),
    JSON.stringify({
      streams: [{ codec_type: 'video', width: 640, height: 480, disposition: { attached_pic: 1 } }],
      format: { format_name: 'mp3', duration: '1' },
    }),
    JSON.stringify({
      streams: [{ codec_type: 'video', width: 0, height: 480, avg_frame_rate: '25/1' }],
      format: { format_name: 'mov', duration: '1' },
    }),
  ]) {
    assert.throws(() => parseMediaProbeJson(input), /media probe/i);
  }
});
