const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const ROOT = path.resolve(__dirname, '..');
const {
  formatReviewSessionMessages,
  installReviewShutdownHandlers,
  parseReviewOptions,
} = require('../scripts/review/cli');
const { startReviewServer } = require('../scripts/review/server');
const { runMediaProcess } = require('../scripts/review/media-process');
const { makeReviewProject } = require('./helpers/review-project');

async function closeServer(server) {
  if (!server || !server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  )));
}

function postImport(session, filename = 'shutdown.png') {
  return new Promise((resolve) => {
    const request = http.request({
      host: '127.0.0.1',
      port: session.server.address().port,
      path: '/api/assets/import',
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.token}`,
        origin: session.origin,
        'content-length': '1',
        'content-type': 'image/png',
        'x-automontage-filename': filename,
      },
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', () => resolve(null));
    request.end('x');
  });
}

const IMAGE_PROBE = JSON.stringify({
  streams: [{
    codec_type: 'video', codec_name: 'png', pix_fmt: 'rgba', width: 64, height: 64,
    avg_frame_rate: '25/1', r_frame_rate: '25/1',
  }],
  format: { format_name: 'png_pipe' },
});

function successfulImageProcessor(invocation) {
  if (invocation.command === 'ffprobe') {
    return Promise.resolve({
      stdout: invocation.args.at(-1).includes('upload')
        ? IMAGE_PROBE
        : IMAGE_PROBE.replace('"png"', '"webp"').replace('png_pipe', 'webp_pipe'),
      stderr: '', code: 0, signal: null,
    });
  }
  if (invocation.command === 'ffmpeg' && !invocation.args.includes('null')) {
    fs.writeFileSync(invocation.args.at(-1), 'normalized image');
  }
  return Promise.resolve({ stdout: '', stderr: '', code: 0, signal: null });
}

async function waitFor(predicate, message, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function childExit(child, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CLI child did not exit in time')), timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === 'ESRCH') return false;
    throw error;
  }
}

function childProcessPid(parentPid, commandPattern) {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match && Number(match[2]) === parentPid && commandPattern.test(match[3])) {
      return Number(match[1]);
    }
  }
  return null;
}

async function startRealReviewCommand(t, fixture, { publicCommand = false } = {}) {
  const commandArgs = publicCommand
    ? [path.join(ROOT, 'scripts', 'cli.js'), 'review']
    : [path.join(ROOT, 'scripts', 'review', 'cli.js')];
  commandArgs.push('--project-dir', fixture.projectDir, '--edit', '--no-open');
  const child = spawn(process.execPath, commandArgs, {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (!processIsAlive(child.pid)) return;
    child.kill('SIGTERM');
    try { await childExit(child, 3_000); } catch (_) { child.kill('SIGKILL'); }
  });
  await waitFor(
    () => /Secure session URL file: .+\n/.test(stdout),
    `review command did not start: ${stderr}`,
  );
  const handoffPath = /Secure session URL file: (.+)\n/.exec(stdout)[1];
  const url = new URL(fs.readFileSync(handoffPath, 'utf8').trim());
  const token = url.hash.slice('#token='.length);
  let nestedReviewPid = null;
  if (publicCommand) {
    await waitFor(() => {
      nestedReviewPid = childProcessPid(child.pid, /scripts\/review\/cli\.js/);
      return Number.isInteger(nestedReviewPid);
    }, 'public review wrapper did not expose its review child');
    t.after(async () => {
      if (!processIsAlive(nestedReviewPid)) return;
      process.kill(nestedReviewPid, 'SIGTERM');
      await waitFor(() => !processIsAlive(nestedReviewPid), 'review child survived test cleanup');
    });
  }
  return {
    child,
    nestedReviewPid,
    origin: url.origin,
    token,
    handoffPath,
  };
}

function beginImport(command, { bytes, declaredLength, filename, contentType }) {
  const url = new URL('/api/assets/import', command.origin);
  const request = http.request({
    host: url.hostname,
    port: url.port,
    path: url.pathname,
    method: 'POST',
    headers: {
      authorization: `Bearer ${command.token}`,
      origin: command.origin,
      'content-length': String(declaredLength),
      'content-type': contentType,
      'x-automontage-filename': filename,
    },
  });
  request.on('error', () => {});
  request.write(bytes);
  if (bytes.length === declaredLength) request.end();
  return request;
}

function activeQuarantines(projectDir) {
  const parent = path.join(projectDir, 'tmp', 'review-imports');
  if (!fs.existsSync(parent)) return [];
  return fs.readdirSync(parent).filter((name) => /^[0-9a-f-]{36}$/.test(name));
}

async function assertCleanSignalExit({ t, fixture, command, signal, request }) {
  const exit = childExit(command.child);
  command.child.kill(signal);
  assert.deepEqual(await exit, {
    code: signal === 'SIGINT' ? 130 : 143,
    signal: null,
  });
  request.destroy();
  assert.equal(fs.existsSync(path.join(fixture.projectDir, '.project-mutation.lock')), false);
  const quarantines = activeQuarantines(fixture.projectDir);
  assert.deepEqual(quarantines, [], JSON.stringify(quarantines.map((name) => ({
    name,
    entries: fs.readdirSync(path.join(fixture.projectDir, 'tmp', 'review-imports', name)),
  }))));
  assert.equal(fs.existsSync(command.handoffPath), false);
  if (command.nestedReviewPid) {
    await waitFor(
      () => !processIsAlive(command.nestedReviewPid),
      'public review child survived its wrapper signal',
    );
  }

  const retry = await startRealReviewCommand(t, fixture, {
    publicCommand: Boolean(command.nestedReviewPid),
  });
  const retryExit = childExit(retry.child);
  retry.child.kill(signal);
  assert.deepEqual(await retryExit, {
    code: signal === 'SIGINT' ? 130 : 143,
    signal: null,
  });
}

test('review requires an existing project directory', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-review-cli-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));

  assert.throws(() => parseReviewOptions(['--project-dir', '']), /project-dir/);
  assert.throws(
    () => parseReviewOptions(['--project-dir', path.join(parent, 'missing')]),
    /project-dir/,
  );
});

test('review is read-only unless edit is explicit', (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-review-cli-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));

  assert.deepEqual(parseReviewOptions(['--project-dir', projectDir]), {
    projectDir: path.resolve(projectDir),
    editable: false,
    open: true,
    port: 0,
  });
  assert.deepEqual(parseReviewOptions([
    '--project-dir', projectDir,
    '--edit',
    '--no-open',
    '--port', '43123',
  ]), {
    projectDir: path.resolve(projectDir),
    editable: true,
    open: false,
    port: 43123,
  });
});

test('review rejects malformed and unknown options', (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-review-cli-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));

  assert.throws(() => parseReviewOptions(['--project-dir', projectDir, '--port']), /port/);
  assert.throws(() => parseReviewOptions(['--project-dir', projectDir, '--port', '-1']), /port/);
  assert.throws(() => parseReviewOptions(['--project-dir', projectDir, '--port', '65536']), /port/);
  assert.throws(() => parseReviewOptions(['--project-dir', projectDir, '--unknown']), /unknown/);
});

test('review CLI reports only the secure handoff path for manual opening', () => {
  const token = 'secret-bearer-token';
  const messages = formatReviewSessionMessages({
    session: {
      origin: 'http://127.0.0.1:43123',
      url: `http://127.0.0.1:43123/#token=${token}`,
      handoffPath: '/tmp/automontage-review-safe.url',
    },
    editable: true,
  });

  assert.deepEqual(messages, [
    'Review server: http://127.0.0.1:43123',
    'Secure session URL file: /tmp/automontage-review-safe.url',
    'Mode: edit-enabled session',
  ]);
  assert.doesNotMatch(messages.join('\n'), new RegExp(token));
  assert.doesNotMatch(messages.join('\n'), /#token=|Bearer /);
});

test('review CLI signal handlers close the server, remove handoff and restore listeners', async (t) => {
  for (const { signal, exitCode } of [
    { signal: 'SIGINT', exitCode: 130 },
    { signal: 'SIGTERM', exitCode: 143 },
  ]) {
    await t.test(signal, async (signalTest) => {
      const { projectDir } = makeReviewProject(signalTest);
      const handoffDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-review-signal-'));
      signalTest.after(() => fs.rmSync(handoffDirectory, { recursive: true, force: true }));
      const session = await startReviewServer({
        root: ROOT,
        projectDir,
        open: false,
        handoffDirectory,
        handoffId: () => signal.toLowerCase(),
        runToolImpl: () => { throw new Error('waveform unavailable'); },
      });
      signalTest.after(() => closeServer(session.server));
      assert.equal(fs.existsSync(session.handoffPath), true);

      const processLike = new EventEmitter();
      const preexistingSignals = [];
      const preexistingListener = () => preexistingSignals.push(signal);
      processLike.on(signal, preexistingListener);
      const exited = new Promise((resolve) => {
        processLike.exit = (code) => resolve(code);
      });
      const restore = installReviewShutdownHandlers({
        server: session.server,
        processLike,
        abortActiveImport: () => preexistingSignals.push('abort-import'),
      });
      signalTest.after(restore);
      assert.equal(processLike.listenerCount('SIGINT'), signal === 'SIGINT' ? 2 : 1);
      assert.equal(processLike.listenerCount('SIGTERM'), signal === 'SIGTERM' ? 2 : 1);

      processLike.emit(signal);

      assert.equal(await exited, exitCode);
      assert.equal(session.server.listening, false);
      assert.equal(fs.existsSync(session.handoffPath), false);
      assert.deepEqual(preexistingSignals, [signal, 'abort-import']);
      assert.deepEqual(processLike.listeners(signal), [preexistingListener]);
      assert.equal(processLike.listenerCount(signal === 'SIGINT' ? 'SIGTERM' : 'SIGINT'), 0);
      restore();
      assert.deepEqual(processLike.listeners(signal), [preexistingListener]);
      processLike.removeListener(signal, preexistingListener);
    });
  }
});

test('review CLI retains signal guards until tracked import finalizers settle', async (t) => {
  const { projectDir } = makeReviewProject(t);
  const session = await startReviewServer({
    root: ROOT,
    projectDir,
    open: false,
    runToolImpl: () => { throw new Error('waveform unavailable'); },
  });
  t.after(() => closeServer(session.server));
  let resolveFinalizers;
  const finalizers = new Promise((resolve) => { resolveFinalizers = resolve; });
  const processLike = new EventEmitter();
  let aborts = 0;
  let exitCode = null;
  processLike.exit = (code) => { exitCode = code; };
  const restore = installReviewShutdownHandlers({
    server: session.server,
    processLike,
    abortActiveImport: () => { aborts += 1; },
    waitForActiveImports: () => finalizers,
  });
  t.after(restore);

  const closed = new Promise((resolve) => session.server.once('close', resolve));
  processLike.emit('SIGTERM');
  await closed;
  assert.equal(exitCode, null);
  assert.equal(processLike.listenerCount('SIGTERM'), 1);
  processLike.emit('SIGTERM');
  assert.equal(aborts, 1);
  assert.equal(exitCode, null);

  resolveFinalizers();
  await waitFor(() => exitCode !== null, 'shutdown did not finish after import finalizers');
  assert.equal(exitCode, 143);
  assert.equal(processLike.listenerCount('SIGTERM'), 0);
});

test('CLI shutdown aborts a real active import, escalates its child, and permits immediate retry', async (t) => {
  const fixture = makeReviewProject(t);
  const marker = path.join(fixture.root, 'shutdown-child-sigterm.txt');
  const ready = path.join(fixture.root, 'shutdown-child-ready.txt');
  let markChildStarted;
  const childStarted = new Promise((resolve) => { markChildStarted = resolve; });
  const session = await startReviewServer({
    root: ROOT,
    projectDir: fixture.projectDir,
    editable: true,
    open: false,
    logger: { error() {} },
    runToolImpl: () => { throw new Error('waveform unavailable'); },
    runMediaProcessImpl: async (invocation) => {
      if (invocation.command === 'ffprobe') {
        return { stdout: IMAGE_PROBE, stderr: '', code: 0, signal: null };
      }
      if (invocation.command === 'ffmpeg' && !invocation.args.includes('null')) {
        const script = [
          "const fs=require('node:fs');",
          `process.on('SIGTERM',()=>fs.writeFileSync(${JSON.stringify(marker)},'SIGTERM'));`,
          `fs.writeFileSync(${JSON.stringify(ready)},'ready');`,
          'setInterval(()=>{},1000);',
        ].join('');
        const running = runMediaProcess({
          command: process.execPath,
          args: ['-e', script],
          signal: invocation.signal,
          terminationGraceMs: 40,
        });
        while (!fs.existsSync(ready)) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        markChildStarted();
        return running;
      }
      return { stdout: '', stderr: '', code: 0, signal: null };
    },
  });
  t.after(() => closeServer(session.server));
  const pendingImport = postImport(session);
  await childStarted;

  const processLike = new EventEmitter();
  const exited = new Promise((resolve) => { processLike.exit = resolve; });
  const restore = installReviewShutdownHandlers({
    server: session.server,
    processLike,
    abortActiveImport: session.abortActiveImports,
  });
  t.after(restore);
  processLike.emit('SIGTERM');
  assert.equal(await exited, 143);
  await pendingImport;
  assert.equal(fs.readFileSync(marker, 'utf8'), 'SIGTERM');
  assert.equal(fs.existsSync(path.join(fixture.projectDir, '.project-mutation.lock')), false);
  const quarantineParent = path.join(fixture.projectDir, 'tmp', 'review-imports');
  assert.deepEqual(fs.existsSync(quarantineParent) ? fs.readdirSync(quarantineParent) : [], []);

  const retrySession = await startReviewServer({
    root: ROOT,
    projectDir: fixture.projectDir,
    editable: true,
    open: false,
    runToolImpl: () => { throw new Error('waveform unavailable'); },
    runMediaProcessImpl: successfulImageProcessor,
  });
  t.after(() => closeServer(retrySession.server));
  assert.equal(await postImport(retrySession, 'retry.png'), 201);
});

test('real review CLI waits for partial-upload cleanup before signal exit', {
  skip: process.platform === 'win32' ? 'POSIX signal lifecycle' : false,
  timeout: 45_000,
}, async (t) => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    await t.test(signal, async (signalTest) => {
      const fixture = makeReviewProject(signalTest);
      const command = await startRealReviewCommand(signalTest, fixture);
      const request = beginImport(command, {
        bytes: Buffer.from('partial'),
        declaredLength: 1024 * 1024,
        filename: 'partial.mp4',
        contentType: 'video/mp4',
      });
      await waitFor(
        () => fs.existsSync(path.join(fixture.projectDir, '.project-mutation.lock'))
          && activeQuarantines(fixture.projectDir).length === 1,
        'partial upload never acquired its lease and quarantine',
      );
      await assertCleanSignalExit({
        t: signalTest, fixture, command, signal, request,
      });
    });
  }
});

test('real review CLI waits for real ffmpeg cleanup before signal exit', {
  skip: process.platform === 'win32' ? 'POSIX signal lifecycle' : false,
  timeout: 60_000,
}, async (t) => {
  const video = fs.readFileSync(path.join(ROOT, 'examples', 'demo-preview.mp4'));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    await t.test(signal, async (signalTest) => {
      const fixture = makeReviewProject(signalTest);
      const command = await startRealReviewCommand(signalTest, fixture);
      const request = beginImport(command, {
        bytes: video,
        declaredLength: video.length,
        filename: 'processing.mp4',
        contentType: 'video/mp4',
      });
      await waitFor(
        () => Number.isInteger(childProcessPid(command.child.pid, /(?:^|\/)ffmpeg(?:\s|$)/)),
        'real ffmpeg child never started',
        20_000,
      );
      await assertCleanSignalExit({
        t: signalTest, fixture, command, signal, request,
      });
    });
  }
});

test('public review wrapper forwards signals and waits for child import cleanup', {
  skip: process.platform === 'win32' ? 'POSIX signal lifecycle' : false,
  timeout: 45_000,
}, async (t) => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    await t.test(signal, async (signalTest) => {
      const fixture = makeReviewProject(signalTest);
      const command = await startRealReviewCommand(signalTest, fixture, { publicCommand: true });
      const request = beginImport(command, {
        bytes: Buffer.from('partial'),
        declaredLength: 1024 * 1024,
        filename: 'public-partial.mp4',
        contentType: 'video/mp4',
      });
      await waitFor(
        () => fs.existsSync(path.join(fixture.projectDir, '.project-mutation.lock'))
          && activeQuarantines(fixture.projectDir).length === 1,
        'public partial upload never acquired its lease and quarantine',
      );
      await assertCleanSignalExit({
        t: signalTest, fixture, command, signal, request,
      });
    });
  }
});

test('top-level CLI dispatches review without forwarding its arguments to build', (t) => {
  const { root } = makeReviewProject(t);
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'cli.js'),
    'review',
    '--project-dir', path.join(root, 'missing-project'),
    '--no-open',
  ], {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    'Review server failed to start. Check --project-dir and options.\n',
  );
  assert.doesNotMatch(result.stderr, /#token=|Bearer |missing-project/);
});
