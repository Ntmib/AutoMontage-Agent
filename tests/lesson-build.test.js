const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  LESSON_DEFAULT_THEME,
  assertLessonOptions,
  buildGenBriefArgs,
  getLessonAction,
  prepareLessonRender,
} = require('../scripts/lesson/workflow');

const ROOT = path.resolve(__dirname, '..');

function runLessonBuildWithIntercept(t, args, { failRender = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-lesson-intercept-'));
  const hook = path.join(directory, 'hook.js');
  const calls = path.join(directory, 'calls.jsonl');
  fs.writeFileSync(hook, [
    "const childProcess = require('node:child_process');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const calls = process.env.AUTOMONTAGE_LESSON_CAPTURE;",
    'childProcess.spawnSync = (command, args) => {',
    "  fs.appendFileSync(calls, JSON.stringify({ command, args }) + '\\n');",
    "  if (command === 'ffprobe') return { status: 0, stdout: JSON.stringify({ streams: [{ codec_type: 'video', width: 1080, height: 1920, r_frame_rate: '25/1' }], format: { duration: '20' } }) };",
    "  if (process.env.AUTOMONTAGE_LESSON_FAIL_RENDER && args.includes('render')) return { status: 1, stdout: '', stderr: 'render failed' };",
    "  return { status: 0, stdout: '' };",
    '};',
    '',
  ].join('\n'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/build.js'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      AUTOMONTAGE_LESSON_CAPTURE: calls,
      AUTOMONTAGE_LESSON_FAIL_RENDER: failRender ? '1' : '',
      NODE_OPTIONS: `--require=${hook}`,
    },
  });
  const invocations = fs.existsSync(calls)
    ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
  return { result, invocations };
}

test('lesson workflow exposes one public default theme', () => {
  assert.equal(LESSON_DEFAULT_THEME, 'lesson-neutral');
});

function makeBrief(status = 'approved') {
  return {
    version: 1,
    status,
    source: '/videos/source.mp4',
    theme: 'lesson-neutral',
    title: 'УРОК',
    output: {
      aspect: 'vertical',
      width: 1080,
      height: 1920,
      fps: 30,
      durationInFrames: 300,
    },
    corrections: [],
    scenes: [
      { scene: 'fullscreen', start: 0, end: 10, caption: 'ГЛАВНАЯ МЫСЛЬ' },
    ],
  };
}

test('lesson without a brief stops at planning', () => {
  assert.equal(getLessonAction({ isLesson: true, briefFile: null }), 'plan');
});

test('lesson with a brief enters approved render flow', () => {
  assert.equal(getLessonAction({ isLesson: true, briefFile: 'lesson.json' }), 'render');
  assert.equal(getLessonAction({ isLesson: false, briefFile: null }), null);
});

test('draft brief is rejected before Remotion', () => {
  assert.throws(
    () => prepareLessonRender({
      brief: makeBrief('draft'),
      theme: 'lesson-neutral',
      sourceVideo: '/videos/source.mp4',
    }),
    /не утверждён/,
  );
});

test('approved brief cannot be rendered against another source', () => {
  assert.throws(
    () => prepareLessonRender({
      brief: makeBrief(),
      theme: 'lesson-neutral',
      sourceVideo: '/videos/another.mp4',
    }),
    /другого исходника/,
  );
});

test('approved brief prepares ReelScenes with frozen geometry', () => {
  const prepared = prepareLessonRender({
    brief: makeBrief(),
    theme: { colors: { bg: '#16120E' } },
    sourceVideo: '/videos/source.mp4',
  });

  assert.equal(prepared.composition, 'ReelScenes');
  assert.equal(prepared.props.width, 1080);
  assert.equal(prepared.props.height, 1920);
  assert.equal(prepared.props.fps, 30);
  assert.equal(prepared.props.durationInFrames, 300);
  assert.equal(prepared.props.audioSrc, 'source.mp4');
});

test('approved lesson keeps music out of Remotion and prepares post-render ducking', () => {
  const brief = makeBrief();
  brief.music = {
    file: '/videos/music/track.mp3',
    gainDb: -22,
    fadeInSec: 0.15,
    fadeOutSec: 0.8,
    startSec: 24,
    playbackRate: 1,
    ducking: {
      thresholdDb: -28,
      ratio: 8,
      attackMs: 5,
      releaseMs: 300,
    },
  };

  const prepared = prepareLessonRender({
    brief,
    theme: 'lesson-neutral',
    sourceVideo: '/videos/source.mp4',
  });

  assert.deepEqual(prepared.music, {
    sourcePath: '/videos/music/track.mp3',
    mixArgs: [
      '--gain', '-22',
      '--start', '24',
      '--rate', '1',
      '--fade-in', '0.15',
      '--fade-out', '0.8',
      '--duration', '10',
      '--threshold', '0.0398',
      '--ratio', '8',
      '--attack', '5',
      '--release', '300',
    ],
  });
  assert.equal(prepared.props.musicSrc, undefined);
});

test('frames override only shortens a local test render', () => {
  const prepared = prepareLessonRender({
    brief: makeBrief(),
    theme: 'lesson-neutral',
    sourceVideo: '/videos/source.mp4',
    framesOverride: 60,
  });

  assert.equal(prepared.props.durationInFrames, 60);
  assert.equal(prepared.props.width, 1080);
  assert.equal(prepared.props.height, 1920);
});

test('gen-brief arguments preserve paths and titles with spaces', () => {
  const args = buildGenBriefArgs({
    transcriptPath: 'src/data/transcript.json',
    briefPath: 'out/my lesson.json',
    markdownPath: 'out/my lesson.md',
    theme: 'lesson-neutral',
    title: 'МОЙ НОВЫЙ УРОК',
    geometry: { aspect: 'horizontal', width: 1920, height: 1080, fps: 25 },
    duration: 42.5,
    source: '/videos/source file.mp4',
    maxScenes: 9,
    availableBroll: ['broll/demo one.jpg'],
  });

  assert.deepEqual(args, [
    'src/data/transcript.json',
    'out/my lesson.json',
    '--markdown', 'out/my lesson.md',
    '--theme', 'lesson-neutral',
    '--title', 'МОЙ НОВЫЙ УРОК',
    '--aspect', 'horizontal',
    '--width', '1920',
    '--height', '1080',
    '--fps', '25',
    '--duration', '42.5',
    '--source', '/videos/source file.mp4',
    '--max', '9',
    '--available-broll', 'broll/demo one.jpg',
  ]);
});

test('gen-brief arguments freeze an optional speaker position', () => {
  const args = buildGenBriefArgs({
    transcriptPath: 'transcript.json',
    briefPath: 'brief.json',
    markdownPath: 'brief.md',
    theme: 'lesson-neutral',
    title: 'УРОК',
    geometry: { aspect: 'vertical', width: 1080, height: 1920, fps: 25 },
    duration: 10,
    source: '/videos/source.mp4',
    maxScenes: 7,
    facePos: { x: 0.25, y: 0.45 },
  });

  assert.deepEqual(args.slice(-4), ['--face-x', '0.25', '--face-y', '0.45']);
});

test('gen-brief arguments freeze an optional speaker zoom', () => {
  const args = buildGenBriefArgs({
    transcriptPath: 'transcript.json',
    briefPath: 'brief.json',
    markdownPath: 'brief.md',
    theme: 'lesson-neutral',
    title: 'УРОК',
    geometry: { aspect: 'vertical', width: 1080, height: 1920, fps: 25 },
    duration: 10,
    source: '/videos/source.mp4',
    maxScenes: 7,
    faceZoom: 1.08,
  });

  assert.deepEqual(args.slice(-2), ['--face-zoom', '1.08']);
});

test('lesson rejects source-changing flags that invalidate approved timings', () => {
  assert.throws(
    () => assertLessonOptions({ isLesson: true, args: ['--tighten'] }),
    /до создания ТЗ/,
  );
  assert.throws(
    () => assertLessonOptions({ isLesson: true, args: ['--reframe'] }),
    /--aspect vertical/,
  );
  assert.doesNotThrow(() => assertLessonOptions({
    isLesson: true,
    args: ['--aspect', 'vertical'],
  }));
  assert.doesNotThrow(() => assertLessonOptions({
    isLesson: false,
    args: ['--tighten'],
  }));
});

test('approved lesson props use one temporary public lease and remove it after render', (t) => {
  const id = `lease-lesson-${process.pid}-${Date.now()}`;
  const propsPath = path.join(ROOT, 'out', `${id}.lesson.props.json`);
  t.after(() => fs.rmSync(propsPath, { force: true }));

  const { result, invocations } = runLessonBuildWithIntercept(t, [
    'examples/demo-source.mp4',
    '--template', 'lesson',
    '--brief', 'examples/lesson-neutral-approved.json',
    '--frames', '25',
    '--id', id,
  ]);

  assert.equal(result.status, 0, result.stderr);
  const props = JSON.parse(fs.readFileSync(propsPath, 'utf8'));
  assert.match(props.faceSrc, /^\.automontage\/dynamic-[0-9a-f-]+\/source\.mp4$/);
  assert.equal(props.audioSrc, props.faceSrc);
  assert.ok(invocations.some((entry) => entry.args.includes('ReelScenes')));
  assert.equal(fs.existsSync(path.join(ROOT, 'public', props.faceSrc)), false);
});

test('failed lesson render still removes its temporary public lease', (t) => {
  const id = `lease-lesson-failed-${process.pid}-${Date.now()}`;
  const propsPath = path.join(ROOT, 'out', `${id}.lesson.props.json`);
  t.after(() => fs.rmSync(propsPath, { force: true }));

  const { result } = runLessonBuildWithIntercept(t, [
    'examples/demo-source.mp4',
    '--template', 'lesson',
    '--brief', 'examples/lesson-neutral-approved.json',
    '--frames', '25',
    '--id', id,
  ], { failRender: true });

  assert.equal(result.status, 1);
  const props = JSON.parse(fs.readFileSync(propsPath, 'utf8'));
  assert.equal(fs.existsSync(path.join(ROOT, 'public', props.faceSrc)), false);
});
