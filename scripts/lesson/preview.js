const path = require('node:path');

const { buildDraftPreviewProps } = require('./brief');
const {
  LESSON_SOURCE_ALIAS,
  buildLessonMusicMixArgs,
} = require('./workflow');

function prepareLessonPreview(options = {}) {
  const {
    brief,
    theme,
    sourceVideo,
  } = options;
  const hasFrom = Object.prototype.hasOwnProperty.call(options, 'fromSec');
  const hasTo = Object.prototype.hasOwnProperty.call(options, 'toSec')
    && options.toSec !== null;
  if (hasFrom !== hasTo) {
    throw new Error('диапазон предпросмотра требует обе границы: --from-sec и --to-sec');
  }

  const approvedSource = path.resolve(brief?.source || '');
  const requestedSource = path.resolve(sourceVideo || '');
  if (approvedSource !== requestedSource) {
    throw new Error(
      `нельзя собирать предпросмотр с видео другого исходника: ${approvedSource}`,
    );
  }

  const props = buildDraftPreviewProps({
    brief,
    theme,
    sourceFile: LESSON_SOURCE_ALIAS,
  });
  const fps = props.fps;
  const durationSec = props.durationInFrames / fps;
  let range = {
    kind: 'full',
    fromSec: 0,
    toSec: durationSec,
    fromFrame: 0,
    toFrameExclusive: props.durationInFrames,
  };

  if (hasFrom && hasTo) {
    const rawFrom = Number(options.fromSec);
    const rawTo = Number(options.toSec);
    if (!Number.isFinite(rawFrom) || !Number.isFinite(rawTo)
      || rawFrom < 0 || rawTo <= rawFrom) {
      throw new Error('диапазон предпросмотра задан некорректно');
    }
    if (rawTo > durationSec) {
      throw new Error('диапазон предпросмотра выходит за длительность композиции');
    }
    const fromFrame = Math.round(rawFrom * fps);
    const toFrameExclusive = Math.round(rawTo * fps);
    if (toFrameExclusive <= fromFrame) {
      throw new Error('диапазон предпросмотра короче одного кадра');
    }
    range = {
      kind: 'excerpt',
      fromSec: fromFrame / fps,
      toSec: toFrameExclusive / fps,
      fromFrame,
      toFrameExclusive,
    };
  }

  const previewMusic = brief.music ? {
    ...brief.music,
    startSec: (brief.music.startSec ?? 0)
      + (range.fromSec * (brief.music.playbackRate ?? 1)),
  } : null;
  const music = previewMusic ? {
    sourcePath: path.resolve(brief.music.file),
    mixArgs: buildLessonMusicMixArgs(previewMusic, range.toSec - range.fromSec),
  } : null;

  return {
    composition: 'ReelScenes',
    props,
    music,
    range,
    previewMedia: {
      brief,
      sourcePath: requestedSource,
      sourceAlias: LESSON_SOURCE_ALIAS,
    },
  };
}

module.exports = { prepareLessonPreview };
