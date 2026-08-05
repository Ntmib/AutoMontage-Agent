const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  audioExtractionCommand,
  frameAnalysisCommand,
  paletteCommand,
  reframeCommand,
  remotionRenderCommand,
  videoProbeCommand,
} = require('../scripts/build-commands');
const { parseBuildOptions } = require('../scripts/build-options');

const ROOT = path.resolve(__dirname, '..');
const HOSTILE = path.resolve(ROOT, `tmp/- clip ' " $() ;\nЮникод.mp4`);

test('build process builders keep hostile host paths as one absolute argv', () => {
  const probe = videoProbeCommand(HOSTILE);
  assert.equal(probe.command, 'ffprobe');
  assert.equal(probe.args.at(-1), HOSTILE);

  const reframe = reframeCommand('/python 3', ROOT, HOSTILE, `${HOSTILE}.out`, 'track');
  assert.equal(reframe.command, '/python 3');
  assert.deepEqual(reframe.args.slice(0, 3), [
    path.join(ROOT, 'scripts/reframe.py'),
    HOSTILE,
    `${HOSTILE}.out`,
  ]);

  const audio = audioExtractionCommand(HOSTILE, `${HOSTILE}.wav`);
  assert.equal(audio.args[2], HOSTILE);
  assert.deepEqual(audio.args.slice(-3), ['-ac', '1', `${HOSTILE}.wav`]);

  const analysis = frameAnalysisCommand('/python 3', ROOT, HOSTILE, '1,2', `${HOSTILE}.json`);
  assert.equal(analysis.args[1], HOSTILE);
  assert.equal(analysis.args.at(-1), `${HOSTILE}.json`);

  const palette = paletteCommand(ROOT, HOSTILE, 0.5);
  assert.equal(palette.command, process.execPath);
  assert.equal(palette.args[1], HOSTILE);
});

test('Remotion keeps entry refs relative and host output paths absolute', () => {
  const resolved = { command: process.execPath, argsPrefix: ['/repo/remotion-cli.js'] };
  const command = remotionRenderCommand(resolved, {
    entry: 'src/index.js',
    composition: 'Dynamic',
    output: HOSTILE,
    props: `${HOSTILE}.json`,
  });
  assert.equal(command.args[2], 'src/index.js');
  assert.equal(command.args[4], HOSTILE);
  assert.deepEqual(command.args.slice(5, 7), ['--props', `${HOSTILE}.json`]);
});

test('build rejects non-finite, out-of-range and injected numeric options', () => {
  for (const [flag, value] of [
    ['--frames', '0'], ['--frames', '1.5'], ['--frames', 'Infinity'],
    ['--max', '0'], ['--max', '101'], ['--max', '1;touch sentinel'],
    ['--beatSec', '0'], ['--beatSec', '61'], ['--beatSec', 'NaN'],
    ['--brandLock', '-0.1'], ['--brandLock', '1.1'], ['--brandLock', '$()'],
  ]) {
    assert.throws(() => parseBuildOptions([flag, value]), new RegExp(flag.slice(2)));
  }
});

test('build accepts only supported reframe modes and valid ranges', () => {
  assert.equal(parseBuildOptions(['--reframe']).reframeMode, 'track');
  assert.equal(parseBuildOptions(['--reframe', 'static']).reframeMode, 'static');
  assert.throws(() => parseBuildOptions(['--reframe', 'crop;touch']), /reframe/);
  assert.deepEqual(parseBuildOptions([
    '--frames', '75', '--max', '8', '--beatSec', '2.5', '--brandLock', '0.4',
  ]), {
    framesOverride: 75,
    maxScenes: 8,
    beatSec: 2.5,
    brandLock: 0.4,
    reframeMode: null,
  });
});

test('central build contains no shell execution escape hatch', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts/build.js'), 'utf8');
  assert.doesNotMatch(source, /\bexecSync\b/);
  assert.doesNotMatch(source, /shell\s*:\s*true/);
});

test('invalid build values fail before ffprobe or sentinel execution', () => {
  const sentinel = path.join(ROOT, 'tmp', 'build-option-sentinel');
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/build.js'),
    path.join(ROOT, 'examples/demo-source.mp4'),
    '--frames', `1;touch ${sentinel}`,
  ], { cwd: ROOT, encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--frames/);
  assert.doesNotMatch(result.stdout, /видео .*fps/);
  assert.equal(fs.existsSync(sentinel), false);
});
