const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyReviewCommand,
  applyReviewCommands,
} = require('../scripts/review/commands');
const { diffLessonBrief } = require('../scripts/review/diff');

function fixtureBrief({ status = 'draft' } = {}) {
  return {
    version: 1,
    status,
    source: 'input/source.mp4',
    theme: { id: 'lesson-neutral', colors: { bg: '#17120f' } },
    title: 'Безопасная правка',
    output: {
      aspect: 'horizontal',
      width: 1920,
      height: 1080,
      fps: 25,
      durationInFrames: 250,
    },
    corrections: [],
    scenes: [
      { scene: 'fullscreen', start: 0, end: 4, caption: 'ПЕРВАЯ СЦЕНА' },
      {
        scene: 'broll',
        start: 4,
        end: 7,
        brollMedia: { kind: 'image', assetId: 'asset-1', fit: 'cover' },
        headCream: 'ПОКАЗЫВАЕМ',
        headOrange: 'СХЕМУ',
      },
      {
        scene: 'split',
        start: 7,
        end: 10,
        headCream: 'ФИНАЛЬНЫЙ',
        headOrange: 'БЛОК',
        bullets: ['Одна', 'Две'],
      },
    ],
  };
}

function assetMap() {
  return new Map([
    ['asset-1', {
      mediaKind: 'image', reference: 'assets/broll/base.webp', canonicalSha256: '1'.repeat(64),
      capabilities: { brollImage: true, brollVideo: false },
    }],
    ['asset-2', {
      mediaKind: 'image', reference: 'assets/broll/second.webp', canonicalSha256: '2'.repeat(64),
      capabilities: { brollImage: true, brollVideo: false },
    }],
    ['asset-7', {
      mediaKind: 'video', reference: 'assets/broll/video/id/media.mp4',
      canonicalSha256: '7'.repeat(64), durationSec: 20, hasAudio: true,
      capabilities: { brollImage: false, brollVideo: true },
    }],
    ['asset-8', {
      mediaKind: 'video', reference: 'assets/broll/video/silent/media.mp4',
      canonicalSha256: '8'.repeat(64), durationSec: 8, hasAudio: false,
      capabilities: { brollImage: false, brollVideo: true },
    }],
  ]);
}

function apply(brief, command, assets = assetMap()) {
  return applyReviewCommand({ brief, command, assets, fps: 25 });
}

test('move-boundary changes only one shared boundary on a deep-cloned brief', () => {
  const before = fixtureBrief();
  const after = apply(before, {
    type: 'move-boundary',
    leftSceneIndex: 0,
    seconds: 4.2,
  });

  assert.equal(after.scenes[0].end, 4.2);
  assert.equal(after.scenes[1].start, 4.2);
  assert.deepEqual(after.scenes[2], {
    scene: 'split',
    start: 7,
    end: 10,
    headCream: 'ФИНАЛЬНЫЙ',
    headOrange: 'БЛОК',
    bullets: ['Одна', 'Две'],
  });
  assert.notStrictEqual(after, before);
  assert.notStrictEqual(after.scenes, before.scenes);
  assert.notStrictEqual(after.scenes[2], before.scenes[2]);
  assert.notStrictEqual(after.output, before.output);
  assert.deepEqual(before, fixtureBrief());
});

test('an edit turns an approved brief into draft without changing protected identity', () => {
  const before = fixtureBrief({ status: 'approved' });
  const sourceBytes = JSON.stringify(before.source);
  const themeBytes = JSON.stringify(before.theme);
  const outputBytes = JSON.stringify(before.output);

  const after = apply(before, {
    type: 'move-boundary',
    leftSceneIndex: 1,
    seconds: 7.4,
  });

  assert.equal(after.status, 'draft');
  assert.equal(JSON.stringify(after.source), sourceBytes);
  assert.equal(JSON.stringify(after.theme), themeBytes);
  assert.equal(JSON.stringify(after.output), outputBytes);
  assert.deepEqual(after.output, {
    aspect: 'horizontal', width: 1920, height: 1080, fps: 25, durationInFrames: 250,
  });
  assert.equal(before.status, 'approved');
  assert.deepEqual(before, fixtureBrief({ status: 'approved' }));
});

test('move-boundary rejects external endpoints and invalid timing', () => {
  const before = fixtureBrief();
  const invalidCommands = [
    { type: 'move-boundary', leftSceneIndex: -1, seconds: 1 },
    { type: 'move-boundary', leftSceneIndex: 2, seconds: 8 },
    { type: 'move-boundary', leftSceneIndex: 0.5, seconds: 4.2 },
    { type: 'move-boundary', leftSceneIndex: 0, seconds: -0.1 },
    { type: 'move-boundary', leftSceneIndex: 0, seconds: Number.NaN },
    { type: 'move-boundary', leftSceneIndex: 0, seconds: Number.POSITIVE_INFINITY },
    { type: 'move-boundary', leftSceneIndex: 0, seconds: '4.2' },
    { type: 'move-boundary', leftSceneIndex: 0, seconds: 0 },
    { type: 'move-boundary', leftSceneIndex: 0, seconds: 7.1 },
  ];

  for (const command of invalidCommands) {
    assert.throws(() => apply(before, command), /boundary|timing|command/i);
  }
  const overlapping = fixtureBrief();
  overlapping.scenes[0].end = 4.1;
  assert.throws(
    () => apply(overlapping, { type: 'move-boundary', leftSceneIndex: 1, seconds: 7.4 }),
    /invalid|timing/i,
  );
  const invalidOutcome = fixtureBrief();
  invalidOutcome.scenes[2].bullets = [42];
  assert.throws(
    () => apply(invalidOutcome, { type: 'move-boundary', leftSceneIndex: 0, seconds: 4.2 }),
    /invalid|brief/i,
  );
  assert.deepEqual(before, fixtureBrief());
});

test('commands fail closed for unknown types and attempts to alter protected fields', () => {
  const before = fixtureBrief({ status: 'approved' });
  const rejected = [
    { type: 'rename-scene', sceneIndex: 0, caption: 'ДРУГОЙ ТЕКСТ' },
    { type: 'move-boundary', leftSceneIndex: 0, seconds: 4.2, title: 'НОВЫЙ ЗАГОЛОВОК' },
    { type: 'move-boundary', leftSceneIndex: 0, seconds: 4.2, source: 'outside.mp4' },
    { type: 'move-boundary', leftSceneIndex: 0, seconds: 4.2, theme: 'other' },
    {
      type: 'move-boundary',
      leftSceneIndex: 0,
      seconds: 4.2,
      output: { aspect: 'vertical', width: 1080, height: 1920, fps: 25, durationInFrames: 250 },
    },
    null,
    [],
  ];

  for (const command of rejected) {
    assert.throws(() => apply(before, command), /command|supported/i);
  }
  let getterCalls = 0;
  const accessorCommand = {
    type: 'move-boundary',
    leftSceneIndex: 0,
  };
  Object.defineProperty(accessorCommand, 'seconds', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 4.2;
    },
  });
  assert.throws(() => apply(before, accessorCommand), /shape|command/i);
  assert.equal(getterCalls, 0);
  assert.deepEqual(before, fixtureBrief({ status: 'approved' }));
});

test('replace-broll accepts only an allowlisted opaque asset on a broll scene', () => {
  const before = fixtureBrief();
  const assets = assetMap();
  const after = apply(before, {
    type: 'replace-broll',
    sceneIndex: 1,
    assetId: 'asset-2',
  }, assets);

  assert.deepEqual(after.scenes[1].brollMedia, {
    kind: 'image', assetId: 'asset-2', fit: 'cover',
  });
  assert.equal(after.scenes[1].brollSrc, undefined);
  assert.equal(after.scenes[1].start, 4);
  assert.equal(after.scenes[1].end, 7);
  assert.deepEqual([...assets.keys()], ['asset-1', 'asset-2', 'asset-7', 'asset-8']);
  assert.deepEqual(before, fixtureBrief());
});

test('replace-broll rejects unknown, unsafe, malformed, and ineligible requests', () => {
  const before = fixtureBrief();
  const unsafeAssets = assetMap();
  unsafeAssets.set('asset-2/../../source.mp4', assetMap().get('asset-2'));
  const rejected = [
    [{ type: 'replace-broll', sceneIndex: 1, assetId: 'unknown' }, assetMap()],
    [{ type: 'replace-broll', sceneIndex: 1, assetId: 'asset-2/../../source.mp4' }, unsafeAssets],
    [{ type: 'replace-broll', sceneIndex: 1, assetId: 'assets/broll/source.mp4' }, assetMap()],
    [{ type: 'replace-broll', sceneIndex: 0, assetId: 'asset-2' }, assetMap()],
    [{ type: 'replace-broll', sceneIndex: 3, assetId: 'asset-2' }, assetMap()],
    [{ type: 'replace-broll', sceneIndex: 1.5, assetId: 'asset-2' }, assetMap()],
    [{ type: 'replace-broll', sceneIndex: 1, assetId: 'asset-2', brollSrc: 'outside.mp4' }, assetMap()],
  ];

  for (const [command, assets] of rejected) {
    assert.throws(() => apply(before, command, assets), /asset|broll|command/i);
  }
  assert.throws(
    () => apply(before, { type: 'replace-broll', sceneIndex: 1, assetId: 'asset-2' }, new Set(['asset-2'])),
    /asset/i,
  );
  assert.deepEqual(before, fixtureBrief());
});

test('command replay is immutable across multiple edits and fails before returning a partial result', () => {
  const before = fixtureBrief({ status: 'approved' });
  const after = applyReviewCommands({
    brief: before,
    commands: [
      { type: 'replace-broll', sceneIndex: 1, assetId: 'asset-2' },
      { type: 'move-boundary', leftSceneIndex: 1, seconds: 7.4 },
      { type: 'move-boundary', leftSceneIndex: 0, seconds: 4.2 },
    ],
    assets: assetMap(),
    fps: 25,
  });

  assert.deepEqual(after.scenes.map((scene) => [scene.start, scene.end, scene.brollMedia?.assetId || null]), [
    [0, 4.2, null],
    [4.2, 7.4, 'asset-2'],
    [7.4, 10, null],
  ]);
  assert.equal(after.status, 'draft');
  assert.deepEqual(before, fixtureBrief({ status: 'approved' }));
  assert.throws(() => applyReviewCommands({
    brief: before,
    commands: [
      { type: 'move-boundary', leftSceneIndex: 0, seconds: 4.2 },
      { type: 'replace-broll', sceneIndex: 1, assetId: 'unknown' },
    ],
    assets: assetMap(),
    fps: 25,
  }), /asset/i);
  assert.throws(() => applyReviewCommands({
    brief: before,
    commands: { type: 'move-boundary', leftSceneIndex: 0, seconds: 4.2 },
    assets: new Map(),
    fps: 25,
  }), /commands/i);
});

test('diff reports supported changes in a stable boundary-then-asset order', () => {
  const before = fixtureBrief();
  const after = applyReviewCommands({
    brief: before,
    commands: [
      { type: 'replace-broll', sceneIndex: 1, assetId: 'asset-2' },
      { type: 'move-boundary', leftSceneIndex: 1, seconds: 7.4 },
      { type: 'move-boundary', leftSceneIndex: 0, seconds: 4.2 },
    ],
    assets: assetMap(),
    fps: 25,
  });

  assert.deepEqual(diffLessonBrief({ before, after }), [
    { kind: 'boundary', leftScene: 0, rightScene: 1, from: 4, to: 4.2 },
    { kind: 'boundary', leftScene: 1, rightScene: 2, from: 7, to: 7.4 },
    { kind: 'asset', scene: 1, from: 'asset-1', to: 'asset-2' },
  ]);
});

test('diff keeps an exact no-op empty and permits the approved-to-draft transition', () => {
  const before = fixtureBrief();
  const approved = fixtureBrief({ status: 'approved' });
  const approvedAfter = apply(approved, {
    type: 'move-boundary',
    leftSceneIndex: 0,
    seconds: 4.2,
  });

  assert.deepEqual(diffLessonBrief({ before, after: fixtureBrief() }), []);
  assert.deepEqual(diffLessonBrief({ before: approved, after: approvedAfter }), [
    { kind: 'boundary', leftScene: 0, rightScene: 1, from: 4, to: 4.2 },
  ]);
});

test('video b-roll commands use exact shapes, defaults, and composition-frame snapping', () => {
  const before = fixtureBrief({ status: 'approved' });
  const after = applyReviewCommands({
    brief: before,
    assets: assetMap(),
    fps: 25,
    commands: [
      { type: 'replace-broll', sceneIndex: 1, assetId: 'asset-7' },
      { type: 'set-broll-fit', sceneIndex: 1, fit: 'cover' },
      { type: 'set-broll-video-start', sceneIndex: 1, trimStartSec: 12.419 },
      { type: 'set-broll-audio-mode', sceneIndex: 1, audioMode: 'replace' },
    ],
  });

  assert.deepEqual(after.scenes[1].brollMedia, {
    kind: 'video',
    assetId: 'asset-7',
    fit: 'cover',
    trimStartSec: 12.4,
    audioMode: 'replace',
  });
  assert.deepEqual(before, fixtureBrief({ status: 'approved' }));

  const defaultVideo = apply(before, {
    type: 'replace-broll', sceneIndex: 1, assetId: 'asset-7',
  });
  assert.deepEqual(defaultVideo.scenes[1].brollMedia, {
    kind: 'video', assetId: 'asset-7', fit: 'contain', trimStartSec: 0, audioMode: 'mute',
  });
  const defaultImage = apply(defaultVideo, {
    type: 'replace-broll', sceneIndex: 1, assetId: 'asset-2',
  });
  assert.deepEqual(defaultImage.scenes[1].brollMedia, {
    kind: 'image', assetId: 'asset-2', fit: 'cover',
  });
});

test('video b-roll commands reject extra keys, wrong media, missing audio, and short clips', () => {
  const image = fixtureBrief();
  const video = apply(image, {
    type: 'replace-broll', sceneIndex: 1, assetId: 'asset-7',
  });
  const silent = apply(image, {
    type: 'replace-broll', sceneIndex: 1, assetId: 'asset-8',
  });
  const rejected = [
    [image, { type: 'set-broll-fit', sceneIndex: 1, fit: 'cover', src: '/private' }],
    [image, { type: 'set-broll-fit', sceneIndex: 0, fit: 'cover' }],
    [image, { type: 'set-broll-fit', sceneIndex: 1, fit: 'stretch' }],
    [image, { type: 'set-broll-video-start', sceneIndex: 1, trimStartSec: 1 }],
    [image, { type: 'set-broll-audio-mode', sceneIndex: 1, audioMode: 'mute' }],
    [silent, { type: 'set-broll-audio-mode', sceneIndex: 1, audioMode: 'mix' }],
    [silent, { type: 'set-broll-audio-mode', sceneIndex: 1, audioMode: 'replace' }],
    [video, { type: 'set-broll-video-start', sceneIndex: 1, trimStartSec: -1 }],
    [video, { type: 'set-broll-video-start', sceneIndex: 1, trimStartSec: Number.NaN }],
  ];
  for (const [brief, command] of rejected) {
    assert.throws(() => apply(brief, command), /review command/i);
  }

  const shortAssets = assetMap();
  shortAssets.set('asset-7', { ...shortAssets.get('asset-7'), durationSec: 14 });
  assert.throws(() => applyReviewCommand({
    brief: video,
    command: { type: 'set-broll-video-start', sceneIndex: 1, trimStartSec: 12.419 },
    assets: shortAssets,
    fps: 25,
  }), /duration|clip|command/i);

  const fractionalScene = fixtureBrief();
  fractionalScene.scenes = [
    { scene: 'fullscreen', start: 0, end: 0.02, caption: 'КОРОТКО' },
    {
      scene: 'broll', start: 0.02, end: 1.04,
      brollMedia: { kind: 'image', assetId: 'asset-1', fit: 'cover' },
      headCream: 'ДВАДЦАТЬ', headOrange: 'ШЕСТЬ КАДРОВ',
    },
    {
      scene: 'split', start: 1.04, end: 10,
      headCream: 'ФИНАЛЬНЫЙ', headOrange: 'БЛОК', bullets: ['Одна', 'Две'],
    },
  ];
  const exactSecond = assetMap();
  exactSecond.set('asset-7', { ...exactSecond.get('asset-7'), durationSec: 1 });
  assert.throws(() => applyReviewCommand({
    brief: fractionalScene,
    command: { type: 'replace-broll', sceneIndex: 1, assetId: 'asset-7' },
    assets: exactSecond,
    fps: 25,
  }), /duration|clip|command/i);
});

test('video b-roll replay is undo-compatible and diff exposes only safe media values', () => {
  const before = fixtureBrief();
  const commands = [
    { type: 'replace-broll', sceneIndex: 1, assetId: 'asset-7' },
    { type: 'set-broll-fit', sceneIndex: 1, fit: 'contain' },
    { type: 'set-broll-video-start', sceneIndex: 1, trimStartSec: 1.019 },
    { type: 'set-broll-audio-mode', sceneIndex: 1, audioMode: 'mix' },
  ];
  const after = applyReviewCommands({ brief: before, commands, assets: assetMap(), fps: 25 });
  const replayed = applyReviewCommands({ brief: before, commands, assets: assetMap(), fps: 25 });
  assert.deepEqual(replayed, after);
  assert.deepEqual(applyReviewCommands({
    brief: before, commands: commands.slice(0, -1), assets: assetMap(), fps: 25,
  }).scenes[1].brollMedia.audioMode, 'mute');
  assert.deepEqual(diffLessonBrief({ before, after }), [
    { kind: 'asset', scene: 1, from: 'asset-1', to: 'asset-7' },
    { kind: 'fit', scene: 1, from: 'cover', to: 'contain' },
    { kind: 'clip-start', scene: 1, from: null, to: 1 },
    { kind: 'audio-mode', scene: 1, from: null, to: 'mix' },
  ]);
  const serialized = JSON.stringify(diffLessonBrief({ before, after }));
  assert.doesNotMatch(serialized, /assets\/broll|[a-f0-9]{64}|\/Users\//);
});

test('diff fails closed when complete briefs contain unsupported changes', () => {
  const before = fixtureBrief();
  const textOnly = fixtureBrief();
  textOnly.scenes[0].caption = 'ПЕРЕПИСАННЫЙ ТЕКСТ';
  const partialBoundary = fixtureBrief();
  partialBoundary.scenes[0].end = 4.2;
  const changedSceneKind = fixtureBrief();
  changedSceneKind.scenes[1] = { ...changedSceneKind.scenes[1], scene: 'split', brollSrc: 'asset-2' };
  const extraScene = fixtureBrief();
  extraScene.scenes.push({ scene: 'fullscreen', start: 10, end: 11, caption: 'ЛИШНЯЯ СЦЕНА' });
  const outputChanged = fixtureBrief();
  outputChanged.output.width = 1080;
  const sourceChanged = fixtureBrief();
  sourceChanged.source = 'other/source.mp4';
  const themeChanged = fixtureBrief();
  themeChanged.theme.colors.bg = '#ffffff';
  const externalEndpoint = fixtureBrief();
  externalEndpoint.scenes[0].start = 0.1;
  const changedFinalEnd = fixtureBrief();
  changedFinalEnd.scenes[2].end = 10.1;
  const nestedSceneField = fixtureBrief();
  nestedSceneField.scenes[2].bullets[0] = 'ПЕРЕПИСАННЫЙ ПУНКТ';
  const disallowedStatus = fixtureBrief({ status: 'approved' });
  const mixed = apply(before, { type: 'move-boundary', leftSceneIndex: 0, seconds: 4.2 });
  mixed.scenes[0].caption = 'ЛИШНИЙ ТЕКСТ';

  for (const after of [
    textOnly,
    partialBoundary,
    changedSceneKind,
    extraScene,
    outputChanged,
    sourceChanged,
    themeChanged,
    externalEndpoint,
    changedFinalEnd,
    nestedSceneField,
    disallowedStatus,
    mixed,
  ]) {
    assert.throws(
      () => diffLessonBrief({ before, after }),
      (error) => error && error.message === 'review diff contains unsupported changes',
    );
  }
  assert.throws(
    () => diffLessonBrief({ before: null, after: fixtureBrief() }),
    (error) => error && error.message === 'review diff contains unsupported changes',
  );
});
