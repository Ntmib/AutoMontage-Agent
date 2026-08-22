const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildWaveformCommand,
  ensureWaveformPreview,
} = require('../scripts/review/waveform');
const { makeReviewProject } = require('./helpers/review-project');

function sourcePathFor(workspace) {
  return path.join(workspace.dir, workspace.manifest.source.localPath);
}

function writeWaveformFixture(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    fs.writeFileSync(args.at(-1), 'waveform png fixture');
  };
}

test('waveform invokes ffmpeg with separate argv', () => {
  assert.deepEqual(buildWaveformCommand('/tmp/a;touch pwn.mp4', '/tmp/wave.png'), {
    command: 'ffmpeg',
    args: [
      '-y',
      '-i',
      path.resolve('/tmp/a;touch pwn.mp4'),
      '-filter_complex',
      'aformat=channel_layouts=mono,showwavespic=s=2400x180:colors=white',
      '-frames:v',
      '1',
      path.resolve('/tmp/wave.png'),
    ],
  });
});

test('waveform writes an atomic owned cache and reuses it for unchanged source', (t) => {
  const { workspace } = makeReviewProject(t);
  const sourcePath = sourcePathFor(workspace);
  const calls = [];

  const first = ensureWaveformPreview({
    workspace,
    sourcePath,
    runToolImpl: writeWaveformFixture(calls),
  });
  const second = ensureWaveformPreview({
    workspace,
    sourcePath,
    runToolImpl: () => assert.fail('unchanged source must reuse waveform cache'),
  });

  assert.equal(first.available, true);
  assert.deepEqual(second, first);
  assert.match(
    path.relative(workspace.dir, first.path).split(path.sep).join('/'),
    /^previews\/review-waveform-[a-f0-9]{64}\.png$/,
  );
  assert.equal(fs.readFileSync(first.path, 'utf8'), 'waveform png fixture');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'ffmpeg');
  assert.deepEqual(calls[0].options, { stage: 'review waveform' });
  assert.notEqual(calls[0].args.at(-1), first.path);
  assert.equal(path.dirname(calls[0].args.at(-1)), path.dirname(first.path));
  assert.equal(fs.existsSync(calls[0].args.at(-1)), false);
});

test('waveform fingerprint changes when source content metadata changes', (t) => {
  const { workspace } = makeReviewProject(t);
  const sourcePath = sourcePathFor(workspace);
  const calls = [];
  const runner = writeWaveformFixture(calls);

  const before = ensureWaveformPreview({ workspace, sourcePath, runToolImpl: runner });
  fs.writeFileSync(sourcePath, 'changed source content with a different byte length');
  const after = ensureWaveformPreview({ workspace, sourcePath, runToolImpl: runner });

  assert.equal(before.available, true);
  assert.equal(after.available, true);
  assert.notEqual(after.path, before.path);
  assert.equal(calls.length, 2);
  assert.equal(fs.existsSync(before.path), true);
  assert.equal(fs.existsSync(after.path), true);
});

test('waveform failure is path-free and removes an adjacent partial temp', (t) => {
  const { workspace } = makeReviewProject(t);
  const sourcePath = sourcePathFor(workspace);
  let temporaryPath;

  const result = ensureWaveformPreview({
    workspace,
    sourcePath,
    runToolImpl: (_command, args) => {
      temporaryPath = args.at(-1);
      fs.writeFileSync(temporaryPath, 'partial output');
      throw new Error(`ffmpeg exposed ${sourcePath}`);
    },
  });

  assert.equal(result.available, false);
  assert.equal(typeof result.warning, 'string');
  assert.doesNotMatch(result.warning, new RegExp(path.basename(sourcePath)));
  assert.doesNotMatch(result.warning, /\/tmp\/|\/Users\/|C:\\Users\\/);
  assert.equal(fs.existsSync(temporaryPath), false);
  assert.deepEqual(
    fs.readdirSync(path.join(workspace.dir, 'previews')).filter((name) => name.includes('.tmp-')),
    [],
  );
});

test('waveform rejects and cleans non-regular generated output', (t) => {
  const { workspace } = makeReviewProject(t);
  let temporaryPath;

  const result = ensureWaveformPreview({
    workspace,
    sourcePath: sourcePathFor(workspace),
    runToolImpl: (_command, args) => {
      temporaryPath = args.at(-1);
      fs.mkdirSync(temporaryPath);
    },
  });

  assert.equal(result.available, false);
  assert.equal(fs.existsSync(temporaryPath), false);
});

test('waveform refuses a symlinked preview directory and writes nothing outside', (t) => {
  const { root, workspace } = makeReviewProject(t);
  const previews = path.join(workspace.dir, 'previews');
  const outside = path.join(root, 'outside-previews');
  fs.mkdirSync(outside);
  fs.rmdirSync(previews);
  fs.symlinkSync(outside, previews);

  const result = ensureWaveformPreview({
    workspace,
    sourcePath: sourcePathFor(workspace),
    runToolImpl: () => assert.fail('symlinked preview directory must not invoke ffmpeg'),
  });

  assert.equal(result.available, false);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('waveform refuses a preview directory swapped for a symlink at the runner boundary', (t) => {
  const { root, workspace } = makeReviewProject(t);
  const previews = path.join(workspace.dir, 'previews');
  const displacedPreviews = path.join(workspace.dir, 'previews-before-swap');
  const outside = path.join(root, 'outside-runner-swap');
  const sentinel = path.join(outside, 'sentinel.txt');
  fs.mkdirSync(outside);
  fs.writeFileSync(sentinel, 'outside sentinel');
  let attackerTemporaryPath;
  let outsideCachePath;

  const result = ensureWaveformPreview({
    workspace,
    sourcePath: sourcePathFor(workspace),
    runToolImpl: (_command, args) => {
      const temporaryName = path.basename(args.at(-1));
      const cacheName = temporaryName.replace(/\.tmp-review-[a-f0-9-]+\.png$/, '');
      attackerTemporaryPath = path.join(outside, temporaryName);
      outsideCachePath = path.join(outside, cacheName);
      fs.writeFileSync(attackerTemporaryPath, 'attacker-owned temporary file');
      fs.renameSync(previews, displacedPreviews);
      fs.symlinkSync(outside, previews);
    },
  });

  assert.equal(result.available, false);
  assert.equal(fs.existsSync(outsideCachePath), false);
  assert.equal(fs.readFileSync(attackerTemporaryPath, 'utf8'), 'attacker-owned temporary file');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside sentinel');
  assert.deepEqual(fs.readdirSync(displacedPreviews), []);
});

test('waveform refuses cached symlinks including dangling symlinks', (t) => {
  const { root, workspace } = makeReviewProject(t);
  const sourcePath = sourcePathFor(workspace);
  const generated = ensureWaveformPreview({
    workspace,
    sourcePath,
    runToolImpl: writeWaveformFixture([]),
  });
  const outside = path.join(root, 'outside.png');
  fs.writeFileSync(outside, 'outside fixture');
  fs.unlinkSync(generated.path);
  fs.symlinkSync(outside, generated.path);

  const liveLink = ensureWaveformPreview({
    workspace,
    sourcePath,
    runToolImpl: () => assert.fail('symlink cache must not invoke ffmpeg'),
  });
  assert.equal(liveLink.available, false);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside fixture');
  assert.equal(fs.lstatSync(generated.path).isSymbolicLink(), true);

  fs.unlinkSync(generated.path);
  fs.symlinkSync(path.join(root, 'missing.png'), generated.path);
  const danglingLink = ensureWaveformPreview({
    workspace,
    sourcePath,
    runToolImpl: () => assert.fail('dangling cache symlink must not invoke ffmpeg'),
  });
  assert.equal(danglingLink.available, false);
  assert.equal(fs.lstatSync(generated.path).isSymbolicLink(), true);
});

test('waveform success and failure leave manifest and approved brief bytes unchanged', (t) => {
  const { workspace, briefPath } = makeReviewProject(t, { briefStatus: 'approved' });
  const sourcePath = sourcePathFor(workspace);
  const manifestPath = path.join(workspace.dir, 'project.json');
  const approvedMarkdownPath = path.join(
    workspace.dir,
    workspace.manifest.briefs[0].markdownPath,
  );
  const beforeManifest = fs.readFileSync(manifestPath);
  const beforeBrief = fs.readFileSync(briefPath);
  const beforeMarkdown = fs.readFileSync(approvedMarkdownPath);

  const success = ensureWaveformPreview({
    workspace,
    sourcePath,
    runToolImpl: writeWaveformFixture([]),
  });
  fs.writeFileSync(sourcePath, 'force a new fingerprint and a failed regeneration');
  const failure = ensureWaveformPreview({
    workspace,
    sourcePath,
    runToolImpl: () => {
      throw new Error('ffmpeg unavailable');
    },
  });

  assert.equal(success.available, true);
  assert.equal(failure.available, false);
  assert.deepEqual(fs.readFileSync(manifestPath), beforeManifest);
  assert.deepEqual(fs.readFileSync(briefPath), beforeBrief);
  assert.deepEqual(fs.readFileSync(approvedMarkdownPath), beforeMarkdown);
});
