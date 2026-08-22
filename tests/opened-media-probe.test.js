const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const mediaProbe = require('../scripts/media-probe');
const { verifyPersistedBrollMedia } = require('../scripts/lesson/broll-media-files');
const { toolAvailable } = require('./helpers/media-fixtures');
const { windowsFileSystem } = require('./helpers/windows-filesystem');

const PROBE_ENTRIES = [
  'stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,duration,duration_ts,time_base,pix_fmt,sample_rate,channels',
  'stream_tags=rotate,DURATION',
  'stream_disposition=attached_pic',
  'stream_side_data=rotation',
  'format=format_name,duration',
].join(':');

function ffmpegCommand() {
  const configured = process.env.AUTOMONTAGE_FFMPEG_DIR;
  if (configured) return path.join(configured, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const macFull = '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
  return process.platform === 'darwin' && fs.existsSync(macFull) ? macFull : 'ffmpeg';
}

function runFixture(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(command)} fixture failed: ${result.error?.message || result.stderr}`);
  }
}

function makePortableFixtures(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-opened-probe-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ffmpeg = ffmpegCommand();
  const files = {
    png: path.join(directory, 'normalized.png'),
    jpeg: path.join(directory, 'normalized.jpg'),
    webp: path.join(directory, 'normalized.webp'),
    mp4: path.join(directory, 'end-moov.mp4'),
    webm: path.join(directory, 'normalized.webm'),
  };
  for (const [colour, output] of [
    ['red', files.png],
    ['green', files.jpeg],
    ['blue', files.webp],
  ]) {
    runFixture(ffmpeg, [
      '-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${colour}:s=32x24`,
      '-frames:v', '1', output,
    ]);
  }
  runFixture(ffmpeg, [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=15:d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', files.mp4,
  ]);
  runFixture(ffmpeg, [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=15:d=1',
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-an', files.webm,
  ]);
  const mp4Bytes = fs.readFileSync(files.mp4);
  assert.ok(mp4Bytes.indexOf(Buffer.from('mdat')) >= 0);
  assert.ok(mp4Bytes.indexOf(Buffer.from('moov')) > mp4Bytes.indexOf(Buffer.from('mdat')));
  return files;
}

function probeInvocation(run = spawnSync) {
  const invocations = [];
  return {
    invocations,
    run(command, args, options) {
      invocations.push({ command, args, options });
      return run(command, args, options);
    },
  };
}

function distortedWindowsStats(fileSystem) {
  let sequence = 0;
  const distort = (stat) => new Proxy(stat, {
    get(target, property) {
      if (property === 'mode') {
        sequence += 1;
        return typeof target.mode === 'bigint' ? BigInt(sequence & 1) : (sequence & 1);
      }
      if (property === 'nlink') {
        sequence += 1;
        return typeof target.nlink === 'bigint' ? BigInt(10 + sequence) : 10 + sequence;
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    ...fileSystem,
    fstatSync(descriptor, options) {
      return distort(fileSystem.fstatSync(descriptor, options));
    },
    lstatSync(target, options) {
      return distort(fileSystem.lstatSync(target, options));
    },
  };
}

function imageProbeResult(command, args, options) {
  assert.equal(command, 'ffprobe');
  assert.equal(args.at(-1), 'pipe:0');
  assert.equal(options.shell, false);
  assert.equal(options.stdio.length, 3);
  assert.equal(Number.isInteger(options.stdio[0]), true);
  return {
    status: 0,
    signal: null,
    stdout: JSON.stringify({
      streams: [{
        codec_type: 'video', codec_name: 'webp', width: 32, height: 24,
        avg_frame_rate: '25/1', r_frame_rate: '25/1', pix_fmt: 'yuv420p',
        disposition: { attached_pic: 0 },
      }],
      format: { format_name: 'webp_pipe' },
    }),
    stderr: '',
  };
}

test('opened-media probe exposes one portable descriptor transport', () => {
  assert.equal(typeof mediaProbe.probeOpenedMedia, 'function');
  assert.equal(typeof mediaProbe.fileSystemCapabilities, 'function');
  assert.deepEqual(mediaProbe.fileSystemCapabilities('win32'), {
    noFollow: false,
    posixPermissions: false,
    directoryFsync: false,
  });
  assert.deepEqual(mediaProbe.fileSystemCapabilities('linux'), {
    noFollow: true,
    posixPermissions: true,
    directoryFsync: true,
  });
});

test('opened-media probe real-parses normalized images and videos without a host path', (t) => {
  const ffmpeg = ffmpegCommand();
  if (!toolAvailable(ffmpeg) || !toolAvailable('ffprobe')) {
    t.skip('real portable probe requires ffmpeg and ffprobe');
    return;
  }
  const files = makePortableFixtures(t);
  for (const [kind, filePath] of Object.entries(files)) {
    const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY);
    const invocation = probeInvocation();
    let parsed;
    try {
      parsed = mediaProbe.probeOpenedMedia({
        fileDescriptor: descriptor,
        runToolImpl: invocation.run,
        stage: 'portable opened media probe',
      });
    } finally {
      fs.closeSync(descriptor);
    }
    assert.equal(parsed.mediaKind, ['png', 'jpeg', 'webp'].includes(kind) ? 'image' : 'video');
    assert.deepEqual([parsed.width, parsed.height], kind === 'mp4' || kind === 'webm'
      ? [160, 90]
      : [32, 24]);
    assert.equal(invocation.invocations.length, 1);
    const [{ command, args, options }] = invocation.invocations;
    assert.equal(command, 'ffprobe');
    assert.deepEqual(args.slice(-4), ['-show_entries', PROBE_ENTRIES, '-of', 'json', 'pipe:0'].slice(-4));
    assert.equal(args.at(-1), 'pipe:0');
    assert.equal(args.some((argument) => argument.includes(filePath)), false);
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 30_000);
    assert.equal(options.maxBuffer, 1024 * 1024);
    assert.deepEqual(options.stdio.slice(1), ['pipe', 'pipe']);
  }
});

test('opened-media probe does not expose ffprobe stderr paths in its error message', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-opened-probe-error-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'private.mp4');
  fs.writeFileSync(filePath, 'not media');
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY);
  try {
    assert.throws(() => mediaProbe.probeOpenedMedia({
      fileDescriptor: descriptor,
      stage: 'portable opened media probe',
      runToolImpl: () => ({
        status: 1,
        signal: null,
        stdout: '',
        stderr: `${filePath}: decoder failed`,
      }),
    }), (error) => {
      assert.equal(error.message, 'portable opened media probe: ffprobe завершился со status 1');
      assert.equal(error.message.includes(filePath), false);
      return true;
    });
  } finally {
    fs.closeSync(descriptor);
  }
});

test('Windows-mode approval ignores POSIX mode noise but still rejects same-size overwrite', (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-win32-approval-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const mediaPath = path.join(projectDir, 'assets', 'broll', 'safe.webp');
  fs.mkdirSync(path.dirname(mediaPath), { recursive: true });
  const original = Buffer.from('stable-image');
  fs.writeFileSync(mediaPath, original);
  const media = {
    kind: 'image',
    src: 'assets/broll/safe.webp',
    sha256: crypto.createHash('sha256').update(original).digest('hex'),
    fit: 'cover',
  };
  const fileSystem = distortedWindowsStats(fs);
  const stable = verifyPersistedBrollMedia({
    root: projectDir,
    workspace: { dir: projectDir },
    scene: { scene: 'broll', start: 0, end: 1, brollMedia: media },
    fps: 25,
    platform: 'win32',
    fileSystem,
    runToolImpl: imageProbeResult,
  });
  stable.assertCurrent();
  stable.close();

  const changed = verifyPersistedBrollMedia({
    root: projectDir,
    workspace: { dir: projectDir },
    scene: { scene: 'broll', start: 0, end: 1, brollMedia: media },
    fps: 25,
    platform: 'win32',
    fileSystem,
    runToolImpl: imageProbeResult,
  });
  fs.writeFileSync(mediaPath, Buffer.from('changed-imag'));
  assert.throws(() => changed.assertCurrent(), (error) => (
    error.code === 'BROLL_MEDIA_IDENTITY_CHANGED'
  ));
  changed.close();
});

test('Windows-mode approval verifies a normalized video proxy without POSIX flags', (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-win32-video-approval-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const id = '4af36be4-0b26-4e6f-bd48-8bdd2215a4f1';
  const mediaDirectory = path.join(projectDir, 'assets', 'broll', 'video', id);
  const previewDirectory = path.join(projectDir, 'previews', 'broll');
  fs.mkdirSync(mediaDirectory, { recursive: true });
  fs.mkdirSync(previewDirectory, { recursive: true });
  const canonical = Buffer.from('normalized-video');
  const preview = Buffer.from('normalized-proxy');
  const mediaPath = path.join(mediaDirectory, 'media.mp4');
  fs.writeFileSync(mediaPath, canonical);
  fs.writeFileSync(path.join(previewDirectory, `${id}.webm`), preview);
  const metadata = {
    version: 2,
    id,
    label: 'demo.mov',
    mediaKind: 'video',
    canonicalSha256: crypto.createHash('sha256').update(canonical).digest('hex'),
    previewSha256: crypto.createHash('sha256').update(preview).digest('hex'),
    width: 160,
    height: 90,
    fps: 15,
    durationSec: 1,
    audioDurationSec: null,
    hasAudio: false,
  };
  fs.writeFileSync(path.join(mediaDirectory, 'asset.json'), `${JSON.stringify(metadata)}\n`);
  const fileSystem = windowsFileSystem(distortedWindowsStats(fs));
  const verified = verifyPersistedBrollMedia({
    root: projectDir,
    workspace: { dir: projectDir },
    scene: {
      scene: 'broll',
      start: 0,
      end: 1,
      brollMedia: {
        kind: 'video',
        src: `assets/broll/video/${id}/media.mp4`,
        sha256: metadata.canonicalSha256,
        fit: 'cover',
        trimStartSec: 0,
        audioMode: 'mute',
      },
    },
    fps: 15,
    platform: 'win32',
    fileSystem,
    runToolImpl: () => ({
      status: 0,
      signal: null,
      stdout: JSON.stringify({
        streams: [{
          codec_type: 'video', codec_name: 'h264', width: 160, height: 90,
          avg_frame_rate: '15/1', r_frame_rate: '15/1', duration: '1', pix_fmt: 'yuv420p',
          disposition: { attached_pic: 0 },
        }],
        format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '1' },
      }),
      stderr: '',
    }),
  });
  verified.assertCurrent();
  verified.close();
});
