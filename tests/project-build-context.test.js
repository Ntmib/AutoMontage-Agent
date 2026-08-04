const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBuildContext } = require('../scripts/project/build-context');

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

test('legacy builds retain the flat out paths', (t) => {
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
  assert.equal(context.paths.transcript, path.join(fixture.dir, 'src/data/transcript.json'));
  assert.equal(context.paths.captions, path.join(fixture.dir, 'src/data/captions.js'));
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
