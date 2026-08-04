const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createOrOpenProject,
  formatProjectId,
  nextBriefPaths,
  nextRenderPaths,
  publishFinal,
  readProjectManifest,
  recordBrief,
  recordRender,
  slugifyProjectName,
} = require('../scripts/project/workspace');

function makeFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-project-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, 'camera.MP4');
  fs.writeFileSync(sourcePath, 'video');
  return { dir, sourcePath };
}

test('project id uses a full dotted date and latin slug', () => {
  assert.equal(formatProjectId({
    date: new Date('2026-08-05T12:00:00Z'),
    name: 'Монтаж Claude Code',
  }), '2026.08.05_montazh-claude-code');
});

test('project slug rejects a name with no letters or digits', () => {
  assert.throws(() => slugifyProjectName('...'), /названи/);
});

test('project creation copies one source and creates the full workspace', (t) => {
  const fixture = makeFixture(t);
  const baseDir = path.join(fixture.dir, 'projects');
  const workspace = createOrOpenProject({
    baseDir,
    name: 'Тест ролик',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });

  assert.equal(path.basename(workspace.dir), '2026.08.05_test-rolik');
  assert.equal(fs.readFileSync(workspace.sourcePath, 'utf8'), 'video');
  assert.ok(fs.existsSync(path.join(workspace.dir, 'assets/music')));
  assert.ok(fs.existsSync(path.join(workspace.dir, 'assets/broll')));
  assert.ok(fs.existsSync(path.join(workspace.dir, 'brief')));
  assert.ok(fs.existsSync(path.join(workspace.dir, 'previews')));
  assert.ok(fs.existsSync(path.join(workspace.dir, 'renders')));
  assert.ok(fs.existsSync(path.join(workspace.dir, 'final')));
  assert.equal(workspace.manifest.source.localPath, 'input/source.mp4');
  assert.equal(readProjectManifest(workspace.dir).id, '2026.08.05_test-rolik');
});

test('existing project opens without copying its source again', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Test reel',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  fs.writeFileSync(workspace.sourcePath, 'kept');

  const reopened = createOrOpenProject({ projectDir: workspace.dir });

  assert.equal(reopened.dir, workspace.dir);
  assert.equal(fs.readFileSync(reopened.sourcePath, 'utf8'), 'kept');
});

test('existing project rejects a different source', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Test reel',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const otherSource = path.join(fixture.dir, 'other.mp4');
  fs.writeFileSync(otherSource, 'other');

  assert.throws(
    () => createOrOpenProject({ projectDir: workspace.dir, sourcePath: otherSource }),
    /другой исходник/,
  );
});

test('brief revisions advance from manifest history', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Versioned brief',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });

  const first = nextBriefPaths(workspace);
  assert.equal(path.basename(first.jsonPath), 'v01-draft.lesson.json');
  assert.equal(path.basename(first.markdownPath), 'v01-draft.lesson.md');

  recordBrief(workspace, {
    revision: first.revision,
    jsonPath: first.jsonPath,
    markdownPath: first.markdownPath,
    status: 'draft',
    theme: 'lesson-neutral',
    aspect: 'source',
  });

  assert.equal(path.basename(nextBriefPaths(workspace).jsonPath), 'v02-draft.lesson.json');
  const manifest = readProjectManifest(workspace.dir);
  assert.equal(manifest.currentBrief, 'brief/v01-draft.lesson.json');
  assert.equal(manifest.briefs[0].theme, 'lesson-neutral');
});

test('render versions keep history and publish one canonical final', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Versioned render',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });

  const first = nextRenderPaths(workspace, 'Новая музыка');
  assert.equal(path.basename(first.dir), 'v01-novaya-muzyka');
  assert.equal(path.basename(first.propsPath), 'props.json');
  assert.equal(path.basename(first.rawPath), 'raw.mp4');
  assert.equal(path.basename(first.finalPath), 'final.mp4');
  fs.writeFileSync(first.finalPath, 'render');

  recordRender(workspace, {
    version: first.version,
    label: first.label,
    dir: first.dir,
    status: 'complete',
  });

  assert.equal(path.basename(nextRenderPaths(workspace, 'Ducking').dir), 'v02-ducking');
  const canonicalFinal = publishFinal(workspace, first.finalPath);
  assert.equal(fs.readFileSync(canonicalFinal, 'utf8'), 'render');
  const manifest = readProjectManifest(workspace.dir);
  assert.equal(manifest.latestRender, 'renders/v01-novaya-muzyka');
  assert.equal(manifest.final, 'final/versioned-render.mp4');
});

test('render status updates one manifest entry instead of duplicating a version', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Render lifecycle',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const render = nextRenderPaths(workspace, 'Ducking');

  recordRender(workspace, {
    version: render.version,
    label: render.label,
    dir: render.dir,
    status: 'started',
  });
  recordRender(workspace, {
    version: render.version,
    label: render.label,
    dir: render.dir,
    status: 'complete',
  });

  const manifest = readProjectManifest(workspace.dir);
  assert.equal(manifest.renders.length, 1);
  assert.equal(manifest.renders[0].status, 'complete');
});
