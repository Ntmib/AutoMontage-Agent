const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const SAFE_TOKEN = /^[A-Za-z0-9_-]+$/;

function absent(fileSystem, target) {
  try {
    fileSystem.lstatSync(target);
    return false;
  } catch (error) {
    if (error && error.code === 'ENOENT') return true;
    throw error;
  }
}

function matchesIdentity(stat, expected, kind) {
  if (!expected || stat.isSymbolicLink()) return false;
  if (kind === 'directory') {
    return stat.isDirectory()
      && String(stat.dev) === String(expected.dev)
      && String(stat.ino) === String(expected.ino);
  }
  if (!stat.isFile()
    || String(stat.dev) !== String(expected.dev)
    || String(stat.ino) !== String(expected.ino)) return false;
  if (kind === 'mutable-file') return true;
  return String(stat.size) === String(expected.size)
    && String(stat.mtimeNs) === String(expected.mtimeNs);
}

function matchesBytes(fileSystem, claimedPath, expected, kind) {
  if (kind !== 'file' || expected.bytes === undefined) return true;
  try {
    return Buffer.from(expected.bytes).equals(fileSystem.readFileSync(claimedPath));
  } catch (_) {
    return false;
  }
}

function removeEmptyTombstone(fileSystem, tombstoneDirectory) {
  try {
    fileSystem.rmdirSync(tombstoneDirectory);
  } catch (_) {
    // A retained claimed object is evidence of a race and must remain recoverable.
  }
}

function resumeRetainedClaim(fileSystem, target, expected, kind) {
  const parent = path.dirname(target);
  const prefix = `.${path.basename(target)}.remove-`;
  let entries;
  try {
    entries = fileSystem.readdirSync(parent, { withFileTypes: true });
  } catch (_) {
    return null;
  }
  for (const entry of entries) {
    if (!entry.name.startsWith(prefix) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const tombstoneDirectory = path.join(parent, entry.name);
    const claimedPath = path.join(tombstoneDirectory, 'claimed');
    let claimed;
    try {
      claimed = fileSystem.lstatSync(claimedPath, { bigint: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        removeEmptyTombstone(fileSystem, tombstoneDirectory);
        continue;
      }
      return false;
    }
    if (!matchesIdentity(claimed, expected, kind)
      || !matchesBytes(fileSystem, claimedPath, expected, kind)) return false;
    if (kind === 'directory') fileSystem.rmdirSync(claimedPath);
    else fileSystem.unlinkSync(claimedPath);
    removeEmptyTombstone(fileSystem, tombstoneDirectory);
    return true;
  }
  return null;
}

function claimAndRemoveOwnedPath({
  target,
  expected,
  kind = 'file',
  fileSystem = fs,
  temporaryId = randomUUID,
} = {}) {
  if (!target) return true;
  if (!['file', 'mutable-file', 'directory'].includes(kind)) return false;
  if (expected) {
    const resumed = resumeRetainedClaim(fileSystem, target, expected, kind);
    if (resumed === false) return false;
  }
  if (absent(fileSystem, target)) return true;
  if (!expected) return false;
  const token = String(temporaryId());
  if (!SAFE_TOKEN.test(token)) throw new Error('owned removal token is unsafe');
  const tombstoneDirectory = path.join(
    path.dirname(target),
    `.${path.basename(target)}.remove-${token}`,
  );
  fileSystem.mkdirSync(tombstoneDirectory, { mode: 0o700 });
  if (typeof fileSystem.chmodSync === 'function') fileSystem.chmodSync(tombstoneDirectory, 0o700);
  const claimedPath = path.join(tombstoneDirectory, 'claimed');
  try {
    fileSystem.renameSync(target, claimedPath);
  } catch (error) {
    removeEmptyTombstone(fileSystem, tombstoneDirectory);
    if (error && error.code === 'ENOENT') return true;
    throw error;
  }
  let claimed;
  try {
    claimed = fileSystem.lstatSync(claimedPath, { bigint: true });
  } catch (_) {
    return false;
  }
  if (!matchesIdentity(claimed, expected, kind)
    || !matchesBytes(fileSystem, claimedPath, expected, kind)) return false;
  let removalError = null;
  const removalAttempts = kind === 'directory' ? 3 : 1;
  for (let attempt = 0; attempt < removalAttempts; attempt += 1) {
    try {
      if (kind === 'directory') fileSystem.rmdirSync(claimedPath);
      else fileSystem.unlinkSync(claimedPath);
      removalError = null;
      break;
    } catch (error) {
      removalError = error;
    }
  }
  if (removalError) {
    if (kind !== 'directory' && absent(fileSystem, target)) {
      try { fileSystem.linkSync(claimedPath, target); } catch (_) { /* retain private claim */ }
    }
    throw removalError;
  }
  removeEmptyTombstone(fileSystem, tombstoneDirectory);
  return true;
}

module.exports = { claimAndRemoveOwnedPath };
