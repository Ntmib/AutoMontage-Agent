const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  createOrOpenProject,
  readProjectManifest,
} = require('../scripts/project/workspace');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_TONE_HZ = 440;
const CUSTOM_TONE_HZ = 880;

function toolDirectory() {
  if (process.env.AUTOMONTAGE_FFMPEG_DIR) return process.env.AUTOMONTAGE_FFMPEG_DIR;
  const macFull = '/opt/homebrew/opt/ffmpeg-full/bin';
  return process.platform === 'darwin' && fs.existsSync(path.join(macFull, 'ffmpeg'))
    ? macFull
    : null;
}

function executable(directory, command) {
  return directory ? path.join(directory, command) : command;
}

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: Object.hasOwn(options, 'encoding') ? options.encoding : 'utf8',
    shell: false,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
    env: options.env ?? process.env,
    cwd: options.cwd,
  });
  assert.equal(result.signal, null, result.stderr || result.stdout);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function makeFixtures(directory, ffmpeg) {
  const source = path.join(directory, 'source.mp4');
  const custom = path.join(directory, 'custom.mp4');
  checked(ffmpeg, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=green:s=160x90:r=25:d=2',
    '-f', 'lavfi', '-i', `sine=frequency=${SOURCE_TONE_HZ}:sample_rate=48000:d=2`,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest', source,
  ]);
  checked(ffmpeg, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=25:d=1',
    '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=25:d=1',
    '-f', 'lavfi', '-i', `sine=frequency=${CUSTOM_TONE_HZ}:sample_rate=48000:d=2`,
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map', '[v]', '-map', '2:a:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest', custom,
  ]);
  return { source, custom };
}

function pixelAt(file, seconds, ffmpeg) {
  const result = checked(ffmpeg, [
    '-v', 'error', '-i', file, '-ss', String(seconds), '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ], { encoding: null, maxBuffer: 160 * 90 * 3 * 2 });
  assert.ok(result.stdout.length >= 3);
  return [...result.stdout.subarray(0, 3)];
}

function toneMagnitude(file, centerSec, frequency, ffmpeg) {
  const duration = 0.4;
  const sampleRate = 48_000;
  const result = checked(ffmpeg, [
    '-v', 'error', '-ss', String(centerSec - duration / 2), '-t', String(duration),
    '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(sampleRate),
    '-f', 'f32le', 'pipe:1',
  ], { encoding: null, maxBuffer: 4 * 1024 * 1024 });
  const count = Math.floor(result.stdout.length / 4);
  assert.ok(count > sampleRate * 0.35);
  let real = 0;
  let imaginary = 0;
  let weightSum = 0;
  for (let index = 0; index < count; index += 1) {
    const sample = result.stdout.readFloatLE(index * 4);
    const weight = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (count - 1));
    const angle = (2 * Math.PI * frequency * index) / sampleRate;
    real += sample * weight * Math.cos(angle);
    imaginary -= sample * weight * Math.sin(angle);
    weightSum += weight;
  }
  return (2 * Math.hypot(real, imaginary)) / weightSum;
}

// The ordinary Node suite stays lightweight. Running this file directly is the mandatory
// real ffmpeg + Remotion acceptance gate for custom scene media.
const realTest = process.env.npm_lifecycle_event === 'test' ? test.skip : test;

realTest('real custom face render keeps global video timing and only the main source audio', {
  timeout: 240_000,
}, (t) => {
  const tools = toolDirectory();
  const ffmpeg = executable(tools, 'ffmpeg');
  checked(ffmpeg, ['-version']);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-custom-face-real-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixtures = makeFixtures(directory, ffmpeg);
  const workspace = createOrOpenProject({
    projectDir: path.join(directory, 'project'),
    name: 'Custom face real acceptance',
    sourcePath: fixtures.source,
    now: new Date('2026-08-22T12:00:00.000Z'),
  });
  const customReference = 'assets/faces/custom.mp4';
  const projectCustom = path.join(workspace.dir, ...customReference.split('/'));
  fs.mkdirSync(path.dirname(projectCustom), { recursive: true });
  fs.copyFileSync(fixtures.custom, projectCustom);
  const briefPath = path.join(workspace.dir, 'brief', 'custom-approved.json');
  const brief = {
    version: 1,
    status: 'approved',
    source: workspace.sourcePath,
    theme: 'lesson-neutral',
    title: 'CUSTOM FACE',
    output: {
      aspect: 'horizontal', width: 160, height: 90, fps: 25, durationInFrames: 50,
    },
    corrections: [],
    scenes: [
      { scene: 'fullscreen', start: 0, end: 1, caption: '' },
      { scene: 'fullscreen', start: 1, end: 2, caption: '', faceSrc: customReference },
    ],
  };
  fs.writeFileSync(briefPath, `${JSON.stringify(brief, null, 2)}\n`);
  const approvedBytes = fs.readFileSync(briefPath);
  const environment = {
    ...process.env,
    AUTOMONTAGE_FFMPEG_DIR: tools || '',
    PATH: tools ? `${tools}${path.delimiter}${process.env.PATH || ''}` : process.env.PATH,
  };

  const render = checked(process.execPath, [
    path.join(ROOT, 'scripts', 'cli.js'),
    workspace.sourcePath,
    '--template', 'lesson',
    '--brief', path.relative(workspace.dir, briefPath),
    '--project-dir', workspace.dir,
    '--version-label', 'custom-face-real',
  ], {
    cwd: ROOT, env: environment, timeout: 220_000, maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(`${render.stdout}${render.stderr}`.includes(projectCustom), false);
  assert.deepEqual(fs.readFileSync(briefPath), approvedBytes);

  const manifest = readProjectManifest(workspace.dir);
  const completed = manifest.renders.find((entry) => entry.status === 'complete');
  assert.ok(completed);
  const final = path.join(workspace.dir, completed.dir, 'final.mp4');
  const props = JSON.parse(fs.readFileSync(path.join(workspace.dir, completed.dir, 'props.json')));
  assert.equal(props.audioSrc, props.faceSrc);
  assert.notEqual(props.scenes[1].faceSrc, props.faceSrc);
  assert.match(props.scenes[1].faceSrc, /^\.automontage\/[^/]+\/media-2\.mp4$/);
  assert.equal(JSON.stringify(props).includes(directory), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'public', props.scenes[1].faceSrc)), false);

  const mainPixel = pixelAt(final, 0.5, ffmpeg);
  const globallyTimedCustomPixel = pixelAt(final, 1.5, ffmpeg);
  assert.ok(mainPixel[1] > mainPixel[0] * 1.5 && mainPixel[1] > mainPixel[2] * 1.5, mainPixel);
  assert.ok(
    globallyTimedCustomPixel[2] > globallyTimedCustomPixel[0] * 2
      && globallyTimedCustomPixel[2] > globallyTimedCustomPixel[1] * 2,
    globallyTimedCustomPixel,
  );
  for (const seconds of [0.5, 1.5]) {
    const sourceTone = toneMagnitude(final, seconds, SOURCE_TONE_HZ, ffmpeg);
    const customTone = toneMagnitude(final, seconds, CUSTOM_TONE_HZ, ffmpeg);
    assert.ok(sourceTone > customTone * 8, { seconds, sourceTone, customTone });
  }
});
