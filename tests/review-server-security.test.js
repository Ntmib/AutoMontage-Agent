const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { startReviewServer } = require('../scripts/review/server');
const { makeReviewProject, registerHigherBrief } = require('./helpers/review-project');

function request(session, pathname, {
  token,
  queryToken = false,
  method = 'GET',
  origin,
  body,
  chunked = false,
  contentType = 'application/json',
} = {}) {
  const suffix = queryToken && token
    ? `${pathname.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
    : '';
  const headers = {};
  if (token && !queryToken) headers.authorization = `Bearer ${token}`;
  if (origin) headers.origin = origin;
  if (body !== undefined) {
    headers['content-type'] = contentType;
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

function jsonBody(value) {
  return JSON.stringify(value);
}

async function editablePayload(session, commands = [{
  type: 'move-boundary',
  leftSceneIndex: 0,
  seconds: 2.2,
}]) {
  const response = await request(session, '/api/state', { token: session.token });
  assert.equal(response.status, 200);
  const state = JSON.parse(response.body.toString('utf8'));
  return {
    state,
    payload: {
      baseRevision: state.session.baseRevision,
      baseHash: state.session.baseHash,
      manifestHash: state.session.manifestHash,
      commands,
    },
  };
}

function postJson(session, pathname, value, overrides = {}) {
  return request(session, pathname, {
    token: session.token,
    method: 'POST',
    origin: session.origin,
    body: jsonBody(value),
    ...overrides,
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

test('review edit routes authenticate and exist only in editable sessions', async (t) => {
  const readOnlyProject = makeReviewProject(t);
  const readOnly = await startTestReviewServer({
    root: ROOT,
    projectDir: readOnlyProject.projectDir,
    open: false,
  });
  t.after(() => closeServer(readOnly.server));
  const { payload: readOnlyPayload } = await editablePayload(readOnly);

  assert.equal((await postJson(readOnly, '/api/validate', readOnlyPayload)).status, 405);
  assert.equal((await postJson(readOnly, '/api/save', readOnlyPayload)).status, 405);
  assert.equal((await request(readOnly, '/api/save', {
    token: readOnly.token,
    method: 'POST',
    origin: readOnly.origin,
    body: '{',
    contentType: 'text/plain',
  })).status, 405);

  const editableProject = makeReviewProject(t);
  const editable = await startTestReviewServer({
    root: ROOT,
    projectDir: editableProject.projectDir,
    editable: true,
    open: false,
  });
  t.after(() => closeServer(editable.server));
  const { payload } = await editablePayload(editable);
  const malformed = '{"baseRevision":';

  assert.equal((await request(editable, '/api/validate', {
    token: 'wrong',
    method: 'POST',
    origin: editable.origin,
    body: malformed,
  })).status, 401);
  assert.equal((await request(editable, '/api/validate', {
    token: editable.token,
    method: 'POST',
    origin: 'https://evil.test',
    body: malformed,
  })).status, 403);
  assert.equal((await postJson(editable, '/api/validate', payload)).status, 200);
});

test('review edit routes reject malformed, extra, path-bearing and unknown JSON', async (t) => {
  const { projectDir } = makeReviewProject(t);
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir,
    editable: true,
    open: false,
  });
  t.after(() => closeServer(session.server));
  const { payload } = await editablePayload(session);
  const malformedBodies = [
    '{',
    jsonBody({ ...payload, brief: { source: '/fixture-host/private/source.mov' } }),
    jsonBody({ ...payload, projectDir: '/fixture-host/private/project' }),
    jsonBody({ ...payload, ['__proto__']: { polluted: true } }),
    jsonBody({
      ...payload,
      commands: [{
        type: 'move-boundary',
        leftSceneIndex: 0,
        seconds: 2.2,
        path: '/fixture-host/private/source.mov',
      }],
    }),
    jsonBody({ ...payload, commands: [{ type: 'delete-project' }] }),
  ];

  for (const body of malformedBodies) {
    const response = await request(session, '/api/validate', {
      token: session.token,
      method: 'POST',
      origin: session.origin,
      body,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.toString('utf8'), 'Request rejected');
    assert.doesNotMatch(response.body.toString('utf8'), /Users|private|delete-project/);
  }
  assert.equal((await request(session, '/api/validate', {
    token: session.token,
    method: 'POST',
    origin: session.origin,
    body: jsonBody(payload),
    contentType: 'text/plain',
  })).status, 400);
});

test('review edit routes reject stale revisions and disk hashes', async (t) => {
  const revisionProject = makeReviewProject(t);
  const revisionSession = await startTestReviewServer({
    root: ROOT,
    projectDir: revisionProject.projectDir,
    editable: true,
    open: false,
  });
  t.after(() => closeServer(revisionSession.server));
  const { payload: revisionPayload } = await editablePayload(revisionSession);
  assert.equal((await postJson(revisionSession, '/api/validate', {
    ...revisionPayload,
    baseRevision: revisionPayload.baseRevision + 1,
  })).status, 409);

  const briefProject = makeReviewProject(t);
  const briefSession = await startTestReviewServer({
    root: ROOT,
    projectDir: briefProject.projectDir,
    editable: true,
    open: false,
  });
  t.after(() => closeServer(briefSession.server));
  const { payload: briefPayload } = await editablePayload(briefSession);
  const brief = JSON.parse(fs.readFileSync(briefProject.briefPath, 'utf8'));
  brief.scenes[0].caption = 'ИЗМЕНЕНО НА ДИСКЕ';
  fs.writeFileSync(briefProject.briefPath, `${JSON.stringify(brief, null, 2)}\n`);
  assert.equal((await postJson(briefSession, '/api/save', briefPayload)).status, 409);

  const manifestProject = makeReviewProject(t);
  const manifestSession = await startTestReviewServer({
    root: ROOT,
    projectDir: manifestProject.projectDir,
    editable: true,
    open: false,
  });
  t.after(() => closeServer(manifestSession.server));
  const { payload: manifestPayload } = await editablePayload(manifestSession);
  const manifestPath = path.join(manifestProject.projectDir, 'project.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.name = 'Changed concurrently';
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.equal((await postJson(manifestSession, '/api/validate', manifestPayload)).status, 409);
});

test('review validate reports safe diff and timing without writing files', async (t) => {
  const { projectDir } = makeReviewProject(t);
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir,
    editable: true,
    open: false,
  });
  t.after(() => closeServer(session.server));
  const { payload } = await editablePayload(session);
  const beforeManifest = fs.readFileSync(path.join(projectDir, 'project.json'));
  const beforeBriefNames = fs.readdirSync(path.join(projectDir, 'brief')).sort();

  const response = await postJson(session, '/api/validate', payload);

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body.toString('utf8')), {
    ok: true,
    destinationRevision: 2,
    diff: [{ kind: 'boundary', leftScene: 0, rightScene: 1, from: 2, to: 2.2 }],
    timing: { errors: [], warnings: [], suggestions: [] },
  });
  assert.deepEqual(fs.readFileSync(path.join(projectDir, 'project.json')), beforeManifest);
  assert.deepEqual(fs.readdirSync(path.join(projectDir, 'brief')).sort(), beforeBriefNames);
  assert.doesNotMatch(response.body.toString('utf8'), /Users|projectDir|source\.mov/);
});

test('review validate allocates its destination above the highest registered revision', async (t) => {
  const fixture = makeReviewProject(t);
  registerHigherBrief(fixture, { revision: 5 });
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir: fixture.projectDir,
    editable: true,
    open: false,
  });
  t.after(() => closeServer(session.server));
  const { state, payload } = await editablePayload(session);

  const response = await postJson(session, '/api/validate', payload);

  assert.equal(state.session.baseRevision, 1);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body.toString('utf8')).destinationRevision, 6);
  assert.doesNotMatch(response.body.toString('utf8'), /brief\/v05|Users|projectDir/);
});

test('review save rejects invalid timing and no-op commands without writing', async (t) => {
  const { projectDir } = makeReviewProject(t);
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir,
    editable: true,
    open: false,
  });
  t.after(() => closeServer(session.server));
  const { payload } = await editablePayload(session);
  const beforeManifest = fs.readFileSync(path.join(projectDir, 'project.json'));
  const beforeBriefNames = fs.readdirSync(path.join(projectDir, 'brief')).sort();

  assert.equal((await postJson(session, '/api/validate', {
    ...payload,
    commands: [{ type: 'move-boundary', leftSceneIndex: 0, seconds: 4 }],
  })).status, 422);
  assert.equal((await postJson(session, '/api/save', {
    ...payload,
    commands: [],
  })).status, 400);
  assert.deepEqual(fs.readFileSync(path.join(projectDir, 'project.json')), beforeManifest);
  assert.deepEqual(fs.readdirSync(path.join(projectDir, 'brief')).sort(), beforeBriefNames);
});

test('review save materializes project and public broll ids into canonical references', async (t) => {
  const { projectDir, briefPath, workspace } = makeReviewProject(t);
  const projectAssets = path.join(workspace.dir, 'assets', 'broll');
  fs.writeFileSync(path.join(projectAssets, 'diagram.png'), 'base asset');
  fs.writeFileSync(path.join(projectAssets, 'replacement.png'), 'replacement asset');
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-review-repository-'));
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repository, 'public', 'broll'), { recursive: true });
  fs.writeFileSync(path.join(repository, 'public', 'broll', 'public.png'), 'public asset');
  const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
  brief.scenes = [
    {
      scene: 'broll',
      start: 0,
      end: 2,
      brollSrc: 'assets/broll/diagram.png',
      headCream: 'ПЕРВАЯ',
      headOrange: 'СХЕМА',
    },
    {
      scene: 'broll',
      start: 2,
      end: 4,
      brollSrc: 'assets/broll/diagram.png',
      headCream: 'ВТОРАЯ',
      headOrange: 'СХЕМА',
    },
  ];
  fs.writeFileSync(briefPath, `${JSON.stringify(brief, null, 2)}\n`);
  const session = await startTestReviewServer({
    root: repository,
    projectDir,
    editable: true,
    open: false,
  });
  t.after(() => closeServer(session.server));
  const stateResponse = await request(session, '/api/state', { token: session.token });
  const state = JSON.parse(stateResponse.body.toString('utf8'));
  assert.deepEqual(state.assets.map(({ id, kind, label }) => ({ id, kind, label })), [
    { id: 'asset-1', kind: 'project', label: 'diagram.png' },
    { id: 'asset-2', kind: 'project', label: 'replacement.png' },
    { id: 'asset-3', kind: 'public', label: 'public.png' },
  ]);
  const payload = {
    baseRevision: state.session.baseRevision,
    baseHash: state.session.baseHash,
    manifestHash: state.session.manifestHash,
    commands: [
      { type: 'replace-broll', sceneIndex: 0, assetId: 'asset-2' },
      { type: 'replace-broll', sceneIndex: 1, assetId: 'asset-3' },
    ],
  };

  const validationResponse = await postJson(session, '/api/validate', payload);
  assert.equal(validationResponse.status, 200);
  assert.deepEqual(JSON.parse(validationResponse.body.toString('utf8')).diff, [
    { kind: 'asset', scene: 0, from: 'asset-1', to: 'asset-2' },
    { kind: 'asset', scene: 1, from: 'asset-1', to: 'asset-3' },
  ]);
  assert.doesNotMatch(
    validationResponse.body.toString('utf8'),
    /assets\/broll|broll\/public|Users|\/media\//,
  );

  const response = await postJson(session, '/api/save', payload);

  assert.equal(response.status, 201);
  const result = JSON.parse(response.body.toString('utf8'));
  const saved = JSON.parse(fs.readFileSync(path.join(projectDir, result.path), 'utf8'));
  assert.equal(saved.scenes[0].brollSrc, 'assets/broll/replacement.png');
  assert.equal(saved.scenes[1].brollSrc, 'broll/public.png');
  assert.doesNotMatch(JSON.stringify(saved), /asset-[1-9]|\/media\//);
  assert.doesNotMatch(response.body.toString('utf8'), /Users|asset-[1-9]|\/media\//);
});

test('review save creates a draft and advances the browser-safe session state', async (t) => {
  const { projectDir } = makeReviewProject(t);
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir,
    editable: true,
    open: false,
  });
  t.after(() => closeServer(session.server));
  const { state: beforeState, payload } = await editablePayload(session);

  const response = await postJson(session, '/api/save', payload);

  assert.equal(response.status, 201);
  const result = JSON.parse(response.body.toString('utf8'));
  assert.equal(result.ok, true);
  assert.equal(result.revision, 2);
  assert.equal(result.path, 'brief/v02-draft.lesson.json');
  assert.equal(result.session.editable, true);
  assert.equal(result.session.baseRevision, 2);
  assert.match(result.session.baseHash, /^[a-f0-9]{64}$/);
  assert.match(result.session.manifestHash, /^[a-f0-9]{64}$/);
  assert.notEqual(result.session.baseHash, beforeState.session.baseHash);
  assert.notEqual(result.session.manifestHash, beforeState.session.manifestHash);
  assert.doesNotMatch(response.body.toString('utf8'), /Users|projectDir|source\.mov/);
  const saved = JSON.parse(fs.readFileSync(path.join(projectDir, result.path), 'utf8'));
  assert.equal(saved.status, 'draft');
  assert.equal(saved.scenes[0].end, 2.2);
  assert.equal(saved.scenes[1].start, 2.2);

  const nextStateResponse = await request(session, '/api/state', { token: session.token });
  const nextState = JSON.parse(nextStateResponse.body.toString('utf8'));
  assert.deepEqual(nextState.session, result.session);
  assert.equal(nextState.brief.scenes[0].end, 2.2);
  assert.equal((await postJson(session, '/api/save', payload)).status, 409);
});

test('review save rejects a manifest changed after replay but before its atomic snapshot', async (t) => {
  const { projectDir } = makeReviewProject(t);
  const manifestPath = path.join(projectDir, 'project.json');
  const beforeBriefNames = fs.readdirSync(path.join(projectDir, 'brief')).sort();
  let foreignManifestBytes = null;
  let injected = false;
  const racingFileSystem = {
    ...fs,
    readFileSync(target, options) {
      if (!injected && path.resolve(target) === manifestPath) {
        injected = true;
        const foreignManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        foreignManifest.name = 'Foreign concurrent manifest';
        foreignManifest.updatedAt = '2026-08-20T15:00:00.000Z';
        foreignManifestBytes = Buffer.from(`${JSON.stringify(foreignManifest, null, 2)}\n`);
        fs.writeFileSync(manifestPath, foreignManifestBytes);
      }
      return fs.readFileSync(target, options);
    },
  };
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir,
    editable: true,
    open: false,
    fileSystem: racingFileSystem,
  });
  t.after(() => closeServer(session.server));
  const { state: beforeState, payload } = await editablePayload(session);

  const response = await postJson(session, '/api/save', payload);

  assert.equal(injected, true);
  assert.equal(response.status, 409);
  assert.equal(response.body.toString('utf8'), 'Request rejected');
  assert.deepEqual(fs.readFileSync(manifestPath), foreignManifestBytes);
  assert.deepEqual(fs.readdirSync(path.join(projectDir, 'brief')).sort(), beforeBriefNames);
  const stateResponse = await request(session, '/api/state', { token: session.token });
  assert.deepEqual(JSON.parse(stateResponse.body.toString('utf8')).session, beforeState.session);
});

test('review save advances in-memory state without fallible disk reload after commit', async (t) => {
  const { projectDir, workspace } = makeReviewProject(t);
  const transcriptPath = path.join(workspace.dir, workspace.manifest.transcript.words);
  let transcriptRemovedAfterCommit = false;
  const postCommitFileSystem = {
    ...fs,
    renameSync(source, target) {
      const result = fs.renameSync(source, target);
      if (!transcriptRemovedAfterCommit && source.includes('.tmp-review-draft-json-')) {
        fs.unlinkSync(transcriptPath);
        transcriptRemovedAfterCommit = true;
      }
      return result;
    },
  };
  const logs = [];
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir,
    editable: true,
    open: false,
    fileSystem: postCommitFileSystem,
    logger: { error: (...args) => logs.push(args) },
  });
  t.after(() => closeServer(session.server));
  const { payload } = await editablePayload(session);

  const response = await postJson(session, '/api/save', payload);

  assert.equal(transcriptRemovedAfterCommit, true);
  assert.equal(fs.existsSync(transcriptPath), false);
  assert.equal(response.status, 201);
  const result = JSON.parse(response.body.toString('utf8'));
  assert.equal(result.revision, 2);
  assert.equal(result.session.baseRevision, 2);
  assert.equal(logs.length, 0);
  const manifest = JSON.parse(fs.readFileSync(path.join(projectDir, 'project.json'), 'utf8'));
  assert.equal(manifest.currentBrief, result.path);
  const stateResponse = await request(session, '/api/state', { token: session.token });
  const state = JSON.parse(stateResponse.body.toString('utf8'));
  assert.deepEqual(state.session, result.session);
  assert.equal(state.brief.scenes[0].end, 2.2);
  assert.equal(state.brief.scenes[1].start, 2.2);
});

test('review save advances session when only post-commit temp cleanup fails', async (t) => {
  const { projectDir } = makeReviewProject(t);
  let jsonCommitted = false;
  let cleanupAttempted = false;
  const postCommitCleanupFailureFs = {
    ...fs,
    renameSync(source, target) {
      const result = fs.renameSync(source, target);
      if (source.includes('.tmp-review-draft-json-')) jsonCommitted = true;
      return result;
    },
    unlinkSync(target) {
      if (jsonCommitted && target.includes('.tmp-review-draft-rollback-')) {
        cleanupAttempted = true;
        throw new Error('simulated post-commit cleanup failure');
      }
      return fs.unlinkSync(target);
    },
  };
  const logs = [];
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir,
    editable: true,
    open: false,
    fileSystem: postCommitCleanupFailureFs,
    logger: { error: (...args) => logs.push(args) },
  });
  t.after(() => closeServer(session.server));
  const { payload } = await editablePayload(session);

  const response = await postJson(session, '/api/save', payload);

  assert.equal(jsonCommitted, true);
  assert.equal(cleanupAttempted, true);
  assert.equal(response.status, 201);
  const result = JSON.parse(response.body.toString('utf8'));
  assert.equal(result.revision, 2);
  assert.equal(result.session.baseRevision, 2);
  assert.equal(logs.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(projectDir, 'project.json'), 'utf8')).currentBrief,
    result.path);
  const stateResponse = await request(session, '/api/state', { token: session.token });
  assert.deepEqual(JSON.parse(stateResponse.body.toString('utf8')).session, result.session);
  assert.ok(fs.readdirSync(projectDir).some((name) => (
    name.includes('.tmp-review-draft-rollback-')
  )));
});

test('review distinguishes unavailable registered assets from unknown ids', async (t) => {
  const { projectDir, briefPath, workspace } = makeReviewProject(t);
  const assetsDirectory = path.join(workspace.dir, 'assets', 'broll');
  const baseAssetPath = path.join(assetsDirectory, 'base.png');
  const unavailableAssetPath = path.join(assetsDirectory, 'gone.png');
  fs.writeFileSync(baseAssetPath, 'base asset');
  fs.writeFileSync(unavailableAssetPath, 'registered at startup');
  const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
  brief.scenes[1] = {
    scene: 'broll',
    start: 2,
    end: 4,
    brollSrc: 'assets/broll/base.png',
    headCream: 'БАЗОВАЯ',
    headOrange: 'СХЕМА',
  };
  fs.writeFileSync(briefPath, `${JSON.stringify(brief, null, 2)}\n`);
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir,
    editable: true,
    open: false,
  });
  t.after(() => closeServer(session.server));
  const stateResponse = await request(session, '/api/state', { token: session.token });
  const state = JSON.parse(stateResponse.body.toString('utf8'));
  const unavailable = state.assets.find((asset) => asset.label === 'gone.png');
  assert.ok(unavailable);
  fs.unlinkSync(unavailableAssetPath);
  const payload = {
    baseRevision: state.session.baseRevision,
    baseHash: state.session.baseHash,
    manifestHash: state.session.manifestHash,
    commands: [{ type: 'replace-broll', sceneIndex: 1, assetId: unavailable.id }],
  };

  assert.equal((await postJson(session, '/api/validate', payload)).status, 422);
  assert.equal((await postJson(session, '/api/save', payload)).status, 422);
  assert.equal((await postJson(session, '/api/validate', {
    ...payload,
    commands: [{ type: 'replace-broll', sceneIndex: 1, assetId: 'asset-999999' }],
  })).status, 400);
  assert.equal((await postJson(session, '/api/validate', {
    ...payload,
    commands: [{ type: 'replace-broll', sceneIndex: 1, assetId: '../gone.png' }],
  })).status, 400);
  assert.equal(JSON.parse(fs.readFileSync(path.join(projectDir, 'project.json'), 'utf8')).currentBrief,
    workspace.manifest.currentBrief);
});

test('review save returns a fixed 500 and preserves state on an injected filesystem failure', async (t) => {
  const { projectDir } = makeReviewProject(t);
  const internalPath = path.join(projectDir, 'private-save-target.json');
  const logs = [];
  const failingFileSystem = {
    ...fs,
    renameSync(source, target) {
      if (source.includes('.tmp-review-draft-manifest-')) {
        throw new Error(`simulated save failure at ${internalPath}`);
      }
      return fs.renameSync(source, target);
    },
  };
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir,
    editable: true,
    open: false,
    fileSystem: failingFileSystem,
    logger: { error: (...args) => logs.push(args) },
  });
  t.after(() => closeServer(session.server));
  const { state: beforeState, payload } = await editablePayload(session);
  const beforeManifest = fs.readFileSync(path.join(projectDir, 'project.json'));

  const response = await postJson(session, '/api/save', payload);

  assert.equal(response.status, 500);
  assert.equal(response.body.toString('utf8'), 'Request rejected');
  assert.doesNotMatch(response.body.toString('utf8'), /simulated|private|Users/);
  assert.deepEqual(fs.readFileSync(path.join(projectDir, 'project.json')), beforeManifest);
  const afterStateResponse = await request(session, '/api/state', { token: session.token });
  assert.deepEqual(JSON.parse(afterStateResponse.body.toString('utf8')).session, beforeState.session);
  assert.equal(logs.length, 1);
  const logged = JSON.stringify(logs);
  assert.match(logged, /simulated save failure/);
  assert.doesNotMatch(logged, new RegExp(session.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(logged, new RegExp(projectDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(logged, /private-save-target|\/api\/save|baseHash|commands/);
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
