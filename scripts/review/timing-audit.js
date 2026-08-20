const {
  frameRateFromFps,
  secondsToFrame,
  frameToSeconds,
} = require('./media-time');

const WORD_SUGGESTION_WINDOW_SECONDS = 0.12;

function isFrameAligned(seconds, rate) {
  const roundedSeconds = frameToSeconds(secondsToFrame(seconds, rate), rate);
  return Math.abs(seconds - roundedSeconds) <= Number.EPSILON * Math.max(1, Math.abs(seconds)) * 16;
}

function normalizedWordBoundaries(words) {
  if (!Array.isArray(words)) return [];
  const boundaries = [];
  for (const word of words) {
    const text = typeof word?.text === 'string' ? word.text.trim() : '';
    const start = Number(word?.start);
    const end = Number(word?.end);
    if (!text || !Number.isFinite(start) || !Number.isFinite(end)
      || start < 0 || end < start) continue;
    boundaries.push(start, end);
  }
  return [...new Set(boundaries)].sort((left, right) => left - right);
}

function nearestWordBoundary(seconds, boundaries) {
  return boundaries
    .filter((value) => Math.abs(value - seconds) <= WORD_SUGGESTION_WINDOW_SECONDS)
    .sort((left, right) => (
      Math.abs(left - seconds) - Math.abs(right - seconds) || left - right
    ))[0];
}

function auditBriefTiming({ brief, words } = {}) {
  const errors = [];
  const warnings = [];
  const suggestions = [];
  const wordBoundaries = normalizedWordBoundaries(words);

  let rate;
  try {
    rate = frameRateFromFps(brief?.output?.fps);
  } catch (error) {
    errors.push({ field: 'output.fps', message: error.message });
    return { errors, warnings, suggestions };
  }

  if (!Array.isArray(brief.scenes)) {
    errors.push({ field: 'scenes', message: 'Scenes must be an array' });
    return { errors, warnings, suggestions };
  }

  const validScenes = [];
  for (let index = 0; index < brief.scenes.length; index += 1) {
    const scene = brief.scenes[index];
    if (!scene || !Number.isFinite(scene.start) || scene.start < 0
      || !Number.isFinite(scene.end) || scene.end < 0) {
      errors.push({ sceneIndex: index, message: 'Scene boundaries must be non-negative finite numbers' });
      continue;
    }
    if (scene.end < scene.start) {
      errors.push({ sceneIndex: index, message: 'Scene end must not precede its start' });
      continue;
    }

    validScenes[index] = true;

    const nextScene = brief.scenes[index + 1];
    if (nextScene && nextScene.start !== scene.end) {
      warnings.push({ sceneIndex: index, message: 'Adjacent scenes do not share a boundary' });
    }
  }

  function suggest(sceneIndex, boundary) {
    const scene = brief.scenes[sceneIndex];
    const seconds = scene[boundary];
    if (!isFrameAligned(seconds, rate)) {
      const frame = secondsToFrame(seconds, rate);
      suggestions.push({
        sceneIndex,
        boundary,
        seconds,
        frame,
        suggestedSeconds: frameToSeconds(frame, rate),
        reason: 'frame',
      });
    }
    const wordSeconds = nearestWordBoundary(seconds, wordBoundaries);
    if (wordSeconds !== undefined && Math.abs(wordSeconds - seconds) > 0.000001) {
      suggestions.push({
        sceneIndex,
        boundary,
        seconds,
        suggestedSeconds: wordSeconds,
        reason: 'word',
      });
    }
  }

  if (validScenes[0]) suggest(0, 'start');
  for (let index = 0; index < brief.scenes.length - 1; index += 1) {
    if (validScenes[index] && validScenes[index + 1]
      && brief.scenes[index].end === brief.scenes[index + 1].start) {
      suggest(index, 'end');
    }
  }
  const lastIndex = brief.scenes.length - 1;
  if (lastIndex >= 0 && validScenes[lastIndex]) {
    suggest(lastIndex, 'end');
  }

  return { errors, warnings, suggestions };
}

module.exports = { auditBriefTiming };
