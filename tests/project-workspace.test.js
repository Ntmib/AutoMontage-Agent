const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createOrOpenProject,
  formatProjectId,
  readProjectManifest,
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
