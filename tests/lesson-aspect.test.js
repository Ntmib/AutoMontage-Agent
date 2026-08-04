const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveOutputGeometry } = require('../scripts/lesson/aspect');

test('source preserves exact source geometry', () => {
  assert.deepEqual(
    resolveOutputGeometry({
      sourceWidth: 2560,
      sourceHeight: 1440,
      sourceFps: 25,
      aspect: 'source',
    }),
    { aspect: 'source', width: 2560, height: 1440, fps: 25 },
  );
});

test('source is the default aspect', () => {
  assert.deepEqual(
    resolveOutputGeometry({ sourceWidth: 1080, sourceHeight: 1920, sourceFps: 30 }),
    { aspect: 'source', width: 1080, height: 1920, fps: 30 },
  );
});

test('vertical overrides dimensions and preserves fps', () => {
  assert.deepEqual(
    resolveOutputGeometry({
      sourceWidth: 1920,
      sourceHeight: 1080,
      sourceFps: 50,
      aspect: 'vertical',
    }),
    { aspect: 'vertical', width: 1080, height: 1920, fps: 50 },
  );
});

test('horizontal alias overrides dimensions and preserves fps', () => {
  assert.deepEqual(
    resolveOutputGeometry({
      sourceWidth: 1080,
      sourceHeight: 1920,
      sourceFps: 30,
      aspect: '16:9',
    }),
    { aspect: 'horizontal', width: 1920, height: 1080, fps: 30 },
  );
});

test('unknown aspect fails before rendering', () => {
  assert.throws(
    () => resolveOutputGeometry({
      sourceWidth: 1920,
      sourceHeight: 1080,
      sourceFps: 30,
      aspect: 'square',
    }),
    /source, vertical, horizontal/,
  );
});
