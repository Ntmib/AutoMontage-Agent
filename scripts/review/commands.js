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

function applyReplaceBroll(candidate, command, assetIds) {
  if (!exactCommandShape(command, ['type', 'sceneIndex', 'assetId'])
    || command.type !== 'replace-broll') {
    commandError('shape is not supported');
  }
  if (!(assetIds instanceof Set)) commandError('asset ids are invalid');

  const { sceneIndex, assetId } = command;
  const scenes = candidate && candidate.scenes;
  if (!Array.isArray(scenes) || !Number.isInteger(sceneIndex)
    || sceneIndex < 0 || sceneIndex >= scenes.length) {
    commandError('broll scene index is invalid');
  }
  if (!isOpaqueAssetId(assetId) || !assetIds.has(assetId)) {
    commandError('asset is not allowlisted');
  }
  if (!scenes[sceneIndex] || scenes[sceneIndex].scene !== 'broll') {
    commandError('broll scene is not eligible');
  }

  scenes[sceneIndex].brollSrc = assetId;
}

function validateCandidate(candidate, base) {
  candidate.status = 'draft';
  const validation = validateLessonBrief(candidate);
  if (!validation.ok) commandError('produced an invalid lesson brief');
  assertProtectedIdentity(candidate, base);
  return candidate;
}

function applyReviewCommand({ brief, command, assetIds } = {}) {
  const candidate = deepCloneBrief(brief);
  const type = isPlainObject(command) && Object.getOwnPropertyDescriptor(command, 'type');
  if (!type || !Object.hasOwn(type, 'value') || typeof type.value !== 'string') {
    commandError('shape is not supported');
  }

  if (type.value === 'move-boundary') {
    applyMoveBoundary(candidate, command);
  } else if (type.value === 'replace-broll') {
    applyReplaceBroll(candidate, command, assetIds);
  } else {
    commandError('type is not supported');
  }
  return validateCandidate(candidate, brief);
}

function applyReviewCommands({ brief, commands, assetIds } = {}) {
  if (!Array.isArray(commands)) commandError('commands must be an array');
  let candidate = deepCloneBrief(brief);
  for (const command of commands) {
    candidate = applyReviewCommand({ brief: candidate, command, assetIds });
    assertProtectedIdentity(candidate, brief);
  }
  return candidate;
}

module.exports = {
  applyReviewCommand,
  applyReviewCommands,
  isOpaqueAssetId,
};
