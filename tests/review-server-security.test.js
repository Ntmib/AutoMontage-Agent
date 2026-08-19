const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
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
} = {}) {
  const suffix = queryToken && token
    ? `${pathname.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
    : '';
  const headers = {};
  if (token && !queryToken) headers.authorization = `Bearer ${token}`;
  if (origin) headers.origin = origin;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(body);
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
    if (body !== undefined) outgoing.end(body);
    else outgoing.end();
  });
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  )));
}

test('review server binds only to loopback and keeps its token in the URL fragment', async (t) => {
  const { projectDir } = makeReviewProject(t);
  const session = await startReviewServer({ root: ROOT, projectDir, open: false });
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
  const session = await startReviewServer({ root: ROOT, projectDir, open: false });
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
  const session = await startReviewServer({ root: ROOT, projectDir, open: false });
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

test('review media requires authentication and resolves only opaque handles', async (t) => {
  const { projectDir, workspace } = makeReviewProject(t);
  const assetPath = path.join(workspace.dir, 'assets', 'broll', 'diagram.png');
  fs.writeFileSync(assetPath, 'project asset fixture');
  const session = await startReviewServer({ root: ROOT, projectDir, open: false });
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

test('review media fails closed if an allowed asset is replaced after startup', async (t) => {
  const { root, projectDir, workspace } = makeReviewProject(t);
  const assetPath = path.join(workspace.dir, 'assets', 'broll', 'diagram.png');
  const outsidePath = path.join(root, 'private.txt');
  fs.writeFileSync(assetPath, 'allowed asset');
  fs.writeFileSync(outsidePath, 'private fixture');
  const session = await startReviewServer({ root: ROOT, projectDir, open: false });
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
