const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildReelScenesProps,
  formatBriefMarkdown,
  validateLessonBrief,
} = require('../scripts/lesson/brief');

function makeBrief(overrides = {}) {
  return {
    version: 1,
    status: 'draft',
    source: '/videos/source.mp4',
    theme: 'dima-grunge',
    title: 'НЕЙРОАГЕНТЫ',
    output: {
      aspect: 'horizontal',
      width: 1920,
      height: 1080,
      fps: 30,
      durationInFrames: 240,
    },
    corrections: [
      {
        start: 1.2,
        end: 2.4,
        from: 'нейроагенда',
        to: 'нейроагента',
        reason: 'словарь терминов',
      },
    ],
    scenes: [
      {
        scene: 'fullscreen',
        start: 0,
        end: 3,
        caption: 'КАК СОБРАТЬ НЕЙРОАГЕНТА',
      },
      {
        scene: 'split',
        start: 3,
        end: 8,
        num: '02',
        headCream: 'ОТ ИДЕИ',
        headOrange: 'К СИСТЕМЕ',
        bullets: ['Собрать процесс', 'Проверить результат'],
      },
    ],
    ...overrides,
  };
}

test('valid draft can be reviewed before approval', () => {
  assert.deepEqual(validateLessonBrief(makeBrief()), { ok: true, errors: [] });
});

test('draft cannot produce render props', () => {
  const result = validateLessonBrief(makeBrief(), { requireApproved: true });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /не утверждён/);
  assert.throws(() => buildReelScenesProps({ brief: makeBrief(), theme: 'dima-grunge' }), /не утверждён/);
});

test('experimental chart scene is rejected', () => {
  const brief = makeBrief({
    scenes: [{ scene: 'chart', start: 0, end: 2, months: 12, perMonth: 20000 }],
  });

  const result = validateLessonBrief(brief);

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /chart/);
});

test('invalid and overlapping intervals are rejected', () => {
  const backwards = validateLessonBrief(makeBrief({
    scenes: [{
      scene: 'split',
      start: 3,
      end: 2,
      headCream: 'ПЛОХОЙ',
      headOrange: 'ТАЙМИНГ',
      bullets: [],
    }],
  }));
  const overlap = validateLessonBrief(makeBrief({
    scenes: [
      { scene: 'fullscreen', start: 0, end: 4, caption: 'ПЕРВАЯ' },
      { scene: 'fullscreen', start: 3, end: 6, caption: 'ВТОРАЯ' },
    ],
  }));

  assert.match(backwards.errors.join('\n'), /end/);
  assert.match(overlap.errors.join('\n'), /пересекается/);
});

test('approved brief becomes ReelScenes props with one audio source', () => {
  const brief = makeBrief({ status: 'approved' });
  const theme = { colors: { bg: '#16120E' } };

  const props = buildReelScenesProps({ brief, theme });

  assert.deepEqual(props, {
    theme,
    scenes: brief.scenes,
    faceSrc: 'source.mp4',
    audioSrc: 'source.mp4',
    videoTitle: 'НЕЙРОАГЕНТЫ',
    width: 1920,
    height: 1080,
    fps: 30,
    durationInFrames: 240,
  });
});

test('markdown brief shows scenes and proofread corrections', () => {
  const markdown = formatBriefMarkdown(makeBrief());

  assert.match(markdown, /Статус: `draft`/);
  assert.match(markdown, /Формат: `horizontal`, 1920x1080, 30 FPS/);
  assert.match(markdown, /split-top/);
  assert.match(markdown, /нейроагенда/);
  assert.match(markdown, /нейроагента/);
});
