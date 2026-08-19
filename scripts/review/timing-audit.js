const {
  frameRateFromFps,
  secondsToFrame,
  frameToSeconds,
} = require('./media-time');

function isFrameAligned(seconds, rate) {
  const roundedSeconds = frameToSeconds(secondsToFrame(seconds, rate), rate);
  return Math.abs(seconds - roundedSeconds) <= Number.EPSILON * Math.max(1, Math.abs(seconds)) * 16;
}

function auditBriefTiming({ brief, transcript } = {}) {
  const errors = [];
  const warnings = [];
  const suggestions = [];

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
    if (isFrameAligned(seconds, rate)) return;
    const frame = secondsToFrame(seconds, rate);
    suggestions.push({
      sceneIndex,
      boundary,
      seconds,
      frame,
      suggestedSeconds: frameToSeconds(frame, rate),
    });
  }

  if (validScenes[0]) suggest(0, 'start');
  for (let index = 0; index < brief.scenes.length - 1; index += 1) {
    if (validScenes[index] && validScenes[index + 1]
      && brief.scenes[index].end === brief.scenes[index + 1].start) {
      suggest(index, 'end');
    }
  }
  const lastIndex = brief.scenes.length - 1;
  if (lastIndex > 0 && validScenes[lastIndex]) {
    suggest(lastIndex, 'end');
  }

  return { errors, warnings, suggestions };
}

module.exports = { auditBriefTiming };
