const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseMediaProbeJson } = require('../media-probe');
const {
  buildImportedAssetRecord,
  buildImportedPublicationClaim,
  cleanupOrphanImportedStages,
  verifyImportedAssetFiles,
} = require('./imported-assets');
const { acquireProjectMutationLease } = require('../project/workspace');

const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const VIDEO_MAX_BYTES = 1024 * 1024 * 1024;
const DISK_RESERVE_BYTES = 512n * 1024n * 1024n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL = /\p{Cc}/u;
const OWNER_PURPOSE = 'review-media-import-owner';
const OWNER_MAX_BYTES = 64 * 1024;
const OWNER_RECORD_KEYS = [
  'version', 'purpose', 'id', 'hostname', 'pid', 'token', 'quarantine', 'bundle',
  'upload', 'canonical', 'preview', 'claim', 'previewStage', 'previewFinal',
  'assetDirectory', 'canonicalFinal', 'metadataFinal', 'committed',
];
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

function openedFileIdentity(stat, nanosecondStat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: nanosecondStat.mtimeNs,
  };
}

function persistedFileIdentity(value) {
  return value ? {
    dev: String(value.dev), ino: String(value.ino), size: String(value.size),
    mtimeNs: String(value.mtimeNs),
  } : null;
}

function persistedDirectoryIdentity(value) {
  return value ? { dev: String(value.dev), ino: String(value.ino) } : null;
}

function ownerRecord(owned) {
  return {
    version: 1,
    purpose: OWNER_PURPOSE,
    id: owned.id,
    hostname: owned.ownerHostname,
    pid: owned.ownerPid,
    token: owned.ownerToken,
    quarantine: persistedDirectoryIdentity(owned.quarantineIdentity),
    bundle: persistedDirectoryIdentity(owned.bundleIdentity),
    upload: persistedFileIdentity(owned.uploadIdentity),
    canonical: persistedFileIdentity(owned.canonicalIdentity),
    preview: persistedFileIdentity(owned.previewIdentity),
    claim: persistedFileIdentity(owned.claimIdentity),
    previewStage: persistedFileIdentity(owned.previewStageIdentity),
    previewFinal: persistedFileIdentity(owned.publishedPreviewIdentity),
    assetDirectory: persistedDirectoryIdentity(owned.assetFinalIdentity),
    canonicalFinal: persistedFileIdentity(owned.canonicalFinalIdentity),
    metadataFinal: persistedFileIdentity(owned.metadataFinalIdentity),
    committed: owned.published === true,
  };
}

function appendOwnerRecord(owned, fileSystem) {
  if (owned.ownerFd === null || owned.ownerFd === undefined) throw unsafeFilesystem();
  const bytes = Buffer.from(`${JSON.stringify(ownerRecord(owned))}\n`);
  let offset = 0;
  while (offset < bytes.length) {
    const written = fileSystem.writeSync(
      owned.ownerFd, bytes, offset, bytes.length - offset, null,
    );
    if (!Number.isSafeInteger(written) || written <= 0) throw unsafeFilesystem();
    offset += written;
  }
  fileSystem.fsyncSync(owned.ownerFd);
}

function createOwnedOutputPlaceholder(fileSystem, filePath) {
  const constants = fileSystem.constants || fs.constants;
  const descriptor = fileSystem.openSync(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    fileSystem.fchmodSync(descriptor, 0o600);
    fileSystem.fsyncSync(descriptor);
    return openedFileIdentity(
      fileSystem.fstatSync(descriptor),
      fileSystem.fstatSync(descriptor, { bigint: true }),
    );
  } finally {
    fileSystem.closeSync(descriptor);
  }
}

function sameFileIdentity(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeNs === right.mtimeNs;
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
    let created = false;
    try {
      fileSystem.mkdirSync(current, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw unsafeFilesystem();
    }
    let stat;
    try {
      if (created) fileSystem.chmodSync(current, 0o700);
      stat = fileSystem.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || (created && (stat.mode & 0o777) !== 0o700)
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

function createOwnedQuarantine(projectDir, id, mediaKind, fileSystem, lease) {
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
    fileSystem.chmodSync(quarantinePath, 0o700);
    const quarantineStat = fileSystem.lstatSync(quarantinePath);
    createdQuarantineIdentity = identity(quarantineStat);
    if (!quarantineStat.isDirectory() || quarantineStat.isSymbolicLink()
      || (quarantineStat.mode & 0o777) !== 0o700) throw unsafeFilesystem();

    const bundlePath = path.join(quarantinePath, 'bundle');
    fileSystem.mkdirSync(bundlePath, { mode: 0o700 });
    fileSystem.chmodSync(bundlePath, 0o700);
    const bundleStat = fileSystem.lstatSync(bundlePath);
    if (!bundleStat.isDirectory() || bundleStat.isSymbolicLink()
      || (bundleStat.mode & 0o777) !== 0o700) throw unsafeFilesystem();

    const uploadPath = path.join(quarantinePath, 'upload.bin');
    const constants = fileSystem.constants || fs.constants;
    const uploadFd = fileSystem.openSync(
      uploadPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
      0o600,
    );
    fileSystem.fchmodSync(uploadFd, 0o600);
    const uploadStat = fileSystem.fstatSync(uploadFd);
    const uploadNanosecondStat = fileSystem.fstatSync(uploadFd, { bigint: true });
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
      uploadIdentity: openedFileIdentity(uploadStat, uploadNanosecondStat),
      assetParent: assetParent.directory,
      assetParentIdentity: assetParent.snapshots.get(assetParent.directory),
      claimPath: path.join(assetParent.directory, `.${id}.claim`),
      claimFd: null,
      claimIdentity: null,
      previewParent: previewParent?.directory || null,
      previewParentIdentity: previewParent?.snapshots.get(previewParent.directory) || null,
      canonicalPath: path.join(bundlePath, mediaKind === 'image' ? 'media.webp' : 'media.mp4'),
      normalizedPreviewPath: mediaKind === 'video' ? path.join(quarantinePath, 'preview.webm') : null,
      assetFinalPath: path.join(assetParent.directory, id),
      previewStagePath: previewParent ? path.join(previewParent.directory, `.${id}.stage.webm`) : null,
      previewFinalPath: previewParent ? path.join(previewParent.directory, `${id}.webm`) : null,
      published: false,
      publishedPreviewIdentity: null,
      ownerHostname: lease.owner.hostname,
      ownerPid: lease.owner.pid,
      ownerToken: lease.owner.token,
      ownerPath: path.join(quarantinePath, 'owner.jsonl'),
      ownerAnchorPath: path.join(quarantinePath, 'owner.anchor'),
      ownerFd: null,
    };
    owned.ownerFd = fileSystem.openSync(
      owned.ownerPath,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL
        | (constants.O_NOFOLLOW || 0),
      0o600,
    );
    fileSystem.fchmodSync(owned.ownerFd, 0o600);
    owned.ownerIdentity = identity(fileSystem.fstatSync(owned.ownerFd));
    fileSystem.linkSync(owned.ownerPath, owned.ownerAnchorPath);
    owned.canonicalIdentity = createOwnedOutputPlaceholder(
      fileSystem, owned.canonicalPath,
    );
    if (owned.normalizedPreviewPath) {
      owned.previewIdentity = createOwnedOutputPlaceholder(
        fileSystem, owned.normalizedPreviewPath,
      );
    }
    appendOwnerRecord(owned, fileSystem);
    fsyncDirectoryIfSupported(fileSystem, quarantinePath);
    return owned;
  } catch (error) {
    if (owned?.uploadFd !== null && owned?.uploadFd !== undefined) {
      try { fileSystem.closeSync(owned.uploadFd); } catch (_) { /* owned cleanup only */ }
    }
    if (owned?.ownerFd !== null && owned?.ownerFd !== undefined) {
      try { fileSystem.closeSync(owned.ownerFd); } catch (_) { /* owned descriptor */ }
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
    const nanosecondStat = fileSystem.lstatSync(filePath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()
      || !sameFileIdentity(openedFileIdentity(stat, nanosecondStat), expected)) {
      throw unsafeFilesystem();
    }
  } catch (error) {
    if (error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE') throw error;
    throw unsafeFilesystem();
  }
}

function captureOwnedFile(fileSystem, filePath, { chmod = false } = {}) {
  try {
    if (chmod) fileSystem.chmodSync(filePath, 0o600);
    const stat = fileSystem.lstatSync(filePath);
    const nanosecondStat = fileSystem.lstatSync(filePath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0
      || (chmod && (stat.mode & 0o777) !== 0o600)) throw unsafeFilesystem();
    return openedFileIdentity(stat, nanosecondStat);
  } catch (error) {
    if (error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE') throw error;
    throw mediaImportError(422, 'MEDIA_IMPORT_OUTPUT_INVALID');
  }
}

function assertOutputIdentities(fileSystem, owned) {
  if (owned.canonicalIdentity) {
    assertOwnedFile(fileSystem, owned.canonicalPath, owned.canonicalIdentity);
  }
  if (owned.previewIdentity) {
    assertOwnedFile(fileSystem, owned.normalizedPreviewPath, owned.previewIdentity);
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
    owned.uploadIdentity = openedFileIdentity(
      fileSystem.fstatSync(owned.uploadFd),
      fileSystem.fstatSync(owned.uploadFd, { bigint: true }),
    );
    appendOwnerRecord(owned, fileSystem);
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
      'stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,duration,pix_fmt,sample_rate,channels:stream_tags=rotate:stream_disposition=attached_pic:stream_side_data=rotation:format=format_name,duration:format_tags=major_brand,compatible_brands',
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

function sourceMatchesExtension(source, extension) {
  const imageCodecs = {
    '.avif': new Set(['av1', 'avif']),
    '.gif': new Set(['gif']),
    '.jpeg': new Set(['mjpeg']),
    '.jpg': new Set(['mjpeg']),
    '.png': new Set(['png']),
    '.webp': new Set(['webp']),
  };
  if (imageCodecs[extension]) return imageCodecs[extension].has(source.videoCodec);
  const containers = new Set(String(source.container || '').split(','));
  if (extension === '.webm') return containers.has('webm');
  return ['.mp4', '.mov', '.m4v'].includes(extension)
    && (containers.has('mov') || containers.has('mp4'));
}

function assertMediaLimits(source, headers) {
  const expectedKind = headers.mediaKind;
  if (source.mediaKind !== expectedKind || !sourceMatchesExtension(source, headers.extension)) {
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
      '-y', owned.canonicalPath,
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
  args.push('-movflags', '+faststart', '-y', owned.canonicalPath);
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
  args.push('-y', owned.normalizedPreviewPath);
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

async function normalizeIntoQuarantine({ source, outputFps, owned, signal, fileSystem, run }) {
  if (!Number.isFinite(outputFps) || outputFps <= 0 || outputFps > 120) {
    throw mediaImportError(500, 'MEDIA_IMPORT_OUTPUT_FPS_INVALID');
  }
  assertOwnedImport(fileSystem, owned);
  if (source.mediaKind === 'image') {
    await run(imageInvocation(owned, signal));
    assertOwnedImport(fileSystem, owned);
    owned.canonicalIdentity = captureOwnedFile(fileSystem, owned.canonicalPath, { chmod: true });
    appendOwnerRecord(owned, fileSystem);
  } else {
    await run(videoMasterInvocation(owned, source, outputFps, signal));
    assertOwnedImport(fileSystem, owned);
    owned.canonicalIdentity = captureOwnedFile(fileSystem, owned.canonicalPath, { chmod: true });
    appendOwnerRecord(owned, fileSystem);
    assertOutputIdentities(fileSystem, owned);
    await run(videoProxyInvocation(owned, source, outputFps, signal));
    assertOwnedFile(fileSystem, owned.canonicalPath, owned.canonicalIdentity);
    owned.previewIdentity = captureOwnedFile(
      fileSystem,
      owned.normalizedPreviewPath,
      { chmod: true },
    );
    appendOwnerRecord(owned, fileSystem);
  }
  assertOwnedImport(fileSystem, owned);
  assertOutputIdentities(fileSystem, owned);
}

async function verifyNormalizedOutputs({ source, outputFps, owned, signal, fileSystem, run }) {
  assertOutputIdentities(fileSystem, owned);
  const masterProbe = await run(buildProbeInvocation(owned.canonicalPath, signal));
  assertOutputIdentities(fileSystem, owned);
  const master = parseMediaProbeJson(masterProbe.stdout);
  const swapsAxes = source.rotation === 90 || source.rotation === 270;
  const expectedWidth = swapsAxes ? source.height : source.width;
  const expectedHeight = swapsAxes ? source.width : source.height;
  if (master.mediaKind !== source.mediaKind || master.rotation !== 0
    || master.width !== expectedWidth || master.height !== expectedHeight) {
    throw mediaImportError(422, 'MEDIA_IMPORT_OUTPUT_INVALID');
  }
  if (source.mediaKind === 'image' && (master.videoCodec !== 'webp'
    || !String(master.container).split(',').includes('webp_pipe')
    || (source.hasAlpha && !master.hasAlpha))) {
    throw mediaImportError(422, 'MEDIA_IMPORT_OUTPUT_INVALID');
  }
  assertOutputIdentities(fileSystem, owned);
  await run(decodeInvocation(owned.canonicalPath, signal));
  assertOutputIdentities(fileSystem, owned);
  if (source.mediaKind === 'video') {
    const expectedMasterAudio = !source.hasAudio || (
      master.audioCodec === 'aac' && master.audioSampleRate === 48_000
      && master.audioChannels === 2
    );
    if (master.videoCodec !== 'h264' || master.pixelFormat !== 'yuv420p'
      || Math.abs(master.fps - outputFps) > 1e-6 || master.hasAudio !== source.hasAudio
      || !expectedMasterAudio
      || Math.abs(master.durationSec - source.durationSec) > (1 / outputFps) + 0.001) {
      throw mediaImportError(422, 'MEDIA_IMPORT_OUTPUT_INVALID');
    }
    assertOutputIdentities(fileSystem, owned);
    const previewProbe = await run(buildProbeInvocation(owned.normalizedPreviewPath, signal));
    assertOutputIdentities(fileSystem, owned);
    const preview = parseMediaProbeJson(previewProbe.stdout);
    const durationTolerance = 1 / master.fps;
    const aspectError = Math.abs(
      preview.width * master.height - preview.height * master.width,
    );
    const expectedPreviewAudio = !source.hasAudio || (
      preview.audioCodec === 'opus' && preview.audioSampleRate === 48_000
      && preview.audioChannels === 2
    );
    if (preview.mediaKind !== 'video' || preview.videoCodec !== 'vp8'
      || preview.width > 1280 || preview.height > 1280
      || Math.abs(preview.fps - Math.min(30, outputFps)) > 1e-6
      || preview.hasAudio !== master.hasAudio
      || !expectedPreviewAudio
      || aspectError > Math.max(master.width, master.height)
      || Math.abs(preview.durationSec - master.durationSec) > durationTolerance + 0.001) {
      throw mediaImportError(422, 'MEDIA_IMPORT_OUTPUT_INVALID');
    }
    assertOutputIdentities(fileSystem, owned);
    await run(decodeInvocation(owned.normalizedPreviewPath, signal));
    assertOutputIdentities(fileSystem, owned);
  }
  assertOwnedImport(fileSystem, owned);
  return master;
}

function hashOpenedFile(fileSystem, filePath, expectedIdentity) {
  const constants = fileSystem.constants || fs.constants;
  let descriptor = null;
  try {
    descriptor = fileSystem.openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = fileSystem.fstatSync(descriptor);
    const nanosecondStat = fileSystem.fstatSync(descriptor, { bigint: true });
    const before = openedFileIdentity(stat, nanosecondStat);
    if (!stat.isFile() || !sameFileIdentity(before, expectedIdentity)) throw unsafeFilesystem();
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytesRead;
    do {
      bytesRead = fileSystem.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
    const after = openedFileIdentity(
      fileSystem.fstatSync(descriptor),
      fileSystem.fstatSync(descriptor, { bigint: true }),
    );
    if (!sameFileIdentity(before, after)) throw unsafeFilesystem();
    return hash.digest('hex');
  } finally {
    if (descriptor !== null) fileSystem.closeSync(descriptor);
  }
}

function writeExclusive(fileSystem, filePath, bytes, onOwned = () => {}) {
  const constants = fileSystem.constants || fs.constants;
  let descriptor = null;
  try {
    descriptor = fileSystem.openSync(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
      0o600,
    );
    fileSystem.fchmodSync(descriptor, 0o600);
    onOwned(identity(fileSystem.fstatSync(descriptor)));
    const buffer = Buffer.from(bytes);
    let offset = 0;
    while (offset < buffer.length) {
      const written = fileSystem.writeSync(descriptor, buffer, offset, buffer.length - offset);
      if (written <= 0) throw unsafeFilesystem();
      offset += written;
    }
    fileSystem.fsyncSync(descriptor);
    const stat = fileSystem.fstatSync(descriptor);
    const nanosecondStat = fileSystem.fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw unsafeFilesystem();
    return openedFileIdentity(stat, nanosecondStat);
  } finally {
    if (descriptor !== null) fileSystem.closeSync(descriptor);
  }
}

function writePublicationClaimState(owned, fileSystem) {
  const claim = buildImportedPublicationClaim({
    id: owned.id,
    mediaKind: owned.normalizedPreviewPath ? 'video' : 'image',
    directory: owned.assetFinalIdentity,
    canonical: owned.canonicalFinalIdentity,
    preview: owned.publishedPreviewIdentity,
  });
  if (!claim || owned.claimFd === null) throw unsafeFilesystem();
  const bytes = Buffer.from(`${JSON.stringify(claim)}\n`);
  const before = fileSystem.fstatSync(owned.claimFd);
  let offset = 0;
  while (offset < bytes.length) {
    const written = fileSystem.writeSync(
      owned.claimFd,
      bytes,
      offset,
      bytes.length - offset,
      null,
    );
    if (!Number.isSafeInteger(written) || written <= 0) throw unsafeFilesystem();
    offset += written;
  }
  fileSystem.fsyncSync(owned.claimFd);
  const stat = fileSystem.fstatSync(owned.claimFd);
  const nanosecondStat = fileSystem.fstatSync(owned.claimFd, { bigint: true });
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600
    || stat.size !== before.size + bytes.length) {
    throw unsafeFilesystem();
  }
  owned.claimIdentity = openedFileIdentity(stat, nanosecondStat);
  assertOwnedFile(fileSystem, owned.claimPath, owned.claimIdentity);
}

function fsyncDirectoryIfSupported(fileSystem, directory) {
  const constants = fileSystem.constants || fs.constants;
  let descriptor = null;
  try {
    descriptor = fileSystem.openSync(directory, constants.O_RDONLY);
    const stat = fileSystem.fstatSync(descriptor);
    if (!stat.isDirectory()) throw unsafeFilesystem();
    fileSystem.fsyncSync(descriptor);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error;
  } finally {
    if (descriptor !== null) fileSystem.closeSync(descriptor);
  }
}

function openPublicationClaim(owned, fileSystem) {
  const constants = fileSystem.constants || fs.constants;
  owned.claimFd = fileSystem.openSync(
    owned.claimPath,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL
      | (constants.O_NOFOLLOW || 0),
    0o600,
  );
  fileSystem.fchmodSync(owned.claimFd, 0o600);
  owned.claimIdentity = identity(fileSystem.fstatSync(owned.claimFd));
  writePublicationClaimState(owned, fileSystem);
  fsyncDirectoryIfSupported(fileSystem, owned.assetParent);
  appendOwnerRecord(owned, fileSystem);
}

function copyExclusiveFile({
  fileSystem,
  sourcePath,
  sourceIdentity,
  targetPath,
  onOwned = () => {},
}) {
  const constants = fileSystem.constants || fs.constants;
  let sourceFd = null;
  let targetFd = null;
  try {
    sourceFd = fileSystem.openSync(
      sourcePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    );
    const sourceBefore = openedFileIdentity(
      fileSystem.fstatSync(sourceFd),
      fileSystem.fstatSync(sourceFd, { bigint: true }),
    );
    if (!sameFileIdentity(sourceBefore, sourceIdentity)) throw unsafeFilesystem();
    targetFd = fileSystem.openSync(
      targetPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
      0o600,
    );
    fileSystem.fchmodSync(targetFd, 0o600);
    onOwned(identity(fileSystem.fstatSync(targetFd)));
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let count;
    do {
      count = fileSystem.readSync(sourceFd, buffer, 0, buffer.length, null);
      if (count > 0) {
        hash.update(buffer.subarray(0, count));
        let offset = 0;
        while (offset < count) {
          const written = fileSystem.writeSync(targetFd, buffer, offset, count - offset);
          if (written <= 0) throw unsafeFilesystem();
          offset += written;
        }
      }
    } while (count > 0);
    fileSystem.fsyncSync(targetFd);
    const sourceAfter = openedFileIdentity(
      fileSystem.fstatSync(sourceFd),
      fileSystem.fstatSync(sourceFd, { bigint: true }),
    );
    const targetStat = fileSystem.fstatSync(targetFd);
    const targetIdentity = openedFileIdentity(
      targetStat,
      fileSystem.fstatSync(targetFd, { bigint: true }),
    );
    if (!sameFileIdentity(sourceBefore, sourceAfter) || targetIdentity.size !== sourceBefore.size
      || (targetStat.mode & 0o777) !== 0o600) throw unsafeFilesystem();
    return { identity: targetIdentity, sha256: hash.digest('hex') };
  } finally {
    if (targetFd !== null) fileSystem.closeSync(targetFd);
    if (sourceFd !== null) fileSystem.closeSync(sourceFd);
  }
}

function buildCanonicalMetadata(owned, headers, master, fileSystem) {
  assertOutputIdentities(fileSystem, owned);
  const canonicalSha256 = hashOpenedFile(
    fileSystem,
    owned.canonicalPath,
    owned.canonicalIdentity,
  );
  assertOutputIdentities(fileSystem, owned);
  const previewSha256 = owned.normalizedPreviewPath
    ? hashOpenedFile(fileSystem, owned.normalizedPreviewPath, owned.previewIdentity)
    : null;
  assertOutputIdentities(fileSystem, owned);
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
  return metadata;
}

function removeIfOwnedFile(fileSystem, target, expected) {
  if (!target || !expected) return false;
  try {
    const stat = fileSystem.lstatSync(target);
    if (stat.isFile() && !stat.isSymbolicLink() && sameIdentity(stat, expected)) {
      fileSystem.unlinkSync(target);
      return true;
    }
  } catch (_) { /* never broaden cleanup after a race */ }
  return false;
}

function ownedFileAbsentOrRemoved(fileSystem, target, expected) {
  if (!target) return true;
  try {
    const stat = fileSystem.lstatSync(target);
    if (!expected || !stat.isFile() || stat.isSymbolicLink() || !sameIdentity(stat, expected)) {
      return false;
    }
    fileSystem.unlinkSync(target);
    return true;
  } catch (error) {
    return error.code === 'ENOENT';
  }
}

function ownedDirectoryAbsentOrRemoved(fileSystem, target, expected) {
  if (!target) return true;
  try {
    const stat = fileSystem.lstatSync(target);
    if (!expected || !stat.isDirectory() || stat.isSymbolicLink()
      || !sameIdentity(stat, expected)) return false;
    fileSystem.rmdirSync(target);
    return true;
  } catch (error) {
    return error.code === 'ENOENT';
  }
}

function claimFinalDirectory(owned, fileSystem) {
  try {
    fileSystem.mkdirSync(owned.assetFinalPath, { mode: 0o700 });
  } catch (_) {
    throw unsafeFilesystem();
  }
  const created = fileSystem.lstatSync(owned.assetFinalPath);
  if (!created.isDirectory() || created.isSymbolicLink()) throw unsafeFilesystem();
  owned.assetFinalIdentity = identity(created);
  fileSystem.chmodSync(owned.assetFinalPath, 0o700);
  const checked = fileSystem.lstatSync(owned.assetFinalPath);
  if (!checked.isDirectory() || checked.isSymbolicLink()
    || !sameIdentity(checked, owned.assetFinalIdentity)
    || (checked.mode & 0o777) !== 0o700) throw unsafeFilesystem();
}

function publishImportedBundle({ owned, metadata, fileSystem }) {
  assertOwnedImport(fileSystem, owned);
  assertOutputIdentities(fileSystem, owned);
  openPublicationClaim(owned, fileSystem);
  if (owned.normalizedPreviewPath) {
    const previewCopy = copyExclusiveFile({
      fileSystem,
      sourcePath: owned.normalizedPreviewPath,
      sourceIdentity: owned.previewIdentity,
      targetPath: owned.previewStagePath,
      onOwned: (value) => { owned.previewStageIdentity = value; },
    });
    if (previewCopy.sha256 !== metadata.previewSha256) throw unsafeFilesystem();
    owned.previewStageIdentity = previewCopy.identity;
    owned.publishedPreviewIdentity = previewCopy.identity;
    writePublicationClaimState(owned, fileSystem);
    appendOwnerRecord(owned, fileSystem);
    fileSystem.linkSync(owned.previewStagePath, owned.previewFinalPath);
    assertOwnedFile(fileSystem, owned.previewFinalPath, owned.publishedPreviewIdentity);
    if (removeIfOwnedFile(fileSystem, owned.previewStagePath, owned.previewStageIdentity)) {
      owned.previewStageIdentity = null;
      appendOwnerRecord(owned, fileSystem);
    }
  }
  assertOwnedDirectory(fileSystem, owned.assetParent, owned.assetParentIdentity, owned.projectReal);
  claimFinalDirectory(owned, fileSystem);
  writePublicationClaimState(owned, fileSystem);
  appendOwnerRecord(owned, fileSystem);
  const finalCanonicalPath = path.join(
    owned.assetFinalPath,
    metadata.mediaKind === 'image' ? 'media.webp' : 'media.mp4',
  );
  owned.canonicalFinalPath = finalCanonicalPath;
  const canonicalCopy = copyExclusiveFile({
    fileSystem,
    sourcePath: owned.canonicalPath,
    sourceIdentity: owned.canonicalIdentity,
    targetPath: finalCanonicalPath,
    onOwned: (value) => { owned.canonicalFinalIdentity = value; },
  });
  if (canonicalCopy.sha256 !== metadata.canonicalSha256) throw unsafeFilesystem();
  owned.canonicalFinalIdentity = canonicalCopy.identity;
  writePublicationClaimState(owned, fileSystem);
  appendOwnerRecord(owned, fileSystem);
  const verified = verifyImportedAssetFiles({
    id: owned.id,
    mediaKind: metadata.mediaKind,
    assetDirectory: owned.assetFinalPath,
    previewPath: owned.previewFinalPath,
    metadata,
    fileSystem,
  });
  if (!verified
    || !sameFileIdentity(verified.canonical, owned.canonicalFinalIdentity)
    || (verified.preview && !sameFileIdentity(verified.preview, owned.publishedPreviewIdentity))) {
    throw mediaImportError(500, 'MEDIA_IMPORT_PUBLICATION_INVALID');
  }
  const record = buildImportedAssetRecord({
    projectDir: owned.projectDir,
    mediaType: metadata.mediaKind === 'image' ? 'images' : 'video',
    id: owned.id,
    verified,
  });
  assertOwnedFile(fileSystem, owned.canonicalFinalPath, owned.canonicalFinalIdentity);
  if (owned.previewFinalPath) {
    assertOwnedFile(fileSystem, owned.previewFinalPath, owned.publishedPreviewIdentity);
  }
  assertOwnedDirectory(
    fileSystem,
    owned.assetFinalPath,
    owned.assetFinalIdentity,
    owned.projectReal,
  );
  owned.metadataFinalPath = path.join(owned.assetFinalPath, 'asset.json');
  owned.metadataFinalIdentity = writeExclusive(
    fileSystem,
    owned.metadataFinalPath,
    `${JSON.stringify(metadata)}\n`,
    (value) => { owned.metadataFinalIdentity = value; },
  );
  owned.published = true;
  appendOwnerRecord(owned, fileSystem);
  return record;
}

function cleanupOwnedImport(owned, fileSystem) {
  if (!owned) return;
  if (owned.uploadFd !== null) {
    try { fileSystem.closeSync(owned.uploadFd); } catch (_) { /* owned descriptor */ }
    owned.uploadFd = null;
  }
  if (owned.claimFd !== null) {
    try { fileSystem.closeSync(owned.claimFd); } catch (_) { /* owned descriptor */ }
    owned.claimFd = null;
  }
  if (owned.ownerFd !== null) {
    try { fileSystem.closeSync(owned.ownerFd); } catch (_) { /* owned descriptor */ }
    owned.ownerFd = null;
  }
  if (!owned.published) {
    const targetsRemoved = [
      ownedFileAbsentOrRemoved(
        fileSystem,
        owned.previewFinalPath,
        owned.publishedPreviewIdentity,
      ),
      ownedFileAbsentOrRemoved(
        fileSystem,
        owned.metadataFinalPath,
        owned.metadataFinalIdentity,
      ),
      ownedFileAbsentOrRemoved(
        fileSystem,
        owned.canonicalFinalPath,
        owned.canonicalFinalIdentity,
      ),
      ownedFileAbsentOrRemoved(
        fileSystem,
        owned.previewStagePath,
        owned.previewStageIdentity,
      ),
    ].every(Boolean);
    if (targetsRemoved && ownedDirectoryAbsentOrRemoved(
      fileSystem,
      owned.assetFinalPath,
      owned.assetFinalIdentity,
    )) {
      removeIfOwnedFile(fileSystem, owned.claimPath, owned.claimIdentity);
    }
  }
  try {
    const expectedRoot = new Set(['owner.jsonl', 'owner.anchor', 'bundle', 'upload.bin']);
    if (owned.previewIdentity) expectedRoot.add('preview.webm');
    const expectedBundle = new Set(owned.canonicalIdentity
      ? [owned.previewIdentity ? 'media.mp4' : 'media.webp'] : []);
    const rootEntries = fileSystem.readdirSync(owned.quarantinePath);
    const bundleEntries = fileSystem.readdirSync(owned.bundlePath);
    if (rootEntries.length === expectedRoot.size
      && rootEntries.every((entry) => expectedRoot.has(entry))
      && bundleEntries.length === expectedBundle.size
      && bundleEntries.every((entry) => expectedBundle.has(entry))) {
      removeIfOwnedFile(fileSystem, owned.canonicalPath, owned.canonicalIdentity);
      removeIfOwnedFile(fileSystem, owned.normalizedPreviewPath, owned.previewIdentity);
      removeIfOwnedFile(fileSystem, owned.uploadPath, owned.uploadIdentity);
      const owner = fileSystem.lstatSync(owned.ownerPath);
      const anchor = fileSystem.lstatSync(owned.ownerAnchorPath);
      if (owner.isFile() && !owner.isSymbolicLink() && anchor.isFile()
        && !anchor.isSymbolicLink() && sameIdentity(owner, owned.ownerIdentity)
        && sameIdentity(anchor, owned.ownerIdentity)) {
        fileSystem.unlinkSync(owned.ownerAnchorPath);
        fileSystem.unlinkSync(owned.ownerPath);
        fileSystem.rmdirSync(owned.bundlePath);
        fileSystem.rmdirSync(owned.quarantinePath);
      }
    }
  } catch (_) { /* an identity race leaves the exact remnant for lease recovery */ }
  if (owned.published) {
    removeIfOwnedFile(fileSystem, owned.previewStagePath, owned.previewStageIdentity);
  }
}

function numericIdentity(value, directory = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = directory ? ['dev', 'ino'] : ['dev', 'ino', 'size', 'mtimeNs'];
  if (Object.keys(value).length !== keys.length
    || !keys.every((key) => typeof value[key] === 'string' && /^(0|[1-9][0-9]*)$/.test(value[key]))) {
    return null;
  }
  return value;
}

function readRecoveryOwner(fileSystem, quarantinePath, id) {
  const ownerPath = path.join(quarantinePath, 'owner.jsonl');
  const anchorPath = path.join(quarantinePath, 'owner.anchor');
  let ownerStat;
  let anchorStat;
  let bytes;
  try {
    ownerStat = fileSystem.lstatSync(ownerPath, { bigint: true });
    anchorStat = fileSystem.lstatSync(anchorPath, { bigint: true });
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || !anchorStat.isFile()
      || anchorStat.isSymbolicLink() || ownerStat.dev !== anchorStat.dev
      || ownerStat.ino !== anchorStat.ino || (ownerStat.mode & 0o777n) !== 0o600n
      || ownerStat.size <= 0n || ownerStat.size > BigInt(OWNER_MAX_BYTES)) return null;
    bytes = fileSystem.readFileSync(ownerPath);
    const after = fileSystem.lstatSync(ownerPath, { bigint: true });
    if (after.dev !== ownerStat.dev || after.ino !== ownerStat.ino
      || after.size !== ownerStat.size || after.mtimeNs !== ownerStat.mtimeNs) return null;
  } catch (_) {
    return null;
  }
  const text = bytes.toString('utf8');
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline < 0) return null;
  const records = text.slice(0, lastNewline).split('\n');
  let latest = null;
  for (const line of records) {
    let record;
    try { record = JSON.parse(line); } catch (_) { return null; }
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || Object.keys(record).length !== OWNER_RECORD_KEYS.length
      || !OWNER_RECORD_KEYS.every((key) => Object.hasOwn(record, key))
      || record.version !== 1 || record.purpose !== OWNER_PURPOSE
      || record.id !== id
      || typeof record.hostname !== 'string' || !Number.isInteger(record.pid) || record.pid <= 0
      || typeof record.token !== 'string' || !/^[A-Za-z0-9_-]+$/.test(record.token)
      || !numericIdentity(record.quarantine, true) || !numericIdentity(record.bundle, true)
      || !numericIdentity(record.upload)
      || !['canonical', 'preview', 'claim', 'previewStage', 'previewFinal',
        'assetDirectory', 'canonicalFinal', 'metadataFinal'].every((key) => (
        record[key] === null || numericIdentity(record[key], key === 'assetDirectory')
      )) || typeof record.committed !== 'boolean') return null;
    if (latest && (record.hostname !== latest.hostname || record.pid !== latest.pid
      || record.token !== latest.token
      || JSON.stringify(record.quarantine) !== JSON.stringify(latest.quarantine)
      || JSON.stringify(record.bundle) !== JSON.stringify(latest.bundle))) return null;
    latest = record;
  }
  return latest ? {
    record: latest,
    ownerIdentity: { dev: String(ownerStat.dev), ino: String(ownerStat.ino) },
    ownerPath,
    anchorPath,
  } : null;
}

function recoveryTargetMatches(fileSystem, target, expected, directory = false) {
  if (!expected) return false;
  try {
    const stat = fileSystem.lstatSync(target, { bigint: true });
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) return false;
    return String(stat.dev) === expected.dev && String(stat.ino) === expected.ino
      && (directory || (String(stat.size) === expected.size
        && String(stat.mtimeNs) === expected.mtimeNs));
  } catch (_) {
    return false;
  }
}

function recoveryNodeMatches(fileSystem, target, expected) {
  if (!expected) return false;
  try {
    const stat = fileSystem.lstatSync(target, { bigint: true });
    return stat.isFile() && !stat.isSymbolicLink()
      && String(stat.dev) === expected.dev && String(stat.ino) === expected.ino;
  } catch (_) {
    return false;
  }
}

function removeRecoveryFile(fileSystem, target, expected) {
  try {
    fileSystem.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return true;
    return false;
  }
  if (!recoveryTargetMatches(fileSystem, target, expected)) return false;
  fileSystem.unlinkSync(target);
  return true;
}

function removeRecoveryNode(fileSystem, target, expected) {
  try {
    fileSystem.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return true;
    return false;
  }
  if (!recoveryNodeMatches(fileSystem, target, expected)) return false;
  fileSystem.unlinkSync(target);
  return true;
}

function recoverQuarantine({ projectDir, quarantinePath, id, fileSystem, hostname, killProcess }) {
  const owned = readRecoveryOwner(fileSystem, quarantinePath, id);
  if (!owned || owned.record.hostname !== hostname) return [];
  try {
    killProcess(owned.record.pid, 0);
    return [];
  } catch (error) {
    if (!error || error.code !== 'ESRCH') return [];
  }
  const { record } = owned;
  if (!recoveryTargetMatches(fileSystem, quarantinePath, record.quarantine, true)
    || !recoveryTargetMatches(fileSystem, path.join(quarantinePath, 'bundle'), record.bundle, true)) {
    return [];
  }
  const bundlePath = path.join(quarantinePath, 'bundle');
  const expectedRoot = new Set(['owner.jsonl', 'owner.anchor', 'bundle', 'upload.bin']);
  if (record.preview) expectedRoot.add('preview.webm');
  const expectedBundle = new Set(record.canonical
    ? [record.preview === null ? 'media.webp' : 'media.mp4'] : []);
  let rootEntries;
  let bundleEntries;
  try {
    rootEntries = fileSystem.readdirSync(quarantinePath);
    bundleEntries = fileSystem.readdirSync(bundlePath);
  } catch (_) {
    return [];
  }
  if (!rootEntries.includes('owner.jsonl') || !rootEntries.includes('owner.anchor')
    || !rootEntries.includes('bundle')
    || rootEntries.some((entry) => !expectedRoot.has(entry))
    || bundleEntries.some((entry) => !expectedBundle.has(entry))) return [];

  const removed = [];
  for (const [target, expected, mutable] of [
    [record.previewStage ? path.join(projectDir, 'previews', 'broll', `.${id}.stage.webm`) : null, record.previewStage, false],
    [path.join(bundlePath, record.preview === null ? 'media.webp' : 'media.mp4'), record.canonical, true],
    [path.join(quarantinePath, 'preview.webm'), record.preview, true],
    [path.join(quarantinePath, 'upload.bin'), record.upload, true],
  ]) {
    if (!target || !expected) continue;
    try {
      if (!(mutable
        ? removeRecoveryNode(fileSystem, target, expected)
        : removeRecoveryFile(fileSystem, target, expected))) return removed;
      removed.push(target);
    } catch (_) { return removed; }
  }
  try {
    const anchor = fileSystem.lstatSync(owned.anchorPath, { bigint: true });
    const owner = fileSystem.lstatSync(owned.ownerPath, { bigint: true });
    if (String(anchor.dev) !== owned.ownerIdentity.dev || String(anchor.ino) !== owned.ownerIdentity.ino
      || String(owner.dev) !== owned.ownerIdentity.dev || String(owner.ino) !== owned.ownerIdentity.ino) {
      return removed;
    }
    fileSystem.unlinkSync(owned.anchorPath);
    fileSystem.unlinkSync(owned.ownerPath);
    fileSystem.rmdirSync(bundlePath);
    fileSystem.rmdirSync(quarantinePath);
    removed.push(owned.anchorPath, owned.ownerPath, bundlePath, quarantinePath);
  } catch (_) { /* resumable on the next lease owner */ }
  return removed;
}

function cleanupOrphanImportQuarantines({
  projectDir,
  fileSystem = fs,
  mutationLease = null,
  hostname = os.hostname(),
  killProcess = process.kill,
} = {}) {
  const lease = mutationLease || acquireProjectMutationLease(projectDir, { fileSystem });
  const ownsLease = !mutationLease;
  const removed = [];
  try {
    const parent = path.join(path.resolve(projectDir), 'tmp', 'review-imports');
    let entries;
    try { entries = fileSystem.readdirSync(parent, { withFileTypes: true }); } catch (_) { return removed; }
    for (const entry of entries) {
      if (!UUID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      removed.push(...recoverQuarantine({
        projectDir: path.resolve(projectDir),
        quarantinePath: path.join(parent, entry.name),
        id: entry.name,
        fileSystem,
        hostname,
        killProcess,
      }));
    }
    return removed;
  } finally {
    if (ownsLease) lease.release();
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
  let mutationLease;
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
    try {
      mutationLease = acquireProjectMutationLease(projectDir, { fileSystem });
    } catch (error) {
      if (error && error.code === 'PROJECT_MANIFEST_CONFLICT') {
        throw mediaImportError(409, 'MEDIA_IMPORT_BUSY');
      }
      throw error;
    }
    cleanupOrphanImportQuarantines({ projectDir, fileSystem, mutationLease });
    cleanupOrphanImportedStages({ projectDir, fileSystem, mutationLease });
    owned = createOwnedQuarantine(
      projectDir, randomId(), parsedHeaders.mediaKind, fileSystem, mutationLease,
    );
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
    assertMediaLimits(source, parsedHeaders);
    let metadata;
    try {
      await normalizeIntoQuarantine({
        source, outputFps, owned, signal, fileSystem, run: runMediaProcessImpl,
      });
      const master = await verifyNormalizedOutputs({
        source, outputFps, owned, signal, fileSystem, run: runMediaProcessImpl,
      });
      metadata = buildCanonicalMetadata(owned, parsedHeaders, master, fileSystem);
      const staged = verifyImportedAssetFiles({
        id: owned.id,
        mediaKind: parsedHeaders.mediaKind,
        assetDirectory: owned.bundlePath,
        previewPath: owned.normalizedPreviewPath,
        metadata,
        fileSystem,
      });
      if (!staged
        || !sameFileIdentity(staged.canonical, owned.canonicalIdentity)
        || (staged.preview && !sameFileIdentity(staged.preview, owned.previewIdentity))) {
        throw mediaImportError(422, 'MEDIA_IMPORT_OUTPUT_INVALID');
      }
    } catch (error) {
      if (error.status || error.code === 'MEDIA_PROCESS_ABORTED') throw error;
      throw mediaImportError(422, 'MEDIA_IMPORT_NORMALIZATION_FAILED', 'media normalization failed', { cause: error });
    }
    try {
      return publishImportedBundle({ owned, metadata, fileSystem });
    } catch (error) {
      if (error.status) throw error;
      throw mediaImportError(500, 'MEDIA_IMPORT_FILESYSTEM_UNSAFE', undefined, { cause: error });
    }
  } finally {
    cleanupOwnedImport(owned, fileSystem);
    if (mutationLease) mutationLease.release();
    controller.release();
  }
}

module.exports = {
  IMAGE_MAX_BYTES,
  VIDEO_MAX_BYTES,
  createImportController,
  cleanupOrphanImportQuarantines,
  importReviewMedia,
  mediaImportError,
  parseImportHeaders,
  requiredFreeBytes,
};
