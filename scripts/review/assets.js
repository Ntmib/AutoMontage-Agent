const fs = require('node:fs');
const path = require('node:path');

const { resolveProjectPath } = require('../project/workspace');
const { isRenderableBrollSource } = require('../lesson/brief');
const { listImportedAssetBundles } = require('./imported-assets');
const { IMAGE_MAX_BYTES } = require('./media-limits');
const { openReadOnlyFlags } = require('../filesystem-capabilities');
const { sameOpenedFileSnapshot } = require('../media-probe');
const crypto = require('node:crypto');

const HASH_BUFFER_BYTES = 64 * 1024;

const REVIEW_MEDIA_EXTENSIONS = new Set([
  '.aac', '.avif', '.flac', '.gif', '.jpeg', '.jpg', '.m4a', '.m4v', '.mov',
  '.mp3', '.mp4', '.oga', '.ogg', '.png', '.wav', '.webm', '.webp',
]);

function isAllowedReviewMediaPath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  const segments = filePath.split(/[\\/]/).filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment.startsWith('.'))) return false;
  return REVIEW_MEDIA_EXTENSIONS.has(path.extname(segments.at(-1)).toLowerCase());
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative));
}

function canonicalReference(reference) {
  if (typeof reference !== 'string' || reference.length === 0 || reference.includes('\0')) return null;
  if (path.isAbsolute(reference) || path.win32.isAbsolute(reference)
    || path.win32.parse(reference).root !== '') return null;
  const segments = reference.split(/[\\/]/);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  return segments.join('/');
}

function regularFileWithoutSymlinks(root, segments) {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
      return null;
    }
    if (stat.isSymbolicLink()) return null;
  }
  try {
    const stat = fs.statSync(current);
    return stat.isFile() ? current : null;
  } catch (_) {
    return null;
  }
}

function resolveProjectAsset(workspace, reference) {
  if (!workspace || typeof workspace.dir !== 'string' || !reference.startsWith('assets/')) return null;
  try {
    return resolveProjectPath(workspace.dir, reference, {
      label: 'review asset',
      mustExist: true,
      type: 'file',
    });
  } catch (_) {
    return null;
  }
}

function resolvePublicAsset(root, reference) {
  if (typeof root !== 'string') return null;
  const publicReference = reference.startsWith('public/') ? reference.slice('public/'.length) : reference;
  if (!publicReference) return null;
  const publicRoot = path.resolve(root, 'public');
  let publicStat;
  try {
    publicStat = fs.lstatSync(publicRoot);
  } catch (_) {
    return null;
  }
  if (!publicStat.isDirectory() || publicStat.isSymbolicLink()) return null;

  const segments = publicReference.split('/');
  const candidate = path.resolve(publicRoot, ...segments);
  if (!isInside(publicRoot, candidate)) return null;
  const resolved = regularFileWithoutSymlinks(publicRoot, segments);
  if (!resolved) return null;

  try {
    const publicReal = fs.realpathSync(publicRoot);
    const candidateReal = fs.realpathSync(resolved);
    return isInside(publicReal, candidateReal) ? resolved : null;
  } catch (_) {
    return null;
  }
}

function mediaKindForPath(assetPath) {
  const extension = path.extname(assetPath).toLowerCase();
  if (['.avif', '.gif', '.jpeg', '.jpg', '.png', '.webp'].includes(extension)) return 'image';
  if (['.aac', '.flac', '.m4a', '.mp3', '.oga', '.ogg', '.wav'].includes(extension)) return 'audio';
  return 'video';
}

function fileSnapshot(fileSystem, target, descriptor = false) {
  const stat = descriptor
    ? fileSystem.fstatSync(target)
    : fileSystem.lstatSync(target);
  const nanosecondStat = descriptor
    ? fileSystem.fstatSync(target, { bigint: true })
    : fileSystem.lstatSync(target, { bigint: true });
  return {
    stat,
    snapshot: {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: nanosecondStat.mtimeNs,
      ctimeNs: nanosecondStat.ctimeNs,
      mode: stat.mode,
      nlink: stat.nlink,
    },
  };
}

function hashLegacyImage(fileSystem, filePath, platform) {
  let descriptor = null;
  try {
    const beforePath = fileSnapshot(fileSystem, filePath);
    if (!beforePath.stat.isFile() || beforePath.stat.isSymbolicLink()
      || beforePath.stat.size > IMAGE_MAX_BYTES) return null;
    descriptor = fileSystem.openSync(filePath, openReadOnlyFlags(fileSystem, platform));
    const beforeDescriptor = fileSnapshot(fileSystem, descriptor, true);
    if (!beforeDescriptor.stat.isFile()
      || !sameOpenedFileSnapshot(beforePath.snapshot, beforeDescriptor.snapshot, platform)) return null;
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
    const afterDescriptor = fileSnapshot(fileSystem, descriptor, true);
    const afterPath = fileSnapshot(fileSystem, filePath);
    if (total !== beforeDescriptor.snapshot.size
      || !sameOpenedFileSnapshot(beforeDescriptor.snapshot, afterDescriptor.snapshot, platform)
      || !sameOpenedFileSnapshot(beforeDescriptor.snapshot, afterPath.snapshot, platform)) return null;
    return { sha256: hash.digest('hex'), ...beforeDescriptor.snapshot };
  } catch (_) {
    return null;
  } finally {
    if (descriptor !== null) fileSystem.closeSync(descriptor);
  }
}

function snapshotLegacyFile(fileSystem, filePath, platform) {
  let descriptor = null;
  try {
    const beforePath = fileSnapshot(fileSystem, filePath);
    if (!beforePath.stat.isFile() || beforePath.stat.isSymbolicLink()) return null;
    descriptor = fileSystem.openSync(filePath, openReadOnlyFlags(fileSystem, platform));
    const descriptorSnapshot = fileSnapshot(fileSystem, descriptor, true);
    const afterPath = fileSnapshot(fileSystem, filePath);
    return descriptorSnapshot.stat.isFile()
      && sameOpenedFileSnapshot(beforePath.snapshot, descriptorSnapshot.snapshot, platform)
      && sameOpenedFileSnapshot(descriptorSnapshot.snapshot, afterPath.snapshot, platform)
      ? descriptorSnapshot.snapshot
      : null;
  } catch (_) {
    return null;
  } finally {
    if (descriptor !== null) fileSystem.closeSync(descriptor);
  }
}

function legacyRecord({ kind, filePath, reference, fileSystem = fs, platform = process.platform }) {
  const mediaKind = mediaKindForPath(filePath);
  const brollImage = mediaKind === 'image' && isRenderableBrollSource(filePath);
  let hashed = null;
  if (brollImage) {
    hashed = hashLegacyImage(fileSystem, filePath, platform);
    if (!hashed) return null;
  } else {
    hashed = snapshotLegacyFile(fileSystem, filePath, platform);
    if (!hashed) return null;
  }
  return {
    kind,
    mediaKind,
    label: path.basename(filePath),
    filePath,
    previewPath: null,
    reference,
    ...(brollImage ? { canonicalSha256: hashed.sha256 } : {}),
    capabilities: { preview: true, brollImage, brollVideo: false },
    dev: hashed.dev,
    ino: hashed.ino,
    size: hashed.size,
    mtimeNs: hashed.mtimeNs,
  };
}

function descriptor({ id, asset }) {
  if (!/^asset-[1-9]\d*$/.test(id)) return null;
  return {
    id,
    kind: asset.kind,
    mediaKind: asset.mediaKind,
    label: asset.label,
    url: `/media/assets/${id}`,
    ...(asset.previewPath ? { previewUrl: `/media/assets/${id}/preview` } : {}),
    ...(asset.width ? {
      width: asset.width,
      height: asset.height,
      fps: asset.fps,
      durationSec: asset.durationSec,
      audioDurationSec: asset.audioDurationSec,
      hasAudio: asset.hasAudio,
    } : {}),
    capabilities: {
      ...asset.capabilities,
    },
  };
}

function resolveReviewAsset({ root, workspace, reference, id = 'asset-1' } = {}) {
  const canonical = canonicalReference(reference);
  if (!canonical || !isAllowedReviewMediaPath(canonical)) return null;

  const projectPath = resolveProjectAsset(workspace, canonical);
  if (projectPath) {
    const asset = listReviewAssetRecords({ root, projectDir: workspace.dir })
      .find((candidate) => candidate.kind === 'project' && candidate.reference === canonical);
    return asset ? descriptor({ id, asset }) : null;
  }

  const publicPath = resolvePublicAsset(root, canonical);
  if (publicPath) {
    const asset = listReviewAssetRecords({ root, projectDir: workspace && workspace.dir })
      .find((candidate) => candidate.kind === 'public' && candidate.reference === canonical);
    return asset ? descriptor({ id, asset }) : null;
  }

  return null;
}

function collectFiles(directory) {
  let directoryStat;
  try {
    directoryStat = fs.lstatSync(directory);
  } catch (_) {
    return [];
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return [];

  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => (
      left.name.localeCompare(right.name)
    ));
  } catch (_) {
    return [];
  }

  return entries.flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return collectFiles(entryPath);
    return entry.isFile() ? [entryPath] : [];
  });
}

function projectAssetReferences(workspace) {
  if (!workspace || typeof workspace.dir !== 'string') return [];
  let assetsDirectory;
  try {
    assetsDirectory = resolveProjectPath(workspace.dir, 'assets', {
      label: 'review assets directory',
      mustExist: true,
      type: 'directory',
    });
  } catch (_) {
    return [];
  }
  return collectFiles(assetsDirectory).map((assetPath) => (
    `assets/${path.relative(assetsDirectory, assetPath).split(path.sep).join('/')}`
  )).filter(isAllowedReviewMediaPath);
}

function publicAssetReferences(root) {
  if (typeof root !== 'string') return [];
  const publicDirectory = path.resolve(root, 'public');
  return collectFiles(publicDirectory).map((assetPath) => (
    path.relative(publicDirectory, assetPath).split(path.sep).join('/')
  )).filter(isAllowedReviewMediaPath);
}

function listReviewAssetRecords({
  root,
  projectDir,
  fileSystem = fs,
  platform = process.platform,
} = {}) {
  const imported = listImportedAssetBundles({ projectDir, fileSystem, platform });
  const importedPaths = new Set(imported.map((asset) => path.resolve(asset.filePath)));
  const projectAssets = projectAssetReferences({ dir: projectDir })
    .map((reference) => {
      const filePath = resolveProjectAsset({ dir: projectDir }, reference);
      if (!filePath || importedPaths.has(path.resolve(filePath))
        || /^assets\/broll\/(?:images|video)\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/media\.(?:webp|mp4)$/.test(reference)) return null;
      return legacyRecord({ kind: 'project', filePath, reference, fileSystem, platform });
    })
    .filter(Boolean);
  const publicAssets = publicAssetReferences(root)
    .map((reference) => {
      const filePath = resolvePublicAsset(root, reference);
      return filePath
        ? legacyRecord({ kind: 'public', filePath, reference, fileSystem, platform })
        : null;
    })
    .filter(Boolean);
  return [...imported, ...projectAssets, ...publicAssets];
}

function listReviewAssets({ root, workspace, fileSystem = fs, platform = process.platform } = {}) {
  return listReviewAssetRecords({
    root, projectDir: workspace && workspace.dir, fileSystem, platform,
  })
    .map((asset, index) => descriptor({ id: `asset-${index + 1}`, asset }));
}

module.exports = {
  isAllowedReviewMediaPath,
  listReviewAssetRecords,
  listReviewAssets,
  resolveReviewAsset,
};
