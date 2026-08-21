const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const { runMediaProcess } = require('../scripts/review/media-process');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal);
    return true;
  };
  return child;
}

test('media process uses argv with shell disabled and returns bounded output after close', async () => {
  const child = fakeChild();
  let invocation;
  const promise = runMediaProcess({
    command: 'ffprobe',
    args: ['--', 'hostile;$(touch nope).mov'],
    cwd: '/tmp',
    maxStdoutBytes: 32,
    maxStderrBytes: 32,
    spawnImpl(command, args, options) {
      invocation = { command, args, options };
      return child;
    },
  });
  child.stdout.end('probe json');
  child.stderr.end('diagnostic');
  child.emit('close', 0, null);
  assert.deepEqual(await promise, {
    stdout: 'probe json', stderr: 'diagnostic', code: 0, signal: null,
  });
  assert.equal(invocation.command, 'ffprobe');
  assert.deepEqual(invocation.args, ['--', 'hostile;$(touch nope).mov']);
  assert.deepEqual(invocation.options, {
    cwd: '/tmp',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
});

test('media process sends one SIGTERM on timeout and rejects only after child close', async () => {
  const child = fakeChild();
  let settled = false;
  const promise = runMediaProcess({
    command: 'ffmpeg', args: [], timeoutMs: 5, spawnImpl: () => child,
  }).finally(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(child.killCalls, ['SIGTERM']);
  assert.equal(settled, false);
  child.stdout.end('partial output');
  child.stderr.end('bounded diagnostic');
  child.emit('close', null, 'SIGTERM');
  await assert.rejects(promise, (error) => error.code === 'MEDIA_PROCESS_TIMEOUT'
    && error.stdout === 'partial output' && error.stderr === 'bounded diagnostic');
});

test('media process abort, overflow, spawn error, and non-zero exit remain bounded', async (t) => {
  await t.test('abort', async () => {
    const child = fakeChild();
    const abort = new AbortController();
    const promise = runMediaProcess({ command: 'ffmpeg', args: [], signal: abort.signal, spawnImpl: () => child });
    abort.abort();
    assert.deepEqual(child.killCalls, ['SIGTERM']);
    child.emit('close', null, 'SIGTERM');
    await assert.rejects(promise, (error) => error.code === 'MEDIA_PROCESS_ABORTED');
  });

  await t.test('bounded stdout', async () => {
    const child = fakeChild();
    const promise = runMediaProcess({
      command: 'ffprobe', args: [], maxStdoutBytes: 4, spawnImpl: () => child,
    });
    child.stdout.write('12345');
    assert.deepEqual(child.killCalls, ['SIGTERM']);
    child.emit('close', null, 'SIGTERM');
    await assert.rejects(promise, (error) => error.code === 'MEDIA_PROCESS_OUTPUT_LIMIT');
  });

  await t.test('non-zero', async () => {
    const child = fakeChild();
    const promise = runMediaProcess({ command: 'ffmpeg', args: [], spawnImpl: () => child });
    child.stderr.end('decoder failed');
    child.emit('close', 7, null);
    await assert.rejects(promise, (error) => error.code === 'MEDIA_PROCESS_EXIT' && error.exitCode === 7);
  });

  await t.test('spawn error waits for close', async () => {
    const child = fakeChild();
    let settled = false;
    const promise = runMediaProcess({ command: 'missing', args: [], spawnImpl: () => child })
      .finally(() => { settled = true; });
    child.emit('error', new Error('ENOENT'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    child.emit('close', -2, null);
    await assert.rejects(promise, (error) => error.code === 'MEDIA_PROCESS_SPAWN');
  });
});
