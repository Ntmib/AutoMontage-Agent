const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const {
  cleanupOrphanImportedStages,
  inspectImportedAssetBundle,
  listImportedAssetBundles,
  parseImportedAssetMetadata,
} = require('../scripts/review/imported-assets');
const { listReviewAssetRecords, listReviewAssets } = require('../scripts/review/assets');
const { startReviewServer } = require('../scripts/review/server');
const { makeReviewProject } = require('./helpers/review-project');

const UUID = '4af36be4-0b26-4e6f-bd48-8bdd2215a4f1';
const SHA = (value) => crypto.createHash('sha256').update(value).digest('hex');

function metadata(overrides = {}) {
  return {
    version: 1,
    id: UUID,
    label: 'Product demo.mov',
    mediaKind: 'video',
    canonicalSha256: SHA('canonical video'),
    previewSha256: SHA('preview video'),
    width: 1920,
    height: 1080,
    fps: 25,
    durationSec: 18.4,
    hasAudio: true,
    ...overrides,
  };
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function makeProject(t) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-imported-assets-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  return projectDir;
}

function writeBundle(projectDir, { mediaKind = 'video', id = UUID, metadataOverrides = {} } = {}) {
  const mediaDirectory = path.join(projectDir, 'assets', 'broll', mediaKind === 'image' ? 'images' : 'video', id);
  const previewDirectory = path.join(projectDir, 'previews', 'broll');
  fs.mkdirSync(mediaDirectory, { recursive: true });
  fs.mkdirSync(previewDirectory, { recursive: true });
  const canonicalPath = path.join(mediaDirectory, mediaKind === 'image' ? 'media.webp' : 'media.mp4');
  const canonicalBytes = Buffer.from(mediaKind === 'image' ? 'canonical image' : 'canonical video');
  fs.writeFileSync(canonicalPath, canonicalBytes);
  const previewPath = path.join(previewDirectory, `${id}.webm`);
  if (mediaKind === 'video') fs.writeFileSync(previewPath, 'preview video');
  const assetMetadata = metadata({
    id,
    mediaKind,
    canonicalSha256: SHA(canonicalBytes),
    previewSha256: mediaKind === 'image' ? null : SHA('preview video'),
    width: mediaKind === 'image' ? 1200 : 1920,
    height: mediaKind === 'image' ? 800 : 1080,
    fps: mediaKind === 'image' ? 0 : 25,
    durationSec: mediaKind === 'image' ? 0 : 18.4,
    hasAudio: mediaKind === 'image' ? false : true,
    ...metadataOverrides,
  });
  writeJson(path.join(mediaDirectory, 'asset.json'), assetMetadata);
  return { assetMetadata, canonicalPath, mediaDirectory, previewPath };
}

function directoryIdentity(filePath) {
  const stat = fs.lstatSync(filePath, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function fileIdentity(filePath) {
  const stat = fs.lstatSync(filePath, { bigint: true });
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
  };
}

function writePublicationClaim(projectDir, {
  id = UUID,
  mediaKind = 'video',
  mediaDirectory,
  canonicalPath,
  previewPath = null,
  claimOverrides = {},
} = {}) {
  const mediaType = mediaKind === 'image' ? 'images' : 'video';
  const claimPath = path.join(projectDir, 'assets', 'broll', mediaType, `.${id}.claim`);
  const claim = {
    version: 1,
    id,
    purpose: 'review-media-import-publication',
    mediaKind,
    directory: mediaDirectory ? directoryIdentity(mediaDirectory) : null,
    canonical: canonicalPath ? fileIdentity(canonicalPath) : null,
    preview: previewPath ? fileIdentity(previewPath) : null,
    ...claimOverrides,
  };
  fs.writeFileSync(claimPath, `${JSON.stringify(claim)}\n`, { mode: 0o600 });
  return claimPath;
}

function requestState(session) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: session.server.address().port,
      path: '/api/state',
      headers: { authorization: `Bearer ${session.token}` },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test('imported metadata rejects malformed shapes and unsafe display labels', () => {
  assert.deepEqual(
    parseImportedAssetMetadata({ bytes: Buffer.from(JSON.stringify(metadata())), expectedId: UUID }),
    metadata(),
  );
  assert.throws(() => parseImportedAssetMetadata({
    bytes: Buffer.from(JSON.stringify(metadata({ extra: true }))),
    expectedId: UUID,
  }), /shape is invalid/);
  assert.throws(() => parseImportedAssetMetadata({
    bytes: Buffer.from(JSON.stringify(metadata({ id: '7c0f5b6a-a921-4a51-8787-467a3a5c7c20' }))),
    expectedId: UUID,
  }), /id is invalid/);
  assert.throws(() => parseImportedAssetMetadata({
    bytes: Buffer.from(JSON.stringify(metadata({ label: 'Cafe\u0301' }))),
    expectedId: UUID,
  }), /label is invalid/);
  assert.throws(() => parseImportedAssetMetadata({
    bytes: Buffer.from(JSON.stringify(metadata({ label: 'unsafe\nlabel' }))),
    expectedId: UUID,
  }), /label is invalid/);
  assert.throws(() => parseImportedAssetMetadata({
    bytes: Buffer.from(JSON.stringify(metadata({ label: 'x'.repeat(256) }))),
    expectedId: UUID,
  }), /label is invalid/);
  assert.throws(() => parseImportedAssetMetadata({
    bytes: Buffer.from(JSON.stringify(metadata({ canonicalSha256: 'A'.repeat(64) }))),
    expectedId: UUID,
  }), /hash is invalid/);
  assert.throws(() => parseImportedAssetMetadata({
    bytes: Buffer.from(JSON.stringify(metadata({ mediaKind: 'image', fps: 1 }))),
    expectedId: UUID,
  }), /image fields are invalid/);
});

test('imported bundle derives fixed paths from its UUID, hashes opened regular files, and requires video proxy', (t) => {
  const projectDir = makeProject(t);
  const video = writeBundle(projectDir);
  const inspected = inspectImportedAssetBundle({ projectDir, assetDirectory: video.mediaDirectory });
  assert.equal(inspected.label, 'Product demo.mov');
  assert.equal(inspected.reference, `assets/broll/video/${UUID}/media.mp4`);
  assert.equal(inspected.previewPath, video.previewPath);
  assert.deepEqual(inspected.capabilities, { preview: true, brollImage: false, brollVideo: true });
  for (const key of ['dev', 'ino', 'size']) assert.equal(typeof inspected[key], 'number');
  assert.equal(typeof inspected.mtimeNs, 'bigint');
  for (const key of ['previewDev', 'previewIno', 'previewSize', 'previewMtimeNs']) {
    assert.equal(typeof inspected[key], key === 'previewMtimeNs' ? 'bigint' : 'number');
  }

  fs.writeFileSync(video.previewPath, 'replaced preview');
  assert.equal(inspectImportedAssetBundle({ projectDir, assetDirectory: video.mediaDirectory }), null);
  fs.unlinkSync(video.previewPath);
  assert.equal(inspectImportedAssetBundle({ projectDir, assetDirectory: video.mediaDirectory }), null);

  const image = writeBundle(projectDir, { mediaKind: 'image', id: '7c0f5b6a-a921-4a51-8787-467a3a5c7c20' });
  const imageInspected = inspectImportedAssetBundle({ projectDir, assetDirectory: image.mediaDirectory });
  assert.equal(imageInspected.previewPath, null);
  assert.deepEqual(imageInspected.capabilities, { preview: true, brollImage: true, brollVideo: false });
  fs.unlinkSync(image.canonicalPath);
  fs.symlinkSync(video.canonicalPath, image.canonicalPath);
  assert.equal(inspectImportedAssetBundle({ projectDir, assetDirectory: image.mediaDirectory }), null);

  const fixedName = writeBundle(projectDir, { mediaKind: 'image', id: '6cfbc858-7e33-4d29-b948-7ce7992761fc' });
  fs.renameSync(fixedName.canonicalPath, path.join(fixedName.mediaDirectory, 'custom.webp'));
  assert.equal(inspectImportedAssetBundle({ projectDir, assetDirectory: fixedName.mediaDirectory }), null);
});

test('imported bundle inspection bounds metadata reads and hashes media incrementally', (t) => {
  const projectDir = makeProject(t);
  const video = writeBundle(projectDir);
  const readLengths = [];
  const fileSystem = Object.create(fs);
  fileSystem.readFileSync = () => {
    throw new Error('whole-file reads are forbidden during imported bundle inspection');
  };
  fileSystem.readSync = (...args) => {
    readLengths.push(args[3]);
    return fs.readSync(...args);
  };

  const inspected = inspectImportedAssetBundle({
    projectDir,
    assetDirectory: video.mediaDirectory,
    fileSystem,
  });
  assert.equal(inspected.label, 'Product demo.mov');
  assert.ok(readLengths.length >= 3);
  assert.ok(Math.max(...readLengths) <= 64 * 1024);
});

test('imported discovery skips invalid bundles and registry prefers valid masters over the generic scan', (t) => {
  const projectDir = makeProject(t);
  const video = writeBundle(projectDir);
  writeBundle(projectDir, {
    mediaKind: 'image',
    id: '7c0f5b6a-a921-4a51-8787-467a3a5c7c20',
    metadataOverrides: { label: 'Diagram.webp' },
  });
  const invalid = writeBundle(projectDir, {
    id: '0e5595fc-20a3-4d57-a4f8-7f538353438b',
    metadataOverrides: { canonicalSha256: '0'.repeat(64) },
  });
  fs.writeFileSync(path.join(projectDir, 'assets', 'broll', 'manual.mp4'), 'manual video');
  fs.writeFileSync(path.join(projectDir, 'assets', 'broll', 'voice.mp3'), 'audio-only');
  fs.writeFileSync(path.join(projectDir, 'assets', 'broll', 'legacy.png'), 'legacy image');
  fs.mkdirSync(path.join(projectDir, 'public', 'broll'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'public', 'broll', 'public.png'), 'public legacy image');

  assert.deepEqual(listImportedAssetBundles({ projectDir }).map((asset) => asset.label), [
    'Diagram.webp',
    'Product demo.mov',
  ]);
  assert.ok(fs.existsSync(invalid.canonicalPath));

  const records = listReviewAssetRecords({ root: projectDir, projectDir });
  assert.equal(records.filter((asset) => asset.filePath === video.canonicalPath).length, 1);
  assert.equal(records.find((asset) => asset.filePath === video.canonicalPath).label, 'Product demo.mov');
  assert.deepEqual(records.map((asset) => [asset.label, asset.capabilities]), [
    ['Diagram.webp', { preview: true, brollImage: true, brollVideo: false }],
    ['Product demo.mov', { preview: true, brollImage: false, brollVideo: true }],
    ['legacy.png', { preview: true, brollImage: true, brollVideo: false }],
    ['manual.mp4', { preview: true, brollImage: false, brollVideo: false }],
    ['voice.mp3', { preview: true, brollImage: false, brollVideo: false }],
    ['public.png', { preview: true, brollImage: true, brollVideo: false }],
  ]);
  assert.match(records.find((asset) => asset.label === 'legacy.png').canonicalSha256, /^[a-f0-9]{64}$/);
  assert.match(records.find((asset) => asset.label === 'public.png').canonicalSha256, /^[a-f0-9]{64}$/);
  assert.equal(records.find((asset) => asset.label === 'manual.mp4').canonicalSha256, undefined);

  const browserAssets = listReviewAssets({ root: projectDir, workspace: { dir: projectDir } });
  assert.equal(browserAssets.filter((asset) => asset.label === 'Product demo.mov').length, 1);
  for (const descriptor of browserAssets) {
    assert.equal(Object.hasOwn(descriptor, 'reference'), false);
    assert.equal(Object.hasOwn(descriptor, 'canonicalSha256'), false);
    assert.equal(Object.hasOwn(descriptor, 'previewSha256'), false);
    assert.equal(JSON.stringify(descriptor).includes(projectDir), false);
  }
});

test('imported discovery refuses an assets/broll ancestor symlink', (t) => {
  const projectDir = makeProject(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-imported-assets-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  writeBundle(outside, { mediaKind: 'image' });
  fs.mkdirSync(path.join(projectDir, 'assets'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'assets', 'broll'), path.join(projectDir, 'assets', 'broll'));

  assert.deepEqual(listImportedAssetBundles({ projectDir }), []);
});

test('orphan cleanup refuses assets and previews whose parents are symlinks', (t) => {
  const projectDir = makeProject(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-imported-assets-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const stage = path.join(outside, 'assets', 'broll', 'video', `.${UUID}.stage`);
  const preview = path.join(outside, 'previews', 'broll', `${UUID}.webm`);
  fs.mkdirSync(stage, { recursive: true });
  fs.mkdirSync(path.dirname(preview), { recursive: true });
  fs.writeFileSync(preview, 'outside preview');
  fs.mkdirSync(path.join(projectDir, 'assets'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'assets', 'broll'), path.join(projectDir, 'assets', 'broll'));
  fs.symlinkSync(path.join(outside, 'previews'), path.join(projectDir, 'previews'));

  assert.deepEqual(cleanupOrphanImportedStages({ projectDir }), []);
  assert.equal(fs.existsSync(stage), true);
  assert.equal(fs.existsSync(preview), true);
});

test('refresh expires a normalized video when its valid proxy is replaced', async (t) => {
  const fixture = makeReviewProject(t);
  const bundle = writeBundle(fixture.projectDir);
  const session = await startReviewServer({
    root: fixture.root,
    projectDir: fixture.projectDir,
    open: false,
    runToolImpl: () => { throw new Error('waveform is unrelated to the registry'); },
  });
  t.after(() => closeServer(session.server));
  assert.equal((await requestState(session)).status, 200);

  fs.writeFileSync(bundle.previewPath, 'new valid proxy bytes');
  writeJson(path.join(bundle.mediaDirectory, 'asset.json'), {
    ...bundle.assetMetadata,
    previewSha256: SHA('new valid proxy bytes'),
  });

  assert.equal((await requestState(session)).status, 409);
});

test('generic preview-only video and audio do not invoke the image hash reader', (t) => {
  const projectDir = makeProject(t);
  fs.mkdirSync(path.join(projectDir, 'assets', 'broll'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'assets', 'broll', 'manual.mp4'), 'video bytes');
  fs.writeFileSync(path.join(projectDir, 'assets', 'broll', 'voice.mp3'), 'audio bytes');
  let calls = 0;
  const readFileSync = fs.readFileSync;
  fs.readFileSync = function trackedRead(target, ...args) {
    if (typeof target === 'number') calls += 1;
    return readFileSync.call(this, target, ...args);
  };
  let records;
  try {
    records = listReviewAssetRecords({ root: projectDir, projectDir });
  } finally {
    fs.readFileSync = readFileSync;
  }

  assert.equal(calls, 0);
  assert.deepEqual(records.map(({ label, capabilities }) => ({ label, capabilities })), [
    { label: 'manual.mp4', capabilities: { preview: true, brollImage: false, brollVideo: false } },
    { label: 'voice.mp3', capabilities: { preview: true, brollImage: false, brollVideo: false } },
  ]);
});

test('review state exposes imported media through opaque URLs without server-only hashes or references', async (t) => {
  const fixture = makeReviewProject(t);
  writeBundle(fixture.projectDir);
  const session = await startReviewServer({
    root: fixture.root,
    projectDir: fixture.projectDir,
    open: false,
    runToolImpl: () => { throw new Error('waveform is unrelated to the registry'); },
  });
  t.after(() => closeServer(session.server));

  const response = await requestState(session);
  assert.equal(response.status, 200);
  const state = JSON.parse(response.body);
  const asset = state.assets.find((candidate) => candidate.label === 'Product demo.mov');
  assert.deepEqual(asset.capabilities, { preview: true, brollImage: false, brollVideo: true });
  assert.equal(asset.url, `/media/assets/${asset.id}`);
  assert.equal(asset.previewUrl, `/media/assets/${asset.id}/preview`);
  assert.equal(Object.hasOwn(asset, 'reference'), false);
  assert.equal(Object.hasOwn(asset, 'canonicalSha256'), false);
  assert.equal(Object.hasOwn(asset, 'previewSha256'), false);
  assert.doesNotMatch(JSON.stringify(state.assets), /assets\/broll|previews\/broll|[a-f0-9]{64}|\/Users\//);
});

test('orphan cleanup preserves UUID stages and previews without a durable ownership record', (t) => {
  const projectDir = makeProject(t);
  const orphanId = '4af36be4-0b26-4e6f-bd48-8bdd2215a4f1';
  const publishedId = '7c0f5b6a-a921-4a51-8787-467a3a5c7c20';
  const stage = path.join(projectDir, 'assets', 'broll', 'video', `.${orphanId}.stage`);
  const preview = path.join(projectDir, 'previews', 'broll', `${orphanId}.webm`);
  const publishedStage = path.join(projectDir, 'assets', 'broll', 'images', `.${publishedId}.stage`);
  fs.mkdirSync(stage, { recursive: true });
  fs.mkdirSync(publishedStage, { recursive: true });
  fs.mkdirSync(path.dirname(preview), { recursive: true });
  fs.writeFileSync(preview, 'orphan preview');
  fs.mkdirSync(path.join(projectDir, 'assets', 'broll', 'images', publishedId), { recursive: true });
  const symlinkStage = path.join(projectDir, 'assets', 'broll', 'video', '.6cfbc858-7e33-4d29-b948-7ce7992761fc.stage');
  fs.symlinkSync(stage, symlinkStage);

  const removed = cleanupOrphanImportedStages({ projectDir });
  assert.deepEqual(removed, []);
  assert.equal(fs.existsSync(stage), true);
  assert.equal(fs.existsSync(preview), true);
  assert.equal(fs.existsSync(publishedStage), true);
  assert.equal(fs.lstatSync(symlinkStage).isSymbolicLink(), true);
});

test('orphan cleanup removes an exactly claimed crash remnant without asset.json', (t) => {
  const projectDir = makeProject(t);
  const mediaDirectory = path.join(projectDir, 'assets', 'broll', 'video', UUID);
  const canonicalPath = path.join(mediaDirectory, 'media.mp4');
  const previewPath = path.join(projectDir, 'previews', 'broll', `${UUID}.webm`);
  fs.mkdirSync(mediaDirectory, { recursive: true });
  fs.mkdirSync(path.dirname(previewPath), { recursive: true });
  fs.writeFileSync(canonicalPath, 'canonical crash remnant');
  fs.writeFileSync(previewPath, 'preview crash remnant');
  const claimPath = writePublicationClaim(projectDir, {
    mediaDirectory, canonicalPath, previewPath,
  });

  const removed = cleanupOrphanImportedStages({ projectDir });
  assert.deepEqual(new Set(removed), new Set([
    previewPath, canonicalPath, mediaDirectory, claimPath,
  ]));
  for (const target of [previewPath, canonicalPath, mediaDirectory, claimPath]) {
    assert.equal(fs.existsSync(target), false, target);
  }
});

test('orphan cleanup preserves a directory absent from the last durable claim', (t) => {
  const projectDir = makeProject(t);
  const mediaDirectory = path.join(projectDir, 'assets', 'broll', 'video', UUID);
  const previewPath = path.join(projectDir, 'previews', 'broll', `${UUID}.webm`);
  fs.mkdirSync(mediaDirectory, { recursive: true });
  fs.mkdirSync(path.dirname(previewPath), { recursive: true });
  fs.writeFileSync(previewPath, 'owned preview before directory claim update');
  const claimPath = writePublicationClaim(projectDir, {
    previewPath,
    claimOverrides: { directory: null, canonical: null },
  });

  assert.deepEqual(cleanupOrphanImportedStages({ projectDir }), []);
  for (const target of [previewPath, mediaDirectory, claimPath]) {
    assert.equal(fs.existsSync(target), true, target);
  }
});

test('orphan cleanup preserves unrecorded directory state when the next claim append was torn', (t) => {
  const projectDir = makeProject(t);
  const mediaDirectory = path.join(projectDir, 'assets', 'broll', 'video', UUID);
  const previewPath = path.join(projectDir, 'previews', 'broll', `${UUID}.webm`);
  fs.mkdirSync(mediaDirectory, { recursive: true });
  fs.mkdirSync(path.dirname(previewPath), { recursive: true });
  fs.writeFileSync(previewPath, 'owned preview with torn next claim');
  const claimPath = writePublicationClaim(projectDir, {
    previewPath,
    claimOverrides: { directory: null, canonical: null },
  });
  fs.appendFileSync(claimPath, '{"version":1,"id":"torn');

  assert.deepEqual(cleanupOrphanImportedStages({ projectDir }), []);
  assert.equal(fs.existsSync(previewPath), true);
  assert.equal(fs.existsSync(mediaDirectory), true);
  assert.equal(fs.existsSync(claimPath), true);
});

test('orphan cleanup preserves a non-empty directory absent from the last durable claim', (t) => {
  const projectDir = makeProject(t);
  const mediaDirectory = path.join(projectDir, 'assets', 'broll', 'video', UUID);
  const foreignPath = path.join(mediaDirectory, 'foreign.txt');
  const previewPath = path.join(projectDir, 'previews', 'broll', `${UUID}.webm`);
  fs.mkdirSync(mediaDirectory, { recursive: true });
  fs.mkdirSync(path.dirname(previewPath), { recursive: true });
  fs.writeFileSync(foreignPath, 'foreign directory contents');
  fs.writeFileSync(previewPath, 'owned preview must also be preserved on mismatch');
  const claimPath = writePublicationClaim(projectDir, {
    previewPath,
    claimOverrides: { directory: null, canonical: null },
  });

  assert.deepEqual(cleanupOrphanImportedStages({ projectDir }), []);
  for (const target of [mediaDirectory, foreignPath, previewPath, claimPath]) {
    assert.equal(fs.existsSync(target), true, target);
  }
});

test('orphan cleanup preserves a valid published bundle and removes only its matching stale claim', (t) => {
  const projectDir = makeProject(t);
  const bundle = writeBundle(projectDir);
  const claimPath = writePublicationClaim(projectDir, {
    mediaDirectory: bundle.mediaDirectory,
    canonicalPath: bundle.canonicalPath,
    previewPath: bundle.previewPath,
  });

  assert.deepEqual(cleanupOrphanImportedStages({ projectDir }), [claimPath]);
  assert.equal(fs.existsSync(claimPath), false);
  assert.ok(inspectImportedAssetBundle({
    projectDir,
    assetDirectory: bundle.mediaDirectory,
  }));
});

test('orphan cleanup preserves foreign UUID directories without a matching ownership claim', (t) => {
  const projectDir = makeProject(t);
  const noClaimId = '7c0f5b6a-a921-4a51-8787-467a3a5c7c20';
  const foreignDirectory = path.join(projectDir, 'assets', 'broll', 'video', noClaimId);
  const foreignMedia = path.join(foreignDirectory, 'media.mp4');
  fs.mkdirSync(foreignDirectory, { recursive: true });
  fs.writeFileSync(foreignMedia, 'foreign without claim');

  const mismatchedDirectory = path.join(projectDir, 'assets', 'broll', 'video', UUID);
  const mismatchedMedia = path.join(mismatchedDirectory, 'media.mp4');
  const mismatchedPreview = path.join(projectDir, 'previews', 'broll', `${UUID}.webm`);
  fs.mkdirSync(mismatchedDirectory, { recursive: true });
  fs.mkdirSync(path.dirname(mismatchedPreview), { recursive: true });
  fs.writeFileSync(mismatchedMedia, 'foreign with mismatched claim');
  fs.writeFileSync(mismatchedPreview, 'foreign preview');
  const actualDirectoryIdentity = directoryIdentity(mismatchedDirectory);
  const claimPath = writePublicationClaim(projectDir, {
    mediaDirectory: mismatchedDirectory,
    canonicalPath: mismatchedMedia,
    previewPath: mismatchedPreview,
    claimOverrides: {
      directory: {
        ...actualDirectoryIdentity,
        ino: String(BigInt(actualDirectoryIdentity.ino) + 1n),
      },
    },
  });

  const permissiveId = '6cfbc858-7e33-4d29-b948-7ce7992761fc';
  const permissiveDirectory = path.join(projectDir, 'assets', 'broll', 'video', permissiveId);
  const permissiveMedia = path.join(permissiveDirectory, 'media.mp4');
  const permissivePreview = path.join(projectDir, 'previews', 'broll', `${permissiveId}.webm`);
  fs.mkdirSync(permissiveDirectory);
  fs.writeFileSync(permissiveMedia, 'foreign permissive canonical');
  fs.writeFileSync(permissivePreview, 'foreign permissive preview');
  const permissiveClaim = writePublicationClaim(projectDir, {
    id: permissiveId,
    mediaDirectory: permissiveDirectory,
    canonicalPath: permissiveMedia,
    previewPath: permissivePreview,
  });
  fs.chmodSync(permissiveClaim, 0o644);

  assert.deepEqual(cleanupOrphanImportedStages({ projectDir }), []);
  for (const target of [foreignDirectory, foreignMedia, mismatchedDirectory,
    mismatchedMedia, mismatchedPreview, claimPath, permissiveDirectory,
    permissiveMedia, permissivePreview, permissiveClaim]) {
    assert.equal(fs.existsSync(target), true, target);
  }
});

test('orphan cleanup never follows or deletes claimed paths replaced after identity capture', async (t) => {
  for (const replacement of ['preview', 'directory', 'directory symlink']) {
    await t.test(replacement, () => {
      const projectDir = makeProject(t);
      const mediaDirectory = path.join(projectDir, 'assets', 'broll', 'video', UUID);
      const canonicalPath = path.join(mediaDirectory, 'media.mp4');
      const previewPath = path.join(projectDir, 'previews', 'broll', `${UUID}.webm`);
      fs.mkdirSync(mediaDirectory, { recursive: true });
      fs.mkdirSync(path.dirname(previewPath), { recursive: true });
      fs.writeFileSync(canonicalPath, 'claimed canonical');
      fs.writeFileSync(previewPath, 'claimed preview');
      const claimPath = writePublicationClaim(projectDir, {
        mediaDirectory, canonicalPath, previewPath,
      });

      if (replacement === 'preview') {
        fs.renameSync(previewPath, `${previewPath}.original`);
        fs.writeFileSync(previewPath, 'replacement preview');
      } else {
        fs.renameSync(mediaDirectory, `${mediaDirectory}.original`);
        if (replacement === 'directory') {
          fs.mkdirSync(mediaDirectory);
          fs.writeFileSync(path.join(mediaDirectory, 'media.mp4'), 'replacement canonical');
        } else {
          fs.symlinkSync(`${mediaDirectory}.original`, mediaDirectory);
        }
      }

      assert.deepEqual(cleanupOrphanImportedStages({ projectDir }), []);
      assert.equal(fs.existsSync(previewPath), true);
      assert.equal(fs.existsSync(mediaDirectory), true);
      assert.equal(fs.existsSync(claimPath), true);
    });
  }
});
