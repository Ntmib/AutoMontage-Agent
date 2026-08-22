const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fileSystemCapabilities,
  fsyncDirectoryIfSupported,
} = require('../scripts/filesystem-capabilities');

test('filesystem capabilities model directory fsync separately from POSIX permissions', () => {
  assert.deepEqual(fileSystemCapabilities('win32'), {
    noFollow: false,
    posixPermissions: false,
    directoryFsync: false,
  });
  assert.deepEqual(fileSystemCapabilities('linux'), {
    noFollow: true,
    posixPermissions: true,
    directoryFsync: true,
  });
});

test('directory fsync obeys only its own capability', () => {
  const calls = [];
  const fileSystem = {
    constants: { O_RDONLY: 0 },
    openSync(target, flags) {
      calls.push(['open', target, flags]);
      return 17;
    },
    fstatSync(descriptor) {
      calls.push(['stat', descriptor]);
      return { isDirectory: () => true };
    },
    fsyncSync(descriptor) {
      calls.push(['fsync', descriptor]);
    },
    closeSync(descriptor) {
      calls.push(['close', descriptor]);
    },
  };

  assert.equal(fsyncDirectoryIfSupported(fileSystem, '/project/assets', {
    noFollow: false,
    posixPermissions: false,
    directoryFsync: true,
  }), true);
  assert.deepEqual(calls, [
    ['open', '/project/assets', 0],
    ['stat', 17],
    ['fsync', 17],
    ['close', 17],
  ]);

  calls.length = 0;
  assert.equal(fsyncDirectoryIfSupported(fileSystem, 'C:\\project\\assets', {
    noFollow: true,
    posixPermissions: true,
    directoryFsync: false,
  }), false);
  assert.deepEqual(calls, []);
});
