const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  approveBrief,
  createOrOpenProject,
  formatProjectId,
  nextBriefPaths,
  nextRenderPaths,
  publishFinal,
  readProjectManifest,
  recordBrief,
  recordRender,
  runRenderLifecycle,
  slugifyProjectName,
  writeProjectManifest,
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

test('manifest rejects traversal and non-canonical final paths without touching an outside file', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Manifest paths',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const sentinelPath = path.join(fixture.dir, 'outside.mp4');
  fs.writeFileSync(sentinelPath, 'do-not-touch');
  const maliciousPaths = [
    '../../outside.mp4',
    '../outside.mp4',
    '/tmp/outside.mp4',
    'C:\\temp\\outside.mp4',
    'C:outside.mp4',
    '..\\..\\outside.mp4',
    'renders/../outside.mp4',
    'renders//final.mp4',
  ];

  for (const maliciousPath of maliciousPaths) {
    const manifest = { ...workspace.manifest, final: maliciousPath };
    fs.writeFileSync(
      path.join(workspace.dir, 'project.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    assert.throws(
      () => readProjectManifest(workspace.dir),
      /final/,
      `read rejects ${JSON.stringify(maliciousPath)} with the field name`,
    );
    assert.throws(
      () => writeProjectManifest(workspace.dir, manifest),
      /final/,
      `write rejects ${JSON.stringify(maliciousPath)} with the field name`,
    );
    assert.equal(fs.readFileSync(sentinelPath, 'utf8'), 'do-not-touch');
  }

  const validManifest = { ...workspace.manifest, final: 'renders/final/final.mp4' };
  fs.writeFileSync(
    path.join(workspace.dir, 'project.json'),
    `${JSON.stringify(validManifest, null, 2)}\n`,
  );
  assert.equal(readProjectManifest(workspace.dir).final, 'renders/final/final.mp4');
});

test('manifest rejects a final path that escapes through a symbolic link', (t) => {
  const fixture = makeFixture(t);
  const projectDir = path.join(fixture.dir, 'project');
  const workspace = createOrOpenProject({
    projectDir,
    name: 'Symbolic link',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const outsideDir = path.join(fixture.dir, 'outside');
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(path.join(outsideDir, 'final.mp4'), 'outside-render');
  fs.symlinkSync('../../outside', path.join(workspace.dir, 'renders', 'link'), 'dir');
  const manifest = { ...workspace.manifest, final: 'renders/link/final.mp4' };
  fs.writeFileSync(
    path.join(workspace.dir, 'project.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  assert.throws(() => readProjectManifest(workspace.dir), /final.*symbolic link/i);
  assert.equal(fs.readFileSync(path.join(outsideDir, 'final.mp4'), 'utf8'), 'outside-render');
});

test('manifest migration adds the canonical transcript paths before validation', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Legacy manifest',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const legacyManifest = { ...workspace.manifest };
  delete legacyManifest.transcript;
  fs.writeFileSync(
    path.join(workspace.dir, 'project.json'),
    `${JSON.stringify(legacyManifest, null, 2)}\n`,
  );

  assert.deepEqual(readProjectManifest(workspace.dir).transcript, {
    words: 'transcript/words.json',
    captions: 'transcript/captions.js',
  });
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
  assert.ok(fs.existsSync(path.join(workspace.dir, 'transcript')));
  assert.ok(fs.existsSync(path.join(workspace.dir, 'previews')));
  assert.ok(fs.existsSync(path.join(workspace.dir, 'renders')));
  assert.ok(fs.existsSync(path.join(workspace.dir, 'final')));
  assert.equal(workspace.manifest.source.localPath, 'input/source.mp4');
  assert.equal(workspace.manifest.transcript.words, 'transcript/words.json');
  assert.equal(workspace.manifest.transcript.captions, 'transcript/captions.js');
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

test('approval freezes a reviewed draft under an approved filename', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Approved brief',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const draft = nextBriefPaths(workspace);
  fs.writeFileSync(draft.jsonPath, JSON.stringify({ status: 'draft', scenes: [] }));
  fs.writeFileSync(draft.markdownPath, 'Статус: draft\n');
  recordBrief(workspace, {
    revision: draft.revision,
    jsonPath: draft.jsonPath,
    markdownPath: draft.markdownPath,
    status: 'draft',
  });

  const approved = approveBrief(workspace, draft.jsonPath);

  assert.equal(path.basename(approved.jsonPath), 'v01-approved.lesson.json');
  assert.equal(path.basename(approved.markdownPath), 'v01-approved.lesson.md');
  assert.equal(JSON.parse(fs.readFileSync(approved.jsonPath, 'utf8')).status, 'approved');
  assert.match(fs.readFileSync(approved.markdownPath, 'utf8'), /Статус: approved/);
  assert.equal(
    readProjectManifest(workspace.dir).currentBrief,
    'brief/v01-approved.lesson.json',
  );
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

test('render lifecycle publishes final only after successful work', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Lifecycle success',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const render = nextRenderPaths(workspace, 'First');

  const destination = runRenderLifecycle(workspace, render, () => {
    fs.writeFileSync(render.finalPath, 'new-final');
    return render.finalPath;
  });

  const manifest = readProjectManifest(workspace.dir);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'new-final');
  assert.equal(manifest.latestRender, 'renders/v01-first');
  assert.equal(manifest.renders[0].status, 'complete');
});

test('render lifecycle records stage failures and retains the previous final', async (t) => {
  for (const failedStage of ['render', 'finish', 'music']) {
    await t.test(failedStage, () => {
      const fixture = makeFixture(t);
      const workspace = createOrOpenProject({
        baseDir: path.join(fixture.dir, 'projects'),
        name: `Failure ${failedStage}`,
        sourcePath: fixture.sourcePath,
        now: new Date('2026-08-05T12:00:00Z'),
      });
      const previous = nextRenderPaths(workspace, 'Previous');
      fs.writeFileSync(previous.finalPath, 'previous-final');
      recordRender(workspace, { ...previous, status: 'complete' });
      const canonical = publishFinal(workspace, previous.finalPath);
      const previousHash = fs.readFileSync(canonical, 'utf8');
      const attempted = nextRenderPaths(workspace, 'Attempted');

      assert.throws(() => runRenderLifecycle(workspace, attempted, () => {
        throw new Error(`${failedStage} failed`);
      }), new RegExp(`${failedStage} failed`));

      const manifest = readProjectManifest(workspace.dir);
      assert.equal(fs.readFileSync(canonical, 'utf8'), previousHash);
      assert.equal(manifest.latestRender, 'renders/v01-previous');
      assert.equal(manifest.renders.at(-1).status, 'failed');
      assert.equal(manifest.renders.length, 2);
    });
  }
});

test('publish failure records failed and retains the previous final', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Publish failure',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const previous = nextRenderPaths(workspace, 'Previous');
  fs.writeFileSync(previous.finalPath, 'previous-final');
  recordRender(workspace, { ...previous, status: 'complete' });
  const canonical = publishFinal(workspace, previous.finalPath);
  const attempted = nextRenderPaths(workspace, 'Attempted');
  fs.writeFileSync(attempted.finalPath, 'attempted-final');

  assert.throws(() => runRenderLifecycle(
    workspace,
    attempted,
    () => attempted.finalPath,
    { publish: () => { throw new Error('publish failed'); } },
  ), /publish failed/);

  const manifest = readProjectManifest(workspace.dir);
  assert.equal(fs.readFileSync(canonical, 'utf8'), 'previous-final');
  assert.equal(manifest.latestRender, 'renders/v01-previous');
  assert.equal(manifest.renders.at(-1).status, 'failed');
});

test('atomic final publish removes a failed temporary copy and preserves canonical final', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Atomic publish',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const render = nextRenderPaths(workspace, 'Attempt');
  fs.writeFileSync(render.finalPath, 'replacement');
  const canonical = path.join(workspace.dir, workspace.manifest.final);
  fs.writeFileSync(canonical, 'previous-final');
  const failingFs = {
    ...fs,
    renameSync() {
      throw new Error('rename failed');
    },
  };

  assert.throws(
    () => publishFinal(workspace, render.finalPath, { fileSystem: failingFs }),
    /rename failed/,
  );

  assert.equal(fs.readFileSync(canonical, 'utf8'), 'previous-final');
  assert.deepEqual(
    fs.readdirSync(path.dirname(canonical)).filter((name) => name.includes('.tmp-')),
    [],
  );
});
