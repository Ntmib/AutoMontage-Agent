const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const REQUIRED_KEYS = [
  'version', 'id', 'label', 'mediaKind', 'canonicalSha256',
  'previewSha256', 'width', 'height', 'fps', 'durationSec', 'hasAudio',
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CONTROL = /[\p{Cc}]/u;

function isRegularDirectory(fileSystem, directory) {
  try {
    const stat = fileSystem.lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (_) {
    return false;
  }
}

function sameOwnedIdentity(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function readOpenedFile(fileSystem, filePath) {
  const constants = fileSystem.constants || fs.constants;
  let descriptor = null;
  try {
    descriptor = fileSystem.openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = fileSystem.fstatSync(descriptor);
    const nanosecondStat = fileSystem.fstatSync(descriptor, { bigint: true });
    if (!stat.isFile()) return null;
    const bytes = fileSystem.readFileSync(descriptor);
    return {
      bytes,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: nanosecondStat.mtimeNs,
    };
  } catch (_) {
    return null;
  } finally {
    if (descriptor !== null) fileSystem.closeSync(descriptor);
  }
}

function invalid(message) {
  throw new Error(`imported asset metadata ${message}`);
}

function parseImportedAssetMetadata({ bytes, expectedId } = {}) {
  let metadata;
  try {
    metadata = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (_) {
    invalid('is invalid JSON');
  }
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)
    || !isDeepStrictEqual(Object.keys(metadata).sort(), [...REQUIRED_KEYS].sort())) {
    invalid('shape is invalid');
  }
  if (!UUID.test(expectedId) || metadata.version !== 1 || metadata.id !== expectedId) {
    invalid('id is invalid');
  }
  if (typeof metadata.label !== 'string' || metadata.label.length === 0
    || metadata.label.normalize('NFKC') !== metadata.label || CONTROL.test(metadata.label)
    || Buffer.byteLength(metadata.label, 'utf8') > 255) {
    invalid('label is invalid');
  }
  if (!['image', 'video'].includes(metadata.mediaKind)) invalid('media kind is invalid');
  if (!SHA256.test(metadata.canonicalSha256)
    || !(metadata.previewSha256 === null || SHA256.test(metadata.previewSha256))) {
    invalid('hash is invalid');
  }
  if (!Number.isSafeInteger(metadata.width) || metadata.width <= 0
    || !Number.isSafeInteger(metadata.height) || metadata.height <= 0
    || typeof metadata.hasAudio !== 'boolean') {
    invalid('media fields are invalid');
  }
  if (metadata.mediaKind === 'image') {
    if (metadata.previewSha256 !== null || metadata.fps !== 0 || metadata.durationSec !== 0
      || metadata.hasAudio !== false) invalid('image fields are invalid');
  } else if (!SHA256.test(metadata.previewSha256) || !Number.isFinite(metadata.fps)
    || metadata.fps <= 0 || !Number.isFinite(metadata.durationSec) || metadata.durationSec <= 0) {
    invalid('video fields are invalid');
  }
  return metadata;
}

function inspectImportedAssetBundle({ projectDir, assetDirectory, fileSystem = fs } = {}) {
  if (typeof projectDir !== 'string' || typeof assetDirectory !== 'string') return null;
  const resolvedProject = path.resolve(projectDir);
  const resolvedDirectory = path.resolve(assetDirectory);
  const id = path.basename(resolvedDirectory);
  const mediaType = path.basename(path.dirname(resolvedDirectory));
  const expectedParent = path.join(resolvedProject, 'assets', 'broll', mediaType);
  if (!UUID.test(id) || !['images', 'video'].includes(mediaType)
    || path.dirname(resolvedDirectory) !== expectedParent || !isRegularDirectory(fileSystem, resolvedDirectory)) {
    return null;
  }
  const metadataFile = readOpenedFile(fileSystem, path.join(resolvedDirectory, 'asset.json'));
  if (!metadataFile) return null;
  let metadata;
  try {
    metadata = parseImportedAssetMetadata({ bytes: metadataFile.bytes, expectedId: id });
  } catch (_) {
    return null;
  }
  const expectedFilename = metadata.mediaKind === 'image' ? 'media.webp' : 'media.mp4';
  if ((metadata.mediaKind === 'image' ? 'images' : 'video') !== mediaType) return null;
  const filePath = path.join(resolvedDirectory, expectedFilename);
  const canonical = readOpenedFile(fileSystem, filePath);
  if (!canonical || crypto.createHash('sha256').update(canonical.bytes).digest('hex') !== metadata.canonicalSha256) {
    return null;
  }
  let previewPath = null;
  let preview = null;
  if (metadata.mediaKind === 'video') {
    previewPath = path.join(resolvedProject, 'previews', 'broll', `${id}.webm`);
    preview = readOpenedFile(fileSystem, previewPath);
    if (!preview || crypto.createHash('sha256').update(preview.bytes).digest('hex') !== metadata.previewSha256) {
      return null;
    }
  }
  return {
    kind: 'project',
    mediaKind: metadata.mediaKind,
    label: metadata.label,
    filePath,
    previewPath,
    reference: `assets/broll/${mediaType}/${id}/${expectedFilename}`,
    canonicalSha256: metadata.canonicalSha256,
    previewSha256: metadata.previewSha256,
    width: metadata.width,
    height: metadata.height,
    fps: metadata.fps,
    durationSec: metadata.durationSec,
    hasAudio: metadata.hasAudio,
    capabilities: {
      preview: true,
      brollImage: metadata.mediaKind === 'image',
      brollVideo: metadata.mediaKind === 'video',
    },
    dev: canonical.dev,
    ino: canonical.ino,
    size: canonical.size,
    mtimeNs: canonical.mtimeNs,
    ...(preview ? {
      previewDev: preview.dev,
      previewIno: preview.ino,
      previewSize: preview.size,
      previewMtimeNs: preview.mtimeNs,
    } : {}),
  };
}

function listImportedAssetBundles({ projectDir, fileSystem = fs } = {}) {
  if (typeof projectDir !== 'string') return [];
  const bundles = [];
  for (const mediaType of ['images', 'video']) {
    const parent = path.join(path.resolve(projectDir), 'assets', 'broll', mediaType);
    if (!isRegularDirectory(fileSystem, parent)) continue;
    let entries;
    try {
      entries = fileSystem.readdirSync(parent, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !UUID.test(entry.name)) continue;
      const bundle = inspectImportedAssetBundle({
        projectDir,
        assetDirectory: path.join(parent, entry.name),
        fileSystem,
      });
      if (bundle) bundles.push(bundle);
    }
  }
  return bundles;
}

function cleanupOrphanImportedStages({ projectDir, fileSystem = fs } = {}) {
  if (typeof projectDir !== 'string') return [];
  const resolvedProject = path.resolve(projectDir);
  const removed = [];
  const published = new Set();
  const stageParents = [
    path.join(resolvedProject, 'assets', 'broll', 'images'),
    path.join(resolvedProject, 'assets', 'broll', 'video'),
  ];
  for (const parent of stageParents) {
    if (!isRegularDirectory(fileSystem, parent)) continue;
    let entries;
    try {
      entries = fileSystem.readdirSync(parent, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      if (UUID.test(entry.name) && entry.isDirectory() && !entry.isSymbolicLink()) {
        published.add(entry.name);
      }
    }
  }
  for (const parent of stageParents) {
    if (!isRegularDirectory(fileSystem, parent)) continue;
    let entries;
    try {
      entries = fileSystem.readdirSync(parent, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      const match = /^\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.stage$/.exec(entry.name);
      if (!match || entry.isSymbolicLink() || published.has(match[1])) continue;
      const target = path.join(parent, entry.name);
      try {
        const before = fileSystem.lstatSync(target);
        if (before.isSymbolicLink() || (!before.isDirectory() && !before.isFile())) continue;
        const current = fileSystem.lstatSync(target);
        if (!sameOwnedIdentity(before, current) || current.isSymbolicLink()) continue;
        fileSystem.rmSync(target, { recursive: before.isDirectory(), force: false });
        removed.push(target);
      } catch (_) {
        // A concurrent publisher owns the remainder; leave it untouched.
      }
    }
  }
  const previewParent = path.join(resolvedProject, 'previews', 'broll');
  if (isRegularDirectory(fileSystem, previewParent)) {
    let entries;
    try {
      entries = fileSystem.readdirSync(previewParent, { withFileTypes: true });
    } catch (_) {
      entries = [];
    }
    for (const entry of entries) {
      const match = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.webm$/.exec(entry.name);
      if (!match || entry.isSymbolicLink() || published.has(match[1])) continue;
      const target = path.join(previewParent, entry.name);
      try {
        const before = fileSystem.lstatSync(target);
        if (!before.isFile() || before.isSymbolicLink()) continue;
        const current = fileSystem.lstatSync(target);
        if (!sameOwnedIdentity(before, current) || current.isSymbolicLink() || !current.isFile()) continue;
        fileSystem.unlinkSync(target);
        removed.push(target);
      } catch (_) {
        // Never broaden a cleanup after an identity race.
      }
    }
  }
  return removed;
}

module.exports = {
  cleanupOrphanImportedStages,
  inspectImportedAssetBundle,
  listImportedAssetBundles,
  parseImportedAssetMetadata,
};
