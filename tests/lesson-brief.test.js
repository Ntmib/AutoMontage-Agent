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

test('approved speaker crop is preserved in render props', () => {
  const brief = makeBrief({
    status: 'approved',
    facePos: { x: 0.25, y: 0.4 },
    faceZoom: 1.08,
  });

  const props = buildReelScenesProps({ brief, theme: 'dima-grunge' });

  assert.deepEqual(props.facePos, { x: 0.25, y: 0.4 });
  assert.equal(props.faceZoom, 1.08);
});

test('approved lesson music is validated and becomes render props', () => {
  const brief = makeBrief({
    status: 'approved',
    music: {
      file: '/audio/music.mp3',
      gainDb: -17,
      fadeInSec: 0.4,
      fadeOutSec: 0.8,
    },
  });

  assert.deepEqual(validateLessonBrief(brief), { ok: true, errors: [] });
  const props = buildReelScenesProps({ brief, theme: 'dima-grunge' });

  assert.equal(props.musicSrc, 'source-music.mp3');
  assert.equal(props.musicGainDb, -17);
  assert.equal(props.musicFadeInSec, 0.4);
  assert.equal(props.musicFadeOutSec, 0.8);
});

test('bottom diagram accepts approved speaker circle and funnel variants', () => {
  const brief = makeBrief({
    scenes: [
      {
        scene: 'bottom-diagram',
        start: 0,
        end: 2,
        variant: 'speaker-circle',
        handle: '@MCDENIL',
        headCream: 'СПИКЕР',
        headOrange: 'В КРУЖКЕ',
        steps: ['Кружок', 'Ободок', 'Ник'],
      },
      {
        scene: 'bottom-diagram',
        start: 2,
        end: 5,
        variant: 'funnel',
        headCream: 'ВОРОНКА',
        headOrange: 'ПРОДАЖ',
        steps: ['Много людей', 'Три уровня', 'Несколько лидов'],
      },
    ],
  });

  assert.deepEqual(validateLessonBrief(brief), { ok: true, errors: [] });
});

test('blur overlay accepts staged official social logos', () => {
  const brief = makeBrief({
    scenes: [
      {
        scene: 'blur-overlay',
        start: 0,
        end: 1.5,
        variant: 'blur-only',
        big: '4',
        headCream: 'ФОН',
        headOrange: 'РАЗМЫВАЕТСЯ',
      },
      {
        scene: 'blur-overlay',
        start: 1.5,
        end: 5,
        variant: 'social-logos',
        logos: ['telegram', 'instagram', 'youtube', 'zoom'],
        big: '4',
        headCream: 'ОФИЦИАЛЬНЫЕ',
        headOrange: 'ЛОГОТИПЫ',
      },
    ],
  });

  assert.deepEqual(validateLessonBrief(brief), { ok: true, errors: [] });
});

test('split accepts an animated gradient presentation variant', () => {
  const brief = makeBrief({
    scenes: [{
      scene: 'split',
      start: 0,
      end: 6,
      variant: 'animated-gradient',
      headCream: 'КАК ЭТО',
      headOrange: 'РАБОТАЕТ',
      bullets: ['Фото сверху', 'Текст снизу', 'Тёмный градиент', 'Всё двигается'],
    }],
  });

  assert.deepEqual(validateLessonBrief(brief), { ok: true, errors: [] });
});

test('short split cards can approve an earlier bullet entrance', () => {
  const brief = makeBrief({
    scenes: [{
      scene: 'split',
      start: 0,
      end: 1.2,
      bulletDelaySec: 0.08,
      headCream: 'ЭТО ВИДЕО СМОНТИРОВАЛ',
      headOrange: 'CLAUDE CODE',
      bullets: ['Полностью без моего участия и без монтажёра'],
    }],
  });

  assert.deepEqual(validateLessonBrief(brief), { ok: true, errors: [] });
});

test('text-only accepts one animated CTA keyword', () => {
  const brief = makeBrief({
    scenes: [{
      scene: 'text-only',
      start: 0,
      end: 2,
      variant: 'keyword-bounce',
      animateKeyword: 'МОНТАЖ',
      quoteCream: 'НАПИШИ',
      quoteOrange: 'В КОММЕНТАРИЯХ',
    }],
  });

  assert.deepEqual(validateLessonBrief(brief), { ok: true, errors: [] });
});

test('markdown brief shows scenes and proofread corrections', () => {
  const markdown = formatBriefMarkdown(makeBrief());

  assert.match(markdown, /Статус: `draft`/);
  assert.match(markdown, /Формат: `horizontal`, 1920x1080, 30 FPS/);
  assert.match(markdown, /split-top/);
  assert.match(markdown, /нейроагенда/);
  assert.match(markdown, /нейроагента/);
});
