const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runPreview } = require('../scripts/preview');
const {
  planPreview,
  publishCurrentPreview,
} = require('../scripts/project/preview-workspace');
const {
  createOrOpenProject,
  publishBriefRevision,
  readProjectManifest,
} = require('../scripts/project/workspace');

const IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
];

function makeProject(t, { music = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-preview-test-'));
  const source = path.join(root, 'speaker.mp4');
  fs.writeFileSync(source, 'source-video');
  const workspace = createOrOpenProject({
    projectDir: path.join(root, 'project'),
    name: 'Preview test',
    sourcePath: source,
    now: new Date('2026-08-23T17:00:00.000Z'),
  });
  const brief = {
    version: 1,
    status: 'draft',
    source: workspace.sourcePath,
    theme: 'lesson-neutral',
    title: 'ПРЕДПРОСМОТР',
    output: {
      aspect: 'horizontal', width: 320, height: 180, fps: 25, durationInFrames: 100,
    },
    corrections: [],
    scenes: [{ scene: 'fullscreen', start: 0, end: 4, caption: 'СМОНТИРОВАНО' }],
  };
  if (music) {
    const musicPath = path.join(workspace.dir, 'assets', 'music', 'track.mp3');
    fs.writeFileSync(musicPath, 'music');
    brief.music = { file: musicPath, gainDb: -20, startSec: 2 };
  }
  const published = publishBriefRevision(workspace, {
    brief,
    markdown: '# Preview test\n',
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, workspace, brief, published };
}

function idSequence() {
  let index = 0;
  return () => IDS[index++] || `preview-${index}`;
}

test('preview publication writes immutable revision, canonical current file, and manifest metadata', (t) => {
  const fixture = makeProject(t);
  const range = {
    kind: 'full', fromSec: 0, toSec: 4, fromFrame: 0, toFrameExclusive: 100,
  };
  const planned = planPreview(fixture.workspace, {
    briefPath: fixture.published.jsonPath,
    range,
    temporaryId: () => IDS[0],
  });
  const staged = path.join(fixture.workspace.dir, 'previews', 'finished.mp4');
  fs.writeFileSync(staged, 'rendered-preview');

  const result = publishCurrentPreview(fixture.workspace, planned, staged, {
    width: 160,
    height: 90,
    fps: 25,
    generatedAt: '2026-08-23T17:05:00.000Z',
  }, { temporaryId: idSequence() });
  const manifest = readProjectManifest(fixture.workspace.dir);

  assert.equal(fs.readFileSync(result.revisionPath, 'utf8'), 'rendered-preview');
  assert.equal(fs.readFileSync(result.currentPath, 'utf8'), 'rendered-preview');
  assert.deepEqual(manifest.currentPreview, {
    filePath: 'previews/v01-draft-full.mp4',
    briefPath: 'brief/v01-draft.lesson.json',
    kind: 'full',
    fromSec: 0,
    toSec: 4,
    width: 160,
    height: 90,
    fps: 25,
    generatedAt: '2026-08-23T17:05:00.000Z',
    sha256: '8df0992f9b4bd17ed44646e739f71e1212ebed6e21d068a9d31a50b4e6846b4e',
  });
  assert.equal(manifest.renders.length, 0);
  assert.equal(manifest.latestRender, null);
});

test('preview manifest staging failure restores the previous canonical preview byte-for-byte', (t) => {
  const fixture = makeProject(t);
  const current = path.join(fixture.workspace.dir, 'previews', 'current-preview.mp4');
  fs.writeFileSync(current, 'previous-preview');
  const beforeManifest = fs.readFileSync(path.join(fixture.workspace.dir, 'project.json'));
  const planned = planPreview(fixture.workspace, {
    briefPath: fixture.published.jsonPath,
    range: { kind: 'full', fromSec: 0, toSec: 4, fromFrame: 0, toFrameExclusive: 100 },
    temporaryId: () => IDS[0],
  });
  const staged = path.join(fixture.workspace.dir, 'previews', 'finished.mp4');
  fs.writeFileSync(staged, 'new-preview');
  const fileSystem = new Proxy(fs, {
    get(target, property) {
      if (property !== 'openSync') return Reflect.get(target, property);
      return (filename, ...args) => {
        if (typeof filename === 'string' && filename.includes('.tmp-preview-manifest-')) {
          const error = new Error('simulated preview manifest stage failure');
          error.code = 'EIO';
          throw error;
        }
        return target.openSync(filename, ...args);
      };
    },
  });

  assert.throws(() => publishCurrentPreview(fixture.workspace, planned, staged, {
    width: 160, height: 90, fps: 25, generatedAt: '2026-08-23T17:05:00.000Z',
  }, { fileSystem, temporaryId: idSequence() }), /simulated preview manifest/);
  assert.equal(fs.readFileSync(current, 'utf8'), 'previous-preview');
  assert.deepEqual(fs.readFileSync(path.join(fixture.workspace.dir, 'project.json')), beforeManifest);
});

function fakePreviewTools({ calls, failStage = null }) {
  return {
    resolveRemotionCommandImpl: () => ({ command: process.execPath, argsPrefix: ['remotion.js'] }),
    runToolImpl(command, args, options) {
      calls.push(options.stage);
      if (options.stage === 'preview Remotion') {
        if (failStage === 'render') throw new Error('render failed');
        fs.writeFileSync(args[4], 'raw-preview');
      }
      if (options.stage === 'preview decode' && failStage === 'decode') {
        throw new Error('decode failed');
      }
    },
    runNodeToolImpl(script, args, options) {
      calls.push(options.stage);
      if (options.stage === 'preview finish') {
        if (failStage === 'finish') throw new Error('finish failed');
        fs.writeFileSync(args[1], 'finished-preview');
      } else if (options.stage === 'preview music mix') {
        if (failStage === 'music') throw new Error('music failed');
        fs.writeFileSync(args[2], 'mixed-preview');
      }
    },
    probeVideoImpl: () => ({ width: 160, height: 90, fps: 25, duration: 4 }),
    openMediaFileImpl: () => { throw new Error('must not open with open=false'); },
    now: () => new Date('2026-08-23T17:05:00.000Z'),
    temporaryId: idSequence(),
  };
}

test('preview command runs the real composition stages in order without final history', (t) => {
  const fixture = makeProject(t, { music: true });
  const calls = [];

  const result = runPreview({
    projectDir: fixture.workspace.dir,
    briefPath: fixture.published.relativePath,
    open: false,
  }, fakePreviewTools({ calls }));
  const manifest = readProjectManifest(fixture.workspace.dir);

  assert.deepEqual(calls, [
    'preview Remotion', 'preview finish', 'preview music mix', 'preview decode',
  ]);
  assert.equal(fs.readFileSync(result.currentPath, 'utf8'), 'mixed-preview');
  assert.equal(result.metadata.kind, 'full');
  assert.equal(manifest.renders.length, 0);
  assert.equal(manifest.latestRender, null);
  assert.equal(fs.existsSync(path.join(fixture.workspace.dir, 'final', 'preview-test.mp4')), false);
});

test('render, finish, and music failures preserve the previous current preview byte-for-byte', async (t) => {
  for (const failStage of ['render', 'finish', 'music']) {
    await t.test(failStage, () => {
      const fixture = makeProject(t, { music: true });
      const current = path.join(fixture.workspace.dir, 'previews', 'current-preview.mp4');
      fs.writeFileSync(current, 'previous-preview');
      const beforeManifest = fs.readFileSync(path.join(fixture.workspace.dir, 'project.json'));

      assert.throws(() => runPreview({
        projectDir: fixture.workspace.dir,
        briefPath: fixture.published.relativePath,
        open: false,
      }, fakePreviewTools({ calls: [], failStage })), new RegExp(`${failStage} failed`));

      assert.equal(fs.readFileSync(current, 'utf8'), 'previous-preview');
      assert.deepEqual(
        fs.readFileSync(path.join(fixture.workspace.dir, 'project.json')),
        beforeManifest,
      );
    });
  }
});
