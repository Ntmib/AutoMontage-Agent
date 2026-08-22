const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');

const { formatBriefMarkdown } = require('../scripts/lesson/brief');
const { probeOpenedMedia } = require('../scripts/media-probe');
const {
  approveBrief,
  createOrOpenProject,
  nextBriefPaths,
  readProjectManifest,
  recordBrief,
  saveDraftRevision,
} = require('../scripts/project/workspace');
const {
  createImportController,
  importReviewMedia,
} = require('../scripts/review/media-import');
const { runMediaProcess } = require('../scripts/review/media-process');
const { listReviewAssetRecords } = require('../scripts/review/assets');
const { loadReviewBase } = require('../scripts/review/model');
const { materializeReviewAssets } = require('../scripts/review/server');

const ROOT = path.resolve(__dirname, '..');

function mediaToolDirectory() {
  if (process.env.AUTOMONTAGE_FFMPEG_DIR) return process.env.AUTOMONTAGE_FFMPEG_DIR;
  const macFull = '/opt/homebrew/opt/ffmpeg-full/bin';
  if (process.platform === 'darwin' && fs.existsSync(path.join(macFull, 'ffmpeg'))) return macFull;
  return null;
}

function executable(directory, command) {
  if (!directory) return command;
  return path.join(directory, process.platform === 'win32' ? `${command}.exe` : command);
}

function toolAvailable(command) {
  const result = spawnSync(command, ['-version'], { encoding: 'utf8', shell: false });
  return !result.error && result.status === 0;
}

function runFixture(command, args) {
  const result = spawnSync(command, ['-y', '-v', 'error', ...args], {
    encoding: 'utf8', shell: false, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`fixture failed: ${result.error?.message || result.stderr}`);
  }
}

function headers(filename, contentType, bytes) {
  return {
    'content-length': String(bytes.length),
    'content-type': contentType,
    'x-automontage-filename': encodeURIComponent(filename),
  };
}

async function importFixture({
  t, toolDirectory, sourcePath, filename, contentType, id, outputFps = 25,
}) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-real-contract-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const bytes = fs.readFileSync(sourcePath);
  const run = (invocation) => runMediaProcess({
    ...invocation,
    command: executable(toolDirectory, invocation.command),
  });
  return importReviewMedia({
    request: Readable.from([bytes]),
    projectDir,
    outputFps,
    headers: headers(filename, contentType, bytes),
    controller: createImportController(),
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }),
    randomId: () => id,
    runMediaProcessImpl: run,
  });
}

test('real still image imports above the video FPS ceiling', {
  timeout: 120_000,
}, async (t) => {
  const toolDirectory = mediaToolDirectory();
  const ffmpeg = executable(toolDirectory, 'ffmpeg');
  const ffprobe = executable(toolDirectory, 'ffprobe');
  if (!toolAvailable(ffmpeg) || !toolAvailable(ffprobe)) {
    t.skip('real still contract requires ffmpeg and ffprobe');
    return;
  }
  const encoders = spawnSync(ffmpeg, ['-hide_banner', '-encoders'], {
    encoding: 'utf8', shell: false,
  });
  if (encoders.status !== 0 || !/\blibwebp\b/.test(encoders.stdout)) {
    t.skip('real still contract requires the libwebp encoder');
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-still-fps-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, 'still.png');
  runFixture(ffmpeg, [
    '-f', 'lavfi', '-i', 'testsrc=s=321x181:r=1', '-frames:v', '1', sourcePath,
  ]);
  const imported = await importFixture({
    t,
    toolDirectory,
    sourcePath,
    filename: 'still.png',
    contentType: 'image/png',
    id: '3ae25ad3-f162-4d5e-8665-e1d124ac4910',
    outputFps: 240,
  });
  assert.deepEqual({
    mediaKind: imported.mediaKind,
    width: imported.width,
    height: imported.height,
    fps: imported.fps,
    durationSec: imported.durationSec,
    audioDurationSec: imported.audioDurationSec,
  }, {
    mediaKind: 'image', width: 321, height: 181, fps: 0, durationSec: 0,
    audioDurationSec: null,
  });
});

test('real mismatched streams keep visual duration and actual replacement audio', {
  timeout: 120_000,
}, async (t) => {
  const toolDirectory = mediaToolDirectory();
  const ffmpeg = executable(toolDirectory, 'ffmpeg');
  const ffprobe = executable(toolDirectory, 'ffprobe');
  if (!toolAvailable(ffmpeg) || !toolAvailable(ffprobe)) {
    t.skip('real duration contract requires ffmpeg and ffprobe');
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-mismatch-fixtures-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const longAudio = path.join(directory, 'video-1-audio-3.mp4');
  const shortAudio = path.join(directory, 'video-3-audio-1.mp4');
  for (const [output, videoDuration, audioDuration] of [
    [longAudio, 1, 3],
    [shortAudio, 3, 1],
  ]) {
    runFixture(ffmpeg, [
      '-f', 'lavfi', '-i', `testsrc2=s=160x90:r=25:d=${videoDuration}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:d=${audioDuration}`,
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', output,
    ]);
  }

  const first = await importFixture({
    t, toolDirectory, sourcePath: longAudio, filename: 'video-1-audio-3.mp4',
    contentType: 'video/mp4', id: '4af36be4-0b26-4e6f-bd48-8bdd2215a4f1',
  });
  assert.ok(Math.abs(first.durationSec - 1) <= 0.05, first.durationSec);
  assert.ok(Math.abs(first.audioDurationSec - 1) <= 0.05, first.audioDurationSec);

  const second = await importFixture({
    t, toolDirectory, sourcePath: shortAudio, filename: 'video-3-audio-1.mp4',
    contentType: 'video/mp4', id: '5bf47cf5-1c37-4f70-8e59-9ce9336b5a02',
  });
  assert.ok(Math.abs(second.durationSec - 3) <= 0.05, second.durationSec);
  assert.ok(Math.abs(second.audioDurationSec - 1) <= 0.05, second.audioDurationSec);
});

test('real odd landscape, portrait, and rotated MOV pad to even geometry without distortion', {
  timeout: 120_000,
}, async (t) => {
  const toolDirectory = mediaToolDirectory();
  const ffmpeg = executable(toolDirectory, 'ffmpeg');
  const ffprobe = executable(toolDirectory, 'ffprobe');
  if (!toolAvailable(ffmpeg) || !toolAvailable(ffprobe)) {
    t.skip('real odd-geometry contract requires ffmpeg and ffprobe');
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-odd-fixtures-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const landscape = path.join(directory, 'odd-landscape.mov');
  const portrait = path.join(directory, 'odd-portrait.mov');
  const rotated = path.join(directory, 'odd-rotated.mov');
  runFixture(ffmpeg, [
    '-f', 'lavfi', '-i', 'testsrc=s=321x181:r=15:d=0.6',
    '-c:v', 'qtrle', '-an', landscape,
  ]);
  runFixture(ffmpeg, [
    '-f', 'lavfi', '-i', 'testsrc=s=181x321:r=15:d=0.6',
    '-c:v', 'qtrle', '-an', portrait,
  ]);
  const rotation = spawnSync(ffmpeg, [
    '-y', '-v', 'error', '-display_rotation', '90', '-i', landscape, '-c', 'copy', rotated,
  ], { encoding: 'utf8', shell: false });
  const cases = [
    [landscape, 'odd-landscape.mov', 321, 181, '6cf58d06-2d48-4071-9f6a-adfa447c6b13'],
    [portrait, 'odd-portrait.mov', 181, 321, '7df69e17-3e59-4182-806b-befb558d7c24'],
  ];
  if (!rotation.error && rotation.status === 0) {
    cases.push([rotated, 'odd-rotated.mov', 181, 321, '8ef7af28-4f60-4293-917c-cf0c669e8d35']);
  }
  for (const [sourcePath, filename, visualWidth, visualHeight, id] of cases) {
    const imported = await importFixture({
      t, toolDirectory, sourcePath, filename, contentType: 'video/quicktime', id,
    });
    assert.equal(imported.width % 2, 0);
    assert.equal(imported.height % 2, 0);
    assert.ok(imported.width >= visualWidth && imported.width <= visualWidth + 1);
    assert.ok(imported.height >= visualHeight && imported.height <= visualHeight + 1);
    assert.ok(
      Math.abs(imported.width * visualHeight - imported.height * visualWidth)
        <= Math.max(imported.width, imported.height),
    );
  }
  if (rotation.status !== 0) t.diagnostic('ffmpeg lacks -display_rotation fixture support');
});

test('real short-audio replace rejects overrun before revision and renders a valid approved interval', {
  timeout: 180_000,
}, async (t) => {
  const toolDirectory = mediaToolDirectory();
  const ffmpeg = executable(toolDirectory, 'ffmpeg');
  const ffprobe = executable(toolDirectory, 'ffprobe');
  if (!toolAvailable(ffmpeg) || !toolAvailable(ffprobe)) {
    t.skip('real Save, approval, and render contract requires ffmpeg and ffprobe');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-replace-render-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'source-short-audio.mp4');
  const brollPath = path.join(root, 'odd-short-audio.mov');
  runFixture(ffmpeg, [
    '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:d=1',
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', sourcePath,
  ]);
  runFixture(ffmpeg, [
    '-f', 'lavfi', '-i', 'testsrc=s=161x91:r=25:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:d=1',
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'qtrle', '-c:a', 'pcm_s16le', brollPath,
  ]);
  const workspace = createOrOpenProject({
    projectDir: path.join(root, 'project'),
    name: 'Replace audio contract',
    sourcePath,
    now: new Date('2026-08-22T00:00:00.000Z'),
  });
  const bytes = fs.readFileSync(brollPath);
  await importReviewMedia({
    request: Readable.from([bytes]),
    projectDir: workspace.dir,
    outputFps: 25,
    headers: headers('odd-short-audio.mov', 'video/quicktime', bytes),
    controller: createImportController(),
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }),
    randomId: () => '9f08b039-5071-43a4-a28d-d01d77af9e46',
    runMediaProcessImpl: (invocation) => runMediaProcess({
      ...invocation,
      command: executable(toolDirectory, invocation.command),
    }),
  });
  const initialPaths = nextBriefPaths(workspace);
  const initialBrief = {
    version: 1,
    status: 'draft',
    source: workspace.sourcePath,
    theme: 'lesson-neutral',
    title: 'Audio duration contract',
    output: {
      aspect: 'horizontal', width: 160, height: 90, fps: 25, durationInFrames: 75,
    },
    corrections: [],
    scenes: [
      { scene: 'fullscreen', start: 0, end: 0.5, caption: 'НАЧАЛО' },
      { scene: 'fullscreen', start: 0.5, end: 3, caption: 'ФИНАЛ' },
    ],
  };
  fs.writeFileSync(initialPaths.jsonPath, `${JSON.stringify(initialBrief, null, 2)}\n`);
  fs.writeFileSync(initialPaths.markdownPath, formatBriefMarkdown(initialBrief));
  recordBrief(workspace, {
    revision: initialPaths.revision,
    jsonPath: initialPaths.jsonPath,
    markdownPath: initialPaths.markdownPath,
    status: 'draft',
    theme: initialBrief.theme,
    aspect: initialBrief.output.aspect,
  });
  const current = loadReviewBase({ projectDir: workspace.dir });
  const records = listReviewAssetRecords({ root: ROOT, projectDir: workspace.dir });
  const assetFiles = new Map(records.map((record, index) => [`asset-${index + 1}`, record]));
  const selected = [...assetFiles].find(([, asset]) => asset.mediaKind === 'video');
  assert.ok(selected);
  assert.deepEqual([selected[1].width, selected[1].height], [162, 92]);
  const runOpenedProbe = ({ fileDescriptor }) => probeOpenedMedia({
    fileDescriptor,
    stage: 'real review materialization probe',
    runToolImpl: (command, args, options) => spawnSync(
      executable(toolDirectory, command), args, options,
    ),
  });
  const invalid = structuredClone(current.brief);
  invalid.scenes = [
    {
      scene: 'broll', start: 0, end: 2,
      brollMedia: {
        kind: 'video', assetId: selected[0], trimStartSec: 0,
        fit: 'contain', audioMode: 'replace',
      },
      headCream: 'СЛИШКОМ', headOrange: 'ДЛИННО',
    },
    { scene: 'fullscreen', start: 2, end: 3, caption: 'ФИНАЛ' },
  ];
  const before = readProjectManifest(workspace.dir);
  const beforeBriefs = fs.readdirSync(path.join(workspace.dir, 'brief')).sort();
  assert.throws(() => materializeReviewAssets({
    root: ROOT,
    current,
    assetFiles,
    candidate: invalid,
    words: [],
    probeMediaImpl: runOpenedProbe,
  }), /asset|audio|clip|duration|unresolved/i);
  assert.deepEqual(readProjectManifest(workspace.dir).renders, before.renders);
  assert.deepEqual(fs.readdirSync(path.join(workspace.dir, 'brief')).sort(), beforeBriefs);

  const valid = structuredClone(current.brief);
  valid.scenes = [
    {
      scene: 'broll', start: 0, end: 0.5,
      brollMedia: {
        kind: 'video', assetId: selected[0], trimStartSec: 0,
        fit: 'contain', audioMode: 'replace',
      },
      headCream: 'КОРОТКИЙ', headOrange: 'ФРАГМЕНТ',
    },
    { scene: 'fullscreen', start: 0.5, end: 3, caption: 'ФИНАЛ' },
  ];
  const materialized = materializeReviewAssets({
    root: ROOT,
    current,
    assetFiles,
    candidate: valid,
    words: [],
    probeMediaImpl: runOpenedProbe,
  });
  const saved = saveDraftRevision(current.workspace, {
    baseJsonPath: current.briefFilePath,
    brief: materialized,
  });
  const approved = approveBrief(current.workspace, saved.jsonPath, {
    root: ROOT,
    runToolImpl: (command, args, options) => spawnSync(
      executable(toolDirectory, command), args, options,
    ),
  });
  const render = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'cli.js'),
    workspace.sourcePath,
    '--template', 'lesson',
    '--brief', path.relative(workspace.dir, approved.jsonPath),
    '--project-dir', workspace.dir,
    '--version-label', 'task4-audio-contract',
    '--frames', '10',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      AUTOMONTAGE_FFMPEG_DIR: toolDirectory || '',
      PATH: toolDirectory
        ? `${toolDirectory}${path.delimiter}${process.env.PATH || ''}`
        : process.env.PATH,
    },
    maxBuffer: 32 * 1024 * 1024,
    timeout: 150_000,
  });
  assert.equal(render.signal, null, render.stderr || render.stdout);
  assert.equal(render.status, 0, render.stderr || render.stdout);
  const manifest = readProjectManifest(workspace.dir);
  assert.equal(manifest.renders.length, 1);
  assert.equal(manifest.renders[0].status, 'complete');
  assert.ok(fs.statSync(path.join(workspace.dir, manifest.renders[0].dir, 'final.mp4')).size > 0);
});
