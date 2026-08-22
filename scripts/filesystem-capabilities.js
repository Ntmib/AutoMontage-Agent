const fs = require('node:fs');

function fileSystemCapabilities(platform = process.platform) {
  const posix = platform !== 'win32';
  return { noFollow: posix, posixPermissions: posix, directoryFsync: posix };
}

function fsyncDirectoryIfSupported(fileSystem, directory, capabilities = fileSystemCapabilities(
  fileSystem.platform || process.platform,
)) {
  if (!capabilities.directoryFsync) return false;
  const constants = fileSystem.constants || fs.constants;
  let descriptor = null;
  try {
    descriptor = fileSystem.openSync(directory, constants.O_RDONLY);
    const stat = fileSystem.fstatSync(descriptor);
    if (!stat.isDirectory()) {
      const error = new Error('directory fsync target must be a directory');
      error.code = 'ENOTDIR';
      throw error;
    }
    fileSystem.fsyncSync(descriptor);
    return true;
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error;
    return false;
  } finally {
    if (descriptor !== null) fileSystem.closeSync(descriptor);
  }
}

function withNoFollow(fileSystem = fs, flags, platform = process.platform) {
  const constants = fileSystem.constants || fs.constants;
  return flags
    | (fileSystemCapabilities(platform).noFollow ? (constants.O_NOFOLLOW || 0) : 0);
}

function openReadOnlyFlags(fileSystem = fs, platform = process.platform) {
  const constants = fileSystem.constants || fs.constants;
  return withNoFollow(fileSystem, constants.O_RDONLY, platform);
}

function privateModeMatches(stat, expected, platform = process.platform) {
  if (!fileSystemCapabilities(platform).posixPermissions) return true;
  const mask = typeof stat.mode === 'bigint' ? 0o777n : 0o777;
  const wanted = typeof stat.mode === 'bigint' ? BigInt(expected) : expected;
  return (stat.mode & mask) === wanted;
}

function setPrivateDescriptorMode(fileSystem, descriptor, mode, platform = process.platform) {
  if (fileSystemCapabilities(platform).posixPermissions) {
    fileSystem.fchmodSync(descriptor, mode);
  }
}

function setPrivatePathMode(fileSystem, target, mode, platform = process.platform) {
  if (fileSystemCapabilities(platform).posixPermissions) {
    fileSystem.chmodSync(target, mode);
  }
}

module.exports = {
  fileSystemCapabilities,
  fsyncDirectoryIfSupported,
  openReadOnlyFlags,
  privateModeMatches,
  setPrivateDescriptorMode,
  setPrivatePathMode,
  withNoFollow,
};
