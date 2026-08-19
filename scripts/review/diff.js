const { isDeepStrictEqual } = require('node:util');

const { validateLessonBrief } = require('../lesson/brief');
const { isOpaqueAssetId } = require('./commands');

function unsupportedDiff() {
  throw new Error('review diff contains unsupported changes');
}

function validBrief(brief) {
  try {
    return validateLessonBrief(brief).ok;
  } catch (_) {
    return false;
  }
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

function addAssetChanges(before, after, expected, changes) {
  for (let index = 0; index < before.scenes.length; index += 1) {
    const beforeScene = before.scenes[index];
    const afterScene = after.scenes[index];
    if (beforeScene.brollSrc === afterScene.brollSrc) continue;
    if (beforeScene.scene !== 'broll' || afterScene.scene !== 'broll'
      || !isOpaqueAssetId(afterScene.brollSrc)) {
      unsupportedDiff();
    }
    expected.scenes[index].brollSrc = afterScene.brollSrc;
    changes.push({
      kind: 'asset',
      scene: index,
      from: beforeScene.brollSrc,
      to: afterScene.brollSrc,
    });
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
