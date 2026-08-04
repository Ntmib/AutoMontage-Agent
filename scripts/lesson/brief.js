const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');

const OFFICIAL_SCENES = [
  'fullscreen',
  'split',
  'bottom-diagram',
  'blur-overlay',
  'text-only',
  'stat',
  'broll',
];

const schemaPath = path.join(__dirname, '../../schema/lesson-brief.schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
const validator = ajv.compile(schema);

function schemaErrors(brief) {
  if (validator(brief)) return [];
  return (validator.errors || []).map((error) => {
    const location = error.instancePath || '(корень)';
    if (error.keyword === 'enum') {
      const value = location.split('/').filter(Boolean).reduce(
        (current, key) => current && current[key],
        brief,
      );
      return `${location}: значение "${value}" не разрешено`;
    }
    return `${location}: ${error.message}`;
  });
}

function validateLessonBrief(brief, { requireApproved = false } = {}) {
  const errors = schemaErrors(brief);
  const scenes = Array.isArray(brief && brief.scenes) ? brief.scenes : [];

  scenes.forEach((scene, index) => {
    if (!OFFICIAL_SCENES.includes(scene.scene)) {
      errors.push(`scenes[${index}]: сцена "${scene.scene}" не входит в официальную библиотеку`);
    }
    if (Number.isFinite(scene.start) && Number.isFinite(scene.end) && scene.end <= scene.start) {
      errors.push(`scenes[${index}]: end (${scene.end}) должен быть больше start (${scene.start})`);
    }
    if (index > 0 && Number.isFinite(scene.start) && Number.isFinite(scenes[index - 1].end)
      && scene.start < scenes[index - 1].end) {
      errors.push(`scenes[${index}]: тайминг пересекается с предыдущей сценой`);
    }
  });

  if (requireApproved && brief && brief.status !== 'approved') {
    errors.push('монтажный лист не утверждён: статус должен быть approved');
  }

  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

function ensureApproved(brief) {
  const result = validateLessonBrief(brief, { requireApproved: true });
  if (!result.ok) throw new Error(result.errors.join('\n'));
}

function buildReelScenesProps({ brief, theme, sourceFile = 'source.mp4' }) {
  ensureApproved(brief);
  const props = {
    theme: theme ?? brief.theme,
    scenes: brief.scenes,
    faceSrc: sourceFile,
    audioSrc: sourceFile,
    videoTitle: brief.title,
    width: brief.output.width,
    height: brief.output.height,
    fps: brief.output.fps,
    durationInFrames: brief.output.durationInFrames,
  };
  if (brief.facePos) props.facePos = brief.facePos;
  if (brief.faceZoom) props.faceZoom = brief.faceZoom;
  if (brief.music) {
    const extension = path.extname(brief.music.file).toLowerCase() || '.mp3';
    props.musicSrc = `source-music${extension}`;
    props.musicGainDb = brief.music.gainDb;
    props.musicFadeInSec = brief.music.fadeInSec ?? 0;
    props.musicFadeOutSec = brief.music.fadeOutSec ?? 0;
  }
  return props;
}

function clock(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const rest = Math.floor(safe % 60);
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function cell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function sceneLabel(scene) {
  return scene === 'split' ? 'split-top' : scene;
}

function sceneSummary(scene) {
  if (scene.scene === 'fullscreen') return scene.caption;
  if (scene.scene === 'bottom-diagram') return `${scene.headCream} ${scene.headOrange}: ${(scene.steps || []).join(' → ')}`;
  if (scene.scene === 'text-only') return `«${scene.quoteCream} ${scene.quoteOrange}»`;
  if (scene.scene === 'stat') return `${scene.statCream}${scene.statOrange}: ${scene.headCream} ${scene.headOrange}`;
  if (scene.scene === 'blur-overlay') return `${scene.big}: ${scene.headCream} ${scene.headOrange}`;
  if (scene.scene === 'broll') return `${scene.headCream} ${scene.headOrange} (${scene.brollSrc})`;
  return `${scene.headCream} ${scene.headOrange}: ${(scene.bullets || []).join('; ')}`;
}

function formatBriefMarkdown(brief) {
  const sceneRows = (brief.scenes || []).map((scene, index) => (
    `| ${String(index + 1).padStart(2, '0')} | ${sceneLabel(scene.scene)} | ${clock(scene.start)}–${clock(scene.end)} | ${cell(sceneSummary(scene))} |`
  ));
  const correctionRows = (brief.corrections || []).map((correction) => (
    `| ${clock(correction.start)} | ${cell(correction.from)} | ${cell(correction.to)} | ${cell(correction.reason)} |`
  ));

  return [
    `# ТЗ на монтаж: ${brief.title || 'ВИДЕО'}`,
    '',
    `Статус: \`${brief.status}\``,
    `Формат: \`${brief.output.aspect}\`, ${brief.output.width}x${brief.output.height}, ${brief.output.fps} FPS`,
    '',
    '## Сцены',
    '',
    '| № | Сцена | Тайминг | Что на экране |',
    '|---:|---|---:|---|',
    ...sceneRows,
    '',
    '## Исправления распознавания',
    '',
    '| Тайминг | Было | Стало | Почему |',
    '|---:|---|---|---|',
    ...(correctionRows.length ? correctionRows : ['| – | Исправлений нет | – | – |']),
    '',
    'Рендер разрешён только после явного утверждения и смены статуса на `approved`.',
    '',
  ].join('\n');
}

module.exports = {
  OFFICIAL_SCENES,
  buildReelScenesProps,
  formatBriefMarkdown,
  validateLessonBrief,
};
