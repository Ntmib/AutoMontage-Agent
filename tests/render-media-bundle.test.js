const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  prepareRenderMediaBundle,
  withRenderMediaBundle,
} = require('../scripts/render-media-bundle');

const FIRST_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_ID = '22222222-2222-4222-8222-222222222222';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function writeFile(filename, bytes) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, bytes);
  return filename;
}

function makeFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-render-bundle-'));
  const root = path.join(directory, 'repository');
  const workspace = { dir: path.join(directory, 'project') };
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.mkdirSync(workspace.dir, { recursive: true });
  const sourcePath = writeFile(path.join(workspace.dir, 'input', 'speaker.mp4'), 'speaker-bytes');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, root, workspace, sourcePath };
}

function bundleInput(fixture, scenes, propsScenes = scenes) {
  const approvedBrief = {
    status: 'approved',
    source: fixture.sourcePath,
    scenes,
  };
  const props = {
    faceSrc: 'source.mp4',
    audioSrc: 'source.mp4',
    scenes: propsScenes,
    theme: { colors: { bg: '#000000' } },
  };
  return {
    root: fixture.root,
    workspace: fixture.workspace,
    props,
    approvedBrief,
    sourcePath: fixture.sourcePath,
    namespace: 'lesson demo',
    temporaryId: FIRST_ID,
  };
}

test('one bundle snapshots source, legacy image, and structured image/video without mutating inputs', (t) => {
  const fixture = makeFixture(t);
  writeFile(path.join(fixture.workspace.dir, 'assets', 'broll', 'legacy.png'), 'legacy-image');
  const imagePath = writeFile(
    path.join(fixture.workspace.dir, 'assets', 'broll', 'images', 'image.webp'),
    'normalized-image',
  );
  const videoPath = writeFile(
    path.join(fixture.workspace.dir, 'assets', 'broll', 'video', 'clip.mp4'),
    'normalized-video',
  );
  const scenes = [
    { scene: 'fullscreen', faceSrc: 'source.mp4' },
    { scene: 'broll', brollSrc: 'assets/broll/legacy.png' },
    {
      scene: 'broll',
      brollMedia: {
        kind: 'image', src: 'assets/broll/images/image.webp', sha256: sha256('normalized-image'), fit: 'cover',
      },
    },
    {
      scene: 'broll',
      brollMedia: {
        kind: 'video', src: 'assets/broll/video/clip.mp4', sha256: sha256('normalized-video'),
        trimStartSec: 0, fit: 'contain', audioMode: 'mute',
      },
    },
  ];
  const input = bundleInput(fixture, scenes);
  const beforeProps = JSON.stringify(input.props);
  const beforeBrief = JSON.stringify(input.approvedBrief);

  const lease = prepareRenderMediaBundle(input);

  assert.equal(lease.directory, path.join(
    fixture.root,
    'public',
    '.automontage',
    `lesson-demo-${FIRST_ID}`,
  ));
  assert.deepEqual(fs.readdirSync(lease.directory).sort(), [
    'media-1.mp4', 'media-2.png', 'media-3.webp', 'media-4.mp4',
  ]);
  assert.equal(fs.readFileSync(path.join(lease.directory, 'media-1.mp4'), 'utf8'), 'speaker-bytes');
  assert.equal(fs.readFileSync(path.join(lease.directory, 'media-2.png'), 'utf8'), 'legacy-image');
  assert.equal(fs.readFileSync(path.join(lease.directory, 'media-3.webp'), 'utf8'), fs.readFileSync(imagePath, 'utf8'));
  assert.equal(fs.readFileSync(path.join(lease.directory, 'media-4.mp4'), 'utf8'), fs.readFileSync(videoPath, 'utf8'));
  assert.equal(lease.props.faceSrc, `.automontage/lesson-demo-${FIRST_ID}/media-1.mp4`);
  assert.equal(lease.props.audioSrc, lease.props.faceSrc);
  assert.equal(lease.props.scenes[0].faceSrc, lease.props.faceSrc);
  assert.match(lease.props.scenes[1].brollSrc, /\/media-2\.png$/);
  assert.match(lease.props.scenes[2].brollMedia.src, /\/media-3\.webp$/);
  assert.match(lease.props.scenes[3].brollMedia.src, /\/media-4\.mp4$/);
  assert.equal(JSON.stringify(input.props), beforeProps);
  assert.equal(JSON.stringify(input.approvedBrief), beforeBrief);
  assert.notEqual(lease.props, input.props);
  assert.notEqual(lease.props.scenes, input.props.scenes);
  assert.notEqual(lease.props.theme, input.props.theme);
  lease.cleanup();
});

test('identical resolved files deduplicate across source and repeated scenes', (t) => {
  const fixture = makeFixture(t);
  const bytes = fs.readFileSync(fixture.sourcePath);
  const reference = 'assets/broll/video/source.mp4';
  const referencedPath = path.join(fixture.workspace.dir, ...reference.split('/'));
  fs.mkdirSync(path.dirname(referencedPath), { recursive: true });
  fs.linkSync(fixture.sourcePath, referencedPath);
  const media = {
    kind: 'video', src: reference, sha256: sha256(bytes), trimStartSec: 0,
    fit: 'contain', audioMode: 'mute',
  };
  const scenes = [
    { scene: 'broll', brollMedia: media },
    { scene: 'broll', brollMedia: { ...media } },
  ];
  const lease = prepareRenderMediaBundle(bundleInput(fixture, scenes));

  assert.deepEqual(fs.readdirSync(lease.directory), ['media-1.mp4']);
  assert.equal(lease.props.faceSrc, lease.props.scenes[0].brollMedia.src);
  assert.equal(lease.props.scenes[0].brollMedia.src, lease.props.scenes[1].brollMedia.src);
  lease.cleanup();
});

test('legacy HTTPS images stay remote while structured remote media fails closed', (t) => {
  const fixture = makeFixture(t);
  const remote = 'https://cdn.example.test/diagram.png?version=2';
  const legacy = bundleInput(fixture, [{ scene: 'broll', brollSrc: remote }]);
  const lease = prepareRenderMediaBundle(legacy);
  assert.equal(lease.props.scenes[0].brollSrc, remote);
  assert.deepEqual(fs.readdirSync(lease.directory), ['media-1.mp4']);
  lease.cleanup();

  const structured = bundleInput(fixture, [{
    scene: 'broll',
    brollMedia: {
      kind: 'image', src: remote, sha256: sha256('remote'), fit: 'cover',
    },
  }]);
  assert.throws(
    () => prepareRenderMediaBundle({ ...structured, temporaryId: SECOND_ID }),
    /reference|URL|remote/i,
  );
});

test('structured media hash mismatch aborts before the operation and removes its bundle', (t) => {
  const fixture = makeFixture(t);
  writeFile(path.join(fixture.workspace.dir, 'assets', 'broll', 'wrong.webp'), 'actual');
  const input = bundleInput(fixture, [{
    scene: 'broll',
    brollMedia: {
      kind: 'image', src: 'assets/broll/wrong.webp', sha256: sha256('approved'), fit: 'cover',
    },
  }]);
  let invoked = false;

  assert.throws(() => withRenderMediaBundle(input, () => {
    invoked = true;
  }), /hash mismatch/i);
  assert.equal(invoked, false);
  assert.equal(fs.existsSync(path.join(
    fixture.root, 'public', '.automontage', `lesson-demo-${FIRST_ID}`,
  )), false);
});

test('a draft brief cannot acquire a render media lease', (t) => {
  const fixture = makeFixture(t);
  const input = bundleInput(fixture, []);
  input.approvedBrief.status = 'draft';

  assert.throws(() => prepareRenderMediaBundle(input), /approved|утвержд/i);
  assert.equal(fs.existsSync(path.join(fixture.root, 'public', '.automontage')), false);
});

test('local references reject traversal, ancestor symlinks, and non-regular files', async (t) => {
  await t.test('traversal', () => {
    const fixture = makeFixture(t);
    const input = bundleInput(fixture, [{ scene: 'broll', brollSrc: 'assets/../outside.png' }]);
    assert.throws(() => prepareRenderMediaBundle(input), /reference|canonical|inside/i);
  });

  await t.test('ancestor symlink', () => {
    const fixture = makeFixture(t);
    const outside = path.join(fixture.directory, 'outside');
    writeFile(path.join(outside, 'escaped.png'), 'must-not-copy');
    fs.mkdirSync(path.join(fixture.workspace.dir, 'assets'), { recursive: true });
    fs.symlinkSync(outside, path.join(fixture.workspace.dir, 'assets', 'linked'), 'dir');
    const input = bundleInput(fixture, [{ scene: 'broll', brollSrc: 'assets/linked/escaped.png' }]);
    assert.throws(() => prepareRenderMediaBundle(input), /symbolic link|symlink/i);
    assert.equal(fs.readFileSync(path.join(outside, 'escaped.png'), 'utf8'), 'must-not-copy');
  });

  await t.test('final directory', () => {
    const fixture = makeFixture(t);
    fs.mkdirSync(path.join(fixture.workspace.dir, 'assets', 'broll', 'directory.png'), { recursive: true });
    const input = bundleInput(fixture, [{ scene: 'broll', brollSrc: 'assets/broll/directory.png' }]);
    assert.throws(() => prepareRenderMediaBundle(input), /regular file/i);
  });
});

test('copy uses no-follow descriptors, bounded reads, and rejects a changed source identity', (t) => {
  const fixture = makeFixture(t);
  fs.writeFileSync(fixture.sourcePath, Buffer.alloc(160 * 1024, 7));
  const opens = [];
  const reads = [];
  let replaced = false;
  const racingFs = {
    ...fs,
    openSync(filename, flags, mode) {
      opens.push({ filename, flags });
      return fs.openSync(filename, flags, mode);
    },
    readSync(descriptor, buffer, offset, length, position) {
      reads.push(length);
      const count = fs.readSync(descriptor, buffer, offset, length, position);
      if (!replaced && count > 0 && position >= 64 * 1024) {
        replaced = true;
        const replacement = `${fixture.sourcePath}.replacement`;
        fs.writeFileSync(replacement, 'replacement');
        fs.renameSync(replacement, fixture.sourcePath);
      }
      return count;
    },
  };

  assert.throws(
    () => prepareRenderMediaBundle({ ...bundleInput(fixture, []), fileSystem: racingFs }),
    /identity|changed/i,
  );
  assert.ok(opens.some(({ flags }) => (flags & (fs.constants.O_NOFOLLOW || 0)) !== 0));
  assert.ok(reads.length >= 2);
  assert.ok(Math.max(...reads) <= 64 * 1024);
  assert.equal(fs.existsSync(path.join(
    fixture.root, 'public', '.automontage', `lesson-demo-${FIRST_ID}`,
  )), false);
});

test('bundle aborts if its directory is replaced while a destination is opened', (t) => {
  const fixture = makeFixture(t);
  const bundleDirectory = path.join(
    fixture.root, 'public', '.automontage', `lesson-demo-${FIRST_ID}`,
  );
  const movedDirectory = `${bundleDirectory}.owned`;
  let replaced = false;
  const racingFs = {
    ...fs,
    openSync(filename, flags, mode) {
      if (!replaced && path.dirname(filename) === bundleDirectory
        && (flags & fs.constants.O_CREAT) !== 0) {
        replaced = true;
        fs.renameSync(bundleDirectory, movedDirectory);
        fs.mkdirSync(bundleDirectory);
        fs.writeFileSync(path.join(bundleDirectory, 'unrelated.txt'), 'unrelated');
      }
      return fs.openSync(filename, flags, mode);
    },
  };
  t.after(() => {
    fs.rmSync(bundleDirectory, { recursive: true, force: true });
    fs.rmSync(movedDirectory, { recursive: true, force: true });
  });

  assert.throws(
    () => prepareRenderMediaBundle({ ...bundleInput(fixture, []), fileSystem: racingFs }),
    /identity|replaced/i,
  );
  assert.equal(fs.readFileSync(path.join(bundleDirectory, 'unrelated.txt'), 'utf8'), 'unrelated');
});

test('props cannot smuggle an unapproved scene-local media reference into the bundle', (t) => {
  const fixture = makeFixture(t);
  const approvedScenes = [{ scene: 'fullscreen' }];
  const propsScenes = [
    { scene: 'fullscreen' },
    { scene: 'broll', brollSrc: '../../private.png' },
  ];

  assert.throws(
    () => prepareRenderMediaBundle(bundleInput(fixture, approvedScenes, propsScenes)),
    /props.*approved brief|scene count/i,
  );
});

test('prepare failure removes only its owned bundle and preserves an unrelated lease', (t) => {
  const fixture = makeFixture(t);
  writeFile(path.join(fixture.workspace.dir, 'assets', 'broll', 'image.png'), 'image');
  const base = path.join(fixture.root, 'public', '.automontage');
  const unrelated = path.join(base, `other-${SECOND_ID}`);
  fs.mkdirSync(unrelated, { recursive: true });
  writeFile(path.join(unrelated, 'keep.txt'), 'keep');
  let writes = 0;
  const failingFs = {
    ...fs,
    writeSync(...args) {
      writes += 1;
      if (writes > 1) throw new Error('simulated copy failure');
      return fs.writeSync(...args);
    },
  };
  const input = bundleInput(fixture, [{ scene: 'broll', brollSrc: 'assets/broll/image.png' }]);

  assert.throws(
    () => prepareRenderMediaBundle({ ...input, fileSystem: failingFs }),
    /simulated copy failure/,
  );
  assert.equal(fs.existsSync(path.join(base, `lesson-demo-${FIRST_ID}`)), false);
  assert.equal(fs.readFileSync(path.join(unrelated, 'keep.txt'), 'utf8'), 'keep');
});

test('success and render failure both clean the owned bundle', (t) => {
  const fixture = makeFixture(t);
  let successDirectory;
  const result = withRenderMediaBundle(bundleInput(fixture, []), (lease) => {
    successDirectory = lease.directory;
    assert.equal(fs.existsSync(successDirectory), true);
    return 'rendered';
  });
  assert.equal(result, 'rendered');
  assert.equal(fs.existsSync(successDirectory), false);

  let failureDirectory;
  const input = { ...bundleInput(fixture, []), temporaryId: SECOND_ID };
  assert.throws(() => withRenderMediaBundle(input, (lease) => {
    failureDirectory = lease.directory;
    throw new Error('render failed');
  }), /render failed/);
  assert.equal(fs.existsSync(failureDirectory), false);
});

test('concurrent bundles never collide and each cleanup leaves the other intact', (t) => {
  const fixture = makeFixture(t);
  const first = prepareRenderMediaBundle(bundleInput(fixture, []));
  const second = prepareRenderMediaBundle({
    ...bundleInput(fixture, []),
    temporaryId: SECOND_ID,
  });
  t.after(() => {
    if (fs.existsSync(first.directory)) first.cleanup();
    if (fs.existsSync(second.directory)) second.cleanup();
  });

  assert.notEqual(first.directory, second.directory);
  assert.equal(fs.existsSync(first.directory), true);
  assert.equal(fs.existsSync(second.directory), true);
  first.cleanup();
  assert.equal(fs.existsSync(first.directory), false);
  assert.equal(fs.existsSync(second.directory), true);
});

test('cleanup refuses replaced directories and never deletes their contents', (t) => {
  const fixture = makeFixture(t);
  const lease = prepareRenderMediaBundle(bundleInput(fixture, []));
  const moved = `${lease.directory}.owned`;
  fs.renameSync(lease.directory, moved);
  fs.mkdirSync(lease.directory);
  writeFile(path.join(lease.directory, 'unrelated.txt'), 'unrelated');
  t.after(() => fs.rmSync(moved, { recursive: true, force: true }));

  assert.throws(() => lease.cleanup(), /identity|replaced/i);
  assert.equal(fs.readFileSync(path.join(lease.directory, 'unrelated.txt'), 'utf8'), 'unrelated');
});

test('a colliding exclusive bundle id cannot remove the first lease', (t) => {
  const fixture = makeFixture(t);
  const input = bundleInput(fixture, []);
  const first = prepareRenderMediaBundle(input);

  assert.throws(() => prepareRenderMediaBundle(input), /exist|exclusive|collision/i);
  assert.equal(fs.readFileSync(path.join(first.directory, 'media-1.mp4'), 'utf8'), 'speaker-bytes');
  first.cleanup();
});
