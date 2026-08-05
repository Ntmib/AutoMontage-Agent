const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const { captureTool, hostPath } = require('./process');

const CACHE_VERSION = 1;
const MANIFEST_NAME = 'manifest.json';

function fileIdentity(file, fileSystem = fs) {
  const resolved = hostPath(file);
  let handle;
  try {
    handle = fileSystem.openSync(resolved, 'r');
  } catch {
    throw new Error('chunk cache: файл для identity недоступен');
  }
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let size = 0;
  try {
    let bytesRead;
    do {
      bytesRead = fileSystem.readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
        size += bytesRead;
      }
    } while (bytesRead > 0);
  } catch {
    throw new Error('chunk cache: не удалось вычислить identity файла');
  } finally {
    fileSystem.closeSync(handle);
  }
  return { size, sha256: hash.digest('hex') };
}

function createRenderJob({
  composition,
  props,
  source = null,
  audio = null,
  total,
  chunk,
  remotionOptions,
}) {
  const descriptor = {
    version: CACHE_VERSION,
    composition,
    props: fileIdentity(props),
    source: source ? fileIdentity(source) : null,
    audio: audio ? fileIdentity(audio) : null,
    total,
    chunk,
    remotionOptions,
  };
  const key = createHash('sha256').update(JSON.stringify(descriptor)).digest('hex');
  return { key, descriptor };
}

function emptyManifest(job) {
  return {
    version: CACHE_VERSION,
    jobKey: job.key,
    job: job.descriptor,
    chunks: [],
  };
}

function loadCacheManifest(directory, job, fileSystem = fs) {
  const resolvedDirectory = hostPath(directory);
  const manifestPath = path.join(resolvedDirectory, MANIFEST_NAME);
  fileSystem.mkdirSync(resolvedDirectory, { recursive: true });
  if (!fileSystem.existsSync(manifestPath)) return emptyManifest(job);
  try {
    const manifest = JSON.parse(fileSystem.readFileSync(manifestPath, 'utf8'));
    if (manifest.version !== CACHE_VERSION
      || manifest.jobKey !== job.key
      || JSON.stringify(manifest.job) !== JSON.stringify(job.descriptor)
      || !Array.isArray(manifest.chunks)) {
      return emptyManifest(job);
    }
    return manifest;
  } catch {
    return emptyManifest(job);
  }
}

function writeManifestAtomic(directory, manifest, {
  fileSystem = fs,
  temporaryId = randomUUID,
} = {}) {
  const manifestPath = path.join(hostPath(directory), MANIFEST_NAME);
  const temporaryPath = `${manifestPath}.tmp-${temporaryId()}`;
  let handle = null;
  try {
    fileSystem.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`);
    handle = fileSystem.openSync(temporaryPath, 'r');
    fileSystem.fsyncSync(handle);
    fileSystem.closeSync(handle);
    handle = null;
    fileSystem.renameSync(temporaryPath, manifestPath);
  } finally {
    if (handle !== null) fileSystem.closeSync(handle);
    if (fileSystem.existsSync(temporaryPath)) fileSystem.unlinkSync(temporaryPath);
  }
}

function recordChunkComplete({
  directory,
  manifest,
  part,
  from,
  to,
  frames,
}, options = {}) {
  const expectedFrames = to - from + 1;
  if (!Number.isSafeInteger(from) || from < 0
    || !Number.isSafeInteger(to) || to < from
    || frames !== expectedFrames) {
    throw new Error('chunk manifest: недопустимый диапазон или frame count');
  }
  const expectedFile = `${from}-${to}.mp4`;
  if (path.basename(part) !== expectedFile || path.dirname(hostPath(part)) !== hostPath(directory)) {
    throw new Error('chunk manifest: part должен находиться в job cache');
  }
  const identity = fileIdentity(part, options.fileSystem || fs);
  if (identity.size <= 1000) throw new Error('chunk manifest: part слишком мал');
  const entry = {
    from,
    to,
    frames,
    file: expectedFile,
    status: 'complete',
    ...identity,
  };
  const existingIndex = manifest.chunks.findIndex((chunk) => chunk.from === from);
  if (existingIndex >= 0) manifest.chunks[existingIndex] = entry;
  else manifest.chunks.push(entry);
  manifest.chunks.sort((left, right) => left.from - right.from);
  writeManifestAtomic(directory, manifest, options);
  return entry;
}

function probeChunkFrames(file, options = {}) {
  const output = captureTool('ffprobe', [
    '-v', 'error',
    '-count_frames',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames',
    '-of', 'default=nk=1:nw=1',
    hostPath(file),
  ], {
    stage: 'chunk frame probe',
    maxBuffer: 1024 * 1024,
    spawnSyncImpl: options.spawnSyncImpl,
  }).trim();
  const frames = Number(output);
  if (!Number.isSafeInteger(frames) || frames <= 0) {
    throw new Error('chunk frame probe: недопустимое число кадров');
  }
  return frames;
}

function isReusableChunk({
  directory,
  manifest,
  from,
  to,
  probeFrames = probeChunkFrames,
  fileSystem = fs,
}) {
  try {
    const expectedFile = `${from}-${to}.mp4`;
    const expectedFrames = to - from + 1;
    const entry = manifest.chunks.find((chunk) => chunk.from === from && chunk.to === to);
    if (!entry || entry.status !== 'complete'
      || entry.file !== expectedFile
      || entry.frames !== expectedFrames
      || !Number.isSafeInteger(entry.size)
      || entry.size <= 1000
      || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      return false;
    }
    const part = path.join(hostPath(directory), expectedFile);
    if (!fileSystem.existsSync(part) || !fileSystem.statSync(part).isFile()) return false;
    const identity = fileIdentity(part, fileSystem);
    if (identity.size !== entry.size || identity.sha256 !== entry.sha256) return false;
    return probeFrames(part) === expectedFrames;
  } catch {
    return false;
  }
}

module.exports = {
  CACHE_VERSION,
  createRenderJob,
  fileIdentity,
  isReusableChunk,
  loadCacheManifest,
  probeChunkFrames,
  recordChunkComplete,
  writeManifestAtomic,
};
