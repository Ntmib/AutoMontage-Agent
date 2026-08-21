const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { spawnSync } = require('node:child_process');

const {
  IMAGE_MAX_BYTES,
  VIDEO_MAX_BYTES,
  createImportController,
  importReviewMedia,
  parseImportHeaders,
  requiredFreeBytes,
} = require('../scripts/review/media-import');
const { runMediaProcess } = require('../scripts/review/media-process');
const {
  ffmpegEncoderAvailable,
  makeMediaFixtures,
  toolAvailable,
} = require('./helpers/media-fixtures');

const UUID = '4af36be4-0b26-4e6f-bd48-8bdd2215a4f1';

function rawHeaders(filename, contentType, contentLength) {
  return {
    'content-length': String(contentLength),
    'content-type': contentType,
    'x-automontage-filename': encodeURIComponent(filename),
  };
}

function expectImportError(fn, status, code) {
  assert.throws(fn, (error) => error.status === status && error.code === code);
}

function tempProject(t) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-media-import-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  return projectDir;
}

function probeJson({ kind = 'video', width = 320, height = 180, fps = '25/1', duration = 1, audio = false, rotation = 0 } = {}) {
  return JSON.stringify({
    streams: [
      {
        codec_type: 'video', width, height, avg_frame_rate: fps, r_frame_rate: fps,
        ...(rotation ? { side_data_list: [{ rotation }] } : {}),
      },
      ...(audio ? [{ codec_type: 'audio' }] : []),
    ],
    format: { format_name: kind === 'image' ? 'png_pipe' : 'mov,mp4,m4a,3gp,3g2,mj2', ...(kind === 'video' ? { duration: String(duration) } : {}) },
  });
}

function fakeProcessor({ source = probeJson(), masterFpsOverride, onCall } = {}) {
  const parsedSource = JSON.parse(source);
  const sourceVideo = parsedSource.streams.find((stream) => stream.codec_type === 'video');
  const sourceAudio = parsedSource.streams.some((stream) => stream.codec_type === 'audio');
  const sourceRotation = Number(sourceVideo.side_data_list?.[0]?.rotation || 0);
  let normalizedFps = 25;
  return async (invocation) => {
    onCall?.(invocation);
    if (invocation.command === 'ffprobe') {
      const input = invocation.args.at(-1);
      if (input.includes('upload')) return { stdout: source, stderr: '', code: 0, signal: null };
      const rotated = [90, -90, 270, -270].includes(sourceRotation);
      const normalizedShape = {
        width: rotated ? sourceVideo.height : sourceVideo.width,
        height: rotated ? sourceVideo.width : sourceVideo.height,
      };
      if (input.endsWith('.webp')) return { stdout: probeJson({ kind: 'image', ...normalizedShape }), stderr: '', code: 0, signal: null };
      const isProxy = input.endsWith('.webm');
      const scale = isProxy ? Math.min(1, 1280 / Math.max(normalizedShape.width, normalizedShape.height)) : 1;
      const outputShape = {
        width: Math.max(2, Math.floor(normalizedShape.width * scale / 2) * 2),
        height: Math.max(2, Math.floor(normalizedShape.height * scale / 2) * 2),
      };
      return { stdout: probeJson({
        ...outputShape,
        audio: sourceAudio,
        fps: `${masterFpsOverride || normalizedFps}/1`,
        duration: Number(parsedSource.format.duration || 1),
      }), stderr: '', code: 0, signal: null };
    }
    if (invocation.command === 'ffmpeg' && !invocation.args.includes('null')) {
      const fpsFilter = invocation.args.find((value) => typeof value === 'string' && /^fps=/.test(value));
      if (fpsFilter) normalizedFps = Number(fpsFilter.slice(4));
      fs.writeFileSync(invocation.args.at(-1), `normalized:${path.extname(invocation.args.at(-1))}`);
    }
    return { stdout: '', stderr: '', code: 0, signal: null };
  };
}

test('import headers require canonical length and an encoded single safe filename component', () => {
  assert.deepEqual(parseImportHeaders(rawHeaders('Product demo.mov', 'video/quicktime', 123)), {
    contentLength: 123,
    contentType: 'video/quicktime',
    extension: '.mov',
    filename: 'Product demo.mov',
    mediaKind: 'video',
  });
  assert.equal(
    parseImportHeaders(rawHeaders('Cafe\u0301.png', 'image/png', 1)).filename,
    'Café.png',
  );
  for (const value of [undefined, ['1', '1'], '', '0', '+1', ' 1', '1 ', '01', '1.0', '9007199254740992']) {
    const headers = rawHeaders('x.png', 'image/png', 1);
    headers['content-length'] = value;
    expectImportError(() => parseImportHeaders(headers), 400, 'MEDIA_IMPORT_LENGTH_INVALID');
  }
  for (const value of [undefined, ['x.png'], '%', '..%2Fsecret.png', 'C%3A%5Csecret.png', 'bad%00.png', 'bad%0A.png', 'photo.exe.png', `${'é'.repeat(126)}.png`]) {
    const headers = rawHeaders('x.png', 'image/png', 1);
    headers['x-automontage-filename'] = value;
    expectImportError(() => parseImportHeaders(headers), 400, 'MEDIA_IMPORT_FILENAME_INVALID');
  }
});

test('import headers enforce extension/MIME matrix, octet-stream, and exact byte ceilings', () => {
  const accepted = [
    ['x.avif', 'image/avif'], ['x.gif', 'image/gif'], ['x.jpeg', 'image/jpeg'],
    ['x.jpg', 'image/jpeg'], ['x.png', 'image/png'], ['x.webp', 'image/webp'],
    ['x.mp4', 'video/mp4'], ['x.mov', 'video/quicktime'], ['x.m4v', 'video/x-m4v'], ['x.webm', 'video/webm'],
    ['x.png', 'application/octet-stream'], ['x.mov', 'application/octet-stream'],
  ];
  for (const [filename, mime] of accepted) assert.doesNotThrow(() => parseImportHeaders(rawHeaders(filename, mime, 1)));
  for (const [filename, mime] of [['x.exe', 'application/octet-stream'], ['x.png', 'video/mp4'], ['x.mov', 'image/png']]) {
    expectImportError(() => parseImportHeaders(rawHeaders(filename, mime, 1)), 415, 'MEDIA_IMPORT_TYPE_UNSUPPORTED');
  }
  assert.equal(parseImportHeaders(rawHeaders('x.png', 'image/png', IMAGE_MAX_BYTES)).contentLength, IMAGE_MAX_BYTES);
  expectImportError(() => parseImportHeaders(rawHeaders('x.png', 'image/png', IMAGE_MAX_BYTES + 1)), 413, 'MEDIA_IMPORT_TOO_LARGE');
  assert.equal(parseImportHeaders(rawHeaders('x.mp4', 'video/mp4', VIDEO_MAX_BYTES)).contentLength, VIDEO_MAX_BYTES);
  expectImportError(() => parseImportHeaders(rawHeaders('x.mp4', 'video/mp4', VIDEO_MAX_BYTES + 1)), 413, 'MEDIA_IMPORT_TOO_LARGE');
  assert.equal(requiredFreeBytes(7), 4n * 7n + 512n * 1024n * 1024n);
});

test('disk reserve is checked before reading a request byte', async () => {
  let reads = 0;
  const request = new Readable({ read() { reads += 1; this.push(Buffer.from('x')); this.push(null); } });
  await assert.rejects(importReviewMedia({
    request,
    projectDir: tempProject({ after() {} }),
    outputFps: 25,
    headers: rawHeaders('x.png', 'image/png', 1),
    controller: createImportController(),
    statfsImpl: () => ({ bavail: 0, bsize: 4096 }),
    randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor({ source: probeJson({ kind: 'image' }) }),
  }), (error) => error.status === 507 && error.code === 'MEDIA_IMPORT_DISK_FULL');
  assert.equal(reads, 0);
});

test('controller has one owner and releases after every transaction failure', async (t) => {
  const controller = createImportController();
  assert.equal(controller.acquire(), true);
  assert.equal(controller.busy, true);
  assert.equal(controller.acquire(), false);
  controller.release();
  assert.equal(controller.busy, false);

  const cases = [
    ['parse', { headers: { ...rawHeaders('x.png', 'image/png', 1), 'content-length': '01' } }],
    ['stream', { request: Readable.from([]), headers: rawHeaders('x.png', 'image/png', 1) }],
    ['probe', { runMediaProcessImpl: async () => { throw new Error('probe failed'); } }],
    ['abort', { signal: AbortSignal.abort() }],
  ];
  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const ownedController = createImportController();
      const projectDir = tempProject(t);
      await assert.rejects(importReviewMedia({
        request: Readable.from([Buffer.from('x')]),
        projectDir,
        outputFps: 25,
        headers: rawHeaders('x.png', 'image/png', 1),
        controller: ownedController,
        statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }),
        randomId: () => UUID,
        runMediaProcessImpl: fakeProcessor({ source: probeJson({ kind: 'image' }) }),
        ...overrides,
      }));
      assert.equal(ownedController.busy, false);
    });
  }
});

test('streaming requires exact bytes, ignores post-body close, and keeps private exact modes', async (t) => {
  for (const chunks of [[], [Buffer.from('xx')]]) {
    const projectDir = tempProject(t);
    await assert.rejects(importReviewMedia({
      request: Readable.from(chunks), projectDir, outputFps: 25,
      headers: rawHeaders('x.png', 'image/png', 1), controller: createImportController(),
      statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
      runMediaProcessImpl: fakeProcessor({ source: probeJson({ kind: 'image' }) }),
    }), (error) => error.code === 'MEDIA_IMPORT_LENGTH_MISMATCH');
  }

  const projectDir = tempProject(t);
  let modes;
  const request = Readable.from([Buffer.from('x')]);
  const result = await importReviewMedia({
    request, projectDir, outputFps: 25,
    headers: rawHeaders('x.png', 'image/png', 1), controller: createImportController(),
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor({
      source: probeJson({ kind: 'image' }),
      onCall(invocation) {
        if (invocation.command === 'ffprobe' && invocation.args.at(-1).includes('upload')) {
          const upload = invocation.args.at(-1);
          modes = {
            directory: fs.statSync(path.dirname(upload)).mode & 0o777,
            upload: fs.statSync(upload).mode & 0o777,
          };
          request.emit('close');
        }
      },
    }),
  });
  assert.deepEqual(modes, { directory: 0o700, upload: 0o600 });
  assert.equal(result.reference, `assets/broll/images/${UUID}/media.webp`);
});

test('authoritative probe rejects content disagreement and exact media ceilings', async (t) => {
  const cases = [
    ['kind', probeJson({ kind: 'video' }), rawHeaders('x.png', 'image/png', 1)],
    ['video dimension', probeJson({ width: 4097, height: 10 }), rawHeaders('x.mp4', 'video/mp4', 1)],
    ['video pixels', probeJson({ width: 4096, height: 2161 }), rawHeaders('x.mp4', 'video/mp4', 1)],
    ['duration', probeJson({ duration: 1800.01 }), rawHeaders('x.mp4', 'video/mp4', 1)],
    ['image dimension', probeJson({ kind: 'image', width: 12001, height: 10 }), rawHeaders('x.png', 'image/png', 1)],
    ['image pixels', probeJson({ kind: 'image', width: 10000, height: 10001 }), rawHeaders('x.png', 'image/png', 1)],
  ];
  for (const [name, source, headers] of cases) {
    await t.test(name, async () => {
      await assert.rejects(importReviewMedia({
        request: Readable.from([Buffer.from('x')]), projectDir: tempProject(t), outputFps: 25,
        headers, controller: createImportController(),
        statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
        runMediaProcessImpl: fakeProcessor({ source }),
      }), (error) => error.status === 422);
    });
  }
});

test('video argv uses exact master/proxy profiles with conditional audio and asset-last publication', async (t) => {
  const projectDir = tempProject(t);
  const calls = [];
  const renameOrder = [];
  const fileSystem = Object.create(fs);
  fileSystem.renameSync = (from, to) => {
    renameOrder.push(path.relative(projectDir, to));
    return fs.renameSync(from, to);
  };
  const result = await importReviewMedia({
    request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 24,
    headers: rawHeaders('hostile;$(touch nope).mov', 'video/quicktime', 1),
    controller: createImportController(), fileSystem,
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor({ source: probeJson({ audio: true, fps: '30000/1001', rotation: -90 }), onCall: (call) => calls.push(call) }),
  });
  assert.equal(result.label, 'hostile;$(touch nope).mov');
  const encodes = calls.filter((call) => call.command === 'ffmpeg' && !call.args.includes('null'));
  const master = encodes.find((call) => call.args.at(-1).endsWith('.mp4'));
  const proxy = encodes.find((call) => call.args.at(-1).endsWith('.webm'));
  for (const token of ['-autorotate', 'libx264', 'yuv420p', '-crf', '18', '-preset', 'medium', '+faststart', '-map_metadata', '-1', 'aac', '48000', '2', '160k']) assert.ok(master.args.includes(token), token);
  assert.ok(master.args.join(' ').includes('fps=24'));
  assert.equal(master.args.includes('loudnorm'), false);
  for (const token of ['libvpx', '-map_metadata', '-1', 'libopus', '48000', '2', '96k']) assert.ok(proxy.args.includes(token), token);
  assert.ok(proxy.args.join(' ').includes('1280'));
  assert.ok(proxy.args.join(' ').includes('fps=24'));
  assert.equal(proxy.args.includes('loudnorm'), false);
  assert.equal(renameOrder.at(-1), `assets/broll/video/${UUID}`);
  assert.ok(renameOrder.indexOf(`previews/broll/${UUID}.webm`) < renameOrder.length - 1);
});

test('failed asset-last rename rolls back published preview and symlinked parents are refused', async (t) => {
  const projectDir = tempProject(t);
  const fileSystem = Object.create(fs);
  fileSystem.renameSync = (from, to) => {
    if (to === path.join(projectDir, 'assets', 'broll', 'video', UUID)) throw new Error('asset publish failed');
    return fs.renameSync(from, to);
  };
  await assert.rejects(importReviewMedia({
    request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 25,
    headers: rawHeaders('x.mp4', 'video/mp4', 1), controller: createImportController(), fileSystem,
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor({ source: probeJson() }),
  }), /asset publish failed/);
  assert.equal(fs.existsSync(path.join(projectDir, 'previews', 'broll', `${UUID}.webm`)), false);
  assert.equal(fs.existsSync(path.join(projectDir, 'assets', 'broll', 'video', UUID)), false);

  const symlinkProject = tempProject(t);
  const outside = tempProject(t);
  fs.symlinkSync(outside, path.join(symlinkProject, 'assets'));
  await assert.rejects(importReviewMedia({
    request: Readable.from([Buffer.from('x')]), projectDir: symlinkProject, outputFps: 25,
    headers: rawHeaders('x.png', 'image/png', 1), controller: createImportController(),
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor({ source: probeJson({ kind: 'image' }) }),
  }), (error) => error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE');
});

test('exclusive quarantine never deletes a pre-existing foreign UUID directory', async (t) => {
  const projectDir = tempProject(t);
  const quarantine = path.join(projectDir, 'tmp', 'review-imports', UUID);
  fs.mkdirSync(quarantine, { recursive: true });
  const sentinel = path.join(quarantine, 'foreign.txt');
  fs.writeFileSync(sentinel, 'keep me');
  await assert.rejects(importReviewMedia({
    request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 25,
    headers: rawHeaders('x.png', 'image/png', 1), controller: createImportController(),
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor({ source: probeJson({ kind: 'image' }) }),
  }), (error) => error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep me');
});

test('a second import is rejected before body consumption while the first owns the semaphore', async (t) => {
  const projectDir = tempProject(t);
  const controller = createImportController();
  const abort = new AbortController();
  const firstBody = new Readable({ read() {} });
  const first = importReviewMedia({
    request: firstBody, signal: abort.signal, projectDir, outputFps: 25,
    headers: rawHeaders('first.png', 'image/png', 1), controller,
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor({ source: probeJson({ kind: 'image' }) }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  let secondReads = 0;
  const secondBody = new Readable({ read() { secondReads += 1; this.push(null); } });
  await assert.rejects(importReviewMedia({
    request: secondBody, projectDir, outputFps: 25,
    headers: rawHeaders('second.png', 'image/png', 1), controller,
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor({ source: probeJson({ kind: 'image' }) }),
  }), (error) => error.status === 409 && error.code === 'MEDIA_IMPORT_BUSY');
  assert.equal(secondReads, 0);
  abort.abort();
  await assert.rejects(first, (error) => error.code === 'MEDIA_IMPORT_ABORTED');
  assert.equal(controller.busy, false);
});

test('parent replacement during processing and dangling final destinations abort publication', async (t) => {
  const projectDir = tempProject(t);
  let replaced = false;
  await assert.rejects(importReviewMedia({
    request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 25,
    headers: rawHeaders('x.png', 'image/png', 1), controller: createImportController(),
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor({
      source: probeJson({ kind: 'image' }),
      onCall(invocation) {
        if (!replaced && invocation.command === 'ffmpeg') {
          replaced = true;
          const parent = path.join(projectDir, 'assets', 'broll', 'images');
          fs.renameSync(parent, `${parent}-replaced`);
          fs.mkdirSync(parent);
        }
      },
    }),
  }), (error) => error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE');
  assert.equal(fs.existsSync(path.join(projectDir, 'assets', 'broll', 'images', UUID)), false);

  const danglingProject = tempProject(t);
  fs.mkdirSync(path.join(danglingProject, 'previews', 'broll'), { recursive: true });
  fs.symlinkSync(path.join(danglingProject, 'missing.webm'), path.join(danglingProject, 'previews', 'broll', `${UUID}.webm`));
  await assert.rejects(importReviewMedia({
    request: Readable.from([Buffer.from('x')]), projectDir: danglingProject, outputFps: 25,
    headers: rawHeaders('x.mp4', 'video/mp4', 1), controller: createImportController(),
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor({ source: probeJson() }),
  }), (error) => error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE');
  assert.equal(fs.lstatSync(path.join(danglingProject, 'previews', 'broll', `${UUID}.webm`)).isSymbolicLink(), true);
});

test('upload pathname replacement before probing is rejected by opened-file identity', async (t) => {
  const projectDir = tempProject(t);
  let replaced = false;
  await assert.rejects(importReviewMedia({
    request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 25,
    headers: rawHeaders('x.png', 'image/png', 1), controller: createImportController(),
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor({
      source: probeJson({ kind: 'image' }),
      onCall(invocation) {
        if (!replaced && invocation.command === 'ffprobe' && invocation.args.at(-1).includes('upload')) {
          replaced = true;
          const upload = invocation.args.at(-1);
          fs.renameSync(upload, `${upload}.original`);
          fs.writeFileSync(upload, 'different bytes');
        }
      },
    }),
  }), (error) => error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE');
  assert.equal(fs.existsSync(path.join(projectDir, 'assets', 'broll', 'images', UUID)), false);
});

test('the exact accepted geometry boundaries normalize without large request allocations', async (t) => {
  for (const [filename, mime, source] of [
    ['boundary.mp4', 'video/mp4', probeJson({ width: 4096, height: 2160, duration: 1800 })],
    ['boundary.png', 'image/png', probeJson({ kind: 'image', width: 10000, height: 10000 })],
  ]) {
    const result = await importReviewMedia({
      request: Readable.from([Buffer.from('x')]), projectDir: tempProject(t), outputFps: 25,
      headers: rawHeaders(filename, mime, 1), controller: createImportController(),
      statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => crypto.randomUUID(),
      runMediaProcessImpl: fakeProcessor({ source }),
    });
    assert.equal(result.label, filename);
  }
});

test('publication rejects a successful encoder result with the wrong authoritative master FPS', async (t) => {
  const controller = createImportController();
  const projectDir = tempProject(t);
  await assert.rejects(importReviewMedia({
    request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 24,
    headers: rawHeaders('wrong-fps.mp4', 'video/mp4', 1), controller,
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor({ source: probeJson(), masterFpsOverride: 30 }),
  }), (error) => error.status === 422 && error.code === 'MEDIA_IMPORT_OUTPUT_INVALID');
  assert.equal(controller.busy, false);
  assert.equal(fs.existsSync(path.join(projectDir, 'assets', 'broll', 'video', UUID)), false);
});

test('real tiny images and videos normalize, decode, preserve alpha/first GIF frame, and expose expected streams', { timeout: 120000 }, async (t) => {
  if (!toolAvailable('ffmpeg') || !toolAvailable('ffprobe')) {
    t.skip('ffmpeg and ffprobe are unavailable; real-media ingest test requires both local tools');
    return;
  }
  const fixtureDir = tempProject(t);
  const files = makeMediaFixtures(fixtureDir);
  const hasWebpEncoder = ffmpegEncoderAvailable('libwebp');
  const cases = [
    ['tiny.jpg', files.jpeg, 'image/jpeg', 'image'],
    ['animated.gif', files.animatedGif, 'image/gif', 'image'],
    ['transparent.png', files.transparentPng, 'image/png', 'image'],
    ['silent.mp4', files.silentLandscape, 'video/mp4', 'video'],
    ['audio.mp4', files.audioPortrait, 'video/mp4', 'video'],
    ['rotated-vfr.mov', files.rotatedVfr, 'video/quicktime', 'video'],
  ];
  for (const [filename, sourcePath, mime, kind] of cases) {
    await t.test(filename, async (subtest) => {
      if (kind === 'image' && !hasWebpEncoder) {
        subtest.skip('ffmpeg libwebp encoder is unavailable; real image normalization requires that local encoder');
        return;
      }
      const projectDir = tempProject(t);
      const bytes = fs.statSync(sourcePath).size;
      const result = await importReviewMedia({
        request: fs.createReadStream(sourcePath), projectDir, outputFps: 25,
        headers: rawHeaders(filename, mime, bytes), controller: createImportController(),
        randomId: () => crypto.randomUUID(), runMediaProcessImpl: runMediaProcess,
      });
      assert.equal(result.mediaKind, kind);
      const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', result.filePath, '-f', 'null', '-'], { encoding: 'utf8' });
      assert.equal(decode.status, 0, decode.stderr);
      if (filename === 'animated.gif') {
        const count = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'default=nw=1:nk=1', result.filePath], { encoding: 'utf8' });
        assert.equal(count.stdout.trim(), '1');
        const pixel = spawnSync('ffmpeg', ['-v', 'error', '-i', result.filePath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: null });
        assert.ok(pixel.stdout[0] > pixel.stdout[2], 'first GIF frame should remain red, not the blue second frame');
      }
      if (filename === 'transparent.png') {
        const alpha = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=pix_fmt', '-of', 'default=nw=1:nk=1', result.filePath], { encoding: 'utf8' });
        assert.match(alpha.stdout, /yuva|rgba|argb|bgra/);
        const pixel = spawnSync('ffmpeg', ['-v', 'error', '-i', result.filePath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { encoding: null });
        assert.ok(pixel.stdout[3] < 16, 'transparent source pixel should remain transparent');
      }
      if (kind === 'video') {
        const master = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', result.filePath], { encoding: 'utf8' }).stdout);
        const proxy = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', result.previewPath], { encoding: 'utf8' }).stdout);
        const masterVideo = master.streams.find((stream) => stream.codec_type === 'video');
        const proxyVideo = proxy.streams.find((stream) => stream.codec_type === 'video');
        assert.equal(masterVideo.codec_name, 'h264');
        assert.equal(masterVideo.pix_fmt, 'yuv420p');
        assert.equal(masterVideo.avg_frame_rate, '25/1');
        assert.equal(proxyVideo.codec_name, 'vp8');
        assert.ok(proxyVideo.width <= 1280 && proxyVideo.height <= 1280);
        assert.ok(Number(proxyVideo.avg_frame_rate.split('/')[0]) / Number(proxyVideo.avg_frame_rate.split('/')[1]) <= 30);
        const masterAudio = master.streams.find((stream) => stream.codec_type === 'audio');
        const proxyAudio = proxy.streams.find((stream) => stream.codec_type === 'audio');
        if (filename !== 'audio.mp4') {
          assert.equal(masterAudio, undefined);
          assert.equal(proxyAudio, undefined);
        } else {
          assert.deepEqual([masterAudio.codec_name, masterAudio.sample_rate, masterAudio.channels], ['aac', '48000', 2]);
          assert.deepEqual([proxyAudio.codec_name, proxyAudio.sample_rate, proxyAudio.channels], ['opus', '48000', 2]);
        }
        const masterDuration = Number(master.format.duration);
        const proxyDuration = Number(proxy.format.duration);
        assert.ok(Math.abs(masterDuration - proxyDuration) <= (1 / 25) + 0.001);
        if (filename === 'rotated-vfr.mov') {
          assert.deepEqual([masterVideo.width, masterVideo.height], [90, 160]);
          assert.equal(masterVideo.tags?.rotate, undefined);
          assert.equal(masterVideo.side_data_list?.some((entry) => Number(entry.rotation) !== 0) ?? false, false);
        }
      }
    });
  }
});
