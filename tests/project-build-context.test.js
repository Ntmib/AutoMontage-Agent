const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createBuildContext,
  resolveOutputDestination,
} = require('../scripts/project/build-context');

function makeFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-context-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source.mp4');
  fs.writeFileSync(source, 'video');
  return { dir, source };
}

test('project planning uses its copied source and versioned brief paths', (t) => {
  const fixture = makeFixture(t);
  const context = createBuildContext({
    root: fixture.dir,
    cwd: fixture.dir,
    video: fixture.source,
    projectName: 'Тест проекта',
    action: 'plan',
    kind: 'lesson',
    now: new Date('2026-08-05T12:00:00Z'),
  });

  assert.equal(context.video, path.join(context.project.dir, 'input/source.mp4'));
  assert.equal(
    context.paths.briefJson,
    path.join(context.project.dir, 'brief/v01-draft.lesson.json'),
  );
  assert.equal(
    context.paths.briefMarkdown,
    path.join(context.project.dir, 'brief/v01-draft.lesson.md'),
  );
  assert.equal(context.paths.transcript, path.join(context.project.dir, 'transcript/words.json'));
  assert.equal(context.paths.captions, path.join(context.project.dir, 'transcript/captions.js'));
  assert.equal(context.paths.render, null);
});

test('project rendering resolves briefs inside the project and allocates a render version', (t) => {
  const fixture = makeFixture(t);
  const planned = createBuildContext({
    root: fixture.dir,
    cwd: fixture.dir,
    video: fixture.source,
    projectName: 'Тест проекта',
    action: 'plan',
    kind: 'lesson',
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const approved = path.join(planned.project.dir, 'brief/v01-approved.lesson.json');
  fs.writeFileSync(approved, '{}');

  const context = createBuildContext({
    root: fixture.dir,
    cwd: fixture.dir,
    video: planned.video,
    projectDir: planned.project.dir,
    action: 'render',
    kind: 'lesson',
    versionLabel: 'Первый рендер',
  });

  assert.equal(context.resolveBrief('brief/v01-approved.lesson.json'), approved);
  assert.equal(path.basename(context.paths.render.dir), 'v01-pervyy-render');
  assert.equal(context.paths.props, path.join(context.paths.render.dir, 'props.json'));
  assert.equal(context.paths.raw, path.join(context.paths.render.dir, 'raw.mp4'));
  assert.equal(context.paths.final, path.join(context.paths.render.dir, 'final.mp4'));
  assert.throws(() => context.resolveBrief('../outside.json'), /внутри проекта/);
});

test('project brief resolution rejects an in-project symlink but accepts a contained file', (t) => {
  const fixture = makeFixture(t);
  const planned = createBuildContext({
    root: fixture.dir,
    cwd: fixture.dir,
    video: fixture.source,
    projectName: 'Brief symlink',
    action: 'plan',
    kind: 'lesson',
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const containedBrief = path.join(planned.project.dir, 'brief/contained.lesson.json');
  const outsideBrief = path.join(fixture.dir, 'outside.lesson.json');
  const symlinkBrief = path.join(planned.project.dir, 'brief/symlink.lesson.json');
  fs.writeFileSync(containedBrief, '{}');
  fs.writeFileSync(outsideBrief, '{"outside":true}');
  fs.symlinkSync(outsideBrief, symlinkBrief, 'file');
  const context = createBuildContext({
    root: fixture.dir,
    cwd: fixture.dir,
    video: planned.video,
    projectDir: planned.project.dir,
    action: 'plan',
    kind: 'lesson',
  });

  assert.equal(context.resolveBrief('brief/contained.lesson.json'), containedBrief);
  assert.throws(() => context.resolveBrief('brief/symlink.lesson.json'), /symbolic link/i);
  assert.equal(fs.readFileSync(outsideBrief, 'utf8'), '{"outside":true}');
});

test('legacy builds isolate generated data under out', (t) => {
  const fixture = makeFixture(t);
  const context = createBuildContext({
    root: fixture.dir,
    cwd: fixture.dir,
    video: fixture.source,
    action: 'render',
    kind: 'lesson',
    id: 'demo',
  });

  assert.equal(context.project, null);
  assert.equal(context.video, fixture.source);
  assert.equal(context.paths.briefJson, path.join(fixture.dir, 'out/demo.lesson.json'));
  assert.equal(context.paths.raw, path.join(fixture.dir, 'out/demo.raw.mp4'));
  assert.equal(context.paths.final, path.join(fixture.dir, 'out/demo.mp4'));
  assert.equal(context.paths.transcript, path.join(fixture.dir, 'out/demo.transcript.json'));
  assert.equal(context.paths.captions, path.join(fixture.dir, 'out/demo.captions.js'));
});

test('legacy ids cannot escape out and canonical ids keep every generated path contained', (t) => {
  const fixture = makeFixture(t);
  const sentinel = path.join(fixture.dir, 'outside', 'owned');
  fs.mkdirSync(path.dirname(sentinel), { recursive: true });
  fs.writeFileSync(sentinel, 'outside-must-survive');

  assert.throws(() => createBuildContext({
    root: fixture.dir,
    cwd: fixture.dir,
    video: fixture.source,
    action: 'render',
    kind: 'lesson',
    id: '../outside/owned',
  }), /--id/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside-must-survive');

  for (const id of ['demo', 'clip_01', 'Reel-2']) {
    const context = createBuildContext({
      root: fixture.dir,
      cwd: fixture.dir,
      video: fixture.source,
      action: 'render',
      kind: 'lesson',
      id,
    });
    for (const generated of Object.values(context.paths).filter((value) => typeof value === 'string')) {
      const relative = path.relative(path.join(fixture.dir, 'out'), generated);
      assert.equal(relative.startsWith('..') || path.isAbsolute(relative), false, generated);
    }
  }
});

test('explicit output destination remains beneath outdir independently of its filename token', () => {
  const cwd = path.join(os.tmpdir(), 'automontage-output-root');
  const outdir = 'exports';
  assert.equal(
    resolveOutputDestination({ cwd, outdir, outputName: 'safe-project-01' }),
    path.join(cwd, outdir, 'safe-project-01.mp4'),
  );
  for (const outputName of ['../outside/owned', 'nested/owned', '/tmp/owned']) {
    assert.throws(
      () => resolveOutputDestination({ cwd, outdir, outputName }),
      /output name|outdir/i,
      outputName,
    );
  }
});

test('project continuation rejects a different input video', (t) => {
  const fixture = makeFixture(t);
  const context = createBuildContext({
    root: fixture.dir,
    cwd: fixture.dir,
    video: fixture.source,
    projectName: 'Frozen source',
    action: 'plan',
    kind: 'lesson',
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const otherSource = path.join(fixture.dir, 'other.mp4');
  fs.writeFileSync(otherSource, 'other');

  assert.throws(() => createBuildContext({
    root: fixture.dir,
    cwd: fixture.dir,
    video: otherSource,
    projectDir: context.project.dir,
    action: 'render',
    kind: 'lesson',
  }), /другой исходник/);
});

test('dynamic project keeps its scenario and render in the same workspace', (t) => {
  const fixture = makeFixture(t);
  const context = createBuildContext({
    root: fixture.dir,
    cwd: fixture.dir,
    video: fixture.source,
    projectName: 'Dynamic reel',
    action: 'render',
    kind: 'scenario',
    versionLabel: 'Auto edit',
    now: new Date('2026-08-05T12:00:00Z'),
  });

  assert.equal(
    context.paths.scenarioJson,
    path.join(context.project.dir, 'brief/v01-draft.scenario.json'),
  );
  assert.equal(path.basename(context.paths.render.dir), 'v01-auto-edit');
});

test('project context exposes only contained source and transcript paths from the manifest', (t) => {
  const fixture = makeFixture(t);
  const planned = createBuildContext({
    root: fixture.dir,
    cwd: fixture.dir,
    video: fixture.source,
    projectName: 'Manifest consumers',
    action: 'plan',
    kind: 'lesson',
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const manifestPath = path.join(planned.project.dir, 'project.json');
  const originalManifest = fs.readFileSync(manifestPath, 'utf8');
  const cases = [
    ['source.localPath', (manifest) => { manifest.source.localPath = '../../outside-source.mp4'; }],
    ['transcript.words', (manifest) => { manifest.transcript.words = '../../outside-words.json'; }],
    ['transcript.captions', (manifest) => { manifest.transcript.captions = '../../outside-captions.js'; }],
  ];

  for (const [field, mutate] of cases) {
    const manifest = JSON.parse(originalManifest);
    mutate(manifest);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.throws(() => createBuildContext({
      root: fixture.dir,
      cwd: fixture.dir,
      video: fixture.source,
      projectDir: planned.project.dir,
      action: 'plan',
      kind: 'lesson',
    }), new RegExp(field.replace('.', '\\.')));
  }
});
