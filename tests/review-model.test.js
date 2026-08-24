const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const {
  buildReviewCandidateBase,
  buildReviewStateFromEdit,
  loadReviewState,
} = require('../scripts/review/model');
const { listReviewAssetRecords, resolveReviewAsset } = require('../scripts/review/assets');
const { makeReviewProject } = require('./helpers/review-project');

function registerCurrentPreview(fixture, {
  kind = 'full', fromSec = 0, toSec = 4,
} = {}) {
  const bytes = Buffer.from('rendered preview fixture');
  const revision = path.join(fixture.workspace.dir, 'previews', 'v01-draft-full.mp4');
  const current = path.join(fixture.workspace.dir, 'previews', 'current-preview.mp4');
  fs.writeFileSync(revision, bytes);
  fs.writeFileSync(current, bytes);
  const manifestPath = path.join(fixture.workspace.dir, 'project.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.currentPreview = {
    filePath: 'previews/v01-draft-full.mp4',
    briefPath: manifest.currentBrief,
    kind,
    fromSec,
    toSec,
    width: 960,
    height: 540,
    fps: 25,
    generatedAt: '2026-08-23T17:05:00.000Z',
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

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
  assert.equal(state.currentPreview, null);
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

test('review state exposes only current rendered preview metadata and an opaque media handle', (t) => {
  const fixture = makeReviewProject(t);
  registerCurrentPreview(fixture, { kind: 'excerpt', fromSec: 31.5, toSec: 57.5 });

  const state = loadReviewState({ root: ROOT, projectDir: fixture.projectDir });

  assert.deepEqual(state.currentPreview, {
    url: '/media/current-preview',
    kind: 'excerpt',
    fromSec: 31.5,
    toSec: 57.5,
    width: 960,
    height: 540,
    fps: 25,
    generatedAt: '2026-08-23T17:05:00.000Z',
  });
  assert.doesNotMatch(JSON.stringify(state.currentPreview), /previews|\.mp4|sha256|\/Users\/|C:\\Users\\/);
});

test('review state timing diagnostics use normalized word timestamps', (t) => {
  const { projectDir, briefPath, workspace } = makeReviewProject(t);
  const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
  brief.scenes[0].end = 2.04;
  brief.scenes[1].start = 2.04;
  fs.writeFileSync(briefPath, `${JSON.stringify(brief, null, 2)}\n`);
  const transcriptPath = path.join(workspace.dir, workspace.manifest.transcript.words);
  fs.writeFileSync(transcriptPath, `${JSON.stringify([{
    start: 0,
    end: 4,
    text: 'слово рядом',
    words: [
      { w: 'слово', s: 1.4, e: 1.9 },
      { w: 'рядом', s: 2.08, e: 2.5 },
    ],
  }], null, 2)}\n`);

  const state = loadReviewState({ root: ROOT, projectDir });

  assert.ok(state.timing.suggestions.some((suggestion) => (
    suggestion.reason === 'word'
      && suggestion.seconds === 2.04
      && suggestion.suggestedSeconds === 2.08
  )));
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
    mediaKind: 'image',
    label: 'diagram.png',
    url: '/media/assets/asset-7',
    capabilities: { preview: true, brollImage: true, brollVideo: false },
  });
  assert.deepEqual(publicAsset, {
    id: 'asset-8',
    kind: 'public',
    mediaKind: 'image',
    label: 'growth.png',
    url: '/media/assets/asset-8',
    capabilities: { preview: true, brollImage: true, brollVideo: false },
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

test('review assets expose preview and renderable b-roll capabilities without host paths', (t) => {
  const { workspace, projectDir } = makeReviewProject(t);
  const assets = path.join(workspace.dir, 'assets', 'broll');
  fs.writeFileSync(path.join(assets, 'diagram.png'), 'image');
  fs.writeFileSync(path.join(assets, 'voice.mp3'), 'audio');
  fs.writeFileSync(path.join(assets, 'clip.mp4'), 'video');

  const state = loadReviewState({ root: ROOT, projectDir });
  const byLabel = new Map(state.assets.map((asset) => [asset.label, asset]));

  assert.deepEqual(byLabel.get('diagram.png').capabilities, { preview: true, brollImage: true, brollVideo: false });
  assert.deepEqual(byLabel.get('voice.mp3').capabilities, { preview: true, brollImage: false, brollVideo: false });
  assert.deepEqual(byLabel.get('clip.mp4').capabilities, { preview: true, brollImage: false, brollVideo: false });
  assert.doesNotMatch(JSON.stringify(state.assets), /assets\/broll|\/Users\/|C:\\Users\\/);
});

test('review state reconstructs the exact opaque imported-video descriptor from disk', (t) => {
  const { projectDir } = makeReviewProject(t);
  const id = '4af36be4-0b26-4e6f-bd48-8bdd2215a4f1';
  const mediaDirectory = path.join(projectDir, 'assets', 'broll', 'video', id);
  const previewDirectory = path.join(projectDir, 'previews', 'broll');
  fs.mkdirSync(mediaDirectory, { recursive: true });
  fs.mkdirSync(previewDirectory, { recursive: true });
  const canonical = Buffer.from('canonical video');
  const preview = Buffer.from('preview video');
  fs.writeFileSync(path.join(mediaDirectory, 'media.mp4'), canonical);
  fs.writeFileSync(path.join(previewDirectory, `${id}.webm`), preview);
  fs.writeFileSync(path.join(mediaDirectory, 'asset.json'), `${JSON.stringify({
    version: 2,
    id,
    label: 'Product demo.mov',
    mediaKind: 'video',
    canonicalSha256: crypto.createHash('sha256').update(canonical).digest('hex'),
    previewSha256: crypto.createHash('sha256').update(preview).digest('hex'),
    width: 1920,
    height: 1080,
    fps: 25,
    durationSec: 18.4,
    audioDurationSec: 18.4,
    hasAudio: true,
  })}\n`);

  const state = loadReviewState({ root: ROOT, projectDir });
  const imported = state.assets.find((asset) => asset.label === 'Product demo.mov');
  assert.deepEqual(imported, {
    id: 'asset-1',
    kind: 'project',
    mediaKind: 'video',
    label: 'Product demo.mov',
    url: '/media/assets/asset-1',
    previewUrl: '/media/assets/asset-1/preview',
    width: 1920,
    height: 1080,
    fps: 25,
    durationSec: 18.4,
    audioDurationSec: 18.4,
    hasAudio: true,
    capabilities: { preview: true, brollImage: false, brollVideo: true },
  });
  assert.doesNotMatch(JSON.stringify(imported), /assets\/broll|previews\/broll|[a-f0-9]{64}|\/Users\//);
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
  brief.scenes[0].faceSrc = '/fixture-host/person/private.mp4';
  brief.scenes[1] = {
    scene: 'broll',
    start: 2,
    end: 4,
    brollSrc: '/fixture-host/person/private.png',
    headCream: 'ЧАСТНЫЙ',
    headOrange: 'ФАЙЛ',
  };
  fs.writeFileSync(briefPath, `${JSON.stringify(brief, null, 2)}\n`);

  const state = loadReviewState({ root: ROOT, projectDir });

  assert.equal(state.brief.scenes[0].faceSrc, undefined);
  assert.equal(state.brief.scenes[1].brollSrc, undefined);
  assert.doesNotMatch(JSON.stringify(state), /\/fixture-host\/|\/Users\/|C:\\Users\\/);
});

test('invalid review briefs expose a fixed public error', (t) => {
  const { projectDir, briefPath } = makeReviewProject(t);
  const hostileValue = '/fixture-host/person/private-invalid-scene';
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

test('persisted media projects to an opaque selection only on exact reference and hash match', (t) => {
  const { projectDir, briefPath, workspace } = makeReviewProject(t);
  const mediaPath = path.join(workspace.dir, 'assets', 'broll', 'selected.png');
  const bytes = Buffer.from('registered image bytes');
  fs.writeFileSync(mediaPath, bytes);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const canonicalBrief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
  canonicalBrief.scenes[1] = {
    scene: 'broll', start: 2, end: 4,
    brollMedia: {
      kind: 'image', src: 'assets/broll/selected.png', sha256, fit: 'contain',
    },
    headCream: 'БЕЗОПАСНЫЙ', headOrange: 'ВЫБОР',
  };
  const records = listReviewAssetRecords({ root: ROOT, projectDir });
  const assetFiles = new Map(records.map((record, index) => [`asset-${index + 1}`, record]));

  const projected = buildReviewCandidateBase({ canonicalBrief, assetFiles });
  const selected = [...assetFiles].find(([, record]) => record.reference === 'assets/broll/selected.png');
  assert.deepEqual(projected.scenes[1].brollMedia, {
    kind: 'image', assetId: selected[0], fit: 'contain',
  });
  assert.doesNotMatch(JSON.stringify(projected.scenes[1].brollMedia), /assets\/broll|[a-f0-9]{64}/);

  const hashMismatch = structuredClone(canonicalBrief);
  hashMismatch.scenes[1].brollMedia.sha256 = 'f'.repeat(64);
  const unresolved = buildReviewCandidateBase({ canonicalBrief: hashMismatch, assetFiles });
  assert.equal(unresolved.scenes[1].brollMedia, undefined);
  assert.equal(unresolved.scenes[1].brollMediaBlocked, true);
  assert.doesNotMatch(JSON.stringify(unresolved.scenes[1]), /assets\/broll|[a-f0-9]{64}/);
});

test('browser state exposes a fixed unresolved-media diagnostic without legacy or persisted values', (t) => {
  const { projectDir, briefPath } = makeReviewProject(t);
  const canonicalBrief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
  canonicalBrief.scenes[1] = {
    scene: 'broll', start: 2, end: 4,
    brollMedia: {
      kind: 'video',
      src: 'assets/broll/video/4af36be4-0b26-4e6f-bd48-8bdd2215a4f1/media.mp4',
      sha256: 'a'.repeat(64), trimStartSec: 1, fit: 'contain', audioMode: 'mute',
    },
    headCream: 'НЕ НАЙДЕН', headOrange: 'ФАЙЛ',
  };
  const candidate = buildReviewCandidateBase({ canonicalBrief, assetFiles: new Map() });
  const state = buildReviewStateFromEdit({
    state: { project: { id: 'p', name: 'P' }, session: {}, transcript: {}, assets: [] },
    brief: candidate,
    timing: { errors: [], warnings: [], suggestions: [] },
  });
  assert.deepEqual(state.brief.scenes[1].brollMediaDiagnostic, {
    code: 'unresolved-media', locked: true,
  });
  assert.equal(state.brief.scenes[1].brollMedia, undefined);
  assert.equal(state.brief.scenes[1].brollMediaBlocked, undefined);
  assert.doesNotMatch(JSON.stringify(state), /\/Users\/|assets\/broll|[a-f0-9]{64}/);

  const legacy = structuredClone(canonicalBrief);
  delete legacy.scenes[1].brollMedia;
  legacy.scenes[1].brollSrc = 'assets/broll/legacy.png';
  const legacyState = buildReviewStateFromEdit({
    state: { project: {}, session: {}, transcript: {}, assets: [] },
    brief: buildReviewCandidateBase({ canonicalBrief: legacy, assetFiles: new Map() }),
    timing: { errors: [], warnings: [], suggestions: [] },
  });
  assert.equal(legacyState.brief.scenes[1].brollSrc, undefined);
  assert.equal(legacyState.brief.scenes[1].brollMedia, undefined);
});
