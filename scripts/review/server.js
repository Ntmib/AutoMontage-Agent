const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomBytes, timingSafeEqual } = require('node:crypto');

const { validateLessonBrief } = require('../lesson/brief');
const {
  readProjectManifest,
  resolveProjectPath,
  saveDraftRevision,
} = require('../project/workspace');
const {
  isAllowedReviewMediaPath,
  resolveReviewAsset,
} = require('./assets');
const { applyReviewCommands, isOpaqueAssetId } = require('./commands');
const { diffLessonBrief } = require('./diff');
const {
  buildReviewStateFromEdit,
  loadReviewBase,
  loadReviewState,
} = require('./model');
const { auditBriefTiming } = require('./timing-audit');
const { ensureWaveformPreview } = require('./waveform');

const BODY_LIMIT = 256 * 1024;
const STATIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/timeline.js', 'timeline.js'],
  ['/player-sync.js', 'player-sync.js'],
  ['/styles.css', 'styles.css'],
]);
const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.aac', 'audio/aac'],
  ['.avif', 'image/avif'],
  ['.flac', 'audio/flac'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.m4a', 'audio/mp4'],
  ['.m4v', 'video/x-m4v'],
  ['.mov', 'video/quicktime'],
  ['.mp3', 'audio/mpeg'],
  ['.mp4', 'video/mp4'],
  ['.ogg', 'audio/ogg'],
  ['.oga', 'audio/ogg'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.wav', 'audio/wav'],
  ['.webm', 'video/webm'],
  ['.webp', 'image/webp'],
]);
const SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
});

function responseHeaders(extra = {}) {
  return { ...SECURITY_HEADERS, ...extra };
}

function send(response, status, body = '', headers = {}, head = false) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  response.writeHead(status, responseHeaders({
    'Content-Length': payload.length,
    ...headers,
  }));
  response.end(head ? undefined : payload);
}

function sendError(response, status, head = false) {
  send(response, status, 'Request rejected', {
    'Content-Type': 'text/plain; charset=utf-8',
  }, head);
}

function sendJson(response, status, value) {
  send(response, status, JSON.stringify(value), {
    'Content-Type': 'application/json; charset=utf-8',
  });
}

class ReviewRequestError extends Error {
  constructor(status, code) {
    super(code);
    this.name = 'ReviewRequestError';
    this.status = status;
    this.code = code;
  }
}

function rejectRequest(status, code) {
  throw new ReviewRequestError(status, code);
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactOwnKeys(value, expectedKeys) {
  if (!isPlainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length || keys.some((key) => typeof key !== 'string')) {
    return false;
  }
  return expectedKeys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return keys.includes(key) && descriptor && Object.hasOwn(descriptor, 'value');
  });
}

function parseEditBody(bytes) {
  let body;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (_) {
    rejectRequest(400, 'MALFORMED_JSON');
  }
  if (!hasExactOwnKeys(body, ['baseRevision', 'baseHash', 'manifestHash', 'commands'])
    || !Number.isSafeInteger(body.baseRevision) || body.baseRevision < 1
    || typeof body.baseHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.baseHash)
    || typeof body.manifestHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.manifestHash)
    || !Array.isArray(body.commands)) {
    rejectRequest(400, 'MALFORMED_EDIT_REQUEST');
  }
  return body;
}

function safeTokenEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

function requestToken(request, url) {
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length);
  }
  return url.pathname.startsWith('/media/') ? url.searchParams.get('token') : null;
}

function isAuthenticated(request, url, token) {
  return safeTokenEqual(requestToken(request, url), token);
}

function hasUnsafePath(requestTarget) {
  const rawPath = String(requestTarget || '').split('?', 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch (_) {
    return true;
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return true;
  return decoded.split('/').some((segment) => segment === '.' || segment === '..');
}

function hasRequestBody(request) {
  return request.headers['content-length'] !== undefined
    || request.headers['transfer-encoding'] !== undefined;
}

function consumeLimitedBody(request, response) {
  if (!hasRequestBody(request)) return Promise.resolve(Buffer.alloc(0));
  const declared = request.headers['content-length'];
  if (declared !== undefined) {
    if (typeof declared !== 'string' || !/^\d+$/.test(declared)) {
      request.resume();
      sendError(response, 400);
      return Promise.resolve(null);
    }
    if (Number(declared) > BODY_LIMIT) {
      request.resume();
      sendError(response, 413);
      return Promise.resolve(null);
    }
  }

  return new Promise((resolve) => {
    let size = 0;
    let rejected = false;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (!rejected && size > BODY_LIMIT) {
        rejected = true;
        sendError(response, 413);
      } else if (!rejected) {
        chunks.push(chunk);
      }
    });
    request.on('end', () => resolve(rejected ? null : Buffer.concat(chunks)));
    request.on('aborted', () => resolve(null));
    request.on('error', () => resolve(null));
  });
}

function collectRegularFiles(directory) {
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch (_) {
    return [];
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return [];

  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => (
      left.name.localeCompare(right.name)
    ));
  } catch (_) {
    return [];
  }
  return entries.flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return collectRegularFiles(entryPath);
    return entry.isFile() ? [entryPath] : [];
  });
}

function snapshotFile(filePath) {
  try {
    const linkStat = fs.lstatSync(filePath);
    if (linkStat.isSymbolicLink() || !linkStat.isFile()) return null;
    const stat = fs.statSync(filePath);
    return { filePath, dev: stat.dev, ino: stat.ino };
  } catch (_) {
    return null;
  }
}

function buildAssetFiles({ root, projectDir, state }) {
  let projectAssets = [];
  try {
    const directory = resolveProjectPath(projectDir, 'assets', {
      label: 'review assets directory',
      mustExist: true,
      type: 'directory',
    });
    projectAssets = collectRegularFiles(directory)
      .filter((filePath) => isAllowedReviewMediaPath(path.relative(directory, filePath)))
      .map((filePath) => ({
        kind: 'project',
        filePath,
        reference: `assets/${path.relative(directory, filePath).split(path.sep).join('/')}`,
      }));
  } catch (_) {
    projectAssets = [];
  }
  const publicDirectory = path.resolve(root, 'public');
  const publicAssets = collectRegularFiles(publicDirectory)
    .filter((filePath) => isAllowedReviewMediaPath(path.relative(publicDirectory, filePath)))
    .map((filePath) => ({
      kind: 'public',
      filePath,
      reference: path.relative(publicDirectory, filePath).split(path.sep).join('/'),
    }));
  const candidates = [...projectAssets, ...publicAssets];
  const mappings = new Map();
  state.assets.forEach((descriptor, index) => {
    const candidate = candidates[index];
    if (candidate && candidate.kind === descriptor.kind
      && path.basename(candidate.filePath) === descriptor.label) {
      const snapshot = snapshotFile(candidate.filePath);
      if (snapshot) mappings.set(descriptor.id, {
        ...snapshot,
        kind: candidate.kind,
        reference: candidate.reference,
      });
    }
  });
  return mappings;
}

function fixedStaticFile(root, pathname) {
  const filename = STATIC_FILES.get(pathname);
  if (!filename) return null;
  const reviewDirectory = path.resolve(root, 'review');
  const filePath = path.join(reviewDirectory, filename);
  try {
    const directoryStat = fs.lstatSync(reviewDirectory);
    const fileStat = fs.lstatSync(filePath);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()
      || fileStat.isSymbolicLink() || !fileStat.isFile()) return null;
    return filePath;
  } catch (_) {
    return null;
  }
}

function contentType(filePath) {
  return CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
}

function parseRange(value, size) {
  if (typeof value !== 'string') return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return false;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || start >= size || end < start) return false;
  return { start, end: Math.min(end, size - 1) };
}

function serveFile(request, response, file) {
  const expected = typeof file === 'string' ? snapshotFile(file) : file;
  let descriptor;
  let stat;
  try {
    if (!expected) throw new Error('missing file');
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    descriptor = fs.openSync(expected.filePath, flags);
    stat = fs.fstatSync(descriptor);
  } catch (_) {
    sendError(response, 404, request.method === 'HEAD');
    return;
  }
  if (!stat.isFile() || stat.dev !== expected.dev || stat.ino !== expected.ino) {
    fs.closeSync(descriptor);
    sendError(response, 404, request.method === 'HEAD');
    return;
  }

  const range = parseRange(request.headers.range, stat.size);
  if (range === false) {
    fs.closeSync(descriptor);
    sendError(response, 416, request.method === 'HEAD');
    return;
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : stat.size - 1;
  const length = stat.size === 0 ? 0 : end - start + 1;
  const headers = responseHeaders({
    'Accept-Ranges': 'bytes',
    'Content-Length': length,
    'Content-Type': contentType(expected.filePath),
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {}),
  });
  response.writeHead(range ? 206 : 200, headers);
  if (request.method === 'HEAD' || stat.size === 0) {
    fs.closeSync(descriptor);
    response.end();
    return;
  }
  const stream = fs.createReadStream(expected.filePath, {
    fd: descriptor,
    autoClose: true,
    start,
    end,
  });
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}

function safeHashEqual(actual, expected) {
  return /^[a-f0-9]{64}$/.test(actual)
    && /^[a-f0-9]{64}$/.test(expected)
    && safeTokenEqual(actual, expected);
}

function currentAssetReference({ root, workspace, assetFiles, assetId }) {
  const registered = assetFiles.get(assetId);
  if (!registered) return null;
  const current = resolveReviewAsset({
    root,
    workspace,
    reference: registered.reference,
    id: assetId,
  });
  if (!current || current.kind !== registered.kind) return null;
  return registered.reference;
}

function assertCurrentReviewAssets({ root, workspace, assetFiles, candidate }) {
  for (const scene of candidate.scenes) {
    if (!isOpaqueAssetId(scene.brollSrc)) continue;
    if (!currentAssetReference({
      root,
      workspace,
      assetFiles,
      assetId: scene.brollSrc,
    })) {
      rejectRequest(422, 'UNRESOLVED_REVIEW_ASSET');
    }
  }
}

function requestStatusForCommandError(error) {
  const message = error && typeof error.message === 'string' ? error.message : '';
  return /boundary seconds|boundary is invalid|produced an invalid lesson brief/.test(message)
    ? 422
    : 400;
}

function replayReviewEdit({ root, projectDir, runtime, body }) {
  const current = loadReviewBase({ projectDir });
  if (current.entry.revision !== body.baseRevision
    || !safeHashEqual(body.baseHash, current.baseHash)
    || !safeHashEqual(body.manifestHash, current.manifestHash)) {
    rejectRequest(409, 'STALE_REVIEW_BASE');
  }

  let candidate;
  try {
    candidate = applyReviewCommands({
      brief: current.brief,
      commands: body.commands,
      assetIds: new Set(runtime.assetFiles.keys()),
    });
  } catch (error) {
    rejectRequest(requestStatusForCommandError(error), 'INVALID_REVIEW_COMMAND');
  }
  assertCurrentReviewAssets({
    root,
    workspace: current.workspace,
    assetFiles: runtime.assetFiles,
    candidate,
  });
  candidate.status = 'draft';
  const validation = validateLessonBrief(candidate);
  if (!validation.ok) rejectRequest(422, 'INVALID_REVIEW_BRIEF');

  let diff;
  try {
    diff = diffLessonBrief({ before: current.brief, after: candidate });
  } catch (_) {
    throw new Error('review edit replay produced an unsupported diff');
  }
  const timing = auditBriefTiming({
    brief: candidate,
    transcript: runtime.state.transcript.segments,
  });
  if (timing.errors.length > 0) rejectRequest(422, 'INVALID_REVIEW_TIMING');
  return { current, candidate, diff, timing };
}

function materializeReviewAssets({ root, current, assetFiles, candidate }) {
  const materialized = structuredClone(candidate);
  for (const scene of materialized.scenes) {
    if (!isOpaqueAssetId(scene.brollSrc)) continue;
    const reference = currentAssetReference({
      root,
      workspace: current.workspace,
      assetFiles,
      assetId: scene.brollSrc,
    });
    if (!reference) rejectRequest(422, 'UNRESOLVED_REVIEW_ASSET');
    scene.brollSrc = reference;
  }
  const validation = validateLessonBrief(materialized);
  if (!validation.ok) rejectRequest(422, 'INVALID_REVIEW_BRIEF');
  const timing = auditBriefTiming({ brief: materialized, transcript: [] });
  if (timing.errors.length > 0) rejectRequest(422, 'INVALID_REVIEW_TIMING');
  return materialized;
}

function browserSafeDiff(diff, assetFiles) {
  return diff.map((change) => {
    if (change.kind === 'boundary') return { ...change };
    if (change.kind !== 'asset') throw new Error('review diff contains an unsafe change');
    let previousId = null;
    for (const [assetId, registered] of assetFiles) {
      if (registered.reference === change.from
        || (registered.kind === 'public' && `public/${registered.reference}` === change.from)) {
        previousId = assetId;
        break;
      }
    }
    return { ...change, from: previousId };
  });
}

function isSaveConflict(error) {
  if (error && error.code === 'PROJECT_MANIFEST_CONFLICT') return true;
  const message = error && typeof error.message === 'string' ? error.message : '';
  return /\bstale\b|changed concurrently|no longer current/.test(message);
}

function sanitizeInternalMessage(error, sensitiveValues) {
  let message = error && typeof error.message === 'string' ? error.message : 'internal error';
  for (const value of sensitiveValues) {
    if (typeof value === 'string' && value.length > 0) message = message.replaceAll(value, '[redacted]');
  }
  return message
    .replace(/(?:[A-Za-z]:\\|\/)[^\s]*/g, '[redacted-path]')
    .slice(0, 300);
}

function logInternalError(logger, error, sensitiveValues) {
  if (!logger || typeof logger.error !== 'function') return;
  try {
    logger.error('Review request failed', {
      name: error && typeof error.name === 'string' ? error.name : 'Error',
      code: error && typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
        ? error.code
        : 'INTERNAL_ERROR',
      message: sanitizeInternalMessage(error, sensitiveValues),
    });
  } catch (_) {
    // Logging must never change the response or expose request data.
  }
}

function handleEditRoute({
  pathname,
  response,
  root,
  projectDir,
  editable,
  runtime,
  bodyBytes,
  fileSystem,
}) {
  if (!editable) rejectRequest(405, 'READ_ONLY_REVIEW');
  const body = parseEditBody(bodyBytes);
  const replay = replayReviewEdit({ root, projectDir, runtime, body });
  if (pathname === '/api/validate') {
    sendJson(response, 200, {
      ok: true,
      diff: browserSafeDiff(replay.diff, runtime.assetFiles),
      timing: replay.timing,
    });
    return;
  }
  if (replay.diff.length === 0) rejectRequest(400, 'EMPTY_REVIEW_DIFF');

  const checked = replayReviewEdit({ root, projectDir, runtime, body });
  if (checked.diff.length === 0) rejectRequest(400, 'EMPTY_REVIEW_DIFF');
  const materialized = materializeReviewAssets({
    root,
    current: checked.current,
    assetFiles: runtime.assetFiles,
    candidate: checked.candidate,
  });
  const nextState = buildReviewStateFromEdit({
    state: runtime.state,
    brief: materialized,
    timing: checked.timing,
  });
  let saved;
  try {
    saved = saveDraftRevision(checked.current.workspace, {
      baseJsonPath: checked.current.briefFilePath,
      brief: materialized,
      fileSystem,
      expectedManifestHash: checked.current.manifestHash,
      expectedBaseHash: checked.current.baseHash,
    });
  } catch (error) {
    if (isSaveConflict(error)) rejectRequest(409, 'STALE_REVIEW_BASE');
    throw error;
  }

  nextState.session = {
    editable: true,
    baseRevision: saved.revision,
    baseHash: saved.baseHash,
    manifestHash: saved.manifestHash,
  };
  runtime.state = nextState;
  sendJson(response, 201, {
    ok: true,
    revision: saved.revision,
    path: saved.relativePath,
    session: nextState.session,
  });
}

async function routeRequest({
  request,
  response,
  token,
  origin,
  root,
  runtime,
  projectDir,
  editable,
  fileSystem,
  sourceFile,
  waveformFile,
}) {
  let url;
  try {
    url = new URL(request.url, origin);
  } catch (_) {
    sendError(response, 400);
    return;
  }
  const pathname = url.pathname;
  const protectedRoute = pathname.startsWith('/api/') || pathname.startsWith('/media/');
  if (protectedRoute && !isAuthenticated(request, url, token)) {
    sendError(response, 401, request.method === 'HEAD');
    return;
  }
  if (hasUnsafePath(request.url)) {
    request.resume();
    sendError(response, 404, request.method === 'HEAD');
    return;
  }

  const safeMethod = request.method === 'GET' || request.method === 'HEAD';
  if (protectedRoute && !safeMethod && request.headers.origin !== origin) {
    request.resume();
    sendError(response, 403);
    return;
  }
  const bodyBytes = await consumeLimitedBody(request, response);
  if (bodyBytes === null) return;
  if (!safeMethod) {
    if (request.method === 'POST'
      && (pathname === '/api/validate' || pathname === '/api/save')) {
      if (!editable) {
        sendError(response, 405);
        return;
      }
      if (typeof request.headers['content-type'] !== 'string'
        || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'])) {
        sendError(response, 400);
        return;
      }
      handleEditRoute({
        pathname,
        response,
        root,
        projectDir,
        editable,
        runtime,
        bodyBytes,
        fileSystem,
      });
      return;
    }
    sendError(response, 405);
    return;
  }

  if (pathname === '/api/state') {
    send(response, 200, JSON.stringify(runtime.state), {
      'Content-Type': 'application/json; charset=utf-8',
    }, request.method === 'HEAD');
    return;
  }
  if (pathname === '/media/source') {
    serveFile(request, response, sourceFile);
    return;
  }
  if (pathname === '/media/waveform') {
    if (!waveformFile) {
      sendError(response, 404, request.method === 'HEAD');
      return;
    }
    serveFile(request, response, waveformFile);
    return;
  }
  const assetMatch = /^\/media\/assets\/(asset-[1-9]\d*)$/.exec(pathname);
  if (assetMatch) {
    const file = runtime.assetFiles.get(assetMatch[1]);
    if (!file) {
      sendError(response, 404, request.method === 'HEAD');
      return;
    }
    serveFile(request, response, file);
    return;
  }
  if (protectedRoute) {
    sendError(response, 404, request.method === 'HEAD');
    return;
  }

  const staticFile = fixedStaticFile(root, pathname);
  if (!staticFile) {
    sendError(response, 404, request.method === 'HEAD');
    return;
  }
  serveFile(request, response, staticFile);
}

function openBrowser(url) {
  let command;
  let args;
  if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (process.platform === 'win32') {
    command = 'rundll32.exe';
    args = ['url.dll,FileProtocolHandler', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  const child = execFile(command, args, { shell: false, windowsHide: true }, () => {});
  child.unref();
}

async function startReviewServer({
  root = path.resolve(__dirname, '../..'),
  projectDir,
  editable = false,
  open = true,
  port = 0,
  runToolImpl,
  fileSystem = fs,
  logger = console,
} = {}) {
  const resolvedRoot = path.resolve(root);
  const resolvedProjectDir = path.resolve(projectDir || '');
  const manifest = readProjectManifest(resolvedProjectDir);
  const sourcePath = resolveProjectPath(resolvedProjectDir, manifest.source.localPath, {
    label: 'review source',
    mustExist: true,
    type: 'file',
  });
  const sourceFile = snapshotFile(sourcePath);
  if (!sourceFile) throw new Error('review source is unavailable');
  const waveformPreview = ensureWaveformPreview({
    workspace: { dir: resolvedProjectDir, manifest },
    sourcePath,
    runToolImpl,
  });
  const waveformFile = waveformPreview.available ? snapshotFile(waveformPreview.path) : null;
  const state = loadReviewState({
    root: resolvedRoot,
    projectDir: resolvedProjectDir,
    editable,
    waveformAvailable: Boolean(waveformFile),
  });
  const assetFiles = buildAssetFiles({
    root: resolvedRoot,
    projectDir: resolvedProjectDir,
    state,
  });
  const runtime = { state, assetFiles };
  const token = randomBytes(32).toString('base64url');
  let origin = 'http://127.0.0.1';
  const server = http.createServer((request, response) => {
    routeRequest({
      request,
      response,
      token,
      origin,
      root: resolvedRoot,
      runtime,
      projectDir: resolvedProjectDir,
      editable: Boolean(editable),
      fileSystem,
      sourceFile,
      waveformFile,
    }).catch((error) => {
      const status = error instanceof ReviewRequestError ? error.status : 500;
      if (status === 500) {
        logInternalError(logger, error, [token, resolvedRoot, resolvedProjectDir]);
      }
      if (!response.headersSent) sendError(response, status);
      else response.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen({ host: '127.0.0.1', port }, () => {
      server.off('error', onError);
      resolve();
    });
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  const url = `${origin}/#token=${token}`;
  if (open) openBrowser(url);
  return { server, token, url, origin };
}

module.exports = {
  parseRange,
  startReviewServer,
};
