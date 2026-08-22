const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setPrivatePathMode } = require('../filesystem-capabilities');

const SAFE_TOKEN = /^[A-Za-z0-9_-]+$/;
const WIN32_TOMBSTONE_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY']);
const WIN32_CLAIMED_UNLINK_RETRY_CODES = new Set(['EPERM', 'EBUSY']);
const TOMBSTONE_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 250, 250];
const TOMBSTONE_RETRY_WAIT = new Int32Array(new SharedArrayBuffer(4));
const UNPROVEN_RETAINED_CLAIM = Symbol('unproven-retained-claim');

function absent(fileSystem, target) {
  try {
    fileSystem.lstatSync(target);
    return false;
  } catch (error) {
    if (error && error.code === 'ENOENT') return true;
    throw error;
  }
}

function matchesClaimedPath(fileSystem, claimedPath, stat, expected, kind) {
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
  if (String(stat.size) !== String(expected.size)) return false;
  if (String(stat.mtimeNs) !== String(expected.mtimeNs)
    && expected.bytes === undefined) return false;
  if (expected.bytes === undefined) return true;
  try {
    return Buffer.from(expected.bytes).equals(fileSystem.readFileSync(claimedPath));
  } catch (_) {
    return false;
  }
}

function captureTombstoneIdentity(fileSystem, tombstoneDirectory) {
  try {
    const stat = fileSystem.lstatSync(tombstoneDirectory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    return { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function removeOwnedEmptyTombstone(
  fileSystem,
  tombstoneDirectory,
  expected,
  platform,
) {
  const attempts = platform === 'win32' ? TOMBSTONE_RETRY_DELAYS_MS.length + 1 : 1;
  let removalUncertain = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let stat;
    try {
      stat = fileSystem.lstatSync(tombstoneDirectory, { bigint: true });
    } catch (error) {
      if (error?.code === 'ENOENT' && removalUncertain) return true;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || String(stat.dev) !== String(expected.dev)
      || String(stat.ino) !== String(expected.ino)) return false;
    if (fileSystem.readdirSync(tombstoneDirectory).length !== 0) {
      if (platform !== 'win32' || attempt === attempts - 1) return false;
      Atomics.wait(TOMBSTONE_RETRY_WAIT, 0, 0, TOMBSTONE_RETRY_DELAYS_MS[attempt]);
      continue;
    }
    try {
      fileSystem.rmdirSync(tombstoneDirectory);
      return true;
    } catch (error) {
      const retryable = platform === 'win32'
        && WIN32_TOMBSTONE_RETRY_CODES.has(error?.code)
        && attempt < attempts;
      if (!retryable) throw error;
      removalUncertain = true;
      if (attempt === attempts - 1) {
        let reconciled;
        try {
          reconciled = fileSystem.lstatSync(tombstoneDirectory, { bigint: true });
        } catch (reconcileError) {
          if (reconcileError?.code === 'ENOENT') return true;
          throw reconcileError;
        }
        if (!reconciled.isDirectory() || reconciled.isSymbolicLink()
          || String(reconciled.dev) !== String(expected.dev)
          || String(reconciled.ino) !== String(expected.ino)
          || fileSystem.readdirSync(tombstoneDirectory).length !== 0) return false;
        throw error;
      }
      Atomics.wait(TOMBSTONE_RETRY_WAIT, 0, 0, TOMBSTONE_RETRY_DELAYS_MS[attempt]);
    }
  }
  return false;
}

function removeOwnedClaimedFile(fileSystem, claimedPath, expected, kind, platform) {
  const attempts = platform === 'win32' ? TOMBSTONE_RETRY_DELAYS_MS.length + 1 : 1;
  let removalUncertain = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let claimed;
    try {
      claimed = fileSystem.lstatSync(claimedPath, { bigint: true });
    } catch (error) {
      if (error?.code === 'ENOENT' && removalUncertain) return true;
      return false;
    }
    if (!matchesClaimedPath(fileSystem, claimedPath, claimed, expected, kind)) return false;
    try {
      fileSystem.unlinkSync(claimedPath);
      return true;
    } catch (error) {
      const retryable = platform === 'win32'
        && WIN32_CLAIMED_UNLINK_RETRY_CODES.has(error?.code);
      if (!retryable) throw error;
      removalUncertain = true;
      if (attempt === attempts - 1) {
        let reconciled;
        try {
          reconciled = fileSystem.lstatSync(claimedPath, { bigint: true });
        } catch (reconcileError) {
          if (reconcileError?.code === 'ENOENT') return true;
          return false;
        }
        if (!matchesClaimedPath(
          fileSystem, claimedPath, reconciled, expected, kind,
        )) return false;
        throw error;
      }
      Atomics.wait(TOMBSTONE_RETRY_WAIT, 0, 0, TOMBSTONE_RETRY_DELAYS_MS[attempt]);
    }
  }
  return false;
}

function removeOwnedClaimedDirectory(fileSystem, claimedPath, expected, platform) {
  return removeOwnedEmptyTombstone(fileSystem, claimedPath, expected, platform);
}

function resumeRetainedClaim(fileSystem, target, expected, kind, platform) {
  const parent = path.dirname(target);
  const prefix = `.${path.basename(target)}.remove-`;
  let entries;
  try {
    entries = fileSystem.readdirSync(parent, { withFileTypes: true });
  } catch (_) {
    return null;
  }
  let sawUnproven = false;
  for (const entry of entries) {
    if (!entry.name.startsWith(prefix) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const tombstoneDirectory = path.join(parent, entry.name);
    const claimedPath = path.join(tombstoneDirectory, 'claimed');
    let claimed;
    try {
      claimed = fileSystem.lstatSync(claimedPath, { bigint: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        sawUnproven = true;
        continue;
      }
      return false;
    }
    if (!matchesClaimedPath(fileSystem, claimedPath, claimed, expected, kind)) {
      continue;
    }
    const tombstoneIdentity = captureTombstoneIdentity(fileSystem, tombstoneDirectory);
    if (!tombstoneIdentity) return false;
    if (kind === 'directory') {
      if (!removeOwnedClaimedDirectory(fileSystem, claimedPath, expected, platform)) return false;
    } else if (!removeOwnedClaimedFile(fileSystem, claimedPath, expected, kind, platform)) {
      return false;
    }
    return removeOwnedEmptyTombstone(
      fileSystem, tombstoneDirectory, tombstoneIdentity, platform,
    );
  }
  return sawUnproven ? UNPROVEN_RETAINED_CLAIM : null;
}

function claimAndRemoveOwnedPath({
  target,
  expected,
  kind = 'file',
  fileSystem = fs,
  temporaryId = randomUUID,
  platform = fileSystem.platform || process.platform,
} = {}) {
  if (!target) return true;
  if (!['file', 'mutable-file', 'directory'].includes(kind)) return false;
  if (expected) {
    const resumed = resumeRetainedClaim(fileSystem, target, expected, kind, platform);
    if (resumed === false) return false;
    if (absent(fileSystem, target)) return resumed !== UNPROVEN_RETAINED_CLAIM;
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
  const tombstoneIdentity = captureTombstoneIdentity(fileSystem, tombstoneDirectory);
  if (!tombstoneIdentity) throw new Error('owned removal tombstone is unsafe');
  setPrivatePathMode(fileSystem, tombstoneDirectory, 0o700, platform);
  const claimedPath = path.join(tombstoneDirectory, 'claimed');
  try {
    fileSystem.renameSync(target, claimedPath);
  } catch (error) {
    let removed;
    try {
      removed = removeOwnedEmptyTombstone(
        fileSystem, tombstoneDirectory, tombstoneIdentity, platform,
      );
    } catch (cleanupError) {
      try { error.cleanupError = cleanupError; } catch (_) { /* keep the primary error */ }
      throw error;
    }
    if (error && error.code === 'ENOENT') return removed;
    throw error;
  }
  let claimed;
  try {
    claimed = fileSystem.lstatSync(claimedPath, { bigint: true });
  } catch (_) {
    return false;
  }
  if (!matchesClaimedPath(fileSystem, claimedPath, claimed, expected, kind)) return false;
  let removalError = null;
  if (kind === 'directory') {
    try {
      if (!removeOwnedClaimedDirectory(fileSystem, claimedPath, expected, platform)) return false;
    } catch (error) {
      removalError = error;
    }
  }
  if (kind !== 'directory') {
    try {
      if (!removeOwnedClaimedFile(fileSystem, claimedPath, expected, kind, platform)) return false;
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
  return removeOwnedEmptyTombstone(
    fileSystem, tombstoneDirectory, tombstoneIdentity, platform,
  );
}

module.exports = { claimAndRemoveOwnedPath };
