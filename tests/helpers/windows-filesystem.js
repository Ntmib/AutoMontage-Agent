const fs = require('node:fs');

const FORBIDDEN_NOFOLLOW = 0x20000000;

function statWithoutPosixMode(stat) {
  return new Proxy(stat, {
    get(target, property) {
      if (property === 'mode') return typeof target.mode === 'bigint' ? 0n : 0;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function windowsFileSystem(fileSystem = fs) {
  const portable = Object.create(fileSystem);
  portable.platform = 'win32';
  portable.constants = { ...fileSystem.constants, O_NOFOLLOW: FORBIDDEN_NOFOLLOW };
  portable.openSync = (target, flags, mode) => {
    if ((flags & FORBIDDEN_NOFOLLOW) !== 0) {
      const error = new Error('simulated Windows rejects POSIX O_NOFOLLOW');
      error.code = 'EINVAL';
      throw error;
    }
    return fileSystem.openSync(target, flags, mode);
  };
  portable.fchmodSync = () => {
    const error = new Error('simulated Windows has no POSIX fchmod semantics');
    error.code = 'ENOSYS';
    throw error;
  };
  portable.chmodSync = () => {
    const error = new Error('simulated Windows has no POSIX chmod semantics');
    error.code = 'ENOSYS';
    throw error;
  };
  portable.fstatSync = (descriptor, options) => (
    statWithoutPosixMode(fileSystem.fstatSync(descriptor, options))
  );
  portable.lstatSync = (target, options) => (
    statWithoutPosixMode(fileSystem.lstatSync(target, options))
  );
  portable.statSync = (target, options) => (
    statWithoutPosixMode(fileSystem.statSync(target, options))
  );
  return portable;
}

module.exports = { windowsFileSystem };
