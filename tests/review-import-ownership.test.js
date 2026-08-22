const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { Readable } = require('node:stream');

const {
  cleanupOrphanImportQuarantines,
  createImportController,
  importReviewMedia,
} = require('../scripts/review/media-import');
const { cleanupOrphanImportedStages } = require('../scripts/review/imported-assets');
const { acquireProjectMutationLease } = require('../scripts/project/workspace');
const { claimAndRemoveOwnedPath } = require('../scripts/project/owned-removal');

const FIRST_ID = '4af36be4-0b26-4e6f-bd48-8bdd2215a4f1';
const SECOND_ID = '7c0f5b6a-a921-4a51-8787-467a3a5c7c20';

function tempProject(t) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-import-owner-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  return projectDir;
}

function headers() {
  return {
    'content-length': '1',
    'content-type': 'image/png',
    'x-automontage-filename': 'diagram.png',
  };
}

function imageProbe(codec = 'png', format = 'png_pipe') {
  return JSON.stringify({
    streams: [{
      codec_type: 'video', codec_name: codec, pix_fmt: 'rgba', width: 64, height: 64,
      avg_frame_rate: '25/1', r_frame_rate: '25/1',
    }],
    format: { format_name: format },
  });
}

function imageProcessor({ pauseAtUpload } = {}) {
  return async (invocation) => {
    if (invocation.command === 'ffprobe') {
      if (invocation.args.at(-1).includes('upload')) {
        if (pauseAtUpload) await pauseAtUpload();
        return { stdout: imageProbe(), stderr: '', code: 0, signal: null };
      }
      return { stdout: imageProbe('webp', 'webp_pipe'), stderr: '', code: 0, signal: null };
    }
    if (invocation.command === 'ffmpeg' && !invocation.args.includes('null')) {
      fs.writeFileSync(invocation.args.at(-1), 'normalized image');
    }
    return { stdout: '', stderr: '', code: 0, signal: null };
  };
}

function importImage(projectDir, id, overrides = {}) {
  return importReviewMedia({
    request: Readable.from([Buffer.from('x')]),
    projectDir,
    outputFps: 25,
    headers: headers(),
    controller: createImportController(),
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }),
    randomId: () => id,
    runMediaProcessImpl: imageProcessor(),
    ...overrides,
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function waitForMessage(child, expected) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.on('message', (message) => {
      if (message === expected) resolve();
    });
  });
}

function findRegularFileWithBytes(root, expected) {
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const nested = findRegularFileWithBytes(candidate, expected);
      if (nested) return nested;
    } else if (entry.isFile() && fs.readFileSync(candidate, 'utf8') === expected) {
      return candidate;
    }
  }
  return null;
}

test('a real import process keeps a second process out until normal release', async (t) => {
  const projectDir = tempProject(t);
  const workerPath = path.join(projectDir, 'live-import-worker.js');
  fs.writeFileSync(workerPath, String.raw`
const fs = require('node:fs');
const { Readable } = require('node:stream');
const [mediaImportPath, projectDir, id] = process.argv.slice(2);
const { createImportController, importReviewMedia } = require(mediaImportPath);
const probe = JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'png', pix_fmt: 'rgba', width: 64, height: 64, avg_frame_rate: '25/1', r_frame_rate: '25/1' }], format: { format_name: 'png_pipe' } });
importReviewMedia({
  request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 25,
  headers: { 'content-length': '1', 'content-type': 'image/png', 'x-automontage-filename': 'live.png' },
  controller: createImportController(), randomId: () => id,
  statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }),
  runMediaProcessImpl: async (invocation) => {
    if (invocation.command === 'ffprobe' && invocation.args.at(-1).includes('upload')) {
      process.send('ready');
      await new Promise((resolve) => process.once('message', resolve));
      return { stdout: probe, stderr: '', code: 0, signal: null };
    }
    if (invocation.command === 'ffprobe') return { stdout: probe.replace('png_pipe', 'webp_pipe').replace('"png"', '"webp"'), stderr: '', code: 0, signal: null };
    if (invocation.command === 'ffmpeg' && !invocation.args.includes('null')) fs.writeFileSync(invocation.args.at(-1), 'normalized image');
    return { stdout: '', stderr: '', code: 0, signal: null };
  },
}).then(() => process.exit(0), () => process.exit(98));
`);
  const child = fork(workerPath, [
    require.resolve('../scripts/review/media-import'), projectDir, FIRST_ID,
  ], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await waitForMessage(child, 'ready');

  assert.throws(
    () => cleanupOrphanImportQuarantines({ projectDir }),
    (error) => error && error.code === 'PROJECT_MANIFEST_CONFLICT',
  );
  await assert.rejects(importImage(projectDir, SECOND_ID), (error) => (
    error && error.status === 409 && error.code === 'MEDIA_IMPORT_BUSY'
  ));
  assert.equal(fs.existsSync(path.join(projectDir, 'tmp', 'review-imports', FIRST_ID)), true);

  child.send('resume');
  assert.deepEqual(await waitForExit(child), { code: 0, signal: null });
  await importImage(projectDir, SECOND_ID);
});

test('a live import owns the shared mutation lease before quarantine and keeps reads independent', async (t) => {
  const projectDir = tempProject(t);
  let markPaused;
  const paused = new Promise((resolve) => { markPaused = resolve; });
  let resume;
  const resumed = new Promise((resolve) => { resume = resolve; });
  const first = importImage(projectDir, FIRST_ID, {
    runMediaProcessImpl: imageProcessor({
      pauseAtUpload: async () => {
        markPaused();
        await resumed;
      },
    }),
  });
  await paused;

  const quarantine = path.join(projectDir, 'tmp', 'review-imports', FIRST_ID);
  const ownerPath = path.join(quarantine, 'owner.jsonl');
  assert.equal(fs.statSync(quarantine).mode & 0o777, 0o700);
  assert.equal(fs.statSync(ownerPath).mode & 0o777, 0o600);
  assert.ok(fs.readFileSync(ownerPath).length > 0);
  assert.throws(
    () => acquireProjectMutationLease(projectDir),
    (error) => error && error.code === 'PROJECT_MANIFEST_CONFLICT',
  );

  let secondReads = 0;
  const secondRequest = new Readable({
    read() {
      secondReads += 1;
      this.push(Buffer.from('x'));
      this.push(null);
    },
  });
  await assert.rejects(importImage(projectDir, SECOND_ID, { request: secondRequest }), (error) => (
    error && error.status === 409 && error.code === 'MEDIA_IMPORT_BUSY'
  ));
  assert.equal(secondReads, 0);
  assert.equal(fs.existsSync(ownerPath), true);

  resume();
  await first;
  await importImage(projectDir, SECOND_ID);
});

test('setup failure removes only recorded owned entries and retains a foreign quarantine child', async (t) => {
  const projectDir = tempProject(t);
  const quarantinePath = path.join(projectDir, 'tmp', 'review-imports', FIRST_ID);
  const foreignPath = path.join(quarantinePath, 'foreign-after-create.txt');
  const fileSystem = Object.create(fs);
  fileSystem.linkSync = (source, target) => {
    if (target === path.join(quarantinePath, 'owner.anchor')) {
      fs.writeFileSync(foreignPath, 'foreign survives setup cleanup');
      const error = new Error('injected owner anchor failure');
      error.code = 'EIO';
      throw error;
    }
    return fs.linkSync(source, target);
  };

  await assert.rejects(importImage(projectDir, FIRST_ID, { fileSystem }), (error) => (
    error.status === 500 && error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE'
  ));
  assert.equal(fs.readFileSync(foreignPath, 'utf8'), 'foreign survives setup cleanup');
  assert.deepEqual(fs.readdirSync(quarantinePath), ['foreign-after-create.txt']);
  await importImage(projectDir, SECOND_ID);
});

test('clean setup failure removes the empty owned quarantine and releases retry', async (t) => {
  const projectDir = tempProject(t);
  const quarantinePath = path.join(projectDir, 'tmp', 'review-imports', FIRST_ID);
  const fileSystem = Object.create(fs);
  fileSystem.linkSync = (source, target) => {
    if (target === path.join(quarantinePath, 'owner.anchor')) {
      const error = new Error('injected owner anchor failure');
      error.code = 'EIO';
      throw error;
    }
    return fs.linkSync(source, target);
  };

  await assert.rejects(importImage(projectDir, FIRST_ID, { fileSystem }), (error) => (
    error.status === 500 && error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE'
  ));
  assert.equal(fs.existsSync(quarantinePath), false);
  await importImage(projectDir, SECOND_ID);
});

test('clean setup failure removes the empty owned quarantine after transient Windows root rmdir errors', async (t) => {
  for (const code of ['EPERM', 'EBUSY', 'ENOTEMPTY']) {
    await t.test(code, async (subtest) => {
      const projectDir = tempProject(subtest);
      const quarantinePath = path.join(projectDir, 'tmp', 'review-imports', FIRST_ID);
      const fileSystem = Object.create(fs);
      Object.defineProperty(fileSystem, 'platform', { value: 'win32' });
      fileSystem.linkSync = (source, target) => {
        if (target === path.join(quarantinePath, 'owner.anchor')) {
          const error = new Error('injected owner anchor failure');
          error.code = 'EIO';
          throw error;
        }
        return fs.linkSync(source, target);
      };
      let transientFailures = 2;
      fileSystem.rmdirSync = (target) => {
        if (target === quarantinePath && transientFailures > 0) {
          transientFailures -= 1;
          const error = new Error(`injected root ${code}`);
          error.code = code;
          throw error;
        }
        return fs.rmdirSync(target);
      };

      await assert.rejects(importImage(projectDir, FIRST_ID, {
        fileSystem,
        platform: 'win32',
      }), (error) => error.status === 500 && error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE');
      assert.equal(transientFailures, 0);
      assert.equal(fs.existsSync(quarantinePath), false);
      assert.deepEqual(fs.readdirSync(path.dirname(quarantinePath)), []);
      await importImage(projectDir, SECOND_ID);
    });
  }
});

test('setup root bigint identity preserves an empty foreign inode after lossy collision', async (t) => {
  const projectDir = tempProject(t);
  const quarantinePath = path.join(projectDir, 'tmp', 'review-imports', FIRST_ID);
  const displacedPath = `${quarantinePath}.displaced`;
  const fileSystem = Object.create(fs);
  let replaced = false;
  fileSystem.lstatSync = (target, options) => {
    const stat = fs.lstatSync(target, options);
    if (target !== quarantinePath) return stat;
    const bigint = options?.bigint === true;
    const inode = replaced ? 9007199254740992n : 9007199254740993n;
    const spoofed = Object.create(stat);
    Object.defineProperties(spoofed, {
      dev: { value: bigint ? 7n : 7 },
      ino: { value: bigint ? inode : Number(inode) },
    });
    if (!bigint && !replaced) {
      fs.renameSync(quarantinePath, displacedPath);
      fs.mkdirSync(quarantinePath, { mode: 0o700 });
      replaced = true;
    }
    return spoofed;
  };
  fileSystem.linkSync = (source, target) => {
    if (target === path.join(quarantinePath, 'owner.anchor')) {
      const error = new Error('injected owner anchor failure after root replacement');
      error.code = 'EIO';
      throw error;
    }
    return fs.linkSync(source, target);
  };

  await assert.rejects(importImage(projectDir, FIRST_ID, { fileSystem }), (error) => (
    error.status === 500 && error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE'
  ));
  assert.equal(fs.existsSync(quarantinePath), true);
  assert.deepEqual(fs.readdirSync(quarantinePath), []);
  assert.equal(fs.existsSync(displacedPath), true);
});

test('setup root authoritative identity preserves a replacement before later checks', async (t) => {
  const projectDir = tempProject(t);
  const quarantinePath = path.join(projectDir, 'tmp', 'review-imports', FIRST_ID);
  const displacedPath = `${quarantinePath}.displaced`;
  const fileSystem = Object.create(fs);
  let replaced = false;
  let foreignIdentity;
  const quarantineLstatKinds = [];
  fileSystem.lstatSync = (target, options) => {
    const stat = fs.lstatSync(target, options);
    if (target === quarantinePath) {
      quarantineLstatKinds.push(options?.bigint === true ? 'bigint' : 'number');
    }
    if (target === quarantinePath && options?.bigint !== true && !replaced) {
      fs.renameSync(quarantinePath, displacedPath);
      fs.mkdirSync(quarantinePath, { mode: 0o700 });
      foreignIdentity = fs.lstatSync(quarantinePath, { bigint: true });
      replaced = true;
    }
    return stat;
  };
  fileSystem.linkSync = (source, target) => {
    if (target === path.join(quarantinePath, 'owner.anchor')) {
      const error = new Error('injected owner anchor failure after root replacement');
      error.code = 'EIO';
      throw error;
    }
    return fs.linkSync(source, target);
  };

  await assert.rejects(importImage(projectDir, FIRST_ID, { fileSystem }), (error) => (
    error.status === 500 && error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE'
  ));
  assert.equal(quarantineLstatKinds[0], 'bigint');
  const after = fs.lstatSync(quarantinePath, { bigint: true });
  assert.equal(after.dev, foreignIdentity.dev);
  assert.equal(after.ino, foreignIdentity.ino);
  assert.deepEqual(fs.readdirSync(quarantinePath), []);
  assert.equal(fs.existsSync(displacedPath), true);
});

test('simulated Windows setup cleanup retries transient owner tombstone removal and removes the empty quarantine', async (t) => {
  for (const code of ['EPERM', 'EBUSY', 'ENOTEMPTY']) {
    await t.test(code, async (subtest) => {
      const projectDir = tempProject(subtest);
      const quarantinePath = path.join(projectDir, 'tmp', 'review-imports', FIRST_ID);
      const fileSystem = Object.create(fs);
      Object.defineProperty(fileSystem, 'platform', { value: 'win32' });
      fileSystem.linkSync = (source, target) => {
        if (target === path.join(quarantinePath, 'owner.anchor')) {
          const error = new Error('injected owner anchor failure');
          error.code = 'EIO';
          throw error;
        }
        return fs.linkSync(source, target);
      };
      let transientFailures = 2;
      fileSystem.rmdirSync = (target) => {
        if (transientFailures > 0
          && path.basename(target).startsWith('.owner.jsonl.remove-')) {
          transientFailures -= 1;
          const error = new Error(`injected transient ${code}`);
          error.code = code;
          throw error;
        }
        return fs.rmdirSync(target);
      };

      await assert.rejects(importImage(projectDir, FIRST_ID, {
        fileSystem,
        platform: 'win32',
      }), (error) => error.status === 500 && error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE');
      assert.equal(transientFailures, 0);
      assert.equal(fs.existsSync(quarantinePath), false);
      assert.deepEqual(fs.readdirSync(path.dirname(quarantinePath)), []);
      await importImage(projectDir, SECOND_ID);
    });
  }
});

test('setup cleanup retains a child that replaced an owned placeholder', async (t) => {
  const projectDir = tempProject(t);
  const quarantinePath = path.join(projectDir, 'tmp', 'review-imports', FIRST_ID);
  const uploadPath = path.join(quarantinePath, 'upload.bin');
  const fileSystem = Object.create(fs);
  fileSystem.linkSync = (source, target) => {
    if (target === path.join(quarantinePath, 'owner.anchor')) {
      fs.renameSync(uploadPath, `${uploadPath}.owned-backup`);
      fs.writeFileSync(uploadPath, 'foreign replacement survives');
      const error = new Error('injected owner anchor failure');
      error.code = 'EIO';
      throw error;
    }
    return fs.linkSync(source, target);
  };

  await assert.rejects(importImage(projectDir, FIRST_ID, { fileSystem }), (error) => (
    error.status === 500 && error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE'
  ));
  assert.ok(findRegularFileWithBytes(quarantinePath, 'foreign replacement survives'));
  assert.equal(fs.existsSync(quarantinePath), true);
  await importImage(projectDir, SECOND_ID);
});

test('hard-exit upload recovery reclaims the shared lease and only its identity-owned quarantine', async (t) => {
  const projectDir = tempProject(t);
  const workerPath = path.join(projectDir, 'crash-import-worker.js');
  fs.writeFileSync(workerPath, String.raw`
const fs = require('node:fs');
const { Readable } = require('node:stream');
const [mediaImportPath, projectDir, id] = process.argv.slice(2);
const { createImportController, importReviewMedia } = require(mediaImportPath);
importReviewMedia({
  request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 25,
  headers: { 'content-length': '1', 'content-type': 'image/png', 'x-automontage-filename': 'crash.png' },
  controller: createImportController(), randomId: () => id,
  statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }),
  runMediaProcessImpl: async (invocation) => {
    if (invocation.command === 'ffprobe' && invocation.args.at(-1).includes('upload')) process.exit(71);
    return { stdout: '', stderr: '', code: 0, signal: null };
  },
}).then(() => process.exit(99), () => process.exit(98));
`);
  const child = fork(workerPath, [
    require.resolve('../scripts/review/media-import'), projectDir, FIRST_ID,
  ], { stdio: 'ignore' });
  assert.deepEqual(await waitForExit(child), { code: 71, signal: null });

  const orphan = path.join(projectDir, 'tmp', 'review-imports', FIRST_ID);
  assert.equal(fs.existsSync(orphan), true);
  assert.equal(fs.existsSync(path.join(projectDir, '.project-mutation.lock')), true);

  const foreign = path.join(projectDir, 'tmp', 'review-imports', SECOND_ID);
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, 'foreign.txt'), 'must survive');
  await importImage(projectDir, SECOND_ID.replace('7c0f', '6c0f'));

  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.readFileSync(path.join(foreign, 'foreign.txt'), 'utf8'), 'must survive');
  assert.equal(fs.existsSync(path.join(projectDir, '.project-mutation.lock')), false);
});

test('hard-exit while upload bytes are still changing recovers the pre-owned upload inode', async (t) => {
  const projectDir = tempProject(t);
  const workerPath = path.join(projectDir, 'crash-mid-upload-worker.js');
  fs.writeFileSync(workerPath, String.raw`
const { Readable } = require('node:stream');
const [mediaImportPath, projectDir, id] = process.argv.slice(2);
const { createImportController, importReviewMedia } = require(mediaImportPath);
let sent = false;
const partialUpload = new Readable({
  read() {
    if (sent) return;
    sent = true;
    this.push(Buffer.from('x'));
    setTimeout(() => process.exit(70), 25);
  },
});
importReviewMedia({
  request: partialUpload, projectDir, outputFps: 25,
  headers: { 'content-length': '2', 'content-type': 'image/png', 'x-automontage-filename': 'crash.png' },
  controller: createImportController(), randomId: () => id,
  statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }),
  runMediaProcessImpl: async () => ({ stdout: '', stderr: '', code: 0, signal: null }),
}).then(() => process.exit(99), () => process.exit(98));
`);
  const child = fork(workerPath, [
    require.resolve('../scripts/review/media-import'), projectDir, FIRST_ID,
  ], { stdio: 'ignore' });
  assert.deepEqual(await waitForExit(child), { code: 70, signal: null });

  const orphan = path.join(projectDir, 'tmp', 'review-imports', FIRST_ID);
  assert.equal(fs.statSync(path.join(orphan, 'upload.bin')).size, 1);
  await importImage(projectDir, SECOND_ID);
  assert.equal(fs.existsSync(orphan), false);
});

test('orphan recovery resumes after an exact target unlink fails once', async (t) => {
  const projectDir = tempProject(t);
  const workerPath = path.join(projectDir, 'crash-before-probe-worker.js');
  fs.writeFileSync(workerPath, String.raw`
const { Readable } = require('node:stream');
const [mediaImportPath, projectDir, id] = process.argv.slice(2);
const { createImportController, importReviewMedia } = require(mediaImportPath);
importReviewMedia({
  request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 25,
  headers: { 'content-length': '1', 'content-type': 'image/png', 'x-automontage-filename': 'crash.png' },
  controller: createImportController(), randomId: () => id,
  statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }),
  runMediaProcessImpl: async (invocation) => {
    if (invocation.command === 'ffprobe') process.exit(71);
    return { stdout: '', stderr: '', code: 0, signal: null };
  },
}).then(() => process.exit(99), () => process.exit(98));
`);
  const child = fork(workerPath, [
    require.resolve('../scripts/review/media-import'), projectDir, FIRST_ID,
  ], { stdio: 'ignore' });
  assert.deepEqual(await waitForExit(child), { code: 71, signal: null });

  const uploadPath = path.join(
    projectDir, 'tmp', 'review-imports', FIRST_ID, 'upload.bin',
  );
  const failingFileSystem = Object.create(fs);
  let injected = false;
  failingFileSystem.unlinkSync = (target) => {
    if (!injected && (target === uploadPath
      || (path.basename(target) === 'claimed'
        && path.basename(path.dirname(target)).startsWith('.upload.bin.remove-')))) {
      injected = true;
      const error = new Error('injected unlink failure');
      error.code = 'EIO';
      throw error;
    }
    return fs.unlinkSync(target);
  };
  cleanupOrphanImportQuarantines({ projectDir, fileSystem: failingFileSystem });
  assert.equal(injected, true);
  assert.equal(fs.existsSync(path.dirname(path.dirname(uploadPath))), true);

  cleanupOrphanImportQuarantines({ projectDir });
  assert.equal(fs.existsSync(path.dirname(uploadPath)), false);
});

test('orphan recovery restores and retries an exact quarantine after rmdir fails once', async (t) => {
  const projectDir = tempProject(t);
  const workerPath = path.join(projectDir, 'crash-before-rmdir-worker.js');
  fs.writeFileSync(workerPath, String.raw`
const { Readable } = require('node:stream');
const [mediaImportPath, projectDir, id] = process.argv.slice(2);
const { createImportController, importReviewMedia } = require(mediaImportPath);
importReviewMedia({
  request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 25,
  headers: { 'content-length': '1', 'content-type': 'image/png', 'x-automontage-filename': 'crash.png' },
  controller: createImportController(), randomId: () => id,
  statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }),
  runMediaProcessImpl: async (invocation) => {
    if (invocation.command === 'ffprobe') process.exit(81);
    return { stdout: '', stderr: '', code: 0, signal: null };
  },
}).then(() => process.exit(99), () => process.exit(98));
`);
  const child = fork(workerPath, [
    require.resolve('../scripts/review/media-import'), projectDir, FIRST_ID,
  ], { stdio: 'ignore' });
  assert.deepEqual(await waitForExit(child), { code: 81, signal: null });

  const quarantinePath = path.join(projectDir, 'tmp', 'review-imports', FIRST_ID);
  const failingFileSystem = Object.create(fs);
  let injected = false;
  failingFileSystem.rmdirSync = (target) => {
    if (!injected && path.basename(target) === 'claimed'
      && path.basename(path.dirname(target)).startsWith(`.${FIRST_ID}.remove-`)) {
      injected = true;
      const error = new Error('injected rmdir failure');
      error.code = 'EIO';
      throw error;
    }
    return fs.rmdirSync(target);
  };
  cleanupOrphanImportQuarantines({ projectDir, fileSystem: failingFileSystem });
  assert.equal(injected, true);

  cleanupOrphanImportQuarantines({ projectDir });
  assert.equal(fs.existsSync(quarantinePath), false);
  assert.deepEqual(fs.readdirSync(path.dirname(quarantinePath)), []);
});

test('owned removal preserves an unrelated empty tombstone without a claimed entry', (t) => {
  const projectDir = tempProject(t);
  const target = path.join(projectDir, 'target');
  const foreignTombstone = path.join(projectDir, '.target.remove-foreign');
  fs.mkdirSync(target);
  fs.mkdirSync(foreignTombstone);
  const targetStat = fs.lstatSync(target, { bigint: true });

  assert.equal(claimAndRemoveOwnedPath({
    target,
    expected: { dev: targetStat.dev, ino: targetStat.ino },
    kind: 'directory',
    temporaryId: () => 'owned',
  }), true);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(foreignTombstone), true);
  assert.deepEqual(fs.readdirSync(foreignTombstone), []);
});

test('exhausted Windows tombstone retries stay fail-closed on the next absent-target call', (t) => {
  const projectDir = tempProject(t);
  const target = path.join(projectDir, 'target');
  const tombstone = path.join(projectDir, '.target.remove-owned');
  fs.mkdirSync(target);
  const targetStat = fs.lstatSync(target, { bigint: true });
  const expected = { dev: targetStat.dev, ino: targetStat.ino };
  const fileSystem = Object.create(fs);
  let transientFailures = 3;
  fileSystem.rmdirSync = (candidate) => {
    if (candidate === tombstone && transientFailures > 0) {
      transientFailures -= 1;
      const error = new Error('injected exhausted EPERM');
      error.code = 'EPERM';
      throw error;
    }
    return fs.rmdirSync(candidate);
  };

  assert.throws(() => claimAndRemoveOwnedPath({
    target,
    expected,
    kind: 'directory',
    fileSystem,
    temporaryId: () => 'owned',
    platform: 'win32',
  }), (error) => error?.code === 'EPERM');
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(tombstone), true);
  assert.deepEqual(fs.readdirSync(tombstone), []);

  assert.equal(claimAndRemoveOwnedPath({
    target,
    expected,
    kind: 'directory',
    fileSystem,
    temporaryId: () => 'next',
    platform: 'win32',
  }), false);
  assert.equal(fs.existsSync(tombstone), true);
  assert.deepEqual(fs.readdirSync(tombstone), []);
});

test('Windows reconciles a tombstone rmdir that completed before reporting EPERM', (t) => {
  const projectDir = tempProject(t);
  const target = path.join(projectDir, 'target');
  const tombstone = path.join(projectDir, '.target.remove-owned');
  fs.mkdirSync(target);
  const targetStat = fs.lstatSync(target, { bigint: true });
  const fileSystem = Object.create(fs);
  let injected = false;
  fileSystem.rmdirSync = (candidate) => {
    if (!injected && candidate === tombstone) {
      injected = true;
      fs.rmdirSync(candidate);
      const error = new Error('injected post-rmdir EPERM');
      error.code = 'EPERM';
      throw error;
    }
    return fs.rmdirSync(candidate);
  };

  assert.equal(claimAndRemoveOwnedPath({
    target,
    expected: { dev: targetStat.dev, ino: targetStat.ino },
    kind: 'directory',
    fileSystem,
    temporaryId: () => 'owned',
    platform: 'win32',
  }), true);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(tombstone), false);
});

test('resume finds an exact retained claim regardless of a foreign mismatch order', async (t) => {
  for (const order of ['foreign-first', 'exact-first']) {
    await t.test(order, (subtest) => {
      const projectDir = tempProject(subtest);
      const target = path.join(projectDir, 'target');
      const foreignTombstone = path.join(projectDir, '.target.remove-foreign');
      const exactTombstone = path.join(projectDir, '.target.remove-exact');
      fs.mkdirSync(target);
      const targetStat = fs.lstatSync(target, { bigint: true });
      fs.mkdirSync(foreignTombstone);
      fs.mkdirSync(path.join(foreignTombstone, 'claimed'));
      fs.mkdirSync(exactTombstone);
      fs.renameSync(target, path.join(exactTombstone, 'claimed'));

      const fileSystem = Object.create(fs);
      fileSystem.readdirSync = (directory, options) => {
        const entries = fs.readdirSync(directory, options);
        if (path.resolve(directory) !== path.resolve(projectDir) || !options?.withFileTypes) {
          return entries;
        }
        const first = order === 'foreign-first' ? 'foreign' : 'exact';
        return entries.sort((left, right) => (
          Number(!left.name.endsWith(first)) - Number(!right.name.endsWith(first))
        ));
      };

      assert.equal(claimAndRemoveOwnedPath({
        target,
        expected: { dev: targetStat.dev, ino: targetStat.ino },
        kind: 'directory',
        fileSystem,
        temporaryId: () => 'unused',
      }), true);
      assert.equal(fs.existsSync(target), false);
      assert.equal(fs.existsSync(exactTombstone), false);
      assert.equal(fs.existsSync(foreignTombstone), true);
      assert.equal(fs.existsSync(path.join(foreignTombstone, 'claimed')), true);
    });
  }
});

test('POSIX tombstone removal is one-shot on a transient Windows-style error', (t) => {
  const projectDir = tempProject(t);
  const target = path.join(projectDir, 'target');
  const tombstone = path.join(projectDir, '.target.remove-owned');
  fs.mkdirSync(target);
  const targetStat = fs.lstatSync(target, { bigint: true });
  const fileSystem = Object.create(fs);
  let injected = false;
  fileSystem.rmdirSync = (candidate) => {
    if (!injected && candidate === tombstone) {
      injected = true;
      const error = new Error('injected POSIX EPERM');
      error.code = 'EPERM';
      throw error;
    }
    return fs.rmdirSync(candidate);
  };

  assert.throws(() => claimAndRemoveOwnedPath({
    target,
    expected: { dev: targetStat.dev, ino: targetStat.ino },
    kind: 'directory',
    fileSystem,
    temporaryId: () => 'owned',
    platform: 'linux',
  }), (error) => error?.code === 'EPERM');
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(tombstone), true);
  assert.deepEqual(fs.readdirSync(tombstone), []);
});

test('bigint tombstone identity rejects adjacent unsafe inodes after container replacement', (t) => {
  const projectDir = tempProject(t);
  const target = path.join(projectDir, 'target');
  const tombstone = path.join(projectDir, '.target.remove-owned');
  const originalContainer = path.join(projectDir, 'original-container-backup');
  const claimed = path.join(tombstone, 'claimed');
  fs.mkdirSync(target);
  const targetStat = fs.lstatSync(target, { bigint: true });
  const fileSystem = Object.create(fs);
  let replaced = false;
  fileSystem.lstatSync = (candidate, options) => {
    const stat = fs.lstatSync(candidate, options);
    if (candidate !== tombstone) return stat;
    const inode = replaced ? 9007199254740993n : 9007199254740992n;
    const bigint = options?.bigint === true;
    return {
      dev: bigint ? 7n : 7,
      ino: bigint ? inode : Number(inode),
      isDirectory: () => stat.isDirectory(),
      isSymbolicLink: () => stat.isSymbolicLink(),
    };
  };
  fileSystem.renameSync = (source, destination) => {
    fs.renameSync(source, destination);
    if (source === target && destination === claimed) {
      fs.renameSync(tombstone, originalContainer);
      fs.mkdirSync(tombstone);
      fs.renameSync(path.join(originalContainer, 'claimed'), claimed);
      replaced = true;
    }
  };

  assert.equal(claimAndRemoveOwnedPath({
    target,
    expected: { dev: targetStat.dev, ino: targetStat.ino },
    kind: 'directory',
    fileSystem,
    temporaryId: () => 'owned',
  }), false);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(tombstone), true);
  assert.deepEqual(fs.readdirSync(tombstone), []);
});

test('absent target ignores a proven foreign mismatching claim and preserves it', (t) => {
  const projectDir = tempProject(t);
  const target = path.join(projectDir, 'target');
  const expectedBackup = path.join(projectDir, 'expected-backup');
  const foreignTombstone = path.join(projectDir, '.target.remove-foreign');
  const foreignClaimed = path.join(foreignTombstone, 'claimed');
  fs.mkdirSync(target);
  const targetStat = fs.lstatSync(target, { bigint: true });
  fs.renameSync(target, expectedBackup);
  fs.mkdirSync(foreignTombstone);
  fs.mkdirSync(foreignClaimed);

  assert.equal(claimAndRemoveOwnedPath({
    target,
    expected: { dev: targetStat.dev, ino: targetStat.ino },
    kind: 'directory',
    temporaryId: () => 'unused',
  }), true);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(expectedBackup), true);
  assert.equal(fs.existsSync(foreignTombstone), true);
  assert.equal(fs.existsSync(foreignClaimed), true);
});

test('primary rename failure survives exhausted Windows tombstone cleanup retries', (t) => {
  const projectDir = tempProject(t);
  const target = path.join(projectDir, 'target');
  const tombstone = path.join(projectDir, '.target.remove-owned');
  fs.mkdirSync(target);
  const targetStat = fs.lstatSync(target, { bigint: true });
  const fileSystem = Object.create(fs);
  fileSystem.renameSync = (source, destination) => {
    if (source === target && destination === path.join(tombstone, 'claimed')) {
      const error = new Error('injected primary rename failure');
      error.code = 'EIO';
      throw error;
    }
    return fs.renameSync(source, destination);
  };
  fileSystem.rmdirSync = (candidate) => {
    if (candidate === tombstone) {
      const error = new Error('injected cleanup EPERM');
      error.code = 'EPERM';
      throw error;
    }
    return fs.rmdirSync(candidate);
  };

  assert.throws(() => claimAndRemoveOwnedPath({
    target,
    expected: { dev: targetStat.dev, ino: targetStat.ino },
    kind: 'directory',
    fileSystem,
    temporaryId: () => 'owned',
    platform: 'win32',
  }), (error) => error?.code === 'EIO' && error.cleanupError?.code === 'EPERM');
  assert.equal(fs.existsSync(target), true);
  assert.equal(fs.existsSync(tombstone), true);
  assert.deepEqual(fs.readdirSync(tombstone), []);
});

test('quarantine cleanup never deletes a foreign file swapped at the final removal syscall', async (t) => {
  const projectDir = tempProject(t);
  const workerPath = path.join(projectDir, 'crash-for-removal-race.js');
  fs.writeFileSync(workerPath, String.raw`
const { Readable } = require('node:stream');
const [mediaImportPath, projectDir, id] = process.argv.slice(2);
const { createImportController, importReviewMedia } = require(mediaImportPath);
importReviewMedia({
  request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 25,
  headers: { 'content-length': '1', 'content-type': 'image/png', 'x-automontage-filename': 'race.png' },
  controller: createImportController(), randomId: () => id,
  statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }),
  runMediaProcessImpl: async () => process.exit(71),
}).then(() => process.exit(99), () => process.exit(98));
`);
  const child = fork(workerPath, [
    require.resolve('../scripts/review/media-import'), projectDir, FIRST_ID,
  ], { stdio: 'ignore' });
  assert.deepEqual(await waitForExit(child), { code: 71, signal: null });

  const uploadPath = path.join(projectDir, 'tmp', 'review-imports', FIRST_ID, 'upload.bin');
  const ownedBackup = `${uploadPath}.owned-backup`;
  const fileSystem = Object.create(fs);
  let swapped = false;
  const swap = () => {
    if (swapped) return;
    swapped = true;
    fs.renameSync(uploadPath, ownedBackup);
    fs.writeFileSync(uploadPath, 'foreign-at-unlink');
  };
  fileSystem.unlinkSync = (target) => {
    if (target === uploadPath) swap();
    return fs.unlinkSync(target);
  };
  fileSystem.renameSync = (from, to) => {
    if (from === uploadPath) swap();
    return fs.renameSync(from, to);
  };

  cleanupOrphanImportQuarantines({ projectDir, fileSystem });
  assert.equal(swapped, true);
  assert.ok(findRegularFileWithBytes(projectDir, 'foreign-at-unlink'));
});

test('hard-exit during normalization removes the pre-owned output inode on the next import', async (t) => {
  const projectDir = tempProject(t);
  const workerPath = path.join(projectDir, 'crash-normalize-worker.js');
  fs.writeFileSync(workerPath, String.raw`
const fs = require('node:fs');
const { Readable } = require('node:stream');
const [mediaImportPath, projectDir, id] = process.argv.slice(2);
const { createImportController, importReviewMedia } = require(mediaImportPath);
const source = JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'png', pix_fmt: 'rgba', width: 64, height: 64, avg_frame_rate: '25/1', r_frame_rate: '25/1' }], format: { format_name: 'png_pipe' } });
importReviewMedia({
  request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 25,
  headers: { 'content-length': '1', 'content-type': 'image/png', 'x-automontage-filename': 'crash.png' },
  controller: createImportController(), randomId: () => id,
  statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }),
  runMediaProcessImpl: async (invocation) => {
    if (invocation.command === 'ffprobe') return { stdout: source, stderr: '', code: 0, signal: null };
    if (invocation.command === 'ffmpeg' && !invocation.args.includes('null')) {
      fs.writeFileSync(invocation.args.at(-1), 'partial normalized bytes');
      process.exit(72);
    }
    return { stdout: '', stderr: '', code: 0, signal: null };
  },
}).then(() => process.exit(99), () => process.exit(98));
`);
  const child = fork(workerPath, [
    require.resolve('../scripts/review/media-import'), projectDir, FIRST_ID,
  ], { stdio: 'ignore' });
  assert.deepEqual(await waitForExit(child), { code: 72, signal: null });
  const orphan = path.join(projectDir, 'tmp', 'review-imports', FIRST_ID);
  assert.equal(fs.existsSync(orphan), true);

  await importImage(projectDir, SECOND_ID);
  assert.equal(fs.existsSync(orphan), false);
});

test('hard-exit recovery covers master, proxy, claim, pre-marker, and committed-marker boundaries', async (t) => {
  for (const [boundary, exitCode, committed] of [
    ['master', 73, false],
    ['proxy', 74, false],
    ['claim', 75, false],
    ['mid-stage', 78, false],
    ['after-mkdir', 79, false],
    ['mid-canonical', 80, false],
    ['pre-marker', 76, false],
    ['marker', 77, true],
  ]) {
    await t.test(boundary, async (subtest) => {
      const projectDir = tempProject(subtest);
      const workerPath = path.join(projectDir, `crash-${boundary}-worker.js`);
      fs.writeFileSync(workerPath, String.raw`
const fs = require('node:fs');
const { Readable } = require('node:stream');
const [mediaImportPath, projectDir, id, boundary] = process.argv.slice(2);
const { createImportController, importReviewMedia } = require(mediaImportPath);
const fileSystem = Object.create(fs);
let claimFd = null;
let markerFd = null;
let previewStageFd = null;
let canonicalFinalFd = null;
let finalDirectoryCreated = false;
fileSystem.mkdirSync = (target, options) => {
  const result = fs.mkdirSync(target, options);
  if (String(target).endsWith('/' + id)) finalDirectoryCreated = true;
  return result;
};
fileSystem.openSync = (target, flags, mode) => {
  if (String(target).endsWith('/asset.json') && boundary === 'pre-marker') process.exit(76);
  const fd = fs.openSync(target, flags, mode);
  if (String(target).endsWith('.claim')) claimFd = fd;
  if (String(target).endsWith('/asset.json')) markerFd = fd;
  if (String(target).endsWith('.stage.webm')) previewStageFd = fd;
  if (String(target).endsWith('/media.mp4') && !String(target).includes('/tmp/review-imports/')) canonicalFinalFd = fd;
  return fd;
};
fileSystem.writeSync = (fd, ...args) => {
  if (boundary === 'after-mkdir' && finalDirectoryCreated && fd === claimFd) process.exit(79);
  const result = fs.writeSync(fd, ...args);
  if (boundary === 'mid-stage' && fd === previewStageFd) process.exit(78);
  if (boundary === 'mid-canonical' && fd === canonicalFinalFd) process.exit(80);
  return result;
};
fileSystem.fsyncSync = (fd) => {
  const result = fs.fsyncSync(fd);
  if (boundary === 'claim' && fd === claimFd) process.exit(75);
  if (boundary === 'marker' && fd === markerFd) process.exit(77);
  return result;
};
function probeFor(target) {
  if (target.includes('upload')) return { streams: [{ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 64, height: 64, avg_frame_rate: '25/1', r_frame_rate: '25/1', duration: '2' }], format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '2', tags: { major_brand: 'isom', compatible_brands: 'isomiso2avc1mp41' } } };
  if (target.endsWith('preview.webm')) return { streams: [{ codec_type: 'video', codec_name: 'vp8', pix_fmt: 'yuv420p', width: 64, height: 64, avg_frame_rate: '25/1', r_frame_rate: '25/1', duration: '2' }], format: { format_name: 'matroska,webm', duration: '2' } };
  return { streams: [{ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 64, height: 64, avg_frame_rate: '25/1', r_frame_rate: '25/1', duration: '2' }], format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '2', tags: { major_brand: 'isom', compatible_brands: 'isomiso2avc1mp41' } } };
}
importReviewMedia({
  request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 25,
  headers: { 'content-length': '1', 'content-type': 'video/mp4', 'x-automontage-filename': 'crash.mp4' },
  controller: createImportController(), randomId: () => id, fileSystem,
  statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }),
  runMediaProcessImpl: async (invocation) => {
    const target = invocation.args.at(-1);
    if (invocation.command === 'ffprobe') return { stdout: JSON.stringify(probeFor(target)), stderr: '', code: 0, signal: null };
    if (invocation.command === 'ffmpeg' && !invocation.args.includes('null')) {
      fs.writeFileSync(target, boundary + '-bytes');
      if (boundary === 'master' && target.endsWith('media.mp4')) process.exit(73);
      if (boundary === 'proxy' && target.endsWith('preview.webm')) process.exit(74);
    }
    return { stdout: '', stderr: '', code: 0, signal: null };
  },
}).then(() => process.exit(99), () => process.exit(98));
`);
      const child = fork(workerPath, [
        require.resolve('../scripts/review/media-import'), projectDir, FIRST_ID, boundary,
      ], { stdio: 'ignore' });
      assert.deepEqual(await waitForExit(child), { code: exitCode, signal: null });

      const finalDirectory = path.join(projectDir, 'assets', 'broll', 'video', FIRST_ID);
      const marker = path.join(finalDirectory, 'asset.json');
      const claim = path.join(
        projectDir, 'assets', 'broll', 'video', `.${FIRST_ID}.claim`,
      );
      const previewStage = path.join(
        projectDir, 'previews', 'broll', `.${FIRST_ID}.stage.webm`,
      );
      const preview = path.join(projectDir, 'previews', 'broll', `${FIRST_ID}.webm`);
      const committedBytes = committed ? fs.readFileSync(marker) : null;
      await importImage(projectDir, SECOND_ID);
      assert.equal(
        fs.existsSync(path.join(projectDir, 'tmp', 'review-imports', FIRST_ID)),
        false,
      );
      assert.equal(fs.existsSync(claim), false, claim);
      assert.equal(fs.existsSync(previewStage), false, previewStage);
      assert.equal(fs.existsSync(finalDirectory), committed);
      assert.equal(fs.existsSync(preview), committed);
      if (committed) assert.deepEqual(fs.readFileSync(marker), committedBytes);
    });
  }
});

test('orphan cleanup never treats UUID names, stages, previews, or age as ownership proof', (t) => {
  const projectDir = tempProject(t);
  const stage = path.join(projectDir, 'assets', 'broll', 'video', `.${FIRST_ID}.stage`);
  const preview = path.join(projectDir, 'previews', 'broll', `${FIRST_ID}.webm`);
  fs.mkdirSync(stage, { recursive: true });
  fs.mkdirSync(path.dirname(preview), { recursive: true });
  fs.writeFileSync(path.join(stage, 'foreign.txt'), 'stage survives');
  fs.writeFileSync(preview, 'preview survives');
  const old = new Date('2000-01-01T00:00:00.000Z');
  fs.utimesSync(stage, old, old);
  fs.utimesSync(preview, old, old);

  assert.deepEqual(cleanupOrphanImportedStages({ projectDir }), []);
  assert.equal(fs.readFileSync(path.join(stage, 'foreign.txt'), 'utf8'), 'stage survives');
  assert.equal(fs.readFileSync(preview, 'utf8'), 'preview survives');
});
