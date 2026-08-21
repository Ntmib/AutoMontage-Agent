const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { isCanonicalBrollReference } = require('./lesson/broll-media');
const { sanitizeNamespace } = require('./public-media');

const COPY_BUFFER_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_EXTENSIONS = new Set(['.avif', '.gif', '.jpeg', '.jpg', '.png', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.mpeg', '.mpg', '.webm']);
const REMOTE_IMAGE = /^https?:\/\//i;
const ASSERT_BUNDLE_CURRENT = Symbol('assertBundleCurrent');
const MACOS_ROOT_ALIASES = new Map([
  ['/etc', '/private/etc'],
  ['/tmp', '/private/tmp'],
  ['/var', '/private/var'],
]);

function fail(message) {
  throw new Error(`render media: ${message}`);
}

function safeTemporaryId(value) {
  const id = String(value ?? '').toLowerCase();
  if (!UUID.test(id)) fail('temporaryId must be a UUID');
  return id;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}

function lstat(fileSystem, target) {
  try {
    return fileSystem.lstatSync(target, { bigint: true });
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
    throw error;
  }
}

function directoryIdentity(stat) {
  return { dev: stat.dev, ino: stat.ino };
}

function fileIdentity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    mode: stat.mode,
    nlink: stat.nlink,
  };
}

function sameDirectory(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function sameFile(left, right) {
  return Boolean(left && right
    && left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
    && left.mode === right.mode && left.nlink === right.nlink);
}

function assertDirectory(target, fileSystem, expected = null) {
  const stat = lstat(fileSystem, target);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    fail('directory path contains a symbolic link or non-directory');
  }
  const identity = directoryIdentity(stat);
  if (expected && !sameDirectory(expected, identity)) fail('directory identity changed');
  return identity;
}

function isRootOwned(stat) {
  return stat && BigInt(stat.uid) === 0n;
}

function isGroupOrOtherWritable(stat) {
  return (BigInt(stat.mode) & 0o022n) !== 0n;
}

function inspectAllowedPlatformRootAlias(target, stat, fileSystem) {
  const expectedTarget = MACOS_ROOT_ALIASES.get(target);
  if (process.platform !== 'darwin' || !expectedTarget || !isRootOwned(stat)
    || isGroupOrOtherWritable(stat)) {
    fail('trusted directory chain contains an untrusted symbolic link');
  }
  const filesystemRoot = path.parse(target).root;
  const rootStat = lstat(fileSystem, filesystemRoot);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()
    || !isRootOwned(rootStat) || isGroupOrOtherWritable(rootStat)) {
    fail('trusted platform alias has an unsafe root parent');
  }
  let realTarget;
  try {
    realTarget = path.resolve(String(fileSystem.realpathSync(target)));
  } catch (_) {
    fail('trusted platform alias target cannot be resolved');
  }
  if (realTarget !== expectedTarget) fail('trusted platform alias target changed');
  const followed = fileSystem.statSync(target, { bigint: true });
  if (!followed.isDirectory()) fail('trusted platform alias target is not a directory');
  return {
    aliasTarget: expectedTarget,
    followedIdentity: directoryIdentity(followed),
  };
}

function assertTrustedDirectoryChain(target, fileSystem) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  const segments = path.relative(parsed.root, resolved).split(path.sep).filter(Boolean);
  let current = parsed.root;
  const guards = [];
  for (const segment of ['', ...segments]) {
    if (segment) current = path.join(current, segment);
    const stat = lstat(fileSystem, current);
    if (!stat) fail('trusted directory chain is missing');
    if (stat.isSymbolicLink()) {
      if (path.dirname(current) !== parsed.root) {
        fail('trusted directory chain contains a symbolic link');
      }
      const platformAlias = inspectAllowedPlatformRootAlias(current, stat, fileSystem);
      guards.push({
        target: current,
        symbolicLink: true,
        identity: fileIdentity(stat),
        ...platformAlias,
      });
    } else if (!stat.isDirectory()) {
      fail('trusted directory chain contains a non-directory');
    } else {
      guards.push({
        target: current,
        symbolicLink: false,
        identity: directoryIdentity(stat),
      });
    }
  }
  return {
    resolved,
    assertCurrent() {
      for (const guard of guards) {
        const stat = lstat(fileSystem, guard.target);
        if (!stat || stat.isSymbolicLink() !== guard.symbolicLink
          || (!guard.symbolicLink && !stat.isDirectory())
          || (guard.symbolicLink
            ? !sameFile(guard.identity, fileIdentity(stat))
            : !sameDirectory(guard.identity, directoryIdentity(stat)))) {
          fail('trusted directory chain identity changed');
        }
        if (guard.symbolicLink) {
          const platformAlias = inspectAllowedPlatformRootAlias(guard.target, stat, fileSystem);
          if (platformAlias.aliasTarget !== guard.aliasTarget
            || !sameDirectory(guard.followedIdentity, platformAlias.followedIdentity)) {
            fail('trusted directory chain identity changed');
          }
        }
      }
    },
  };
}

function ensureLeaseBase(root, fileSystem) {
  const rootChain = assertTrustedDirectoryChain(root, fileSystem);
  const resolvedRoot = rootChain.resolved;
  assertDirectory(resolvedRoot, fileSystem);
  const publicDirectory = path.join(resolvedRoot, 'public');
  const publicIdentity = assertDirectory(publicDirectory, fileSystem);
  const leaseBase = path.join(publicDirectory, '.automontage');
  let baseStat = lstat(fileSystem, leaseBase);
  if (!baseStat) {
    try {
      fileSystem.mkdirSync(leaseBase, { mode: 0o700 });
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }
    baseStat = lstat(fileSystem, leaseBase);
  }
  if (!baseStat || baseStat.isSymbolicLink() || !baseStat.isDirectory()) {
    fail('bundle base contains a symbolic link or non-directory');
  }
  assertDirectory(publicDirectory, fileSystem, publicIdentity);
  rootChain.assertCurrent();
  return {
    rootChain,
    publicDirectory,
    publicIdentity,
    leaseBase,
    baseIdentity: directoryIdentity(baseStat),
  };
}

function canonicalSegments(reference) {
  if (!isCanonicalBrollReference(reference)) fail('media reference must be canonical and local');
  return reference.split('/');
}

function resolveContainedReference({ storageRoot, reference, fileSystem }) {
  const rootChain = assertTrustedDirectoryChain(storageRoot, fileSystem);
  const resolvedRoot = rootChain.resolved;
  const rootStat = lstat(fileSystem, resolvedRoot);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail('media storage root contains a symbolic link or non-directory');
  }
  const segments = canonicalSegments(reference);
  const candidate = path.resolve(resolvedRoot, ...segments);
  if (!isInside(resolvedRoot, candidate)) fail('media reference must stay inside its storage root');

  const guards = [{
    target: resolvedRoot,
    directory: true,
    identity: directoryIdentity(rootStat),
  }];
  let current = resolvedRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const stat = lstat(fileSystem, current);
    if (!stat) fail('media file is missing');
    if (stat.isSymbolicLink()) fail('media path contains a symbolic link');
    const final = index === segments.length - 1;
    if (final ? !stat.isFile() : !stat.isDirectory()) {
      fail(final ? 'media must be a regular file' : 'media ancestor must be a directory');
    }
    guards.push({
      target: current,
      directory: !final,
      identity: final ? fileIdentity(stat) : directoryIdentity(stat),
    });
  }

  return {
    filePath: candidate,
    guards,
    assertCurrent() {
      rootChain.assertCurrent();
      for (const guard of guards) {
        const stat = lstat(fileSystem, guard.target);
        if (!stat || stat.isSymbolicLink()
          || (guard.directory ? !stat.isDirectory() : !stat.isFile())) {
          fail('media identity changed');
        }
        const currentIdentity = guard.directory ? directoryIdentity(stat) : fileIdentity(stat);
        if (guard.directory
          ? !sameDirectory(guard.identity, currentIdentity)
          : !sameFile(guard.identity, currentIdentity)) {
          fail('media identity changed');
        }
      }
    },
  };
}

function resolveSource(sourcePath, fileSystem) {
  const resolved = path.resolve(sourcePath);
  return resolveContainedReference({
    storageRoot: path.dirname(resolved),
    reference: path.basename(resolved),
    fileSystem,
  });
}

function resolveBrollReference({ root, workspace, reference, fileSystem }) {
  const segments = canonicalSegments(reference);
  const projectReference = segments[0] === 'assets';
  if (projectReference && (!workspace || typeof workspace.dir !== 'string')) {
    fail('project media reference requires a project workspace');
  }
  const publicReference = segments[0] === 'public' ? segments.slice(1).join('/') : reference;
  if (!publicReference) fail('public media reference is incomplete');
  return resolveContainedReference({
    storageRoot: projectReference ? workspace.dir : path.join(path.resolve(root), 'public'),
    reference: projectReference ? reference : publicReference,
    fileSystem,
  });
}

function safeExtension(filename, allowed, label) {
  const extension = path.extname(filename).toLowerCase();
  if (!allowed.has(extension)) fail(`${label} extension is not render-safe`);
  return extension;
}

function extensionForSource(sourcePath) {
  return safeExtension(sourcePath, VIDEO_EXTENSIONS, 'source');
}

function extensionForLegacy(reference) {
  let pathname = reference;
  if (REMOTE_IMAGE.test(reference)) {
    try {
      pathname = new URL(reference).pathname;
    } catch (_) {
      fail('legacy remote image URL is invalid');
    }
  }
  return safeExtension(pathname, IMAGE_EXTENSIONS, 'legacy image');
}

function extensionForStructured(media) {
  return safeExtension(
    media.src,
    media.kind === 'image' ? IMAGE_EXTENSIONS : VIDEO_EXTENSIONS,
    `structured ${media.kind}`,
  );
}

function openTracked(resolved, fileSystem) {
  resolved.assertCurrent();
  const constants = fileSystem.constants || fs.constants;
  let descriptor;
  try {
    descriptor = fileSystem.openSync(
      resolved.filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    );
  } catch (error) {
    if (error && error.code === 'ELOOP') fail('media path contains a symbolic link');
    fail('media could not be opened with no-follow');
  }
  let identity;
  try {
    const stat = fileSystem.fstatSync(descriptor, { bigint: true });
    if (!stat.isFile()) fail('media must be a regular file');
    identity = fileIdentity(stat);
    const pathStat = lstat(fileSystem, resolved.filePath);
    if (!pathStat || pathStat.isSymbolicLink() || !pathStat.isFile()
      || !sameFile(identity, fileIdentity(pathStat))) {
      fail('media identity changed');
    }
  } catch (error) {
    fileSystem.closeSync(descriptor);
    throw error;
  }
  return { descriptor, identity, resolved };
}

function assertTrackedCurrent(tracked, fileSystem) {
  tracked.resolved.assertCurrent();
  const descriptorStat = fileSystem.fstatSync(tracked.descriptor, { bigint: true });
  const pathStat = lstat(fileSystem, tracked.resolved.filePath);
  if (!descriptorStat.isFile() || !pathStat || pathStat.isSymbolicLink() || !pathStat.isFile()
    || !sameFile(tracked.identity, fileIdentity(descriptorStat))
    || !sameFile(tracked.identity, fileIdentity(pathStat))) {
    fail('media identity changed during copy');
  }
}

function writeAll(fileSystem, descriptor, buffer, length) {
  let offset = 0;
  while (offset < length) {
    const written = fileSystem.writeSync(descriptor, buffer, offset, length - offset);
    if (!Number.isInteger(written) || written <= 0) fail('bundle copy made no progress');
    offset += written;
  }
}

function hashOpenedDescriptor(fileSystem, descriptor, expectedIdentity, label) {
  if (expectedIdentity.size < 0n || expectedIdentity.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail(`${label} size cannot be verified safely`);
  }
  const expectedBytes = Number(expectedIdentity.size);
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let position = 0;
  while (position < expectedBytes) {
    const bytesRead = fileSystem.readSync(
      descriptor,
      buffer,
      0,
      Math.min(buffer.length, expectedBytes - position),
      position,
    );
    if (!Number.isInteger(bytesRead) || bytesRead <= 0) fail(`${label} changed while hashing`);
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  const after = fileSystem.fstatSync(descriptor, { bigint: true });
  if (!after.isFile() || !sameFile(expectedIdentity, fileIdentity(after))) {
    fail(`${label} identity changed while hashing`);
  }
  return hash.digest('hex');
}

function copyTracked({ tracked, destination, fileSystem, onCreated }) {
  const constants = fileSystem.constants || fs.constants;
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let destinationDescriptor;
  try {
    destinationDescriptor = fileSystem.openSync(
      destination,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
      0o600,
    );
    const createdStat = fileSystem.fstatSync(destinationDescriptor, { bigint: true });
    if (!createdStat.isFile()) fail('bundle destination must be a regular file');
    onCreated(directoryIdentity(createdStat));

    let position = 0;
    for (;;) {
      const bytesRead = fileSystem.readSync(
        tracked.descriptor,
        buffer,
        0,
        buffer.length,
        position,
      );
      if (bytesRead === 0) break;
      if (!Number.isInteger(bytesRead) || bytesRead < 0) fail('bundle source read failed');
      hash.update(buffer.subarray(0, bytesRead));
      writeAll(fileSystem, destinationDescriptor, buffer, bytesRead);
      position += bytesRead;
    }
    fileSystem.fsyncSync(destinationDescriptor);
    assertTrackedCurrent(tracked, fileSystem);
    const finalDestination = fileSystem.fstatSync(destinationDescriptor, { bigint: true });
    const destinationPath = lstat(fileSystem, destination);
    if (!destinationPath || destinationPath.isSymbolicLink() || !destinationPath.isFile()
      || BigInt(position) !== finalDestination.size
      || !sameFile(fileIdentity(finalDestination), fileIdentity(destinationPath))) {
      fail('bundle destination identity changed');
    }
    const sourceDigest = hash.digest('hex');
    const destinationIdentity = fileIdentity(finalDestination);
    const destinationDigest = hashOpenedDescriptor(
      fileSystem,
      destinationDescriptor,
      destinationIdentity,
      'bundle destination',
    );
    if (destinationDigest !== sourceDigest) fail('bundle destination hash differs from copied bytes');
    return { sha256: sourceDigest, identity: destinationIdentity };
  } finally {
    if (destinationDescriptor !== undefined) fileSystem.closeSync(destinationDescriptor);
  }
}

function deepClone(value, seen = new Map()) {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  const clone = Array.isArray(value) ? [] : {};
  seen.set(value, clone);
  for (const [key, item] of Object.entries(value)) clone[key] = deepClone(item, seen);
  return clone;
}

function attachCleanupDiagnostic(operationError, cleanupError) {
  if (operationError && (typeof operationError === 'object' || typeof operationError === 'function')) {
    try {
      Object.defineProperty(operationError, 'cleanupError', { value: cleanupError });
    } catch (_) {
      // A frozen render error remains the primary diagnostic.
    }
  }
}

function prepareRenderMediaBundle({
  root,
  workspace,
  props,
  approvedBrief,
  sourcePath,
  namespace,
  temporaryId = randomUUID(),
  fileSystem = fs,
} = {}) {
  if (!props || typeof props !== 'object' || !Array.isArray(props.scenes)) {
    fail('lesson props are required');
  }
  if (!approvedBrief || typeof approvedBrief !== 'object' || !Array.isArray(approvedBrief.scenes)) {
    fail('approved brief media context is required');
  }
  if (approvedBrief.status !== 'approved') fail('brief must be approved before render');
  if (props.scenes.length !== approvedBrief.scenes.length) {
    fail('lesson props scene count does not match the approved brief');
  }
  if (typeof root !== 'string' || typeof sourcePath !== 'string') fail('root and source are required');
  const approvedSource = path.isAbsolute(approvedBrief.source)
    ? path.resolve(approvedBrief.source)
    : path.resolve(root, approvedBrief.source || '');
  const resolvedSourcePath = path.resolve(sourcePath);
  if (approvedSource !== resolvedSourcePath) fail('source path does not match the approved brief');

  const id = safeTemporaryId(temporaryId);
  const safeNamespace = sanitizeNamespace(namespace || 'lesson');
  const base = ensureLeaseBase(root, fileSystem);
  const directoryName = `${safeNamespace}-${id}`;
  const directory = path.join(base.leaseBase, directoryName);
  let directoryIdentityValue = null;
  const ownedFiles = new Map();
  let cleanupPhase = 'original';
  let cleanupContainer = null;
  let cleanupContainerIdentity = null;
  let cleanupContainerCreateStatus = null;
  let claimedDirectory = null;

  function assertOwnedDirectoryCurrent() {
    base.rootChain.assertCurrent();
    assertDirectory(base.publicDirectory, fileSystem, base.publicIdentity);
    assertDirectory(base.leaseBase, fileSystem, base.baseIdentity);
    assertDirectory(directory, fileSystem, directoryIdentityValue);
  }

  function assertExactOwnedEntries(targetDirectory, { allowUnlinkProgress = false } = {}) {
    const currentNames = new Set(fileSystem.readdirSync(targetDirectory));
    const expectedNames = new Set();
    for (const record of ownedFiles.values()) {
      const present = currentNames.has(record.cleanupName);
      if (record.cleanupState === 'removed') {
        if (present) fail('removed bundle file name was replaced; cleanup refused');
        continue;
      }
      if (!present) {
        if (allowUnlinkProgress && record.cleanupState === 'unlinking') {
          record.cleanupState = 'removed';
          continue;
        }
        fail('bundle contents changed; cleanup refused');
      }
      expectedNames.add(record.cleanupName);
      const stat = lstat(fileSystem, path.join(targetDirectory, record.cleanupName));
      if (!stat || stat.isSymbolicLink() || !stat.isFile()
        || !sameDirectory(record.cleanupIdentity, directoryIdentity(stat))) {
        fail('bundle file identity changed; cleanup refused');
      }
    }
    if (currentNames.size !== expectedNames.size
      || [...currentNames].some((name) => !expectedNames.has(name))) {
      fail('bundle contents changed; cleanup refused');
    }
  }

  function assertBundlePathIdentitiesCurrent() {
    assertOwnedDirectoryCurrent();
    assertExactOwnedEntries(directory);
    for (const [name, record] of ownedFiles) {
      const stat = lstat(fileSystem, path.join(directory, name));
      if (!stat || stat.isSymbolicLink() || !stat.isFile()
        || !sameFile(record.identity, fileIdentity(stat))) {
        fail('bundle file identity changed before render');
      }
    }
    assertOwnedDirectoryCurrent();
  }

  function verifyBundleFilesCurrent() {
    assertOwnedDirectoryCurrent();
    assertExactOwnedEntries(directory);
    const constants = fileSystem.constants || fs.constants;
    for (const [name, record] of ownedFiles) {
      if (!record.identity || !record.sha256) fail('bundle file verification is incomplete');
      const filename = path.join(directory, name);
      let descriptor;
      try {
        descriptor = fileSystem.openSync(
          filename,
          constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
        );
        const descriptorStat = fileSystem.fstatSync(descriptor, { bigint: true });
        const pathStat = lstat(fileSystem, filename);
        if (!descriptorStat.isFile() || !pathStat || pathStat.isSymbolicLink()
          || !pathStat.isFile()
          || !sameFile(record.identity, fileIdentity(descriptorStat))
          || !sameFile(record.identity, fileIdentity(pathStat))) {
          fail('bundle file identity changed before render');
        }
        const digest = hashOpenedDescriptor(
          fileSystem,
          descriptor,
          record.identity,
          'bundle file',
        );
        if (digest !== record.sha256) fail('bundle file hash changed before render');
      } finally {
        if (descriptor !== undefined) fileSystem.closeSync(descriptor);
      }
    }
    // Every descriptor is closed before this final pathname-only sweep. Nothing user-controlled
    // runs between this sweep and the operation callback; the documented same-UID syscall gap is
    // the remaining Node 20 boundary.
    assertBundlePathIdentitiesCurrent();
  }

  function attemptCleanupContainerCreate() {
    cleanupContainerCreateStatus = 'attempting';
    try {
      fileSystem.mkdirSync(cleanupContainer, { mode: 0o700 });
    } catch (error) {
      cleanupContainerCreateStatus = error?.code === 'EEXIST' ? 'foreign' : 'ambiguous';
      throw error;
    }

    cleanupContainerCreateStatus = 'created-unverified';
    const constants = fileSystem.constants || fs.constants;
    let descriptor;
    let captureError = null;
    try {
      descriptor = fileSystem.openSync(
        cleanupContainer,
        constants.O_RDONLY
          | (constants.O_DIRECTORY || 0)
          | (constants.O_NOFOLLOW || 0),
      );
      const opened = fileSystem.fstatSync(descriptor, { bigint: true });
      if (!opened.isDirectory()) fail('cleanup container is not a directory');
      cleanupContainerIdentity = directoryIdentity(opened);
      cleanupContainerCreateStatus = 'exclusive';
    } catch (error) {
      captureError = error;
    }
    if (descriptor !== undefined) {
      try {
        fileSystem.closeSync(descriptor);
      } catch (error) {
        if (!captureError) captureError = error;
      }
    }
    if (captureError) throw captureError;
  }

  function reconcileCleanupContainerCreate() {
    if (cleanupContainerCreateStatus === 'foreign') {
      fail('cleanup container ownership is foreign; cleanup refused');
    }

    let current = lstat(fileSystem, cleanupContainer);
    if (!current) {
      if (cleanupContainerIdentity
        || cleanupContainerCreateStatus === 'exclusive'
        || cleanupContainerCreateStatus === 'created-unverified') {
        fail('owned cleanup container disappeared; cleanup refused');
      }
      if (cleanupContainerCreateStatus !== 'unattempted'
        && cleanupContainerCreateStatus !== 'ambiguous') {
        fail('cleanup container ownership is uncertain; cleanup refused');
      }
      assertDirectory(base.leaseBase, fileSystem, base.baseIdentity);
      attemptCleanupContainerCreate();
      current = lstat(fileSystem, cleanupContainer);
    }

    if (!current || current.isSymbolicLink() || !current.isDirectory()) {
      fail('cleanup container is foreign or unsafe; cleanup refused');
    }
    if (!cleanupContainerIdentity) {
      fail('cleanup container ownership is uncertain; cleanup refused');
    }
    const currentIdentity = directoryIdentity(current);
    if (!sameDirectory(cleanupContainerIdentity, currentIdentity)) {
      fail('cleanup container identity changed; cleanup refused');
    }
    if (cleanupContainerCreateStatus !== 'exclusive') {
      fail('cleanup container has no exclusive-create ownership evidence');
    }
    if (fileSystem.readdirSync(cleanupContainer).length !== 0) {
      fail('cleanup container is not empty; cleanup refused');
    }
    assertDirectory(base.leaseBase, fileSystem, base.baseIdentity);
    assertDirectory(cleanupContainer, fileSystem, cleanupContainerIdentity);
    cleanupPhase = 'container-ready';
  }

  function cleanup() {
    if (cleanupPhase === 'cleaned') return;
    base.rootChain.assertCurrent();
    assertDirectory(base.publicDirectory, fileSystem, base.publicIdentity);
    assertDirectory(base.leaseBase, fileSystem, base.baseIdentity);

    if (cleanupPhase === 'original') {
      const currentDirectory = lstat(fileSystem, directory);
      if (!currentDirectory) {
        cleanupPhase = 'cleaned';
        return;
      }
      if (currentDirectory.isSymbolicLink() || !currentDirectory.isDirectory()
        || !sameDirectory(directoryIdentityValue, directoryIdentity(currentDirectory))) {
        fail('bundle directory was replaced; cleanup refused');
      }
      assertExactOwnedEntries(directory);

      const cleanupToken = safeTemporaryId(randomUUID());
      cleanupContainer = path.join(
        base.leaseBase,
        `.${directoryName}.cleanup-${cleanupToken}`,
      );
      cleanupContainerCreateStatus = 'unattempted';
      cleanupPhase = 'container-create-uncertain';
      const existingContainer = lstat(fileSystem, cleanupContainer);
      if (existingContainer) {
        cleanupContainerCreateStatus = 'foreign';
        fail('cleanup container candidate already exists; cleanup refused');
      }
      attemptCleanupContainerCreate();
    }

    if (cleanupPhase === 'container-create-uncertain') {
      reconcileCleanupContainerCreate();
    }

    if (cleanupPhase === 'container-ready') {
      claimedDirectory = path.join(cleanupContainer, 'bundle');
      cleanupPhase = 'claim-uncertain';
      fileSystem.renameSync(directory, claimedDirectory);
      cleanupPhase = 'claimed-unverified';
    }

    if (cleanupPhase === 'claim-uncertain') {
      const moved = lstat(fileSystem, claimedDirectory);
      const original = lstat(fileSystem, directory);
      if (moved && !moved.isSymbolicLink() && moved.isDirectory()
        && sameDirectory(directoryIdentityValue, directoryIdentity(moved))) {
        cleanupPhase = 'claimed-unverified';
      } else if (!moved && original && !original.isSymbolicLink() && original.isDirectory()
        && sameDirectory(directoryIdentityValue, directoryIdentity(original))) {
        cleanupPhase = 'container-ready';
        return cleanup();
      } else {
        fail('bundle claim outcome cannot be verified; cleanup refused');
      }
    }

    if (cleanupPhase === 'claimed-unverified') {
      const moved = lstat(fileSystem, claimedDirectory);
      if (!moved || moved.isSymbolicLink() || !moved.isDirectory()
        || !sameDirectory(directoryIdentityValue, directoryIdentity(moved))) {
        fail('bundle claim moved a replaced directory; cleanup refused');
      }
      assertExactOwnedEntries(claimedDirectory, { allowUnlinkProgress: true });
      cleanupPhase = 'claimed';
    }

    base.rootChain.assertCurrent();
    assertDirectory(base.publicDirectory, fileSystem, base.publicIdentity);
    assertDirectory(base.leaseBase, fileSystem, base.baseIdentity);
    if (cleanupPhase !== 'container-rmdir-uncertain') {
      assertDirectory(cleanupContainer, fileSystem, cleanupContainerIdentity);
    }

    if (cleanupPhase === 'claimed') {
      assertDirectory(claimedDirectory, fileSystem, directoryIdentityValue);
      assertExactOwnedEntries(claimedDirectory, { allowUnlinkProgress: true });

      for (const record of ownedFiles.values()) {
        if (record.cleanupState === 'removed') continue;
        const deletePath = path.join(claimedDirectory, record.cleanupName);
        const beforeUnlink = lstat(fileSystem, deletePath);
        if (!beforeUnlink || beforeUnlink.isSymbolicLink() || !beforeUnlink.isFile()
          || !sameDirectory(record.cleanupIdentity, directoryIdentity(beforeUnlink))) {
          fail('bundle cleanup file changed before unlink');
        }
        record.cleanupState = 'unlinking';
        // Node 20 has no unlinkat/rmdirat API. The exclusive 0700 random tombstone removes the
        // attacker-controlled original path and the recursive-delete hazard; the final unlink and
        // rmdir still have an unavoidable same-UID path-check/syscall gap.
        fileSystem.unlinkSync(deletePath);
        record.cleanupState = 'removed';
      }

      assertExactOwnedEntries(claimedDirectory, { allowUnlinkProgress: true });
      cleanupPhase = 'bundle-rmdir-uncertain';
    }

    if (cleanupPhase === 'bundle-rmdir-uncertain') {
      const claimed = lstat(fileSystem, claimedDirectory);
      if (claimed) {
        if (claimed.isSymbolicLink() || !claimed.isDirectory()
          || !sameDirectory(directoryIdentityValue, directoryIdentity(claimed))) {
          fail('bundle tombstone identity changed before rmdir');
        }
        if (fileSystem.readdirSync(claimedDirectory).length !== 0) {
          fail('bundle tombstone contains unexpected files; cleanup refused');
        }
        fileSystem.rmdirSync(claimedDirectory);
      }
      cleanupPhase = 'bundle-removed';
    }

    if (cleanupPhase === 'bundle-removed') {
      if (fileSystem.readdirSync(cleanupContainer).length !== 0) {
        fail('cleanup container contains unexpected files');
      }
      assertDirectory(cleanupContainer, fileSystem, cleanupContainerIdentity);
      cleanupPhase = 'container-rmdir-uncertain';
    }

    if (cleanupPhase === 'container-rmdir-uncertain') {
      const container = lstat(fileSystem, cleanupContainer);
      if (container) {
        if (container.isSymbolicLink() || !container.isDirectory()
          || !sameDirectory(cleanupContainerIdentity, directoryIdentity(container))) {
          fail('cleanup container identity changed before rmdir');
        }
        if (fileSystem.readdirSync(cleanupContainer).length !== 0) {
          fail('cleanup container contains unexpected files');
        }
        fileSystem.rmdirSync(cleanupContainer);
      }
      cleanupPhase = 'cleaned';
    }
  }

  try {
    fileSystem.mkdirSync(directory, { mode: 0o700 });
    const createdDirectory = lstat(fileSystem, directory);
    if (!createdDirectory || createdDirectory.isSymbolicLink() || !createdDirectory.isDirectory()) {
      fail('exclusive bundle directory was not created safely');
    }
    directoryIdentityValue = directoryIdentity(createdDirectory);
    assertDirectory(base.leaseBase, fileSystem, base.baseIdentity);

    const clonedProps = deepClone(props);
    const copiedByIdentity = new Map();
    let sequence = 0;

    function snapshotResolved(resolved, extension, expectedSha = null, mediaRole = null) {
      if (expectedSha !== null && !SHA256.test(expectedSha)) fail('approved SHA-256 is invalid');
      if (mediaRole !== 'image' && mediaRole !== 'video') fail('bundle media role is invalid');
      assertOwnedDirectoryCurrent();
      const tracked = openTracked(resolved, fileSystem);
      try {
        const key = `${tracked.identity.dev}:${tracked.identity.ino}`;
        const existing = copiedByIdentity.get(key);
        if (existing) {
          assertTrackedCurrent(tracked, fileSystem);
          assertOwnedDirectoryCurrent();
          if (existing.extension !== extension || existing.mediaRole !== mediaRole) {
            fail('inode dedup has an incompatible media role or extension');
          }
          if (expectedSha && existing.sha256 !== expectedSha) fail('render media hash mismatch');
          return existing.publicPath;
        }
        sequence += 1;
        const basename = `media-${sequence}${extension}`;
        const destination = path.join(directory, basename);
        const publicPath = path.posix.join('.automontage', directoryName, basename);
        let ownedRecord = null;
        const copied = copyTracked({
          tracked,
          destination,
          fileSystem,
          onCreated(identity) {
            ownedRecord = {
              cleanupIdentity: identity,
              cleanupName: basename,
              cleanupState: 'present',
              identity: null,
              sha256: null,
            };
            ownedFiles.set(basename, ownedRecord);
          },
        });
        ownedRecord.identity = copied.identity;
        ownedRecord.sha256 = copied.sha256;
        assertOwnedDirectoryCurrent();
        if (expectedSha && copied.sha256 !== expectedSha) fail('render media hash mismatch');
        copiedByIdentity.set(key, {
          publicPath,
          sha256: copied.sha256,
          extension,
          mediaRole,
        });
        return publicPath;
      } finally {
        fileSystem.closeSync(tracked.descriptor);
      }
    }

    const sourcePublicPath = snapshotResolved(
      resolveSource(resolvedSourcePath, fileSystem),
      extensionForSource(resolvedSourcePath),
      null,
      'video',
    );
    const originalFaceSrc = props.faceSrc;
    clonedProps.faceSrc = sourcePublicPath;
    clonedProps.audioSrc = sourcePublicPath;
    for (const scene of clonedProps.scenes) {
      if (scene && Object.hasOwn(scene, 'faceSrc')) {
        if (scene.faceSrc !== originalFaceSrc) {
          fail('scene source does not match the approved lesson source');
        }
        scene.faceSrc = sourcePublicPath;
      }
    }

    for (let index = 0; index < approvedBrief.scenes.length; index += 1) {
      const approvedScene = approvedBrief.scenes[index];
      const clonedScene = clonedProps.scenes[index];
      const hasLegacy = approvedScene && Object.hasOwn(approvedScene, 'brollSrc');
      const hasStructured = approvedScene && Object.hasOwn(approvedScene, 'brollMedia');
      if (!clonedScene || clonedScene.scene !== approvedScene?.scene) {
        fail('lesson props do not match the approved brief');
      }
      if (!hasLegacy && Object.hasOwn(clonedScene, 'brollSrc')) {
        fail('lesson props legacy reference does not match the approved brief');
      }
      if (!hasStructured && Object.hasOwn(clonedScene, 'brollMedia')) {
        fail('lesson props structured reference does not match the approved brief');
      }
      if ((hasLegacy || hasStructured) && approvedScene.scene !== 'broll') {
        fail('b-roll media is attached to a non-broll scene');
      }
      if (!hasLegacy && !hasStructured) continue;
      if (hasLegacy) {
        if (clonedScene.brollSrc !== approvedScene.brollSrc) {
          fail('lesson props legacy reference does not match the approved brief');
        }
        extensionForLegacy(approvedScene.brollSrc);
        if (!REMOTE_IMAGE.test(approvedScene.brollSrc)) {
          clonedScene.brollSrc = snapshotResolved(
            resolveBrollReference({
              root, workspace, reference: approvedScene.brollSrc, fileSystem,
            }),
            extensionForLegacy(approvedScene.brollSrc),
            null,
            'image',
          );
        }
      }
      if (hasStructured) {
        const media = approvedScene.brollMedia;
        if (!media || (media.kind !== 'image' && media.kind !== 'video')
          || !isCanonicalBrollReference(media.src) || REMOTE_IMAGE.test(media.src)) {
          fail('structured media reference must be local');
        }
        if (!clonedScene.brollMedia || clonedScene.brollMedia.kind !== media.kind
          || clonedScene.brollMedia.src !== media.src
          || clonedScene.brollMedia.sha256 !== media.sha256) {
          fail('lesson props structured reference does not match the approved brief');
        }
        clonedScene.brollMedia.src = snapshotResolved(
          resolveBrollReference({ root, workspace, reference: media.src, fileSystem }),
          extensionForStructured(media),
          media.sha256,
          media.kind,
        );
      }
    }

    verifyBundleFilesCurrent();

    return {
      props: clonedProps,
      directory,
      cleanup,
      [ASSERT_BUNDLE_CURRENT]: verifyBundleFilesCurrent,
    };
  } catch (error) {
    if (directoryIdentityValue) {
      try {
        cleanup();
      } catch (cleanupError) {
        attachCleanupDiagnostic(error, cleanupError);
      }
    }
    throw error;
  }
}

function withRenderMediaBundle(options, operation) {
  if (typeof operation !== 'function') fail('operation must be a function');
  const lease = prepareRenderMediaBundle(options);
  let operationError = null;
  let operationFailed = false;
  try {
    lease[ASSERT_BUNDLE_CURRENT]();
    return operation(lease);
  } catch (error) {
    operationError = error;
    operationFailed = true;
    throw error;
  } finally {
    try {
      lease.cleanup();
    } catch (cleanupError) {
      if (!operationFailed) throw cleanupError;
      attachCleanupDiagnostic(operationError, cleanupError);
    }
  }
}

module.exports = {
  prepareRenderMediaBundle,
  withRenderMediaBundle,
};
