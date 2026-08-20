const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const ROOT = path.resolve(__dirname, '..');
const {
  formatReviewSessionMessages,
  installReviewShutdownHandlers,
  parseReviewOptions,
} = require('../scripts/review/cli');
const { startReviewServer } = require('../scripts/review/server');
const { makeReviewProject } = require('./helpers/review-project');

async function closeServer(server) {
  if (!server || !server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  )));
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
      });
      signalTest.after(restore);
      assert.equal(processLike.listenerCount('SIGINT'), signal === 'SIGINT' ? 2 : 1);
      assert.equal(processLike.listenerCount('SIGTERM'), signal === 'SIGTERM' ? 2 : 1);

      processLike.emit(signal);

      assert.equal(await exited, exitCode);
      assert.equal(session.server.listening, false);
      assert.equal(fs.existsSync(session.handoffPath), false);
      assert.deepEqual(preexistingSignals, [signal]);
      assert.deepEqual(processLike.listeners(signal), [preexistingListener]);
      assert.equal(processLike.listenerCount(signal === 'SIGINT' ? 'SIGTERM' : 'SIGINT'), 0);
      restore();
      assert.deepEqual(processLike.listeners(signal), [preexistingListener]);
      processLike.removeListener(signal, preexistingListener);
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
