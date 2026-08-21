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
const METADATA_MAX_BYTES = 16 * 1024;
const HASH_BUFFER_BYTES = 64 * 1024;
const PUBLICATION_CLAIM_PURPOSE = 'review-media-import-publication';
const PUBLICATION_CLAIM_KEYS = [
  'version', 'id', 'purpose', 'mediaKind', 'directory', 'canonical', 'preview',
];

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative));
}

function ownedDirectory(fileSystem, projectDir, segments) {
  const resolvedProject = path.resolve(projectDir);
  let projectReal;
  try {
    const projectStat = fileSystem.lstatSync(resolvedProject);
    if (!projectStat.isDirectory() || projectStat.isSymbolicLink()) return null;
    projectReal = fileSystem.realpathSync(resolvedProject);
  } catch (_) {
    return null;
  }
  let directory = resolvedProject;
  for (const segment of segments) {
    directory = path.join(directory, segment);
    try {
      const stat = fileSystem.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || !isInside(projectReal, fileSystem.realpathSync(directory))) return null;
    } catch (_) {
      return null;
    }
  }
  return directory;
}

function sameOwnedIdentity(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function fileSnapshot(stat, nanosecondStat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: nanosecondStat.mtimeNs,
  };
}

function sameFileSnapshot(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

function persistedDirectoryIdentity(value) {
  return value ? { dev: String(value.dev), ino: String(value.ino) } : null;
}

function persistedFileIdentity(value) {
  return value ? {
    dev: String(value.dev),
    ino: String(value.ino),
    size: String(value.size),
    mtimeNs: String(value.mtimeNs),
  } : null;
}

function buildImportedPublicationClaim({
  id,
  mediaKind,
  directory = null,
  canonical = null,
  preview = null,
} = {}) {
  if (!UUID.test(id) || !['image', 'video'].includes(mediaKind)) return null;
  return {
    version: 1,
    id,
    purpose: PUBLICATION_CLAIM_PURPOSE,
    mediaKind,
    directory: persistedDirectoryIdentity(directory),
    canonical: persistedFileIdentity(canonical),
    preview: persistedFileIdentity(preview),
  };
}

function validPersistedIdentity(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
    && keys.every((key) => typeof value[key] === 'string'
      && /^(0|[1-9][0-9]*)$/.test(value[key]));
}

function parseImportedPublicationClaim({ bytes, expectedId, expectedMediaKind } = {}) {
  let claim;
  try {
    claim = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (_) {
    return null;
  }
  if (claim === null || typeof claim !== 'object' || Array.isArray(claim)
    || !isDeepStrictEqual(Object.keys(claim).sort(), [...PUBLICATION_CLAIM_KEYS].sort())
    || claim.version !== 1 || claim.id !== expectedId || !UUID.test(claim.id)
    || claim.purpose !== PUBLICATION_CLAIM_PURPOSE
    || claim.mediaKind !== expectedMediaKind
    || !(claim.directory === null
      || validPersistedIdentity(claim.directory, ['dev', 'ino']))
    || !(claim.canonical === null
      || validPersistedIdentity(claim.canonical, ['dev', 'ino', 'size', 'mtimeNs']))
    || !(claim.preview === null
      || validPersistedIdentity(claim.preview, ['dev', 'ino', 'size', 'mtimeNs']))
    || (claim.canonical !== null && claim.directory === null)
    || (claim.mediaKind === 'image' && claim.preview !== null)) return null;
  return claim;
}

function readOpenedMetadata(fileSystem, filePath) {
  const constants = fileSystem.constants || fs.constants;
  let descriptor = null;
  try {
    descriptor = fileSystem.openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = fileSystem.fstatSync(descriptor);
    const nanosecondStat = fileSystem.fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || stat.size <= 0 || stat.size > METADATA_MAX_BYTES) return null;
    const before = fileSnapshot(stat, nanosecondStat);
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fileSystem.readSync(
        descriptor,
        bytes,
        offset,
        Math.min(HASH_BUFFER_BYTES, bytes.length - offset),
        null,
      );
      if (count <= 0) return null;
      offset += count;
    }
    const after = fileSnapshot(
      fileSystem.fstatSync(descriptor),
      fileSystem.fstatSync(descriptor, { bigint: true }),
    );
    return sameFileSnapshot(before, after)
      ? { bytes, mode: stat.mode & 0o777, ...before }
      : null;
  } catch (_) {
    return null;
  } finally {
    if (descriptor !== null) fileSystem.closeSync(descriptor);
  }
}

function hashOpenedFile(fileSystem, filePath) {
  const constants = fileSystem.constants || fs.constants;
  let descriptor = null;
  try {
    descriptor = fileSystem.openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = fileSystem.fstatSync(descriptor);
    const nanosecondStat = fileSystem.fstatSync(descriptor, { bigint: true });
    if (!stat.isFile()) return null;
    const before = fileSnapshot(stat, nanosecondStat);
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let total = 0;
    let count;
    do {
      count = fileSystem.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count > 0) {
        hash.update(buffer.subarray(0, count));
        total += count;
      }
    } while (count > 0);
    const after = fileSnapshot(
      fileSystem.fstatSync(descriptor),
      fileSystem.fstatSync(descriptor, { bigint: true }),
    );
    if (total !== before.size || !sameFileSnapshot(before, after)) return null;
    return { sha256: hash.digest('hex'), ...before };
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

function verifyImportedAssetFiles({
  id,
  mediaKind,
  assetDirectory,
  previewPath = null,
  metadata,
  fileSystem = fs,
} = {}) {
  if (!UUID.test(id) || !['image', 'video'].includes(mediaKind)
    || !metadata || metadata.id !== id || metadata.mediaKind !== mediaKind) return null;
  try {
    parseImportedAssetMetadata({ bytes: Buffer.from(JSON.stringify(metadata)), expectedId: id });
  } catch (_) {
    return null;
  }
  const expectedFilename = mediaKind === 'image' ? 'media.webp' : 'media.mp4';
  const filePath = path.join(assetDirectory, expectedFilename);
  const canonical = hashOpenedFile(fileSystem, filePath);
  if (!canonical || canonical.sha256 !== metadata.canonicalSha256) return null;
  let preview = null;
  if (mediaKind === 'video') {
    preview = hashOpenedFile(fileSystem, previewPath);
    if (!preview || preview.sha256 !== metadata.previewSha256) return null;
  }
  return { metadata, filePath, previewPath, canonical, preview };
}

function buildImportedAssetRecord({ projectDir, mediaType, id, verified }) {
  const { metadata, filePath, previewPath, canonical, preview } = verified;
  const expectedFilename = metadata.mediaKind === 'image' ? 'media.webp' : 'media.mp4';
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

function inspectImportedAssetBundle({ projectDir, assetDirectory, fileSystem = fs } = {}) {
  if (typeof projectDir !== 'string' || typeof assetDirectory !== 'string') return null;
  const resolvedProject = path.resolve(projectDir);
  const resolvedDirectory = path.resolve(assetDirectory);
  const id = path.basename(resolvedDirectory);
  const mediaType = path.basename(path.dirname(resolvedDirectory));
  const expectedParent = path.join(resolvedProject, 'assets', 'broll', mediaType);
  const ownedAssetDirectory = ownedDirectory(fileSystem, resolvedProject, [
    'assets', 'broll', mediaType, id,
  ]);
  if (!UUID.test(id) || !['images', 'video'].includes(mediaType)
    || path.dirname(resolvedDirectory) !== expectedParent || ownedAssetDirectory !== resolvedDirectory) {
    return null;
  }
  const metadataFile = readOpenedMetadata(fileSystem, path.join(resolvedDirectory, 'asset.json'));
  if (!metadataFile) return null;
  let metadata;
  try {
    metadata = parseImportedAssetMetadata({ bytes: metadataFile.bytes, expectedId: id });
  } catch (_) {
    return null;
  }
  if ((metadata.mediaKind === 'image' ? 'images' : 'video') !== mediaType) return null;
  let previewPath = null;
  if (metadata.mediaKind === 'video') {
    const previewDirectory = ownedDirectory(fileSystem, resolvedProject, ['previews', 'broll']);
    if (!previewDirectory) return null;
    previewPath = path.join(previewDirectory, `${id}.webm`);
  }
  const verified = verifyImportedAssetFiles({
    id,
    mediaKind: metadata.mediaKind,
    assetDirectory: resolvedDirectory,
    previewPath,
    metadata,
    fileSystem,
  });
  return verified ? buildImportedAssetRecord({
    projectDir: resolvedProject,
    mediaType,
    id,
    verified,
  }) : null;
}

function listImportedAssetBundles({ projectDir, fileSystem = fs } = {}) {
  if (typeof projectDir !== 'string') return [];
  const bundles = [];
  for (const mediaType of ['images', 'video']) {
    const parent = ownedDirectory(fileSystem, projectDir, ['assets', 'broll', mediaType]);
    if (!parent) continue;
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

function targetIdentityState(fileSystem, target, expected, kind) {
  let stat;
  try {
    stat = fileSystem.lstatSync(target, { bigint: true });
  } catch (error) {
    return error.code === 'ENOENT' ? { matches: true, exists: false } : { matches: false };
  }
  if (stat.isSymbolicLink()
    || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
    return { matches: false, exists: true };
  }
  if (expected === null) return { matches: false, exists: true };
  const matches = String(stat.dev) === expected.dev && String(stat.ino) === expected.ino
    && (kind === 'directory' || (String(stat.size) === expected.size
      && String(stat.mtimeNs) === expected.mtimeNs));
  return { matches, exists: true };
}

function removeClaimSnapshot(fileSystem, target, expected) {
  try {
    const stat = fileSystem.lstatSync(target);
    const nanosecondStat = fileSystem.lstatSync(target, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()
      || !sameFileSnapshot(fileSnapshot(stat, nanosecondStat), expected)) return false;
    fileSystem.unlinkSync(target);
    return true;
  } catch (_) {
    return false;
  }
}

function removeClaimedTarget(fileSystem, target, expected, kind) {
  const state = targetIdentityState(fileSystem, target, expected, kind);
  if (!state.matches || !state.exists) return false;
  try {
    if (kind === 'directory') fileSystem.rmdirSync(target);
    else fileSystem.unlinkSync(target);
    return true;
  } catch (_) {
    return false;
  }
}

function cleanupPublicationClaim({
  projectDir,
  parent,
  mediaKind,
  id,
  claimPath,
  fileSystem,
}) {
  const claimFile = readOpenedMetadata(fileSystem, claimPath);
  if (!claimFile || claimFile.mode !== 0o600) return [];
  const claim = parseImportedPublicationClaim({
    bytes: claimFile.bytes,
    expectedId: id,
    expectedMediaKind: mediaKind,
  });
  if (!claim) return [];

  const mediaDirectory = path.join(parent, id);
  const canonicalPath = path.join(
    mediaDirectory,
    mediaKind === 'image' ? 'media.webp' : 'media.mp4',
  );
  const previewParent = mediaKind === 'video'
    ? ownedDirectory(fileSystem, projectDir, ['previews', 'broll'])
    : null;
  if (mediaKind === 'video' && !previewParent) return [];
  const previewPath = previewParent ? path.join(previewParent, `${id}.webm`) : null;

  const directoryState = targetIdentityState(
    fileSystem,
    mediaDirectory,
    claim.directory,
    'directory',
  );
  const previewState = previewPath
    ? targetIdentityState(fileSystem, previewPath, claim.preview, 'file')
    : { matches: claim.preview === null, exists: false };
  if (!directoryState.matches || !previewState.matches) return [];

  let canonicalState = { matches: claim.canonical === null, exists: false };
  let markerExists = false;
  let committedMetadata = null;
  if (directoryState.exists) {
    canonicalState = targetIdentityState(
      fileSystem,
      canonicalPath,
      claim.canonical,
      'file',
    );
    if (!canonicalState.matches) return [];
    const markerPath = path.join(mediaDirectory, 'asset.json');
    try {
      const markerStat = fileSystem.lstatSync(markerPath);
      markerExists = true;
      if (!markerStat.isFile() || markerStat.isSymbolicLink()) return [];
      const markerFile = readOpenedMetadata(fileSystem, markerPath);
      if (!markerFile) return [];
      committedMetadata = parseImportedAssetMetadata({ bytes: markerFile.bytes, expectedId: id });
    } catch (error) {
      if (error.code !== 'ENOENT') return [];
    }
  } else if (claim.canonical !== null) {
    canonicalState = { matches: true, exists: false };
  }

  if (markerExists) {
    if (!committedMetadata || committedMetadata.mediaKind !== mediaKind
      || claim.directory === null || claim.canonical === null
      || (mediaKind === 'video' && claim.preview === null)) return [];
    const mediaType = mediaKind === 'image' ? 'images' : 'video';
    const published = inspectImportedAssetBundle({
      projectDir,
      assetDirectory: mediaDirectory,
      fileSystem,
    });
    if (!published
      || !targetIdentityState(fileSystem, mediaDirectory, claim.directory, 'directory').matches
      || !targetIdentityState(fileSystem, canonicalPath, claim.canonical, 'file').matches
      || (previewPath
        && !targetIdentityState(fileSystem, previewPath, claim.preview, 'file').matches)
      || path.basename(path.dirname(mediaDirectory)) !== mediaType) return [];
    return removeClaimSnapshot(fileSystem, claimPath, claimFile) ? [claimPath] : [];
  }

  if (directoryState.exists) {
    let entries;
    try {
      entries = fileSystem.readdirSync(mediaDirectory);
    } catch (_) {
      return [];
    }
    const expectedEntries = canonicalState.exists ? [path.basename(canonicalPath)] : [];
    if (!isDeepStrictEqual([...entries].sort(), expectedEntries)) return [];
  }

  const removed = [];
  let complete = true;
  if (previewState.exists) {
    if (removeClaimedTarget(fileSystem, previewPath, claim.preview, 'file')) {
      removed.push(previewPath);
    } else {
      complete = false;
    }
  }
  if (canonicalState.exists) {
    if (removeClaimedTarget(fileSystem, canonicalPath, claim.canonical, 'file')) {
      removed.push(canonicalPath);
    } else {
      complete = false;
    }
  }
  if (directoryState.exists) {
    if (removeClaimedTarget(fileSystem, mediaDirectory, claim.directory, 'directory')) {
      removed.push(mediaDirectory);
    } else {
      complete = false;
    }
  }
  if (complete && removeClaimSnapshot(fileSystem, claimPath, claimFile)) removed.push(claimPath);
  return removed;
}

function cleanupOrphanImportedStages({ projectDir, fileSystem = fs } = {}) {
  if (typeof projectDir !== 'string') return [];
  const resolvedProject = path.resolve(projectDir);
  const removed = [];
  const published = new Set();
  const stageParents = [
    {
      parent: ownedDirectory(fileSystem, resolvedProject, ['assets', 'broll', 'images']),
      mediaKind: 'image',
    },
    {
      parent: ownedDirectory(fileSystem, resolvedProject, ['assets', 'broll', 'video']),
      mediaKind: 'video',
    },
  ].filter(({ parent }) => Boolean(parent));
  for (const { parent, mediaKind } of stageParents) {
    let entries;
    try {
      entries = fileSystem.readdirSync(parent, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      if (UUID.test(entry.name)) published.add(entry.name);
      const claimMatch = /^\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.claim$/.exec(entry.name);
      if (claimMatch && entry.isFile() && !entry.isSymbolicLink()) {
        removed.push(...cleanupPublicationClaim({
          projectDir: resolvedProject,
          parent,
          mediaKind,
          id: claimMatch[1],
          claimPath: path.join(parent, entry.name),
          fileSystem,
        }));
      }
    }
  }
  for (const { parent } of stageParents) {
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
  const previewParent = ownedDirectory(fileSystem, resolvedProject, ['previews', 'broll']);
  if (previewParent) {
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
  buildImportedAssetRecord,
  buildImportedPublicationClaim,
  cleanupOrphanImportedStages,
  inspectImportedAssetBundle,
  listImportedAssetBundles,
  parseImportedAssetMetadata,
  verifyImportedAssetFiles,
};
