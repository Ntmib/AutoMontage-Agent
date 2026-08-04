const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertLessonOptions,
  buildGenBriefArgs,
  getLessonAction,
  prepareLessonRender,
} = require('../scripts/lesson/workflow');

function makeBrief(status = 'approved') {
  return {
    version: 1,
    status,
    source: '/videos/source.mp4',
    theme: 'dima-grunge',
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
      theme: 'dima-grunge',
      sourceVideo: '/videos/source.mp4',
    }),
    /не утверждён/,
  );
});

test('approved brief cannot be rendered against another source', () => {
  assert.throws(
    () => prepareLessonRender({
      brief: makeBrief(),
      theme: 'dima-grunge',
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
    file: '/Users/editor/Music/track.mp3',
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
    theme: 'dima-grunge',
    sourceVideo: '/videos/source.mp4',
  });

  assert.deepEqual(prepared.music, {
    sourcePath: '/Users/editor/Music/track.mp3',
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
    theme: 'dima-grunge',
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
    theme: 'dima-grunge',
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
    '--theme', 'dima-grunge',
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
    theme: 'dima-grunge',
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
    theme: 'dima-grunge',
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
