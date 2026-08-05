const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const {
  concatChunksCommand,
  muxAudioCommand,
  parseChunkOptions,
  remotionChunkCommand,
  renderChunkAtomically,
} = require('../scripts/render-chunks');
const {
  createRenderJob,
  fileIdentity,
  isReusableChunk,
  loadCacheManifest,
  recordChunkComplete,
} = require('../scripts/chunk-cache');

const hostile = `- lead 'single' "double" $() ;\nЮникод`;

test('chunk render keeps composition and hostile paths as separate argv', () => {
  const props = path.join(os.tmpdir(), hostile, 'props.json');
  const output = path.join(os.tmpdir(), hostile, 'part.mp4');
  const command = remotionChunkCommand({
    command: process.execPath,
    argsPrefix: ['/local/remotion-cli.js'],
  }, {
    composition: 'Dynamic',
    props,
    output,
    from: 0,
    to: 29,
  });

  assert.deepEqual(command.args.slice(0, 5), [
    '/local/remotion-cli.js', 'render', 'src/index.js', 'Dynamic', path.resolve(output),
  ]);
  assert.equal(command.args[command.args.indexOf('--props') + 1], path.resolve(props));
  assert.equal(command.args[command.args.indexOf('--frames') + 1], '0-29');
});

test('chunk concat emits every input as its own argv and mux keeps audio literal', () => {
  const parts = [
    path.join(os.tmpdir(), hostile, 'part 1.mp4'),
    path.join(os.tmpdir(), hostile, 'part 2.mp4'),
  ];
  const glued = path.join(os.tmpdir(), hostile, 'glued.mp4');
  const concat = concatChunksCommand(parts, glued);
  assert.deepEqual(
    concat.args.filter((arg, index) => concat.args[index - 1] === '-i'),
    parts.map((part) => path.resolve(part)),
  );
  assert.match(concat.args[concat.args.indexOf('-filter_complex') + 1], /concat=n=2/);
  assert.equal(concat.args.at(-1), path.resolve(glued));

  const audio = path.join(os.tmpdir(), hostile, 'audio.mp4');
  const output = path.join(os.tmpdir(), hostile, 'output.mp4');
  const mux = muxAudioCommand(glued, audio, output);
  assert.equal(mux.args[mux.args.lastIndexOf('-i') + 1], path.resolve(audio));
  assert.equal(mux.args.at(-1), path.resolve(output));
});

test('chunk options require a safe composition and positive integer ranges', () => {
  const valid = parseChunkOptions(['Dynamic', 'props.json', 'out.mp4', '75', '--chunk', '30']);
  assert.equal(valid.total, 75);
  assert.equal(valid.chunk, 30);
  for (const args of [
    ['--inspect', 'props.json', 'out.mp4', '75'],
    ['Dynamic', 'props.json', 'out.mp4', '0'],
    ['Dynamic', 'props.json', 'out.mp4', '75.5'],
    ['Dynamic', 'props.json', 'out.mp4', '75;touch sentinel'],
    ['Dynamic', 'props.json', 'out.mp4', '75', '--chunk', '0'],
    ['Dynamic', 'props.json', 'out.mp4', '75', '--chunk', 'Infinity'],
  ]) {
    assert.throws(() => parseChunkOptions(args));
  }
});

test('failed chunk render removes temp and preserves an existing completed part', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-chunk-atomic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const part = path.join(dir, 'part.mp4');
  fs.writeFileSync(part, 'previous-complete');

  assert.throws(() => renderChunkAtomically({
    resolvedRemotion: { command: process.execPath, argsPrefix: ['/local/remotion.js'] },
    composition: 'Dynamic',
    props: path.join(dir, 'props.json'),
    part,
    from: 0,
    to: 29,
  }, {
    temporaryId: () => 'fixed',
    run() {
      fs.writeFileSync(path.join(dir, 'part.tmp-fixed.mp4'), 'partial');
      throw new Error('fake render failed');
    },
  }), /fake render failed/);

  assert.equal(fs.readFileSync(part, 'utf8'), 'previous-complete');
  assert.equal(fs.existsSync(path.join(dir, 'part.tmp-fixed.mp4')), false);
});

test('invalid chunk CLI values fail before Remotion and cannot execute a sentinel', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-chunk-sentinel-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sentinel = path.join(dir, 'sentinel');
  const payload = `1;touch ${sentinel}`;
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/render-chunks.js'),
    'Dynamic', 'props.json', 'out.mp4', payload,
  ], { encoding: 'utf8' });

  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(sentinel), false);
});

test('chunk renderer contains no shell execution escape hatch', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts/render-chunks.js'), 'utf8');
  assert.doesNotMatch(source, /\bexecSync\b|shell\s*:\s*true/);
});

test('render job key covers composition, props, source, audio and render options', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-chunk-job-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const props = path.join(dir, 'props.json');
  const source = path.join(dir, 'source.mp4');
  const audio = path.join(dir, 'audio.mp4');
  fs.writeFileSync(props, '{"source":"source.mp4","value":1}');
  fs.writeFileSync(source, 'source-a');
  fs.writeFileSync(audio, 'audio-a');
  const input = {
    composition: 'Dynamic',
    props,
    source,
    audio,
    total: 75,
    chunk: 30,
    remotionOptions: { entry: 'src/index.js', codec: 'h264', log: 'error' },
  };
  const original = createRenderJob(input);
  assert.equal(createRenderJob(input).key, original.key);

  fs.writeFileSync(props, '{"source":"source.mp4","value":2}');
  assert.notEqual(createRenderJob(input).key, original.key);
  fs.writeFileSync(props, '{"source":"source.mp4","value":1}');
  fs.writeFileSync(source, 'source-b');
  assert.notEqual(createRenderJob(input).key, original.key);
  fs.writeFileSync(source, 'source-a');
  fs.writeFileSync(audio, 'audio-b');
  assert.notEqual(createRenderJob(input).key, original.key);
  fs.writeFileSync(audio, 'audio-a');
  assert.notEqual(createRenderJob({ ...input, composition: 'ReelScenes' }).key, original.key);
  assert.notEqual(createRenderJob({ ...input, total: 76 }).key, original.key);
  assert.throws(
    () => createRenderJob({ ...input, props: path.join(dir, 'missing private props.json') }),
    (error) => !error.message.includes(dir),
  );
});

test('chunk reuse requires matching manifest range, hash, size and frame count', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-chunk-resume-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const job = { key: 'job-key', descriptor: { total: 30, chunk: 30 } };
  const manifest = loadCacheManifest(dir, job);
  const part = path.join(dir, '0-29.mp4');
  fs.writeFileSync(part, Buffer.alloc(1500, 1));
  recordChunkComplete({
    directory: dir,
    manifest,
    part,
    from: 0,
    to: 29,
    frames: 30,
  });

  assert.equal(isReusableChunk({
    directory: dir,
    manifest,
    from: 0,
    to: 29,
    probeFrames: () => 30,
  }), true);
  assert.equal(isReusableChunk({
    directory: dir,
    manifest,
    from: 0,
    to: 28,
    probeFrames: () => 29,
  }), false);
  assert.equal(isReusableChunk({
    directory: dir,
    manifest,
    from: 0,
    to: 29,
    probeFrames: () => 29,
  }), false);

  const originalIdentity = fileIdentity(part);
  fs.writeFileSync(part, Buffer.alloc(1500, 2));
  assert.notDeepEqual(fileIdentity(part), originalIdentity);
  assert.equal(isReusableChunk({
    directory: dir,
    manifest,
    from: 0,
    to: 29,
    probeFrames: () => 30,
  }), false);
  fs.writeFileSync(part, Buffer.alloc(10, 1));
  assert.equal(isReusableChunk({
    directory: dir,
    manifest,
    from: 0,
    to: 29,
    probeFrames: () => 30,
  }), false);
});
