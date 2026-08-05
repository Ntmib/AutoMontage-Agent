#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const { captureTool, runNodeTool, runTool } = require('./process');
const {
  createOrOpenProject,
  readProjectManifest,
} = require('./project/workspace');

const ROOT = path.resolve(__dirname, '..');
const PROTECTED_FILES = ['src/data/captions.js', 'src/data/transcript.json'];
const MAX_DRIFT_SECONDS = 0.08;

function hashFile(file) {
  if (!fs.existsSync(file)) return null;
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function snapshotFiles(root, files) {
  return new Map(files.map((file) => [file, hashFile(path.join(root, file))]));
}

function assertProtectedFilesUnchanged(root, before) {
  for (const [file, expected] of before) {
    const actual = hashFile(path.join(root, file));
    if (actual !== expected) throw new Error(`protected file changed: ${file}`);
  }
}

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} is not finite`);
  return number;
}

function probeMedia(file) {
  const source = captureTool('ffprobe', [
    '-v', 'error',
    '-count_frames',
    '-show_entries', 'stream=codec_type,start_time,duration,nb_read_frames:format=duration',
    '-of', 'json',
    path.resolve(file),
  ], { cwd: ROOT, stage: `probe ${path.basename(file)}`, maxBuffer: 4 * 1024 * 1024 });
  let probe;
  try {
    probe = JSON.parse(source);
  } catch (error) {
    throw new Error(`ffprobe returned invalid JSON for ${file}: ${error.message}`);
  }
  const video = (probe.streams || []).find((stream) => stream.codec_type === 'video');
  const audio = (probe.streams || []).find((stream) => stream.codec_type === 'audio');
  if (!video || !audio) throw new Error(`${file} must contain video and audio streams`);
  const formatDuration = finite(probe.format && probe.format.duration, `${file} format duration`);
  const timing = (stream, label) => ({
    start: finite(stream.start_time ?? 0, `${file} ${label} start`),
    duration: finite(stream.duration ?? formatDuration, `${file} ${label} duration`),
  });
  const videoTiming = timing(video, 'video');
  const audioTiming = timing(audio, 'audio');
  const startDrift = Math.abs(videoTiming.start - audioTiming.start);
  const durationDrift = Math.abs(videoTiming.duration - audioTiming.duration);
  if (startDrift >= MAX_DRIFT_SECONDS || durationDrift >= MAX_DRIFT_SECONDS) {
    throw new Error(
      `${file} A/V drift is too large (start=${startDrift.toFixed(3)}s, duration=${durationDrift.toFixed(3)}s)`,
    );
  }
  return {
    frames: finite(video.nb_read_frames, `${file} video frame count`),
    startDrift,
    durationDrift,
  };
}

function decodeMedia(file) {
  runTool('ffmpeg', [
    '-v', 'error',
    '-i', path.resolve(file),
    '-map', '0:v:0',
    '-map', '0:a:0',
    '-f', 'null',
    '-',
  ], { cwd: ROOT, stage: `decode ${path.basename(file)}` });
}

function assertMedia(file, expectedFrames) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`smoke final does not exist: ${file}`);
  }
  const probe = probeMedia(file);
  if (probe.frames !== expectedFrames) {
    throw new Error(`${file} has ${probe.frames} frames instead of ${expectedFrames}`);
  }
  decodeMedia(file);
  return probe;
}

function assertProjectFinal(projectDir) {
  const manifest = readProjectManifest(projectDir);
  if (!manifest.final || !manifest.latestRender || !Array.isArray(manifest.renders)) {
    throw new Error('project manifest lacks final, latestRender, or renders[]');
  }
  const selected = manifest.renders.find((render) => render.dir === manifest.latestRender);
  if (!selected || selected.status !== 'complete') {
    throw new Error('latestRender does not select a complete renders[] entry');
  }
  const finalPath = path.join(projectDir, manifest.final);
  const renderFinalPath = path.join(projectDir, selected.dir, 'final.mp4');
  if (!fs.existsSync(finalPath) || !fs.existsSync(renderFinalPath)) {
    throw new Error('project final or selected render final is missing');
  }
  if (hashFile(finalPath) !== hashFile(renderFinalPath)) {
    throw new Error('project final SHA-256 differs from the selected render final');
  }
  return finalPath;
}

function preservePublicSource(root) {
  const publicSource = path.join(root, 'public', 'source.mp4');
  const backupDir = path.join(root, 'tmp', 'release-smoke-backups');
  const backup = path.join(backupDir, `source-${randomUUID()}.mp4`);
  const existed = fs.existsSync(publicSource);
  if (existed) {
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(publicSource, backup, fs.constants.COPYFILE_EXCL);
  }
  return () => {
    if (existed) {
      fs.copyFileSync(backup, publicSource);
      fs.unlinkSync(backup);
    } else if (fs.existsSync(publicSource)) {
      fs.unlinkSync(publicSource);
    }
  };
}

function runReleaseSmoke({ root = ROOT, id = `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}` } = {}) {
  const resolvedRoot = path.resolve(root);
  const protectedBefore = snapshotFiles(resolvedRoot, PROTECTED_FILES);
  const restorePublicSource = preservePublicSource(resolvedRoot);
  const childEnv = { ...process.env };
  delete childEnv.THEMES_EXT;
  const lessonId = `release-lesson-neutral-${id}`;
  const lessonDir = path.join(resolvedRoot, 'out', 'release-smoke', id, 'lesson');
  const lessonFinal = path.join(lessonDir, `${lessonId}.mp4`);
  const source = path.join(resolvedRoot, 'examples', 'demo-source.mp4');
  const lessonBrief = path.join(resolvedRoot, 'examples', 'lesson-neutral-approved.json');
  const projectDir = path.join(resolvedRoot, 'projects', `release-dynamic-smoke-${id}`);
  let completed = false;
  try {
    runNodeTool(path.join(resolvedRoot, 'scripts', 'build.js'), [
      source,
      '--template', 'lesson',
      '--brief', lessonBrief,
      '--frames', '75',
      '--id', lessonId,
      '--outdir', lessonDir,
    ], { cwd: resolvedRoot, env: childEnv, stage: 'release lesson smoke' });
    assertMedia(lessonFinal, 75);

    const workspace = createOrOpenProject({
      baseDir: path.join(resolvedRoot, 'projects'),
      name: 'Release Dynamic Smoke',
      projectDir,
      sourcePath: source,
    });
    const scenarioPath = path.join(workspace.dir, 'brief', 'release-smoke.scenario.json');
    fs.copyFileSync(
      path.join(resolvedRoot, 'examples', 'scenario-demo.json'),
      scenarioPath,
      fs.constants.COPYFILE_EXCL,
    );
    runNodeTool(path.join(resolvedRoot, 'scripts', 'build.js'), [
      workspace.sourcePath,
      '--scenario', path.relative(workspace.dir, scenarioPath),
      '--project-dir', workspace.dir,
      '--version-label', 'smoke',
      '--frames', '75',
      '--no-transcribe',
    ], { cwd: resolvedRoot, env: childEnv, stage: 'release dynamic smoke' });
    const projectFinal = assertProjectFinal(workspace.dir);
    assertMedia(projectFinal, 75);
    completed = true;
    return { lessonFinal, projectFinal };
  } finally {
    try {
      restorePublicSource();
    } finally {
      assertProtectedFilesUnchanged(resolvedRoot, protectedBefore);
    }
    if (!completed) console.error(`release smoke artifacts kept for diagnosis: ${lessonDir}, ${projectDir}`);
  }
}

function main() {
  const result = runReleaseSmoke();
  console.log(`lesson final: ${result.lessonFinal}`);
  console.log(`dynamic project final: ${result.projectFinal}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`release smoke failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  assertMedia,
  assertProjectFinal,
  assertProtectedFilesUnchanged,
  probeMedia,
  runReleaseSmoke,
  snapshotFiles,
};
