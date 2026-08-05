const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { buildDemoArgs, ensureOutputDestination } = require('../scripts/project/cli-options');

test('demo output and generated data stay in the ignored out directory', () => {
  const root = path.resolve('repo/automontage');
  const cwd = root;
  assert.deepEqual(buildDemoArgs(root, cwd), [
    path.join(root, 'examples/demo-source.mp4'),
    '--scenario', path.join(root, 'examples/scenario-demo.json'),
    '--no-transcribe', '--id', 'demo',
    '--outdir', path.join(root, 'out'),
  ]);
});

test('legacy CLI keeps copying the result to the current directory', () => {
  assert.deepEqual(
    ensureOutputDestination(['video.mp4'], '/work'),
    ['video.mp4', '--outdir', '/work'],
  );
});

test('new project mode owns its output directory', () => {
  assert.deepEqual(
    ensureOutputDestination(['video.mp4', '--project', 'Тема'], '/work'),
    ['video.mp4', '--project', 'Тема'],
  );
});

test('existing project mode owns its output directory', () => {
  assert.deepEqual(
    ensureOutputDestination([
      'video.mp4',
      '--project-dir',
      '/work/projects/demo',
    ], '/work'),
    ['video.mp4', '--project-dir', '/work/projects/demo'],
  );
});

test('explicit outdir is never duplicated', () => {
  assert.deepEqual(
    ensureOutputDestination(['video.mp4', '--outdir', '/exports'], '/work'),
    ['video.mp4', '--outdir', '/exports'],
  );
});
