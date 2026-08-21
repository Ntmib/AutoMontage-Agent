const { isDeepStrictEqual } = require('node:util');

const { isOpaqueAssetId } = require('./commands');

function unsupportedDiff() {
  throw new Error('review diff contains unsupported changes');
}

function validBrief(brief) {
  return brief !== null && typeof brief === 'object' && !Array.isArray(brief)
    && Array.isArray(brief.scenes) && typeof brief.status === 'string';
}

function deepClone(brief) {
  try {
    return structuredClone(brief);
  } catch (_) {
    unsupportedDiff();
  }
}

function isSharedBoundary(left, right) {
  return left && right && Number.isFinite(left.end) && Number.isFinite(right.start)
    && left.end === right.start;
}

function allowedStatusTransition(before, after) {
  return after.status === 'draft' && (before.status === 'approved' || before.status === 'draft');
}

function addBoundaryChanges(before, after, expected, changes) {
  for (let index = 0; index < before.scenes.length - 1; index += 1) {
    const beforeLeft = before.scenes[index];
    const beforeRight = before.scenes[index + 1];
    const afterLeft = after.scenes[index];
    const afterRight = after.scenes[index + 1];
    const leftChanged = beforeLeft.end !== afterLeft.end;
    const rightChanged = beforeRight.start !== afterRight.start;
    if (!leftChanged && !rightChanged) continue;
    if (!leftChanged || !rightChanged || !isSharedBoundary(beforeLeft, beforeRight)
      || !isSharedBoundary(afterLeft, afterRight)) {
      unsupportedDiff();
    }
    expected.scenes[index].end = afterLeft.end;
    expected.scenes[index + 1].start = afterRight.start;
    changes.push({
      kind: 'boundary',
      leftScene: index,
      rightScene: index + 1,
      from: beforeLeft.end,
      to: afterLeft.end,
    });
  }
}

function reviewMedia(scene) {
  if (scene?.brollMedia) return scene.brollMedia;
  if (isOpaqueAssetId(scene?.brollSrc)) {
    return { kind: 'image', assetId: scene.brollSrc, fit: 'cover' };
  }
  return null;
}

function safeReviewMedia(media) {
  if (!media || !['image', 'video'].includes(media.kind)
    || !isOpaqueAssetId(media.assetId) || !['contain', 'cover'].includes(media.fit)) return false;
  if (media.kind === 'image') {
    return isDeepStrictEqual(Object.keys(media).sort(), ['assetId', 'fit', 'kind']);
  }
  return isDeepStrictEqual(
    Object.keys(media).sort(),
    ['assetId', 'audioMode', 'fit', 'kind', 'trimStartSec'],
  ) && Number.isFinite(media.trimStartSec) && media.trimStartSec >= 0
    && ['mute', 'mix', 'replace'].includes(media.audioMode);
}

function addAssetChanges(before, after, expected, changes) {
  for (let index = 0; index < before.scenes.length; index += 1) {
    const beforeScene = before.scenes[index];
    const afterScene = after.scenes[index];
    const beforeMedia = reviewMedia(beforeScene);
    const afterMedia = reviewMedia(afterScene);
    if (isDeepStrictEqual(beforeMedia, afterMedia)) continue;
    if (beforeScene.scene !== 'broll' || afterScene.scene !== 'broll'
      || !safeReviewMedia(afterMedia)) unsupportedDiff();

    delete expected.scenes[index].brollSrc;
    expected.scenes[index].brollMedia = deepClone(afterMedia);
    const beforeId = safeReviewMedia(beforeMedia)
      ? beforeMedia.assetId
      : (typeof beforeScene.brollSrc === 'string' ? beforeScene.brollSrc : null);
    if (beforeId !== afterMedia.assetId) {
      changes.push({ kind: 'asset', scene: index, from: beforeId, to: afterMedia.assetId });
    }
    const beforeFit = safeReviewMedia(beforeMedia)
      ? beforeMedia.fit
      : (typeof beforeScene.brollSrc === 'string' ? 'cover' : null);
    if (beforeFit !== afterMedia.fit) {
      changes.push({ kind: 'fit', scene: index, from: beforeFit, to: afterMedia.fit });
    }
    const beforeStart = safeReviewMedia(beforeMedia) && beforeMedia.kind === 'video'
      ? beforeMedia.trimStartSec : null;
    const afterStart = afterMedia.kind === 'video' ? afterMedia.trimStartSec : null;
    if (beforeStart !== afterStart) {
      changes.push({ kind: 'clip-start', scene: index, from: beforeStart, to: afterStart });
    }
    const beforeAudio = safeReviewMedia(beforeMedia) && beforeMedia.kind === 'video'
      ? beforeMedia.audioMode : null;
    const afterAudio = afterMedia.kind === 'video' ? afterMedia.audioMode : null;
    if (beforeAudio !== afterAudio) {
      changes.push({ kind: 'audio-mode', scene: index, from: beforeAudio, to: afterAudio });
    }
  }
}

function diffLessonBrief({ before, after } = {}) {
  if (!validBrief(before) || !validBrief(after) || !allowedStatusTransition(before, after)
    || before.scenes.length !== after.scenes.length) {
    unsupportedDiff();
  }

  const expected = deepClone(before);
  expected.status = 'draft';
  const changes = [];
  addBoundaryChanges(before, after, expected, changes);
  addAssetChanges(before, after, expected, changes);
  if (!isDeepStrictEqual(expected, after)) unsupportedDiff();
  return changes;
}

module.exports = { diffLessonBrief };
