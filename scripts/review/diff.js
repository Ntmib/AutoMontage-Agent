const { isOpaqueAssetId } = require('./commands');

function scenesFrom(brief) {
  return Array.isArray(brief && brief.scenes) ? brief.scenes : null;
}

function isSharedBoundary(left, right) {
  return left && right && Number.isFinite(left.end) && Number.isFinite(right.start)
    && left.end === right.start;
}

function hasSameSceneKinds(beforeScenes, afterScenes) {
  return beforeScenes.length === afterScenes.length && beforeScenes.every((scene, index) => (
    scene && afterScenes[index] && scene.scene === afterScenes[index].scene
  ));
}

function diffLessonBrief({ before, after } = {}) {
  const beforeScenes = scenesFrom(before);
  const afterScenes = scenesFrom(after);
  if (!beforeScenes || !afterScenes || !hasSameSceneKinds(beforeScenes, afterScenes)) return [];

  const changes = [];
  for (let index = 0; index < beforeScenes.length - 1; index += 1) {
    const beforeLeft = beforeScenes[index];
    const beforeRight = beforeScenes[index + 1];
    const afterLeft = afterScenes[index];
    const afterRight = afterScenes[index + 1];
    if (isSharedBoundary(beforeLeft, beforeRight) && isSharedBoundary(afterLeft, afterRight)
      && beforeLeft.end !== afterLeft.end) {
      changes.push({
        kind: 'boundary',
        leftScene: index,
        rightScene: index + 1,
        from: beforeLeft.end,
        to: afterLeft.end,
      });
    }
  }
  for (let index = 0; index < beforeScenes.length; index += 1) {
    const beforeScene = beforeScenes[index];
    const afterScene = afterScenes[index];
    if (beforeScene.scene === 'broll' && afterScene.scene === 'broll'
      && typeof beforeScene.brollSrc === 'string' && typeof afterScene.brollSrc === 'string'
      && beforeScene.brollSrc !== afterScene.brollSrc && isOpaqueAssetId(afterScene.brollSrc)) {
      changes.push({
        kind: 'asset',
        scene: index,
        from: beforeScene.brollSrc,
        to: afterScene.brollSrc,
      });
    }
  }
  return changes;
}

module.exports = { diffLessonBrief };
