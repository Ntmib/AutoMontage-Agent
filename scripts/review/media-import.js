const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { parseMediaProbeJson } = require('../media-probe');
const { inspectImportedAssetBundle } = require('./imported-assets');

const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const VIDEO_MAX_BYTES = 1024 * 1024 * 1024;
const DISK_RESERVE_BYTES = 512n * 1024n * 1024n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL = /\p{Cc}/u;
const IMAGE_TYPES = new Map([
  ['.avif', 'image/avif'],
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);
const VIDEO_TYPES = new Map([
  ['.mp4', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.m4v', 'video/x-m4v'],
  ['.webm', 'video/webm'],
]);

function mediaImportError(status, code, message = code, properties = {}) {
  return Object.assign(new Error(message), { status, code, ...properties });
}

function singleHeader(headers, name, code) {
  const matches = Object.entries(headers || {}).filter(([key]) => key.toLowerCase() === name);
  if (matches.length !== 1 || typeof matches[0][1] !== 'string') {
    throw mediaImportError(400, code);
  }
  return matches[0][1];
}

function parseImportHeaders(headers) {
  const lengthText = singleHeader(headers, 'content-length', 'MEDIA_IMPORT_LENGTH_INVALID');
  if (!/^[1-9][0-9]*$/.test(lengthText)) {
    throw mediaImportError(400, 'MEDIA_IMPORT_LENGTH_INVALID');
  }
  const lengthBigInt = BigInt(lengthText);
  if (lengthBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw mediaImportError(400, 'MEDIA_IMPORT_LENGTH_INVALID');
  }

  const encodedFilename = singleHeader(
    headers,
    'x-automontage-filename',
    'MEDIA_IMPORT_FILENAME_INVALID',
  );
  let decodedFilename;
  try {
    decodedFilename = decodeURIComponent(encodedFilename);
  } catch (_) {
    throw mediaImportError(400, 'MEDIA_IMPORT_FILENAME_INVALID');
  }
  const filename = decodedFilename.normalize('NFKC');
  const extension = path.posix.extname(filename).toLowerCase();
  const stem = filename.slice(0, -extension.length);
  if (!filename || encodeURIComponent(decodedFilename) !== encodedFilename
    || CONTROL.test(filename) || /[\\/]/.test(filename)
    || Buffer.byteLength(filename, 'utf8') > 255
    || !extension || !stem || stem.includes('.')) {
    throw mediaImportError(400, 'MEDIA_IMPORT_FILENAME_INVALID');
  }

  const imageType = IMAGE_TYPES.get(extension);
  const videoType = VIDEO_TYPES.get(extension);
  if (!imageType && !videoType) {
    throw mediaImportError(415, 'MEDIA_IMPORT_TYPE_UNSUPPORTED');
  }
  let contentType;
  try {
    contentType = singleHeader(headers, 'content-type', 'MEDIA_IMPORT_TYPE_UNSUPPORTED');
  } catch (error) {
    if (error.code === 'MEDIA_IMPORT_TYPE_UNSUPPORTED') error.status = 415;
    throw error;
  }
  const expectedType = imageType || videoType;
  if (contentType !== expectedType && contentType !== 'application/octet-stream') {
    throw mediaImportError(415, 'MEDIA_IMPORT_TYPE_UNSUPPORTED');
  }

  const mediaKind = imageType ? 'image' : 'video';
  const contentLength = Number(lengthBigInt);
  const limit = mediaKind === 'image' ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES;
  if (contentLength > limit) throw mediaImportError(413, 'MEDIA_IMPORT_TOO_LARGE');
  return { contentLength, contentType, extension, filename, mediaKind };
}

function requiredFreeBytes(contentLength) {
  return 4n * BigInt(contentLength) + DISK_RESERVE_BYTES;
}

function createImportController() {
  let busy = false;
  return {
    acquire() {
      if (busy) return false;
      busy = true;
      return true;
    },
    release() {
      busy = false;
    },
    get busy() {
      return busy;
    },
  };
}

function identity(stat) {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(stat, expected) {
  return stat && expected && stat.dev === expected.dev && stat.ino === expected.ino;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative));
}

function unsafeFilesystem() {
  return mediaImportError(500, 'MEDIA_IMPORT_FILESYSTEM_UNSAFE');
}

function ensureOwnedDirectories(fileSystem, projectDir, segments) {
  const resolvedProject = path.resolve(projectDir);
  let projectStat;
  let projectReal;
  try {
    projectStat = fileSystem.lstatSync(resolvedProject);
    if (!projectStat.isDirectory() || projectStat.isSymbolicLink()) throw unsafeFilesystem();
    projectReal = fileSystem.realpathSync(resolvedProject);
  } catch (error) {
    if (error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE') throw error;
    throw unsafeFilesystem();
  }
  const snapshots = new Map([[resolvedProject, identity(projectStat)]]);
  let current = resolvedProject;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      fileSystem.mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw unsafeFilesystem();
    }
    let stat;
    try {
      stat = fileSystem.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || !isInside(projectReal, fileSystem.realpathSync(current))) throw unsafeFilesystem();
    } catch (error) {
      if (error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE') throw error;
      throw unsafeFilesystem();
    }
    snapshots.set(current, identity(stat));
  }
  return { resolvedProject, projectReal, snapshots, directory: current };
}

function assertOwnedDirectory(fileSystem, directory, expected, projectReal) {
  try {
    const stat = fileSystem.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(stat, expected)
      || !isInside(projectReal, fileSystem.realpathSync(directory))) throw unsafeFilesystem();
  } catch (error) {
    if (error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE') throw error;
    throw unsafeFilesystem();
  }
}

function assertAbsent(fileSystem, target) {
  try {
    fileSystem.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw unsafeFilesystem();
  }
  throw unsafeFilesystem();
}

function createOwnedQuarantine(projectDir, id, mediaKind, fileSystem) {
  if (!UUID.test(id)) throw unsafeFilesystem();
  const quarantineParent = ensureOwnedDirectories(fileSystem, projectDir, ['tmp', 'review-imports']);
  const assetParent = ensureOwnedDirectories(fileSystem, projectDir, [
    'assets', 'broll', mediaKind === 'image' ? 'images' : 'video',
  ]);
  const previewParent = mediaKind === 'video'
    ? ensureOwnedDirectories(fileSystem, projectDir, ['previews', 'broll'])
    : null;
  const quarantinePath = path.join(quarantineParent.directory, id);
  let owned;
  let createdQuarantineIdentity = null;
  try {
    fileSystem.mkdirSync(quarantinePath, { mode: 0o700 });
    const quarantineStat = fileSystem.lstatSync(quarantinePath);
    createdQuarantineIdentity = identity(quarantineStat);
    fileSystem.chmodSync(quarantinePath, 0o700);
    if (!quarantineStat.isDirectory() || quarantineStat.isSymbolicLink()
      || (quarantineStat.mode & 0o777) !== 0o700) throw unsafeFilesystem();

    const bundlePath = path.join(quarantinePath, 'bundle');
    fileSystem.mkdirSync(bundlePath, { mode: 0o700 });
    fileSystem.chmodSync(bundlePath, 0o700);
    const bundleStat = fileSystem.lstatSync(bundlePath);
    if (!bundleStat.isDirectory() || bundleStat.isSymbolicLink()) throw unsafeFilesystem();

    const uploadPath = path.join(quarantinePath, 'upload.bin');
    const constants = fileSystem.constants || fs.constants;
    const uploadFd = fileSystem.openSync(
      uploadPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
      0o600,
    );
    fileSystem.fchmodSync(uploadFd, 0o600);
    const uploadStat = fileSystem.fstatSync(uploadFd);
    if (!uploadStat.isFile() || (uploadStat.mode & 0o777) !== 0o600) {
      fileSystem.closeSync(uploadFd);
      throw unsafeFilesystem();
    }
    owned = {
      id,
      projectDir: quarantineParent.resolvedProject,
      projectReal: quarantineParent.projectReal,
      quarantinePath,
      quarantineIdentity: identity(quarantineStat),
      bundlePath,
      bundleIdentity: identity(bundleStat),
      uploadPath,
      uploadFd,
      uploadIdentity: identity(uploadStat),
      assetParent: assetParent.directory,
      assetParentIdentity: assetParent.snapshots.get(assetParent.directory),
      previewParent: previewParent?.directory || null,
      previewParentIdentity: previewParent?.snapshots.get(previewParent.directory) || null,
      canonicalPath: path.join(bundlePath, mediaKind === 'image' ? 'media.webp' : 'media.mp4'),
      normalizedPreviewPath: mediaKind === 'video' ? path.join(quarantinePath, 'preview.webm') : null,
      metadataPath: path.join(bundlePath, 'asset.json'),
      assetStagePath: path.join(assetParent.directory, `.${id}.stage`),
      assetFinalPath: path.join(assetParent.directory, id),
      previewStagePath: previewParent ? path.join(previewParent.directory, `.${id}.stage.webm`) : null,
      previewFinalPath: previewParent ? path.join(previewParent.directory, `${id}.webm`) : null,
      published: false,
      publishedPreviewIdentity: null,
    };
    return owned;
  } catch (error) {
    if (owned?.uploadFd !== null && owned?.uploadFd !== undefined) {
      try { fileSystem.closeSync(owned.uploadFd); } catch (_) { /* owned cleanup only */ }
    }
    try {
      const current = fileSystem.lstatSync(quarantinePath);
      if (current.isDirectory() && !current.isSymbolicLink()
        && sameIdentity(current, createdQuarantineIdentity)) {
        fileSystem.rmSync(quarantinePath, { recursive: true, force: false });
      }
    } catch (_) { /* refuse broader cleanup */ }
    throw error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE' ? error : unsafeFilesystem();
  }
}

function assertOwnedImport(fileSystem, owned) {
  assertOwnedDirectory(
    fileSystem,
    owned.quarantinePath,
    owned.quarantineIdentity,
    owned.projectReal,
  );
  assertOwnedDirectory(fileSystem, owned.bundlePath, owned.bundleIdentity, owned.projectReal);
  assertOwnedDirectory(fileSystem, owned.assetParent, owned.assetParentIdentity, owned.projectReal);
  if (owned.previewParent) {
    assertOwnedDirectory(
      fileSystem,
      owned.previewParent,
      owned.previewParentIdentity,
      owned.projectReal,
    );
  }
}

function assertOwnedFile(fileSystem, filePath, expected) {
  try {
    const stat = fileSystem.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || !sameIdentity(stat, expected)) {
      throw unsafeFilesystem();
    }
  } catch (error) {
    if (error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE') throw error;
    throw unsafeFilesystem();
  }
}

async function streamExactBody(request, owned, expectedBytes, signal, fileSystem) {
  const abortError = () => mediaImportError(499, 'MEDIA_IMPORT_ABORTED');
  if (signal?.aborted) throw abortError();
  const onAbort = () => request.destroy?.(abortError());
  signal?.addEventListener('abort', onAbort, { once: true });
  let total = 0;
  try {
    for await (const value of request) {
      if (signal?.aborted) throw abortError();
      const chunk = Buffer.from(value);
      if (total + chunk.length > expectedBytes) {
        throw mediaImportError(400, 'MEDIA_IMPORT_LENGTH_MISMATCH');
      }
      let offset = 0;
      while (offset < chunk.length) {
        const written = fileSystem.writeSync(
          owned.uploadFd,
          chunk,
          offset,
          chunk.length - offset,
        );
        if (!Number.isSafeInteger(written) || written <= 0) throw unsafeFilesystem();
        offset += written;
      }
      total += chunk.length;
    }
    if (signal?.aborted) throw abortError();
    if (total !== expectedBytes) throw mediaImportError(400, 'MEDIA_IMPORT_LENGTH_MISMATCH');
    fileSystem.fsyncSync(owned.uploadFd);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (owned.uploadFd !== null) {
      fileSystem.closeSync(owned.uploadFd);
      owned.uploadFd = null;
    }
  }
}

function buildProbeInvocation(inputPath, signal) {
  return {
    command: 'ffprobe',
    args: [
      '-v', 'error',
      '-show_entries',
      'stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,duration,pix_fmt,sample_rate,channels:stream_tags=rotate:stream_disposition=attached_pic:stream_side_data=rotation:format=format_name,duration',
      '-of', 'json',
      inputPath,
    ],
    cwd: path.dirname(inputPath),
    signal,
    timeoutMs: 30_000,
    maxStdoutBytes: 1024 * 1024,
    maxStderrBytes: 1024 * 1024,
  };
}

function assertMediaLimits(source, expectedKind) {
  if (source.mediaKind !== expectedKind) {
    throw mediaImportError(422, 'MEDIA_IMPORT_CONTENT_MISMATCH');
  }
  const maxDimension = expectedKind === 'image' ? 12_000 : 4_096;
  const maxPixels = expectedKind === 'image' ? 100_000_000 : 8_847_360;
  if (source.width > maxDimension || source.height > maxDimension
    || source.width * source.height > maxPixels) {
    throw mediaImportError(422, 'MEDIA_IMPORT_GEOMETRY_UNSUPPORTED');
  }
  if (expectedKind === 'video' && source.durationSec > 1_800) {
    throw mediaImportError(422, 'MEDIA_IMPORT_DURATION_UNSUPPORTED');
  }
}

function imageInvocation(owned, signal) {
  return {
    command: 'ffmpeg',
    args: [
      '-hide_banner', '-loglevel', 'error', '-autorotate', '-i', owned.uploadPath,
      '-map', '0:v:0', '-map_metadata', '-1', '-frames:v', '1',
      '-vf', 'format=rgba', '-c:v', 'libwebp', '-quality', '90', '-pix_fmt', 'yuva420p',
      owned.canonicalPath,
    ],
    cwd: owned.quarantinePath,
    signal,
    timeoutMs: 10 * 60_000,
    maxStdoutBytes: 1024 * 1024,
    maxStderrBytes: 4 * 1024 * 1024,
  };
}

function videoMasterInvocation(owned, source, outputFps, signal) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-autorotate', '-i', owned.uploadPath,
    '-map', '0:v:0',
  ];
  if (source.hasAudio) args.push('-map', '0:a:0');
  args.push(
    '-map_metadata', '-1', '-metadata:s:v:0', 'rotate=0',
    '-vf', `fps=${outputFps}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-crf', '18', '-preset', 'medium',
  );
  if (source.hasAudio) {
    args.push('-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '160k');
  } else {
    args.push('-an');
  }
  args.push('-movflags', '+faststart', owned.canonicalPath);
  return {
    command: 'ffmpeg', args, cwd: owned.quarantinePath, signal,
    timeoutMs: 2 * 60 * 60_000,
    maxStdoutBytes: 1024 * 1024,
    maxStderrBytes: 4 * 1024 * 1024,
  };
}

function videoProxyInvocation(owned, source, outputFps, signal) {
  const proxyFps = Math.min(30, outputFps);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-i', owned.canonicalPath,
    '-map', '0:v:0',
  ];
  if (source.hasAudio) args.push('-map', '0:a:0');
  args.push(
    '-map_metadata', '-1',
    '-vf', `scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=${proxyFps}`,
    '-c:v', 'libvpx', '-crf', '32', '-b:v', '0',
  );
  if (source.hasAudio) {
    args.push('-c:a', 'libopus', '-ar', '48000', '-ac', '2', '-b:a', '96k');
  } else {
    args.push('-an');
  }
  args.push(owned.normalizedPreviewPath);
  return {
    command: 'ffmpeg', args, cwd: owned.quarantinePath, signal,
    timeoutMs: 2 * 60 * 60_000,
    maxStdoutBytes: 1024 * 1024,
    maxStderrBytes: 4 * 1024 * 1024,
  };
}

function decodeInvocation(inputPath, signal) {
  return {
    command: 'ffmpeg',
    args: ['-hide_banner', '-loglevel', 'error', '-i', inputPath, '-f', 'null', '-'],
    cwd: path.dirname(inputPath),
    signal,
    timeoutMs: 2 * 60 * 60_000,
    maxStdoutBytes: 1024 * 1024,
    maxStderrBytes: 4 * 1024 * 1024,
  };
}

function assertRegularOutput(fileSystem, filePath) {
  try {
    const stat = fileSystem.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw unsafeFilesystem();
  } catch (error) {
    if (error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE') throw error;
    throw mediaImportError(422, 'MEDIA_IMPORT_OUTPUT_INVALID');
  }
}

async function normalizeIntoQuarantine({ source, outputFps, owned, signal, fileSystem, run }) {
  if (!Number.isFinite(outputFps) || outputFps <= 0 || outputFps > 120) {
    throw mediaImportError(500, 'MEDIA_IMPORT_OUTPUT_FPS_INVALID');
  }
  assertOwnedImport(fileSystem, owned);
  if (source.mediaKind === 'image') {
    await run(imageInvocation(owned, signal));
  } else {
    await run(videoMasterInvocation(owned, source, outputFps, signal));
    assertOwnedImport(fileSystem, owned);
    assertRegularOutput(fileSystem, owned.canonicalPath);
    await run(videoProxyInvocation(owned, source, outputFps, signal));
  }
  assertOwnedImport(fileSystem, owned);
  assertRegularOutput(fileSystem, owned.canonicalPath);
  if (owned.normalizedPreviewPath) assertRegularOutput(fileSystem, owned.normalizedPreviewPath);
}

async function verifyNormalizedOutputs({ source, outputFps, owned, signal, fileSystem, run }) {
  const masterProbe = await run(buildProbeInvocation(owned.canonicalPath, signal));
  const master = parseMediaProbeJson(masterProbe.stdout);
  const swapsAxes = source.rotation === 90 || source.rotation === 270;
  const expectedWidth = swapsAxes ? source.height : source.width;
  const expectedHeight = swapsAxes ? source.width : source.height;
  if (master.mediaKind !== source.mediaKind || master.rotation !== 0
    || master.width !== expectedWidth || master.height !== expectedHeight) {
    throw mediaImportError(422, 'MEDIA_IMPORT_OUTPUT_INVALID');
  }
  await run(decodeInvocation(owned.canonicalPath, signal));
  if (source.mediaKind === 'video') {
    if (Math.abs(master.fps - outputFps) > 1e-6 || master.hasAudio !== source.hasAudio) {
      throw mediaImportError(422, 'MEDIA_IMPORT_OUTPUT_INVALID');
    }
    const previewProbe = await run(buildProbeInvocation(owned.normalizedPreviewPath, signal));
    const preview = parseMediaProbeJson(previewProbe.stdout);
    const durationTolerance = 1 / master.fps;
    const aspectError = Math.abs(
      preview.width * master.height - preview.height * master.width,
    );
    if (preview.mediaKind !== 'video' || preview.width > 1280 || preview.height > 1280
      || Math.abs(preview.fps - Math.min(30, outputFps)) > 1e-6
      || preview.hasAudio !== master.hasAudio
      || aspectError > Math.max(master.width, master.height)
      || Math.abs(preview.durationSec - master.durationSec) > durationTolerance + 0.001) {
      throw mediaImportError(422, 'MEDIA_IMPORT_OUTPUT_INVALID');
    }
    await run(decodeInvocation(owned.normalizedPreviewPath, signal));
  }
  assertOwnedImport(fileSystem, owned);
  return master;
}

function hashOpenedFile(fileSystem, filePath) {
  const constants = fileSystem.constants || fs.constants;
  let descriptor = null;
  try {
    descriptor = fileSystem.openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = fileSystem.fstatSync(descriptor);
    if (!stat.isFile()) throw unsafeFilesystem();
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytesRead;
    do {
      bytesRead = fileSystem.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
    return hash.digest('hex');
  } finally {
    if (descriptor !== null) fileSystem.closeSync(descriptor);
  }
}

function writeExclusive(fileSystem, filePath, bytes) {
  const constants = fileSystem.constants || fs.constants;
  let descriptor = null;
  try {
    descriptor = fileSystem.openSync(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
      0o600,
    );
    fileSystem.fchmodSync(descriptor, 0o600);
    const buffer = Buffer.from(bytes);
    let offset = 0;
    while (offset < buffer.length) {
      const written = fileSystem.writeSync(descriptor, buffer, offset, buffer.length - offset);
      if (written <= 0) throw unsafeFilesystem();
      offset += written;
    }
    fileSystem.fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) fileSystem.closeSync(descriptor);
  }
}

function buildCanonicalMetadata(owned, headers, master, fileSystem) {
  const canonicalSha256 = hashOpenedFile(fileSystem, owned.canonicalPath);
  const previewSha256 = owned.normalizedPreviewPath
    ? hashOpenedFile(fileSystem, owned.normalizedPreviewPath)
    : null;
  const metadata = {
    version: 1,
    id: owned.id,
    label: headers.filename,
    mediaKind: headers.mediaKind,
    canonicalSha256,
    previewSha256,
    width: master.width,
    height: master.height,
    fps: headers.mediaKind === 'image' ? 0 : master.fps,
    durationSec: headers.mediaKind === 'image' ? 0 : master.durationSec,
    hasAudio: headers.mediaKind === 'image' ? false : master.hasAudio,
  };
  writeExclusive(fileSystem, owned.metadataPath, `${JSON.stringify(metadata)}\n`);
  return metadata;
}

function removeIfOwnedFile(fileSystem, target, expected) {
  if (!target || !expected) return;
  try {
    const stat = fileSystem.lstatSync(target);
    if (stat.isFile() && !stat.isSymbolicLink() && sameIdentity(stat, expected)) {
      fileSystem.unlinkSync(target);
    }
  } catch (_) { /* never broaden cleanup after a race */ }
}

function publishImportedBundle({ owned, fileSystem }) {
  assertOwnedImport(fileSystem, owned);
  for (const target of [
    owned.assetStagePath,
    owned.assetFinalPath,
    owned.previewStagePath,
    owned.previewFinalPath,
  ].filter(Boolean)) assertAbsent(fileSystem, target);

  fileSystem.renameSync(owned.bundlePath, owned.assetStagePath);
  const assetStageStat = fileSystem.lstatSync(owned.assetStagePath);
  if (!assetStageStat.isDirectory() || assetStageStat.isSymbolicLink()) throw unsafeFilesystem();
  owned.assetStageIdentity = identity(assetStageStat);

  if (owned.normalizedPreviewPath) {
    fileSystem.renameSync(owned.normalizedPreviewPath, owned.previewStagePath);
    const previewStageStat = fileSystem.lstatSync(owned.previewStagePath);
    if (!previewStageStat.isFile() || previewStageStat.isSymbolicLink()) throw unsafeFilesystem();
    owned.publishedPreviewIdentity = identity(previewStageStat);
    fileSystem.renameSync(owned.previewStagePath, owned.previewFinalPath);
    const previewFinalStat = fileSystem.lstatSync(owned.previewFinalPath);
    if (!previewFinalStat.isFile() || previewFinalStat.isSymbolicLink()
      || !sameIdentity(previewFinalStat, owned.publishedPreviewIdentity)) throw unsafeFilesystem();
  }

  try {
    assertOwnedDirectory(fileSystem, owned.assetParent, owned.assetParentIdentity, owned.projectReal);
    fileSystem.renameSync(owned.assetStagePath, owned.assetFinalPath);
  } catch (error) {
    removeIfOwnedFile(
      fileSystem,
      owned.previewFinalPath,
      owned.publishedPreviewIdentity,
    );
    throw error;
  }
  const assetFinalStat = fileSystem.lstatSync(owned.assetFinalPath);
  if (!assetFinalStat.isDirectory() || assetFinalStat.isSymbolicLink()
    || !sameIdentity(assetFinalStat, owned.assetStageIdentity)) throw unsafeFilesystem();
  owned.published = true;

  const record = inspectImportedAssetBundle({
    projectDir: owned.projectDir,
    assetDirectory: owned.assetFinalPath,
    fileSystem,
  });
  if (!record) throw mediaImportError(500, 'MEDIA_IMPORT_PUBLICATION_INVALID');
  return record;
}

function cleanupOwnedImport(owned, fileSystem) {
  if (!owned) return;
  if (owned.uploadFd !== null) {
    try { fileSystem.closeSync(owned.uploadFd); } catch (_) { /* owned descriptor */ }
    owned.uploadFd = null;
  }
  if (!owned.published) {
    removeIfOwnedFile(fileSystem, owned.previewFinalPath, owned.publishedPreviewIdentity);
  }
  try {
    const stat = fileSystem.lstatSync(owned.quarantinePath);
    if (stat.isDirectory() && !stat.isSymbolicLink()
      && sameIdentity(stat, owned.quarantineIdentity)) {
      fileSystem.rmSync(owned.quarantinePath, { recursive: true, force: false });
    }
  } catch (_) { /* an identity race leaves the UUID-owned remnant for startup cleanup */ }
  if (!owned.published && owned.assetStageIdentity) {
    try {
      const stat = fileSystem.lstatSync(owned.assetStagePath);
      if (stat.isDirectory() && !stat.isSymbolicLink()
        && sameIdentity(stat, owned.assetStageIdentity)) {
        fileSystem.rmSync(owned.assetStagePath, { recursive: true, force: false });
      }
    } catch (_) { /* refuse broad cleanup */ }
  }
  if (owned.previewStagePath) {
    try {
      const stat = fileSystem.lstatSync(owned.previewStagePath);
      if (stat.isFile() && !stat.isSymbolicLink()) fileSystem.unlinkSync(owned.previewStagePath);
    } catch (_) { /* refuse broad cleanup */ }
  }
}

async function importReviewMedia({
  request,
  signal,
  projectDir,
  outputFps,
  headers,
  controller,
  fileSystem = fs,
  runMediaProcessImpl,
  statfsImpl = fs.statfsSync,
  randomId = crypto.randomUUID,
}) {
  if (!controller?.acquire()) throw mediaImportError(409, 'MEDIA_IMPORT_BUSY');
  let owned;
  try {
    const parsedHeaders = parseImportHeaders(headers);
    let filesystemStats;
    try {
      filesystemStats = statfsImpl(projectDir);
    } catch (_) {
      throw unsafeFilesystem();
    }
    const availableBytes = BigInt(filesystemStats.bavail) * BigInt(filesystemStats.bsize);
    if (availableBytes < requiredFreeBytes(parsedHeaders.contentLength)) {
      throw mediaImportError(507, 'MEDIA_IMPORT_DISK_FULL');
    }
    owned = createOwnedQuarantine(projectDir, randomId(), parsedHeaders.mediaKind, fileSystem);
    await streamExactBody(request, owned, parsedHeaders.contentLength, signal, fileSystem);
    assertOwnedFile(fileSystem, owned.uploadPath, owned.uploadIdentity);

    let source;
    try {
      const probeOutput = await runMediaProcessImpl(buildProbeInvocation(owned.uploadPath, signal));
      assertOwnedFile(fileSystem, owned.uploadPath, owned.uploadIdentity);
      source = parseMediaProbeJson(probeOutput.stdout);
    } catch (error) {
      if (error.status || error.code === 'MEDIA_PROCESS_ABORTED') throw error;
      throw mediaImportError(422, 'MEDIA_IMPORT_DECODE_FAILED', 'media decode failed', { cause: error });
    }
    assertMediaLimits(source, parsedHeaders.mediaKind);
    try {
      await normalizeIntoQuarantine({
        source, outputFps, owned, signal, fileSystem, run: runMediaProcessImpl,
      });
      const master = await verifyNormalizedOutputs({
        source, outputFps, owned, signal, fileSystem, run: runMediaProcessImpl,
      });
      buildCanonicalMetadata(owned, parsedHeaders, master, fileSystem);
    } catch (error) {
      if (error.status || error.code === 'MEDIA_PROCESS_ABORTED') throw error;
      throw mediaImportError(422, 'MEDIA_IMPORT_NORMALIZATION_FAILED', 'media normalization failed', { cause: error });
    }
    return publishImportedBundle({ owned, fileSystem });
  } finally {
    cleanupOwnedImport(owned, fileSystem);
    controller.release();
  }
}

module.exports = {
  IMAGE_MAX_BYTES,
  VIDEO_MAX_BYTES,
  createImportController,
  importReviewMedia,
  mediaImportError,
  parseImportHeaders,
  requiredFreeBytes,
};
