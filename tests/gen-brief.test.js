const test = require('node:test');
const assert = require('node:assert/strict');

const dictionary = require('../scripts/data/proofread-dictionary.json');
const {
  applyDictionary,
  normalizeGeneratedBrief,
} = require('../scripts/gen-brief');

const context = {
  source: '/videos/source.mp4',
  theme: 'dima-grunge',
  title: 'АГЕНТ ОТ А ДО Я',
  output: {
    aspect: 'vertical',
    width: 1080,
    height: 1920,
    fps: 30,
    durationInFrames: 300,
  },
  dictionaryCorrections: [],
  availableBroll: [],
};

test('dictionary corrects transcript and records every replacement', () => {
  const result = applyDictionary([
    {
      start: 1,
      end: 3,
      text: 'Агент от Адая помогает собрать нейроагенда',
      words: [],
    },
  ], dictionary);

  assert.equal(result.segments[0].text, 'Агент от А до Я помогает собрать нейроагента');
  assert.deepEqual(result.corrections.map(({ from, to }) => ({ from, to })), [
    { from: 'Агент от Адая', to: 'Агент от А до Я' },
    { from: 'нейроагенда', to: 'нейроагента' },
  ]);
  assert.equal(result.corrections[0].start, 1);
  assert.equal(result.corrections[0].end, 3);
});

test('unknown chart scene becomes a safe split scene', () => {
  const brief = normalizeGeneratedBrief({
    scenes: [{
      scene: 'chart',
      start: 0,
      end: 4,
      headCream: 'РОСТ',
      headOrange: 'В ДВА РАЗА',
      sub: 'Результат вырос в два раза',
    }],
  }, context);

  assert.equal(brief.scenes[0].scene, 'split');
  assert.deepEqual(brief.scenes[0].bullets, ['Результат вырос в два раза']);
  assert.equal(brief.status, 'draft');
});

test('special scene without required data falls back to split', () => {
  const brief = normalizeGeneratedBrief({
    scenes: [
      { scene: 'stat', start: 0, end: 3, headCream: 'БЕЗ', headOrange: 'ЦИФРЫ', sub: 'Это тезис' },
      { scene: 'broll', start: 3, end: 6, brollSrc: 'public/broll/missing.jpg', headCream: 'НЕТ', headOrange: 'ФАЙЛА' },
    ],
  }, context);

  assert.deepEqual(brief.scenes.map((scene) => scene.scene), ['split', 'split']);
});

test('normalizer sorts timings, removes overlap and clips scene arrays', () => {
  const brief = normalizeGeneratedBrief({
    scenes: [
      {
        scene: 'bottom-diagram',
        start: 5,
        end: 10,
        headCream: 'ТРИ',
        headOrange: 'ШАГА',
        steps: ['Один', 'Два', 'Три', 'Четыре', 'Пять'],
      },
      {
        scene: 'split',
        start: 0,
        end: 7,
        headCream: 'ПЕРВАЯ',
        headOrange: 'МЫСЛЬ',
        bullets: ['1', '2', '3', '4', '5'],
      },
    ],
  }, context);

  assert.deepEqual(brief.scenes.map(({ start, end }) => ({ start, end })), [
    { start: 0, end: 5 },
    { start: 5, end: 10 },
  ]);
  assert.deepEqual(brief.scenes[0].bullets, ['1', '2', '3', '4']);
  assert.deepEqual(brief.scenes[1].steps, ['Один', 'Два', 'Три', 'Четыре']);
});

test('available broll remains in the draft and corrections are merged', () => {
  const availableBroll = ['broll/demo.jpg'];
  const brief = normalizeGeneratedBrief({
    corrections: [{ start: 4, from: 'робат', to: 'робот', reason: 'контекст' }],
    scenes: [{
      scene: 'broll',
      start: 0,
      end: 5,
      brollSrc: 'broll/demo.jpg',
      headCream: 'ЖИВОЙ',
      headOrange: 'ПРИМЕР',
    }],
  }, {
    ...context,
    dictionaryCorrections: [{ start: 1, from: 'Адая', to: 'А до Я', reason: 'словарь' }],
    availableBroll,
  });

  assert.equal(brief.scenes[0].scene, 'broll');
  assert.equal(brief.corrections.length, 2);
  assert.deepEqual(brief.output, context.output);
});

test('scene limit is enforced after the LLM response', () => {
  const scenes = [0, 2, 4].map((start, index) => ({
    scene: 'fullscreen',
    start,
    end: start + 2,
    caption: `СЦЕНА ${index + 1}`,
  }));

  const brief = normalizeGeneratedBrief({ scenes }, { ...context, maxScenes: 2 });

  assert.equal(brief.scenes.length, 2);
});

test('speaker position from intake is stored in the draft', () => {
  const brief = normalizeGeneratedBrief({
    scenes: [{ scene: 'fullscreen', start: 0, end: 2, caption: 'В КАДРЕ' }],
  }, { ...context, facePos: { x: 0.25, y: 0.45 } });

  assert.deepEqual(brief.facePos, { x: 0.25, y: 0.45 });
});

test('speaker zoom from intake is stored in the draft', () => {
  const brief = normalizeGeneratedBrief({
    scenes: [{ scene: 'fullscreen', start: 0, end: 2, caption: 'В КАДРЕ' }],
  }, { ...context, faceZoom: 1.08 });

  assert.equal(brief.faceZoom, 1.08);
});
