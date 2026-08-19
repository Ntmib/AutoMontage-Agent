const fs = require('node:fs');
const path = require('node:path');

const { resolveProjectPath } = require('../project/workspace');

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

function descriptor({ id, kind, assetPath }) {
  if (!/^asset-[1-9]\d*$/.test(id)) return null;
  return {
    id,
    kind,
    label: path.basename(assetPath),
    url: `/media/assets/${id}`,
  };
}

function resolveReviewAsset({ root, workspace, reference, id = 'asset-1' } = {}) {
  const canonical = canonicalReference(reference);
  if (!canonical) return null;

  const projectPath = resolveProjectAsset(workspace, canonical);
  if (projectPath) return descriptor({ id, kind: 'project', assetPath: projectPath });

  const publicPath = resolvePublicAsset(root, canonical);
  if (publicPath) return descriptor({ id, kind: 'public', assetPath: publicPath });

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
  ));
}

function publicAssetReferences(root) {
  if (typeof root !== 'string') return [];
  const publicDirectory = path.resolve(root, 'public');
  return collectFiles(publicDirectory).map((assetPath) => (
    path.relative(publicDirectory, assetPath).split(path.sep).join('/')
  ));
}

function listReviewAssets({ root, workspace } = {}) {
  const references = [
    ...projectAssetReferences(workspace),
    ...publicAssetReferences(root),
  ];
  const assets = [];
  for (const reference of references) {
    const asset = resolveReviewAsset({
      root,
      workspace,
      reference,
      id: `asset-${assets.length + 1}`,
    });
    if (asset) assets.push(asset);
  }
  return assets;
}

module.exports = {
  listReviewAssets,
  resolveReviewAsset,
};
