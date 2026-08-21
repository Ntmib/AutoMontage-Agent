const { validateLessonBrief } = require('../lesson/brief');

const OPAQUE_ASSET_ID = /^asset-[1-9]\d*$/;

function commandError(message) {
  throw new Error(`review command ${message}`);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch (_) {
    return false;
  }
}

function exactCommandShape(command, expectedKeys) {
  if (!isPlainObject(command)) return false;
  const keys = Reflect.ownKeys(command);
  if (keys.length !== expectedKeys.length || keys.some((key) => typeof key !== 'string')) return false;
  for (const expectedKey of expectedKeys) {
    if (!keys.includes(expectedKey)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(command, expectedKey);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false;
  }
  return true;
}

function deepCloneBrief(brief) {
  try {
    return structuredClone(brief);
  } catch (_) {
    commandError('brief must be cloneable');
  }
}

function jsonBytes(value) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) commandError('cannot change protected identity');
  return encoded;
}

function assertProtectedIdentity(candidate, base) {
  for (const field of ['source', 'theme', 'output']) {
    if (jsonBytes(candidate[field]) !== jsonBytes(base && base[field])) {
      commandError('cannot change protected identity');
    }
  }
}

function isOpaqueAssetId(value) {
  return typeof value === 'string' && OPAQUE_ASSET_ID.test(value);
}

function applyMoveBoundary(candidate, command) {
  if (!exactCommandShape(command, ['type', 'leftSceneIndex', 'seconds'])
    || command.type !== 'move-boundary') {
    commandError('shape is not supported');
  }

  const { leftSceneIndex, seconds } = command;
  const scenes = candidate && candidate.scenes;
  if (!Array.isArray(scenes) || !Number.isInteger(leftSceneIndex)
    || leftSceneIndex < 0 || leftSceneIndex >= scenes.length - 1) {
    commandError('boundary index is invalid');
  }
  if (!Number.isFinite(seconds) || seconds < 0) commandError('boundary seconds are invalid');

  const left = scenes[leftSceneIndex];
  const right = scenes[leftSceneIndex + 1];
  if (!left || !right || !Number.isFinite(left.start) || !Number.isFinite(left.end)
    || !Number.isFinite(right.start) || !Number.isFinite(right.end)
    || left.end !== right.start) {
    commandError('boundary is invalid');
  }
  if (seconds <= left.start || seconds >= right.end) {
    commandError('boundary seconds are out of range');
  }

  left.end = seconds;
  right.start = seconds;
}

function eligibleBrollScene(candidate, sceneIndex) {
  const scenes = candidate && candidate.scenes;
  if (!Array.isArray(scenes) || !Number.isInteger(sceneIndex)
    || sceneIndex < 0 || sceneIndex >= scenes.length) {
    commandError('broll scene index is invalid');
  }
  const scene = scenes[sceneIndex];
  if (!scene || scene.scene !== 'broll' || scene.brollMediaBlocked === true) {
    commandError('broll scene is not eligible');
  }
  return scene;
}

function selectableAsset(assets, assetId) {
  if (!(assets instanceof Map)) commandError('assets are invalid');
  if (!isOpaqueAssetId(assetId)) commandError('asset is not allowlisted');
  const asset = assets.get(assetId);
  if (!asset || !['image', 'video'].includes(asset.mediaKind)) {
    commandError('asset is not allowlisted');
  }
  const selectable = asset.mediaKind === 'image'
    ? asset.capabilities?.brollImage === true
    : asset.capabilities?.brollVideo === true;
  if (!selectable) commandError('asset is not selectable');
  return asset;
}

function applyReplaceBroll(candidate, command, assets) {
  if (!exactCommandShape(command, ['type', 'sceneIndex', 'assetId'])
    || command.type !== 'replace-broll') {
    commandError('shape is not supported');
  }
  const { sceneIndex, assetId } = command;
  const scene = eligibleBrollScene(candidate, sceneIndex);
  const asset = selectableAsset(assets, assetId);
  delete scene.brollSrc;
  scene.brollMedia = asset.mediaKind === 'video'
    ? { kind: 'video', assetId, trimStartSec: 0, fit: 'contain', audioMode: 'mute' }
    : { kind: 'image', assetId, fit: 'cover' };
}

function selectedAsset(scene, assets) {
  const media = scene && scene.brollMedia;
  return media && isOpaqueAssetId(media.assetId) && assets instanceof Map
    ? assets.get(media.assetId)
    : null;
}

function validateMediaSelection(scene, assets, fps) {
  const media = scene.brollMedia;
  const asset = selectedAsset(scene, assets);
  if (!asset || asset.mediaKind !== media.kind) commandError('selected asset is invalid');
  if (!['contain', 'cover'].includes(media.fit)) commandError('broll fit is invalid');
  if (media.kind === 'image') {
    if (!exactCommandShape(media, ['kind', 'assetId', 'fit'])
      || asset.capabilities?.brollImage !== true) commandError('image selection is invalid');
    return {
      kind: 'image', src: asset.reference, sha256: asset.canonicalSha256, fit: media.fit,
    };
  }
  if (!exactCommandShape(media, ['kind', 'assetId', 'trimStartSec', 'fit', 'audioMode'])
    || asset.capabilities?.brollVideo !== true
    || !Number.isFinite(media.trimStartSec) || media.trimStartSec < 0
    || !['mute', 'mix', 'replace'].includes(media.audioMode)
    || (asset.hasAudio !== true && media.audioMode !== 'mute')) {
    commandError('video selection is invalid');
  }
  const trimStartFrame = Math.round(media.trimStartSec * fps);
  if (media.trimStartSec !== trimStartFrame / fps) commandError('video start is not frame snapped');
  const sceneFrames = Math.round((scene.end - scene.start) * fps);
  const clipFrames = Math.round(Number(asset.durationSec) * fps);
  if (!Number.isSafeInteger(sceneFrames) || sceneFrames <= 0
    || !Number.isSafeInteger(clipFrames) || clipFrames <= 0
    || trimStartFrame + sceneFrames > clipFrames) commandError('video clip duration is too short');
  return {
    kind: 'video',
    src: asset.reference,
    sha256: asset.canonicalSha256,
    trimStartSec: media.trimStartSec,
    fit: media.fit,
    audioMode: media.audioMode,
  };
}

function validateReviewCandidate({ candidate, base, assets, fps } = {}) {
  if (!(assets instanceof Map) || !Number.isFinite(fps) || fps <= 0
    || candidate?.output?.fps !== fps) {
    commandError('review context is invalid');
  }
  candidate.status = 'draft';
  if (!Array.isArray(candidate.scenes)
    || candidate.scenes.some((scene) => scene && scene.brollMediaBlocked === true)) {
    commandError('contains unresolved broll media');
  }
  const canonicalCandidate = deepCloneBrief(candidate);
  for (let index = 0; index < canonicalCandidate.scenes.length; index += 1) {
    const original = candidate.scenes[index];
    if (!original || original.scene !== 'broll' || !original.brollMedia) continue;
    canonicalCandidate.scenes[index].brollMedia = validateMediaSelection(original, assets, fps);
  }
  const validation = validateLessonBrief(canonicalCandidate);
  if (!validation.ok) commandError('produced an invalid lesson brief');
  assertProtectedIdentity(candidate, base);
  return candidate;
}

function applySetBrollFit(candidate, command) {
  if (!exactCommandShape(command, ['type', 'sceneIndex', 'fit'])
    || command.type !== 'set-broll-fit' || !['contain', 'cover'].includes(command.fit)) {
    commandError('shape is not supported');
  }
  const scene = eligibleBrollScene(candidate, command.sceneIndex);
  if (!scene.brollMedia) commandError('broll media is not selected');
  scene.brollMedia.fit = command.fit;
}

function applySetBrollVideoStart(candidate, command, fps) {
  if (!exactCommandShape(command, ['type', 'sceneIndex', 'trimStartSec'])
    || command.type !== 'set-broll-video-start'
    || !Number.isFinite(command.trimStartSec) || command.trimStartSec < 0
    || !Number.isFinite(fps) || fps <= 0) commandError('shape is not supported');
  const scene = eligibleBrollScene(candidate, command.sceneIndex);
  if (scene.brollMedia?.kind !== 'video') commandError('video broll is not selected');
  scene.brollMedia.trimStartSec = Math.round(command.trimStartSec * fps) / fps;
}

function applySetBrollAudioMode(candidate, command, assets) {
  if (!exactCommandShape(command, ['type', 'sceneIndex', 'audioMode'])
    || command.type !== 'set-broll-audio-mode'
    || !['mute', 'mix', 'replace'].includes(command.audioMode)) {
    commandError('shape is not supported');
  }
  const scene = eligibleBrollScene(candidate, command.sceneIndex);
  if (scene.brollMedia?.kind !== 'video') commandError('video broll is not selected');
  const asset = selectedAsset(scene, assets);
  if (!asset || (asset.hasAudio !== true && command.audioMode !== 'mute')) {
    commandError('video asset has no eligible audio');
  }
  scene.brollMedia.audioMode = command.audioMode;
}

function applyReviewCommand({ brief, command, assets, fps } = {}) {
  const candidate = deepCloneBrief(brief);
  const type = isPlainObject(command) && Object.getOwnPropertyDescriptor(command, 'type');
  if (!type || !Object.hasOwn(type, 'value') || typeof type.value !== 'string') {
    commandError('shape is not supported');
  }

  if (type.value === 'move-boundary') {
    applyMoveBoundary(candidate, command);
  } else if (type.value === 'replace-broll') {
    applyReplaceBroll(candidate, command, assets);
  } else if (type.value === 'set-broll-fit') {
    applySetBrollFit(candidate, command);
  } else if (type.value === 'set-broll-video-start') {
    applySetBrollVideoStart(candidate, command, fps);
  } else if (type.value === 'set-broll-audio-mode') {
    applySetBrollAudioMode(candidate, command, assets);
  } else {
    commandError('type is not supported');
  }
  return validateReviewCandidate({ candidate, base: brief, assets, fps });
}

function applyReviewCommands({ brief, commands, assets, fps } = {}) {
  if (!Array.isArray(commands)) commandError('commands must be an array');
  let candidate = deepCloneBrief(brief);
  for (const command of commands) {
    candidate = applyReviewCommand({ brief: candidate, command, assets, fps });
    assertProtectedIdentity(candidate, brief);
  }
  return candidate;
}

module.exports = {
  applyReviewCommand,
  applyReviewCommands,
  isOpaqueAssetId,
  selectedAsset,
  validateReviewCandidate,
};
