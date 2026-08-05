const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { assertProjectFinal } = require('../scripts/smoke-release');
const {
  createOrOpenProject,
  nextRenderPaths,
  publishFinal,
  recordRender,
} = require('../scripts/project/workspace');

test('release smoke accepts a final owned by the complete render selected in the manifest', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-smoke-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, 'source.mp4');
  fs.writeFileSync(sourcePath, 'source');
  const workspace = createOrOpenProject({
    baseDir: path.join(dir, 'projects'),
    name: 'Smoke final',
    sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const render = nextRenderPaths(workspace, 'Release');
  fs.writeFileSync(render.finalPath, 'release-render');
  recordRender(workspace, { ...render, status: 'complete' });
  const finalPath = publishFinal(workspace, render.finalPath);

  assert.equal(assertProjectFinal(workspace.dir), finalPath);
});

test('release smoke rejects a latestRender that does not select a complete render', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-smoke-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, 'source.mp4');
  fs.writeFileSync(sourcePath, 'source');
  const workspace = createOrOpenProject({
    baseDir: path.join(dir, 'projects'),
    name: 'Invalid smoke final',
    sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const render = nextRenderPaths(workspace, 'Unfinished');
  fs.writeFileSync(render.finalPath, 'unfinished-render');
  const manifest = {
    ...workspace.manifest,
    renders: [{
      version: render.version,
      label: render.label,
      dir: 'renders/v01-unfinished',
      briefPath: null,
      status: 'started',
    }],
    latestRender: 'renders/v01-unfinished',
  };
  fs.writeFileSync(
    path.join(workspace.dir, 'project.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  assert.throws(() => assertProjectFinal(workspace.dir), /latestRender.*complete/);
});

test('release smoke rejects a selected render final that escapes through a symbolic link', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-smoke-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, 'source.mp4');
  const outsideFinal = path.join(dir, 'outside-final.mp4');
  fs.writeFileSync(sourcePath, 'source');
  fs.writeFileSync(outsideFinal, 'release-render');
  const workspace = createOrOpenProject({
    baseDir: path.join(dir, 'projects'),
    name: 'Symlink smoke final',
    sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const render = nextRenderPaths(workspace, 'Release');
  fs.writeFileSync(render.finalPath, 'release-render');
  recordRender(workspace, { ...render, status: 'complete' });
  publishFinal(workspace, render.finalPath);
  fs.unlinkSync(render.finalPath);
  fs.symlinkSync(outsideFinal, render.finalPath, 'file');

  assert.throws(() => assertProjectFinal(workspace.dir), /symbolic link/);
});
