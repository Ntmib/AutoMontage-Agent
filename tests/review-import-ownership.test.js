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
    if (!injected && target === uploadPath) {
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
fileSystem.openSync = (target, flags, mode) => {
  if (String(target).endsWith('/asset.json') && boundary === 'pre-marker') process.exit(76);
  const fd = fs.openSync(target, flags, mode);
  if (String(target).endsWith('.claim')) claimFd = fd;
  if (String(target).endsWith('/asset.json')) markerFd = fd;
  return fd;
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
      const committedBytes = committed ? fs.readFileSync(marker) : null;
      await importImage(projectDir, SECOND_ID);
      assert.equal(
        fs.existsSync(path.join(projectDir, 'tmp', 'review-imports', FIRST_ID)),
        false,
      );
      assert.equal(fs.existsSync(finalDirectory), committed);
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
