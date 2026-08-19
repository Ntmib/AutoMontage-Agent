const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { startReviewServer } = require('../scripts/review/server');
const { makeReviewProject } = require('./helpers/review-project');

function request(session, pathname, {
  token,
  queryToken = false,
  method = 'GET',
  origin,
  body,
  chunked = false,
} = {}) {
  const suffix = queryToken && token
    ? `${pathname.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
    : '';
  const headers = {};
  if (token && !queryToken) headers.authorization = `Bearer ${token}`;
  if (origin) headers.origin = origin;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    if (chunked) headers['transfer-encoding'] = 'chunked';
    else headers['content-length'] = Buffer.byteLength(body);
  }
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      host: '127.0.0.1',
      port: session.server.address().port,
      path: `${pathname}${suffix}`,
      method,
      headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    outgoing.on('error', reject);
    if (body !== undefined && chunked) {
      const split = Math.floor(body.length / 2);
      outgoing.write(body.subarray(0, split));
      outgoing.end(body.subarray(split));
    } else if (body !== undefined) outgoing.end(body);
    else outgoing.end();
  });
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  )));
}

function startTestReviewServer(options) {
  return startReviewServer({
    runToolImpl: () => {
      throw new Error('waveform unavailable in unrelated server test');
    },
    ...options,
  });
}

test('review server binds only to loopback and keeps its token in the URL fragment', async (t) => {
  const { projectDir } = makeReviewProject(t);
  const session = await startTestReviewServer({ root: ROOT, projectDir, open: false });
  t.after(() => closeServer(session.server));

  const address = session.server.address();
  assert.equal(address.address, '127.0.0.1');
  assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    session.url,
    `http://127.0.0.1:${address.port}/#token=${session.token}`,
  );

  const shell = await request(session, '/');
  assert.notEqual(shell.status, 401);
  assert.doesNotMatch(shell.body.toString('utf8'), /#token=|Bearer |baseHash|manifestHash/);
});

test('review API authenticates state and sends defensive response headers', async (t) => {
  const { projectDir } = makeReviewProject(t);
  const session = await startTestReviewServer({ root: ROOT, projectDir, open: false });
  t.after(() => closeServer(session.server));

  assert.equal((await request(session, '/api/state')).status, 401);
  assert.equal((await request(session, '/api/state', { token: 'wrong' })).status, 401);
  assert.equal((await request(session, '/api/state', {
    token: session.token,
    queryToken: true,
  })).status, 401);
  const response = await request(session, '/api/state', { token: session.token });
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.match(response.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal(JSON.parse(response.body.toString('utf8')).project.name, 'Review fixture');
  assert.doesNotMatch(
    response.body.toString('utf8'),
    new RegExp(`${projectDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|${session.token}`),
  );
});

test('review server rejects foreign writes, oversized bodies, and traversal', async (t) => {
  const { projectDir } = makeReviewProject(t);
  const session = await startTestReviewServer({ root: ROOT, projectDir, open: false });
  t.after(() => closeServer(session.server));
  const origin = `http://127.0.0.1:${session.server.address().port}`;

  assert.equal((await request(session, '/api/validate', {
    token: session.token,
    method: 'POST',
    origin: 'https://evil.test',
    body: '{}',
  })).status, 403);
  assert.equal((await request(session, '/api/validate', {
    token: session.token,
    method: 'POST',
    origin,
    body: '{}',
  })).status, 405);
  assert.equal((await request(session, '/api/validate', {
    token: session.token,
    method: 'POST',
    origin,
    body: Buffer.alloc((256 * 1024) + 1, 0x61),
  })).status, 413);
  assert.equal((await request(session, '/', {
    method: 'POST',
    origin,
    body: Buffer.alloc((256 * 1024) + 1, 0x61),
  })).status, 413);
  assert.equal((await request(session, '/../../.env', { token: session.token })).status, 404);
  assert.equal((await request(session, '/api/ignored/../state', {
    token: session.token,
  })).status, 404);
  assert.equal((await request(session, '/api/ignored/%2e%2e/state', {
    token: session.token,
  })).status, 404);
  assert.equal((await request(session, '/package.json', { token: session.token })).status, 404);
  assert.equal((await request(session, '/api/%00', { token: session.token })).status, 404);
});

test('review applies the body limit to declared GET and HEAD requests', async (t) => {
  const { projectDir } = makeReviewProject(t);
  const session = await startTestReviewServer({ root: ROOT, projectDir, open: false });
  t.after(() => closeServer(session.server));
  const oversized = Buffer.alloc((256 * 1024) + 1, 0x61);

  assert.equal((await request(session, '/api/state', { token: session.token })).status, 200);
  assert.equal((await request(session, '/api/state', {
    token: session.token,
    method: 'HEAD',
  })).status, 200);
  assert.equal((await request(session, '/api/state', {
    token: session.token,
    method: 'GET',
    body: oversized,
  })).status, 413);
  assert.equal((await request(session, '/api/state', {
    token: session.token,
    method: 'HEAD',
    body: oversized,
  })).status, 413);
});

test('review applies the body limit to chunked GET and HEAD requests', async (t) => {
  const { projectDir } = makeReviewProject(t);
  const session = await startTestReviewServer({ root: ROOT, projectDir, open: false });
  t.after(() => closeServer(session.server));
  const oversized = Buffer.alloc((256 * 1024) + 1, 0x61);

  assert.equal((await request(session, '/api/state', {
    token: session.token,
    method: 'GET',
    body: oversized,
    chunked: true,
  })).status, 413);
  assert.equal((await request(session, '/api/state', {
    token: session.token,
    method: 'HEAD',
    body: oversized,
    chunked: true,
  })).status, 413);
});

test('review media requires authentication and resolves only opaque handles', async (t) => {
  const { projectDir, workspace } = makeReviewProject(t);
  const assetPath = path.join(workspace.dir, 'assets', 'broll', 'diagram.png');
  fs.writeFileSync(assetPath, 'project asset fixture');
  const session = await startTestReviewServer({ root: ROOT, projectDir, open: false });
  t.after(() => closeServer(session.server));

  assert.equal((await request(session, '/media/source')).status, 401);
  const source = await request(session, '/media/source', { token: session.token });
  assert.equal(source.status, 200);
  assert.equal(source.body.toString('utf8'), 'video fixture');

  const stateResponse = await request(session, '/api/state', { token: session.token });
  const state = JSON.parse(stateResponse.body.toString('utf8'));
  const descriptor = state.assets.find((asset) => asset.label === 'diagram.png');
  assert.ok(descriptor);
  assert.match(descriptor.url, /^\/media\/assets\/asset-[1-9]\d*$/);
  assert.equal((await request(session, descriptor.url)).status, 401);
  const asset = await request(session, descriptor.url, {
    token: session.token,
    queryToken: true,
  });
  assert.equal(asset.status, 200);
  assert.equal(asset.body.toString('utf8'), 'project asset fixture');
  assert.equal((await request(session, '/media/assets/../../project.json', {
    token: session.token,
  })).status, 404);
});

test('review waveform is optional, token-protected, and exposes no cache path', async (t) => {
  const { projectDir } = makeReviewProject(t);
  const session = await startReviewServer({
    root: ROOT,
    projectDir,
    open: false,
    runToolImpl: (_command, args) => fs.writeFileSync(args.at(-1), 'waveform fixture'),
  });
  t.after(() => closeServer(session.server));

  const stateResponse = await request(session, '/api/state', { token: session.token });
  const stateBody = stateResponse.body.toString('utf8');
  assert.deepEqual(JSON.parse(stateBody).waveform, { url: '/media/waveform' });
  assert.doesNotMatch(JSON.stringify(JSON.parse(stateBody).waveform), /previews|review-waveform-[a-f0-9]|\.png/);
  assert.equal((await request(session, '/media/waveform')).status, 401);
  const waveform = await request(session, '/media/waveform', { token: session.token });
  assert.equal(waveform.status, 200);
  assert.equal(waveform.headers['content-type'], 'image/png');
  assert.equal(waveform.body.toString('utf8'), 'waveform fixture');
});

test('review starts with null waveform when generation fails', async (t) => {
  const { projectDir } = makeReviewProject(t);
  const session = await startReviewServer({
    root: ROOT,
    projectDir,
    open: false,
    runToolImpl: () => {
      throw new Error('ffmpeg unavailable');
    },
  });
  t.after(() => closeServer(session.server));

  const stateResponse = await request(session, '/api/state', { token: session.token });
  assert.equal(stateResponse.status, 200);
  assert.equal(JSON.parse(stateResponse.body.toString('utf8')).waveform, null);
  assert.equal((await request(session, '/media/waveform', { token: session.token })).status, 404);
});

test('review waveform fails closed if its cache file is replaced after startup', async (t) => {
  const { root, projectDir, workspace } = makeReviewProject(t);
  const session = await startReviewServer({
    root: ROOT,
    projectDir,
    open: false,
    runToolImpl: (_command, args) => fs.writeFileSync(args.at(-1), 'waveform fixture'),
  });
  t.after(() => closeServer(session.server));
  const waveformName = fs.readdirSync(path.join(workspace.dir, 'previews'))
    .find((name) => /^review-waveform-[a-f0-9]{64}\.png$/.test(name));
  assert.ok(waveformName);
  const waveformPath = path.join(workspace.dir, 'previews', waveformName);
  const outsidePath = path.join(root, 'private-waveform.png');
  fs.writeFileSync(outsidePath, 'private fixture');
  fs.unlinkSync(waveformPath);
  fs.symlinkSync(outsidePath, waveformPath);

  const response = await request(session, '/media/waveform', { token: session.token });
  assert.equal(response.status, 404);
  assert.doesNotMatch(response.body.toString('utf8'), /private fixture/);
});

test('review advertises and serves only explicit non-hidden media types', async (t) => {
  const { projectDir, workspace } = makeReviewProject(t);
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-review-root-'));
  fs.mkdirSync(path.join(repository, 'public'));
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  const assets = path.join(workspace.dir, 'assets', 'broll');
  fs.writeFileSync(path.join(assets, '.env'), 'PRIVATE_VALUE=secret');
  fs.writeFileSync(path.join(assets, '.hidden.png'), 'hidden image');
  fs.writeFileSync(path.join(assets, 'diagram.png'), 'safe image');
  fs.writeFileSync(path.join(assets, 'payload.svg'), '<svg><script>alert(1)</script></svg>');
  fs.writeFileSync(path.join(assets, 'page.html'), '<script>alert(1)</script>');

  const session = await startTestReviewServer({ root: repository, projectDir, open: false });
  t.after(() => closeServer(session.server));
  const stateResponse = await request(session, '/api/state', { token: session.token });
  const state = JSON.parse(stateResponse.body.toString('utf8'));

  assert.deepEqual(state.assets.map((asset) => asset.label), ['diagram.png']);
  const safe = await request(session, state.assets[0].url, { token: session.token });
  assert.equal(safe.status, 200);
  assert.equal(safe.body.toString('utf8'), 'safe image');
  for (const id of ['asset-2', 'asset-3', 'asset-4', 'asset-5']) {
    assert.equal((await request(session, `/media/assets/${id}`, {
      token: session.token,
    })).status, 404);
  }
});

test('review media fails closed if an allowed asset is replaced after startup', async (t) => {
  const { root, projectDir, workspace } = makeReviewProject(t);
  const assetPath = path.join(workspace.dir, 'assets', 'broll', 'diagram.png');
  const outsidePath = path.join(root, 'private.txt');
  fs.writeFileSync(assetPath, 'allowed asset');
  fs.writeFileSync(outsidePath, 'private fixture');
  const session = await startTestReviewServer({ root: ROOT, projectDir, open: false });
  t.after(() => closeServer(session.server));

  const stateResponse = await request(session, '/api/state', { token: session.token });
  const state = JSON.parse(stateResponse.body.toString('utf8'));
  const descriptor = state.assets.find((asset) => asset.label === 'diagram.png');
  assert.ok(descriptor);

  fs.rmSync(assetPath);
  fs.symlinkSync(outsidePath, assetPath);
  const response = await request(session, descriptor.url, { token: session.token });
  assert.equal(response.status, 404);
  assert.doesNotMatch(response.body.toString('utf8'), /private fixture/);
});
