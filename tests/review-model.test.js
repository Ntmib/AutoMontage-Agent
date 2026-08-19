const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { loadReviewState } = require('../scripts/review/model');
const { resolveReviewAsset } = require('../scripts/review/assets');
const { makeReviewProject } = require('./helpers/review-project');

test('review state exposes scenes and words without host paths', (t) => {
  const { projectDir } = makeReviewProject(t);

  const state = loadReviewState({ root: ROOT, projectDir, editable: false });

  assert.equal(state.session.editable, false);
  assert.equal(state.session.baseRevision, 1);
  assert.match(state.session.baseHash, /^[a-f0-9]{64}$/);
  assert.match(state.session.manifestHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(state.output, {
    width: 1920,
    height: 1080,
    fps: 25,
    durationInFrames: 100,
  });
  assert.deepEqual(state.source, { url: '/media/source' });
  assert.equal(state.brief.status, 'draft');
  assert.equal(state.brief.scenes.length, 2);
  assert.deepEqual(state.transcript.words, [
    { text: 'Первый', start: 0, end: 0.4 },
    { text: 'фрагмент', start: 0.5, end: 1.1 },
    { text: 'речи', start: 1.2, end: 1.6 },
  ]);
  assert.equal(state.waveform, null);
  assert.doesNotMatch(JSON.stringify(state), /\/Users\/|C:\\Users\\/);
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
});

test('review state exposes only the fixed waveform media handle when available', (t) => {
  const { projectDir } = makeReviewProject(t);

  const state = loadReviewState({
    root: ROOT,
    projectDir,
    waveformAvailable: true,
  });

  assert.deepEqual(state.waveform, { url: '/media/waveform' });
  assert.doesNotMatch(JSON.stringify(state.waveform), /previews|review-waveform|\/Users\/|C:\\Users\\/);
});

test('review rejects an unregistered brief and escaping asset path', (t) => {
  const { projectDir, workspace } = makeReviewProject(t);

  assert.throws(
    () => loadReviewState({ root: ROOT, projectDir, briefPath: '../../outside.json' }),
    /project|brief/i,
  );
  assert.equal(resolveReviewAsset({ root: ROOT, workspace, reference: '../../secret' }), null);
});

test('review asset descriptors expose opaque URLs for allowed project and public files', (t) => {
  const { workspace, projectDir } = makeReviewProject(t);
  const projectAsset = path.join(workspace.dir, 'assets', 'broll', 'diagram.png');
  fs.writeFileSync(projectAsset, 'project asset');

  const project = resolveReviewAsset({
    root: ROOT,
    workspace,
    reference: 'assets/broll/diagram.png',
    id: 'asset-7',
  });
  const publicAsset = resolveReviewAsset({
    root: ROOT,
    workspace,
    reference: 'broll/growth.png',
    id: 'asset-8',
  });

  assert.deepEqual(project, {
    id: 'asset-7',
    kind: 'project',
    label: 'diagram.png',
    url: '/media/assets/asset-7',
  });
  assert.deepEqual(publicAsset, {
    id: 'asset-8',
    kind: 'public',
    label: 'growth.png',
    url: '/media/assets/asset-8',
  });
  const state = loadReviewState({ root: ROOT, projectDir });
  assert.ok(state.assets.some((asset) => (
    asset.kind === 'project' && asset.label === 'diagram.png' && asset.url === '/media/assets/asset-1'
  )));
  assert.ok(state.assets.some((asset) => (
    asset.kind === 'public' && asset.label === 'growth.png' && /^\/media\/assets\/asset-\d+$/.test(asset.url)
  )));
  assert.doesNotMatch(JSON.stringify([project, publicAsset]), /assets\/broll|public\/broll|\/Users\/|C:\\Users\\/);
});

test('review asset resolution fails closed for project and public symlinks', (t) => {
  const { root, workspace } = makeReviewProject(t);
  const outside = path.join(root, 'outside.png');
  fs.writeFileSync(outside, 'outside asset');
  fs.symlinkSync(outside, path.join(workspace.dir, 'assets', 'broll', 'escape.png'));

  const repository = path.join(root, 'repository');
  const publicDir = path.join(repository, 'public', 'broll');
  fs.mkdirSync(publicDir, { recursive: true });
  fs.symlinkSync(outside, path.join(publicDir, 'escape.png'));

  assert.equal(resolveReviewAsset({
    root: repository,
    workspace,
    reference: 'assets/broll/escape.png',
  }), null);
  assert.equal(resolveReviewAsset({
    root: repository,
    workspace,
    reference: 'broll/escape.png',
  }), null);

});

test('review state strips path-bearing scene fields before browser serialization', (t) => {
  const { projectDir, briefPath } = makeReviewProject(t);
  const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
  brief.scenes[0].faceSrc = '/Users/person/private.mp4';
  brief.scenes[1] = {
    scene: 'broll',
    start: 2,
    end: 4,
    brollSrc: '/Users/person/private.png',
    headCream: 'ЧАСТНЫЙ',
    headOrange: 'ФАЙЛ',
  };
  fs.writeFileSync(briefPath, `${JSON.stringify(brief, null, 2)}\n`);

  const state = loadReviewState({ root: ROOT, projectDir });

  assert.equal(state.brief.scenes[0].faceSrc, undefined);
  assert.equal(state.brief.scenes[1].brollSrc, undefined);
  assert.doesNotMatch(JSON.stringify(state), /\/Users\/|C:\\Users\\/);
});

test('invalid review briefs expose a fixed public error', (t) => {
  const { projectDir, briefPath } = makeReviewProject(t);
  const hostileValue = '/Users/person/private-invalid-scene';
  const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
  brief.scenes[0].scene = hostileValue;
  fs.writeFileSync(briefPath, `${JSON.stringify(brief, null, 2)}\n`);

  assert.throws(
    () => loadReviewState({ root: ROOT, projectDir }),
    (error) => {
      assert.equal(error.message, 'review brief is invalid');
      assert.doesNotMatch(error.message, new RegExp(hostileValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.doesNotMatch(error.message, /\/Users\/|C:\\Users\\/);
      return true;
    },
  );
});
