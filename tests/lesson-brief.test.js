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
    theme: 'lesson-neutral',
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
  assert.throws(() => buildReelScenesProps({ brief: makeBrief(), theme: 'lesson-neutral' }), /не утверждён/);
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

test('audio and video b-roll cannot cross the approval or render boundary', () => {
  for (const brollSrc of ['broll/voice.mp3', 'broll/clip.mp4']) {
    const brief = makeBrief({
      status: 'approved',
      scenes: [{
        scene: 'broll',
        start: 0,
        end: 8,
        brollSrc,
        headCream: 'НЕПОДДЕРЖИВАЕМОЕ',
        headOrange: 'МЕДИА',
      }],
    });

    const validation = validateLessonBrief(brief);
    assert.equal(validation.ok, false);
    assert.match(validation.errors.join('\n'), /b-roll|изображен/i);
    assert.throws(
      () => buildReelScenesProps({ brief, theme: 'lesson-neutral' }),
      /b-roll|изображен/i,
    );
  }
});

function makeBrollScene(overrides = {}) {
  return {
    scene: 'broll',
    start: 0,
    end: 8,
    headCream: 'ПРИМЕР',
    headOrange: 'B-ROLL',
    ...overrides,
  };
}

function makeImageBrollMedia(overrides = {}) {
  return {
    kind: 'image',
    src: 'assets/broll/images/4af36be4-0b26-4e6f-bd48-8bdd2215a4f1/media.webp',
    sha256: 'b'.repeat(64),
    fit: 'cover',
    ...overrides,
  };
}

function makeVideoBrollMedia(overrides = {}) {
  return {
    kind: 'video',
    src: 'assets/broll/video/4af36be4-0b26-4e6f-bd48-8bdd2215a4f1/media.mp4',
    sha256: 'a'.repeat(64),
    trimStartSec: 12.4,
    fit: 'contain',
    audioMode: 'replace',
    ...overrides,
  };
}

test('legacy image b-roll remains valid without changing its serialized bytes', () => {
  const brief = makeBrief({
    scenes: [makeBrollScene({ brollSrc: 'broll/growth.png' })],
  });
  const serialized = JSON.stringify(brief);

  assert.deepEqual(validateLessonBrief(brief), { ok: true, errors: [] });
  assert.equal(JSON.stringify(brief), serialized);
});

test('strict persisted image b-roll media is valid', () => {
  const brief = makeBrief({
    scenes: [makeBrollScene({ brollMedia: makeImageBrollMedia() })],
  });

  assert.deepEqual(validateLessonBrief(brief), { ok: true, errors: [] });
});

test('strict persisted video b-roll media is valid', () => {
  const brief = makeBrief({
    scenes: [makeBrollScene({ brollMedia: makeVideoBrollMedia() })],
  });

  assert.deepEqual(validateLessonBrief(brief), { ok: true, errors: [] });
});

test('b-roll requires exactly one legacy or persisted media reference', () => {
  const missing = makeBrief({ scenes: [makeBrollScene()] });
  const both = makeBrief({
    scenes: [makeBrollScene({
      brollSrc: 'broll/growth.png',
      brollMedia: makeImageBrollMedia(),
    })],
  });

  assert.equal(validateLessonBrief(missing).ok, false);
  assert.equal(validateLessonBrief(both).ok, false);
});

test('persisted b-roll media rejects extra keys and image-only violations', () => {
  for (const media of [
    makeImageBrollMedia({ unexpected: true }),
    makeImageBrollMedia({ trimStartSec: 0 }),
    makeImageBrollMedia({ audioMode: 'mute' }),
  ]) {
    const result = validateLessonBrief(makeBrief({
      scenes: [makeBrollScene({ brollMedia: media })],
    }));
    assert.equal(result.ok, false);
  }
});

test('persisted video b-roll rejects invalid starts and enum values', () => {
  for (const media of [
    makeVideoBrollMedia({ trimStartSec: -0.1 }),
    makeVideoBrollMedia({ trimStartSec: Infinity }),
    makeVideoBrollMedia({ fit: 'stretch' }),
    makeVideoBrollMedia({ audioMode: 'voice' }),
  ]) {
    const result = validateLessonBrief(makeBrief({
      scenes: [makeBrollScene({ brollMedia: media })],
    }));
    assert.equal(result.ok, false);
  }
});

test('persisted b-roll media permits only canonical relative references', () => {
  for (const src of [
    '/private/media.webp',
    'https://example.test/media.webp',
    'assets\\broll\\images\\media.webp',
    'assets/./broll/images/media.webp',
    'assets/broll/../images/media.webp',
    '/media/assets/asset-1',
    'media/assets/asset-1',
    'asset-1',
  ]) {
    const result = validateLessonBrief(makeBrief({
      scenes: [makeBrollScene({
        brollMedia: makeImageBrollMedia({ src }),
      })],
    }));
    assert.equal(result.ok, false, src);
  }
});

test('persisted b-roll media requires a lowercase SHA-256 digest', () => {
  for (const sha256 of [
    'a'.repeat(63),
    'A'.repeat(64),
    'g'.repeat(64),
  ]) {
    const result = validateLessonBrief(makeBrief({
      scenes: [makeBrollScene({
        brollMedia: makeImageBrollMedia({ sha256 }),
      })],
    }));
    assert.equal(result.ok, false, sha256);
  }
});

test('frameSnapSeconds rounds to a frame and rejects invalid inputs', () => {
  const { frameSnapSeconds } = require('../scripts/lesson/broll-media');

  assert.equal(frameSnapSeconds(12.419, 25), 12.4);
  for (const [seconds, fps] of [
    [-1, 25],
    [Infinity, 25],
    [12.4, 0],
    [12.4, Infinity],
  ]) {
    assert.throws(() => frameSnapSeconds(seconds, fps), /b-roll frame time is invalid/);
  }
});

test('approved speaker crop is preserved in render props', () => {
  const brief = makeBrief({
    status: 'approved',
    facePos: { x: 0.25, y: 0.4 },
    faceZoom: 1.08,
  });

  const props = buildReelScenesProps({ brief, theme: 'lesson-neutral' });

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
      startSec: 22,
      playbackRate: 1.06,
      ducking: {
        thresholdDb: -28,
        ratio: 8,
        attackMs: 5,
        releaseMs: 300,
      },
    },
  });

  assert.deepEqual(validateLessonBrief(brief), { ok: true, errors: [] });
  const props = buildReelScenesProps({ brief, theme: 'lesson-neutral' });

  assert.equal(props.musicSrc, 'source-music.mp3');
  assert.equal(props.musicGainDb, -17);
  assert.equal(props.musicFadeInSec, 0.4);
  assert.equal(props.musicFadeOutSec, 0.8);
  assert.equal(props.musicTrimBeforeFrames, 660);
  assert.equal(props.musicPlaybackRate, 1.06);
});

test('bottom diagram accepts approved speaker circle and funnel variants', () => {
  const brief = makeBrief({
    scenes: [
      {
        scene: 'bottom-diagram',
        start: 0,
        end: 2,
        variant: 'speaker-circle',
        handle: '@SPEAKER',
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

test('blur overlay accepts approved social channel marker ids', () => {
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

test('markdown scene summaries use the selected persisted b-roll reference', () => {
  const media = makeVideoBrollMedia();
  const markdown = formatBriefMarkdown(makeBrief({
    scenes: [makeBrollScene({ brollMedia: media })],
  }));

  assert.match(markdown, new RegExp(media.src));
  assert.doesNotMatch(markdown, /undefined/);
});

test('markdown legacy b-roll scene summary remains unchanged', () => {
  const markdown = formatBriefMarkdown(makeBrief({
    scenes: [makeBrollScene({ brollSrc: 'broll/growth.png' })],
  }));

  assert.match(markdown, /ПРИМЕР B-ROLL \(broll\/growth\.png\)/);
});

test('markdown brief reflects an approved status from its brief object', () => {
  const markdown = formatBriefMarkdown(makeBrief({ status: 'approved' }));

  assert.match(markdown, /^Статус: `approved`$/m);
  assert.equal((markdown.match(/^Статус:/gm) || []).length, 1);
  assert.doesNotMatch(markdown, /^Статус: `draft`$/m);
});
