const path = require('path');
const { buildReelScenesProps } = require('./brief');

const LESSON_DEFAULT_THEME = 'lesson-neutral';

const DEFAULT_DUCKING = {
  thresholdDb: -28,
  ratio: 8,
  attackMs: 5,
  releaseMs: 300,
};

function buildLessonMusicMixArgs(music, durationSec) {
  const ducking = { ...DEFAULT_DUCKING, ...(music.ducking || {}) };
  return [
    '--gain', String(music.gainDb),
    '--start', String(music.startSec ?? 0),
    '--rate', String(music.playbackRate ?? 1),
    '--fade-in', String(music.fadeInSec ?? 0),
    '--fade-out', String(music.fadeOutSec ?? 0),
    '--duration', String(durationSec),
    '--threshold', (10 ** (ducking.thresholdDb / 20)).toFixed(4),
    '--ratio', String(ducking.ratio),
    '--attack', String(ducking.attackMs),
    '--release', String(ducking.releaseMs),
  ];
}

function getLessonAction({ isLesson, briefFile }) {
  if (!isLesson) return null;
  return briefFile ? 'render' : 'plan';
}

function assertLessonOptions({ isLesson, args }) {
  if (!isLesson) return;
  if (args.includes('--tighten')) {
    throw new Error('--tighten для lesson нужно применить до создания ТЗ к отдельному исходнику');
  }
  if (args.includes('--reframe')) {
    throw new Error('для вертикального lesson используй --aspect vertical вместо --reframe');
  }
}

function buildGenBriefArgs({
  transcriptPath,
  briefPath,
  markdownPath,
  theme,
  title,
  geometry,
  duration,
  source,
  maxScenes,
  availableBroll = [],
  facePos = null,
  faceZoom = null,
}) {
  const args = [
    transcriptPath,
    briefPath,
    '--markdown', markdownPath,
    '--theme', theme,
    '--title', title,
    '--aspect', geometry.aspect,
    '--width', String(geometry.width),
    '--height', String(geometry.height),
    '--fps', String(geometry.fps),
    '--duration', String(duration),
    '--source', source,
    '--max', String(maxScenes),
  ];
  if (availableBroll.length) {
    args.push('--available-broll', availableBroll.join(','));
  }
  if (facePos) {
    args.push('--face-x', String(facePos.x), '--face-y', String(facePos.y));
  }
  if (faceZoom) args.push('--face-zoom', String(faceZoom));
  return args;
}

function prepareLessonRender({ brief, theme, sourceVideo, framesOverride = null }) {
  const approvedSource = path.resolve(brief.source);
  const requestedSource = path.resolve(sourceVideo);
  if (approvedSource !== requestedSource) {
    throw new Error(
      `нельзя рендерить утверждённый brief с видео другого исходника: ${approvedSource}`,
    );
  }

  const props = buildReelScenesProps({ brief, theme, includeMusic: false });
  const requestedFrames = Number(framesOverride);
  if (Number.isFinite(requestedFrames) && requestedFrames > 0) {
    props.durationInFrames = Math.min(
      props.durationInFrames,
      Math.floor(requestedFrames),
    );
  }

  const durationSec = props.durationInFrames / props.fps;
  const music = brief.music ? {
    sourcePath: path.resolve(brief.music.file),
    mixArgs: buildLessonMusicMixArgs(brief.music, durationSec),
  } : null;

  return { composition: 'ReelScenes', props, music };
}

module.exports = {
  LESSON_DEFAULT_THEME,
  assertLessonOptions,
  buildLessonMusicMixArgs,
  buildGenBriefArgs,
  getLessonAction,
  prepareLessonRender,
};
