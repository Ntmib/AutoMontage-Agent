const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  captureTool,
  hostPath,
  runNodeTool,
  runTool,
} = require('../scripts/process');

test('hostile paths stay one literal argv and cannot execute a sentinel', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'argv security '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const probe = path.join(root, 'argv-probe.js');
  const sentinel = path.join(root, 'sentinel');
  fs.writeFileSync(probe, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n');
  const hostile = [
    '-leading.mp4',
    'path with spaces.mp4',
    "single'quote.mp4",
    'double"quote.mp4',
    `$(touch ${sentinel})`,
    `clip;touch ${sentinel}`,
    'line\nbreak.mp4',
    'Юникод-🎬.mp4',
  ];

  const stdout = captureTool(process.execPath, [probe, ...hostile], {
    stage: 'hostile argv probe',
    maxBuffer: 64 * 1024,
  });

  assert.deepEqual(JSON.parse(stdout), hostile);
  assert.equal(fs.existsSync(sentinel), false);
  assert.equal(path.isAbsolute(hostPath('-leading.mp4', root)), true);
});

test('runner reports ENOENT with the doctor recovery command', () => {
  assert.throws(
    () => runTool('automontage-tool-that-does-not-exist', [], { stage: 'render' }),
    /render.*не найден.*npm run doctor/,
  );
});

test('runner rejects non-zero status and terminating signals', () => {
  assert.throws(
    () => captureTool(process.execPath, ['-e', 'process.exit(7)'], {
      stage: 'probe',
      maxBuffer: 1024,
    }),
    /probe.*status 7/,
  );

  assert.throws(
    () => runTool('ffmpeg', [], {
      stage: 'render',
      spawnSyncImpl: () => ({ status: null, signal: 'SIGTERM', error: null }),
    }),
    /render.*SIGTERM/,
  );
});

test('long-running helpers inherit stdio and Node scripts use process.execPath', () => {
  let call;
  runNodeTool('/tmp/tool.js', ['input.mp4'], {
    stage: 'render',
    spawnSyncImpl: (command, args, options) => {
      call = { command, args, options };
      return { status: 0, signal: null, error: null };
    },
  });

  assert.equal(call.command, process.execPath);
  assert.deepEqual(call.args, ['/tmp/tool.js', 'input.mp4']);
  assert.equal(call.options.stdio, 'inherit');
  assert.equal(call.options.shell, false);
});

test('captured commands require an explicit positive maxBuffer', () => {
  assert.throws(
    () => captureTool(process.execPath, ['--version'], { stage: 'probe' }),
    /maxBuffer/,
  );
});
