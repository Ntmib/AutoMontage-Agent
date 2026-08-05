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
  resolveRenderSource,
} = require('../scripts/render-chunks');
const {
  canonicalizeRenderProps,
  collectReferencedPublicAssets,
  createRenderJob,
  directoryIdentity,
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

function cacheFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-chunk-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const src = path.join(root, 'src');
  const publicDir = path.join(root, 'public');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(path.join(publicDir, 'broll'), { recursive: true });
  fs.writeFileSync(path.join(src, 'index.jsx'), 'export const scene = 1;\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture"}\n');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  fs.writeFileSync(path.join(publicDir, 'broll', 'clip.mp4'), 'b-roll-a');
  fs.writeFileSync(path.join(publicDir, 'unused.mp4'), 'unused-a');
  return { root, src, publicDir };
}

function renderCodeFor(root) {
  return {
    src: directoryIdentity(path.join(root, 'src')),
    packageJson: fileIdentity(path.join(root, 'package.json')),
    lockfile: fileIdentity(path.join(root, 'package-lock.json')),
  };
}

function jobFor(root, props, source = null) {
  const publicAssets = collectReferencedPublicAssets(props, path.join(root, 'public'));
  return createRenderJob({
    composition: 'Dynamic',
    props: canonicalizeRenderProps(props, publicAssets),
    source,
    audio: null,
    total: 75,
    chunk: 30,
    remotionOptions: { entry: 'src/index.js', codec: 'h264', log: 'error' },
    renderCode: renderCodeFor(root),
    publicAssets,
  });
}

test('render cache key is stable for identical code, props and public asset bytes', (t) => {
  const { root, publicDir } = cacheFixture(t);
  const props = { source: 'broll/clip.mp4', nested: { broll: 'broll/clip.mp4' }, value: 1 };
  const source = path.join(publicDir, 'broll', 'clip.mp4');
  const original = jobFor(root, props, source);

  assert.equal(jobFor(root, props, source).key, original.key);
  assert.match(renderCodeFor(root).src, /^[a-f0-9]{64}$/);
  assert.deepEqual(collectReferencedPublicAssets(props, publicDir), [
    { pointer: '/nested/broll', size: 8, sha256: fileIdentity(source).sha256 },
    { pointer: '/source', size: 8, sha256: fileIdentity(source).sha256 },
  ]);
});

test('render cache key changes when a JSX byte changes', (t) => {
  const { root } = cacheFixture(t);
  const props = { source: 'broll/clip.mp4' };
  const original = jobFor(root, props);
  fs.writeFileSync(path.join(root, 'src', 'index.jsx'), 'export const scene = 2;\n');

  assert.notEqual(jobFor(root, props).key, original.key);
});

test('render cache key changes when a referenced public asset changes under the same name', (t) => {
  const { root, publicDir } = cacheFixture(t);
  const props = { source: 'broll/clip.mp4' };
  const original = jobFor(root, props, path.join(publicDir, 'broll', 'clip.mp4'));
  fs.writeFileSync(path.join(publicDir, 'broll', 'clip.mp4'), 'b-roll-b');

  assert.notEqual(jobFor(root, props, path.join(publicDir, 'broll', 'clip.mp4')).key, original.key);
});

test('render cache key ignores an unreferenced public file', (t) => {
  const { root, publicDir } = cacheFixture(t);
  const props = { source: 'broll/clip.mp4' };
  const original = jobFor(root, props);
  fs.writeFileSync(path.join(publicDir, 'unused.mp4'), 'unused-b');

  assert.equal(jobFor(root, props).key, original.key);
});

test('render cache key changes when package metadata changes', (t) => {
  const { root } = cacheFixture(t);
  const props = { source: 'broll/clip.mp4' };
  const original = jobFor(root, props);
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"changed"}\n');
  assert.notEqual(jobFor(root, props).key, original.key);

  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture"}\n');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":4}\n');
  assert.notEqual(jobFor(root, props).key, original.key);
});

test('render code identity rejects a symlink instead of following it', (t) => {
  const { root, src } = cacheFixture(t);
  const outside = path.join(root, 'outside.jsx');
  fs.writeFileSync(outside, 'private code');
  fs.symlinkSync(outside, path.join(src, 'linked.jsx'));

  assert.throws(() => directoryIdentity(src), /chunk cache: symlink в render code запрещён/);
});

test('public asset collection does not read traversal props outside public', (t) => {
  const { root, publicDir } = cacheFixture(t);
  const secret = path.join(root, 'secret.mp4');
  fs.writeFileSync(secret, 'do-not-read');
  const assets = collectReferencedPublicAssets({ broll: '../../secret.mp4' }, publicDir);

  assert.deepEqual(assets, []);
  assert.deepEqual(canonicalizeRenderProps({ broll: '../../secret.mp4' }, assets), {
    broll: '../../secret.mp4',
  });
});

test('public asset discovery and source resolution reject a symlinked ancestor', (t) => {
  const { root, publicDir } = cacheFixture(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.mp4'), 'do-not-read');
  fs.symlinkSync(outside, path.join(publicDir, 'linked'));
  const propsPath = path.join(root, 'props.json');
  fs.writeFileSync(propsPath, '{"source":"linked/secret.mp4"}');

  assert.throws(
    () => collectReferencedPublicAssets({ broll: 'linked/secret.mp4' }, publicDir),
    /chunk cache: public asset проходит через symlink/,
  );
  assert.throws(
    () => resolveRenderSource(propsPath, root),
    /chunk cache: public asset проходит через symlink/,
  );
});

test('render cache key preserves observable props key order', (t) => {
  const { root } = cacheFixture(t);
  const first = jobFor(root, { source: 'broll/clip.mp4', title: 'same' });
  const second = jobFor(root, { title: 'same', source: 'broll/clip.mp4' });

  assert.notEqual(second.key, first.key);
});

test('render cache key ignores random public lease paths when media bytes match', (t) => {
  const { root, publicDir } = cacheFixture(t);
  const firstLease = path.join(publicDir, 'lease-a.mp4');
  const secondLease = path.join(publicDir, 'lease-b.mp4');
  fs.writeFileSync(firstLease, 'same-source-bytes');
  fs.writeFileSync(secondLease, 'same-source-bytes');

  const first = jobFor(root, { source: 'lease-a.mp4', title: 'same' }, firstLease);
  const second = jobFor(root, { source: 'lease-b.mp4', title: 'same' }, secondLease);

  assert.equal(second.key, first.key);
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
