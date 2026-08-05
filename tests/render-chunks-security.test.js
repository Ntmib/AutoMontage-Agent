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
