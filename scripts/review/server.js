const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomBytes, timingSafeEqual } = require('node:crypto');

const { readProjectManifest, resolveProjectPath } = require('../project/workspace');
const { isAllowedReviewMediaPath } = require('./assets');
const { loadReviewState } = require('./model');

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
  if (!hasRequestBody(request)) return Promise.resolve(true);
  const declared = request.headers['content-length'];
  if (declared !== undefined) {
    if (typeof declared !== 'string' || !/^\d+$/.test(declared)) {
      request.resume();
      sendError(response, 400);
      return Promise.resolve(false);
    }
    if (Number(declared) > BODY_LIMIT) {
      request.resume();
      sendError(response, 413);
      return Promise.resolve(false);
    }
  }

  return new Promise((resolve) => {
    let size = 0;
    let rejected = false;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (!rejected && size > BODY_LIMIT) {
        rejected = true;
        sendError(response, 413);
      }
    });
    request.on('end', () => resolve(!rejected));
    request.on('aborted', () => resolve(false));
    request.on('error', () => resolve(false));
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
      .map((filePath) => ({ kind: 'project', filePath }));
  } catch (_) {
    projectAssets = [];
  }
  const publicDirectory = path.resolve(root, 'public');
  const publicAssets = collectRegularFiles(publicDirectory)
    .filter((filePath) => isAllowedReviewMediaPath(path.relative(publicDirectory, filePath)))
    .map((filePath) => ({ kind: 'public', filePath }));
  const candidates = [...projectAssets, ...publicAssets];
  const mappings = new Map();
  state.assets.forEach((descriptor, index) => {
    const candidate = candidates[index];
    if (candidate && candidate.kind === descriptor.kind
      && path.basename(candidate.filePath) === descriptor.label) {
      const snapshot = snapshotFile(candidate.filePath);
      if (snapshot) mappings.set(descriptor.id, snapshot);
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

async function routeRequest({
  request,
  response,
  token,
  origin,
  root,
  state,
  sourceFile,
  assetFiles,
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
  if (!await consumeLimitedBody(request, response)) return;
  if (!safeMethod) {
    sendError(response, 405);
    return;
  }

  if (pathname === '/api/state') {
    send(response, 200, JSON.stringify(state), {
      'Content-Type': 'application/json; charset=utf-8',
    }, request.method === 'HEAD');
    return;
  }
  if (pathname === '/media/source') {
    serveFile(request, response, sourceFile);
    return;
  }
  const assetMatch = /^\/media\/assets\/(asset-[1-9]\d*)$/.exec(pathname);
  if (assetMatch) {
    const file = assetFiles.get(assetMatch[1]);
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
} = {}) {
  const resolvedRoot = path.resolve(root);
  const resolvedProjectDir = path.resolve(projectDir || '');
  const state = loadReviewState({
    root: resolvedRoot,
    projectDir: resolvedProjectDir,
    editable,
  });
  const manifest = readProjectManifest(resolvedProjectDir);
  const sourcePath = resolveProjectPath(resolvedProjectDir, manifest.source.localPath, {
    label: 'review source',
    mustExist: true,
    type: 'file',
  });
  const sourceFile = snapshotFile(sourcePath);
  if (!sourceFile) throw new Error('review source is unavailable');
  const assetFiles = buildAssetFiles({
    root: resolvedRoot,
    projectDir: resolvedProjectDir,
    state,
  });
  const token = randomBytes(32).toString('base64url');
  let origin = 'http://127.0.0.1';
  const server = http.createServer((request, response) => {
    routeRequest({
      request,
      response,
      token,
      origin,
      root: resolvedRoot,
      state,
      sourceFile,
      assetFiles,
    }).catch(() => {
      if (!response.headersSent) sendError(response, 500);
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
