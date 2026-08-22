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
const trackedRenderRoots = new Map();
const trackedFs = {
  ...fs,
  mkdtempSync(prefix, options) {
    const created = fs.mkdtempSync(prefix, options);
    if (path.basename(prefix) === 'automontage-render-') {
      const stat = fs.lstatSync(created, { bigint: true });
      trackedRenderRoots.set(created, { dev: stat.dev, ino: stat.ino });
    }
    return created;
  },
};

test.after(() => {
  for (const [target, identity] of trackedRenderRoots) {
    const stat = fs.lstatSync(target, { bigint: true, throwIfNoEntry: false });
    if (stat && !stat.isSymbolicLink() && stat.isDirectory()
      && stat.dev === identity.dev && stat.ino === identity.ino
      && path.basename(target).startsWith('automontage-render-')) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
});

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function writeFile(filename, bytes) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, bytes);
  return filename;
}

function makeFixture(t, tempRoot = os.tmpdir()) {
  const directory = fs.mkdtempSync(path.join(tempRoot, 'automontage-render-bundle-'));
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
    sourceAlias: 'source.mp4',
    namespace: 'lesson demo',
    temporaryId: FIRST_ID,
    fileSystem: trackedFs,
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
    lease.publicDirectory,
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

test('approved public and project custom face videos are snapshotted and deduplicated', (t) => {
  const fixture = makeFixture(t);
  writeFile(path.join(fixture.root, 'public', 'clips', 'public-face.mp4'), 'public-face');
  writeFile(
    path.join(fixture.workspace.dir, 'assets', 'faces', 'project-face.webm'),
    'project-face',
  );
  const scenes = [
    { scene: 'fullscreen', faceSrc: 'source.mp4' },
    { scene: 'split', faceSrc: 'clips/public-face.mp4' },
    { scene: 'blur-overlay', faceSrc: 'clips/public-face.mp4' },
    { scene: 'fullscreen', faceSrc: 'public/clips/public-face.mp4' },
    { scene: 'fullscreen', faceSrc: 'assets/faces/project-face.webm' },
  ];
  const input = bundleInput(fixture, scenes);
  const beforeBrief = JSON.stringify(input.approvedBrief);

  const lease = prepareRenderMediaBundle(input);

  assert.deepEqual(fs.readdirSync(lease.directory).sort(), [
    'media-1.mp4', 'media-2.mp4', 'media-3.webm',
  ]);
  assert.equal(lease.props.scenes[0].faceSrc, lease.props.faceSrc);
  assert.equal(lease.props.scenes[1].faceSrc, lease.props.scenes[2].faceSrc);
  assert.match(lease.props.scenes[1].faceSrc, /\/media-2\.mp4$/);
  assert.equal(lease.props.scenes[3].faceSrc, lease.props.scenes[1].faceSrc);
  assert.match(lease.props.scenes[4].faceSrc, /\/media-3\.webm$/);
  assert.equal(lease.props.audioSrc, lease.props.faceSrc);
  assert.equal(JSON.stringify(input.approvedBrief), beforeBrief);
  assert.equal(JSON.stringify(lease.props).includes(fixture.directory), false);
  lease.cleanup();
});

test('custom face hard-link deduplicates with source only for the same video extension and role', (t) => {
  const fixture = makeFixture(t);
  const reference = 'assets/faces/source.mp4';
  const customPath = path.join(fixture.workspace.dir, ...reference.split('/'));
  fs.mkdirSync(path.dirname(customPath), { recursive: true });
  fs.linkSync(fixture.sourcePath, customPath);
  const lease = prepareRenderMediaBundle(bundleInput(fixture, [
    { scene: 'fullscreen', faceSrc: reference },
    { scene: 'fullscreen', faceSrc: reference },
  ]));

  assert.deepEqual(fs.readdirSync(lease.directory), ['media-1.mp4']);
  assert.equal(lease.props.scenes[0].faceSrc, lease.props.faceSrc);
  assert.equal(lease.props.scenes[1].faceSrc, lease.props.faceSrc);
  assert.equal(lease.props.audioSrc, lease.props.faceSrc);
  lease.cleanup();
});

test('custom face hard-link with a different extension fails instead of reusing source bytes', (t) => {
  const fixture = makeFixture(t);
  const reference = 'assets/faces/source.mov';
  const customPath = path.join(fixture.workspace.dir, ...reference.split('/'));
  fs.mkdirSync(path.dirname(customPath), { recursive: true });
  fs.linkSync(fixture.sourcePath, customPath);
  let invoked = false;

  assert.throws(() => withRenderMediaBundle(bundleInput(fixture, [
    { scene: 'fullscreen', faceSrc: reference },
  ]), () => {
    invoked = true;
  }), /incompatible|extension|role/i);
  assert.equal(invoked, false);
});

test('trusted source alias rejects crafted top-level props before the render callback', (t) => {
  const fixture = makeFixture(t);
  const reference = 'assets/faces/custom.mp4';
  writeFile(path.join(fixture.workspace.dir, ...reference.split('/')), 'custom-face');
  const input = bundleInput(fixture, [
    { scene: 'fullscreen', faceSrc: reference },
  ]);
  input.props.faceSrc = reference;
  input.props.audioSrc = reference;
  let invoked = false;

  assert.throws(() => withRenderMediaBundle(input, () => {
    invoked = true;
  }), /source alias|top-level|lesson props/i);
  assert.equal(invoked, false);
});

test('render bundle requires the trusted lesson source alias before the render callback', (t) => {
  const fixture = makeFixture(t);
  const input = bundleInput(fixture, []);
  delete input.sourceAlias;
  let invoked = false;

  assert.throws(() => withRenderMediaBundle(input, () => {
    invoked = true;
  }), /source alias/i);
  assert.equal(invoked, false);
});

test('same-inode dedup rejects ctime-only projected byte drift after the first snapshot', (t) => {
  const fixture = makeFixture(t);
  const reference = 'assets/faces/source.mp4';
  const customPath = path.join(fixture.workspace.dir, ...reference.split('/'));
  fs.mkdirSync(path.dirname(customPath), { recursive: true });
  fs.linkSync(fixture.sourcePath, customPath);
  const descriptors = new Map();
  let baselineIdentity = null;
  let mutated = false;
  const isSourcePath = (filename) => filename === fixture.sourcePath || filename === customPath;
  const projectSourceIdentity = (stat) => {
    if (!mutated || !baselineIdentity) return stat;
    const projected = Object.create(stat);
    for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'mode', 'nlink']) {
      Object.defineProperty(projected, key, {
        configurable: true, enumerable: true, value: baselineIdentity[key],
      });
    }
    Object.defineProperty(projected, 'ctimeNs', {
      configurable: true, enumerable: true, value: baselineIdentity.ctimeNs + 1n,
    });
    return projected;
  };
  const adversarialFs = {
    ...trackedFs,
    openSync(filename, flags, mode) {
      const descriptor = fs.openSync(filename, flags, mode);
      descriptors.set(descriptor, filename);
      return descriptor;
    },
    closeSync(descriptor) {
      const filename = descriptors.get(descriptor);
      const result = fs.closeSync(descriptor);
      descriptors.delete(descriptor);
      if (!mutated && typeof filename === 'string'
        && /[\\/]\.automontage[\\/].*[\\/]media-1\.mp4$/.test(filename)) {
        baselineIdentity = fs.lstatSync(fixture.sourcePath, { bigint: true });
        const changed = fs.readFileSync(fixture.sourcePath);
        changed[0] ^= 0xff;
        fs.writeFileSync(fixture.sourcePath, changed);
        mutated = true;
      }
      return result;
    },
    fstatSync(descriptor, options) {
      const stat = fs.fstatSync(descriptor, options);
      return isSourcePath(descriptors.get(descriptor)) ? projectSourceIdentity(stat) : stat;
    },
    lstatSync(filename, options) {
      const stat = fs.lstatSync(filename, options);
      return isSourcePath(filename) ? projectSourceIdentity(stat) : stat;
    },
  };
  let invoked = false;

  assert.throws(() => withRenderMediaBundle({
    ...bundleInput(fixture, [{ scene: 'fullscreen', faceSrc: reference }]),
    fileSystem: adversarialFs,
  }, () => {
    invoked = true;
  }), /dedup|identity|hash|changed/i);
  assert.equal(mutated, true);
  assert.equal(invoked, false);
});

test('bundle mutation restored during the callback still fails closed', (t) => {
  const fixture = makeFixture(t);
  const descriptors = new Map();
  let bundlePath = null;
  let baselineIdentity = null;
  let callbackFinished = false;
  const isBundlePath = (filename) => callbackFinished && filename === bundlePath;
  const projectBundleIdentity = (stat) => {
    if (!baselineIdentity) return stat;
    const projected = Object.create(stat);
    for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'mode', 'nlink']) {
      Object.defineProperty(projected, key, {
        configurable: true, enumerable: true, value: baselineIdentity[key],
      });
    }
    Object.defineProperty(projected, 'ctimeNs', {
      configurable: true, enumerable: true, value: baselineIdentity.ctimeNs + 1n,
    });
    return projected;
  };
  const adversarialFs = {
    ...trackedFs,
    openSync(filename, flags, mode) {
      const descriptor = fs.openSync(filename, flags, mode);
      descriptors.set(descriptor, filename);
      return descriptor;
    },
    closeSync(descriptor) {
      descriptors.delete(descriptor);
      return fs.closeSync(descriptor);
    },
    fstatSync(descriptor, options) {
      const stat = fs.fstatSync(descriptor, options);
      return isBundlePath(descriptors.get(descriptor)) ? projectBundleIdentity(stat) : stat;
    },
    lstatSync(filename, options) {
      const stat = fs.lstatSync(filename, options);
      return isBundlePath(filename) ? projectBundleIdentity(stat) : stat;
    },
  };
  let invoked = false;

  assert.throws(() => withRenderMediaBundle({
    ...bundleInput(fixture, []),
    fileSystem: adversarialFs,
  }, (lease) => {
    invoked = true;
    bundlePath = path.join(lease.directory, 'media-1.mp4');
    baselineIdentity = fs.lstatSync(bundlePath, { bigint: true });
    const original = fs.readFileSync(bundlePath);
    const changed = Buffer.from(original);
    changed[0] ^= 0xff;
    fs.writeFileSync(bundlePath, changed);
    fs.writeFileSync(bundlePath, original);
    callbackFinished = true;
  }), /callback|identity|ctime|changed/i);
  assert.equal(invoked, true);
  assert.equal(fs.existsSync(path.join(
    fixture.root, 'public', '.automontage', `lesson-demo-${FIRST_ID}`,
  )), false);
});

test('an unguarded pre-render callback cannot mutate and restore a bundle before its baseline', (t) => {
  const fixture = makeFixture(t);
  let prepareInvoked = false;
  let renderInvoked = false;

  assert.throws(() => withRenderMediaBundle(
    bundleInput(fixture, []),
    () => {
      renderInvoked = true;
      return 'rendered';
    },
    (lease) => {
      prepareInvoked = true;
      const bundlePath = path.join(lease.directory, 'media-1.mp4');
      const baseline = fs.statSync(bundlePath, { bigint: true });
      const original = fs.readFileSync(bundlePath);
      const changed = Buffer.from(original);
      changed[0] ^= 0xff;
      fs.writeFileSync(bundlePath, changed);
      fs.writeFileSync(bundlePath, original);
      fs.utimesSync(
        bundlePath,
        Number(baseline.atimeNs) / 1e9,
        Number(baseline.mtimeNs) / 1e9,
      );
    },
  ), /pre-render|prepare operation|callback boundary|unsupported/i);
  assert.equal(prepareInvoked, false);
  assert.equal(renderInvoked, false);
});

test('render bundles use an owner-only isolated public directory outside the repository', (t) => {
  const fixture = makeFixture(t);
  let publicDirectory;
  let bundleDirectory;

  assert.equal(withRenderMediaBundle(bundleInput(fixture, []), (lease) => {
    publicDirectory = lease.publicDirectory;
    bundleDirectory = lease.directory;
    assert.equal(path.isAbsolute(publicDirectory), true);
    assert.equal(publicDirectory.startsWith(`${fixture.root}${path.sep}`), false);
    assert.equal(bundleDirectory.startsWith(`${publicDirectory}${path.sep}`), true);
    assert.equal(fs.lstatSync(publicDirectory).mode & 0o077, 0);
    return 'rendered';
  }), 'rendered');

  assert.equal(fs.existsSync(bundleDirectory), false);
  assert.equal(fs.existsSync(publicDirectory), false);
  assert.equal(fs.existsSync(path.join(fixture.root, 'public', '.automontage')), false);
});

test('isolated public cleanup refuses a foreign replacement and preserves its bytes', (t) => {
  const fixture = makeFixture(t);
  const lease = prepareRenderMediaBundle(bundleInput(fixture, []));
  const ownedPublic = `${lease.publicDirectory}.owned`;
  fs.renameSync(lease.publicDirectory, ownedPublic);
  fs.mkdirSync(lease.publicDirectory, { mode: 0o700 });
  const foreign = path.join(lease.publicDirectory, 'foreign.txt');
  fs.writeFileSync(foreign, 'foreign-must-survive');
  t.after(() => {
    fs.rmSync(path.dirname(lease.publicDirectory), { recursive: true, force: true });
  });

  assert.throws(() => lease.cleanup(), /directory identity changed|cleanup refused/i);
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'foreign-must-survive');
  assert.equal(fs.readFileSync(path.join(
    ownedPublic, '.automontage', `lesson-demo-${FIRST_ID}`, 'media-1.mp4',
  ), 'utf8'), 'speaker-bytes');
});

test('approved brief is authoritative for every scene custom face reference and type', async (t) => {
  const fixture = makeFixture(t);
  writeFile(path.join(fixture.root, 'public', 'clips', 'approved.mp4'), 'approved');
  writeFile(path.join(fixture.root, 'public', 'clips', 'other.mp4'), 'other');
  const cases = [
    {
      name: 'props-only reference',
      approved: [{ scene: 'fullscreen' }],
      props: [{ scene: 'fullscreen', faceSrc: 'clips/approved.mp4' }],
    },
    {
      name: 'approved-only reference',
      approved: [{ scene: 'fullscreen', faceSrc: 'clips/approved.mp4' }],
      props: [{ scene: 'fullscreen' }],
    },
    {
      name: 'different reference',
      approved: [{ scene: 'fullscreen', faceSrc: 'clips/approved.mp4' }],
      props: [{ scene: 'fullscreen', faceSrc: 'clips/other.mp4' }],
    },
    {
      name: 'different scene type',
      approved: [{ scene: 'fullscreen', faceSrc: 'clips/approved.mp4' }],
      props: [{ scene: 'split', faceSrc: 'clips/approved.mp4' }],
    },
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index];
    await t.test(item.name, () => {
      let invoked = false;
      assert.throws(() => withRenderMediaBundle({
        ...bundleInput(fixture, item.approved, item.props),
        temporaryId: `33333333-3333-4333-8333-33333333333${index}`,
      }, () => {
        invoked = true;
      }), /props|approved brief|scene|match/i);
      assert.equal(invoked, false);
    });
  }
});

test('unsafe custom face references fail before the render callback without leaking the value', async (t) => {
  const fixture = makeFixture(t);
  const references = [
    '/private/face.mp4',
    'C:\\private\\face.mp4',
    '\\\\server\\share\\face.mp4',
    '..\\private\\face.mp4',
    '../private/face.mp4',
    '%2e%2e%2fprivate/face.mp4',
    'file:///private/face.mp4',
    'https://example.test/face.mp4',
    'data:video/mp4;base64,AAAA',
    'blob:https://example.test/id',
    'clips/face.png',
    'clips/face.mp3',
    'clips/face.txt',
  ];
  const sourceBefore = fs.readFileSync(fixture.sourcePath);
  for (let index = 0; index < references.length; index += 1) {
    await t.test(`unsafe reference ${index + 1}`, () => {
      const reference = references[index];
      let invoked = false;
      let error;
      try {
        withRenderMediaBundle({
          ...bundleInput(fixture, [{ scene: 'fullscreen', faceSrc: reference }]),
          temporaryId: `44444444-4444-4444-8444-${String(index).padStart(12, '0')}`,
        }, () => {
          invoked = true;
        });
      } catch (caught) {
        error = caught;
      }
      assert.ok(error);
      assert.equal(invoked, false);
      assert.equal(String(error.message).includes(reference), false);
      assert.ok(/canonical|local|extension|reference|render-safe/i.test(error.message), error.message);
      assert.deepEqual(fs.readFileSync(fixture.sourcePath), sourceBefore);
    });
  }
});

test('custom face symlink ancestors, final symlinks, and non-files fail closed', async (t) => {
  const fixture = makeFixture(t);
  const outside = path.join(fixture.directory, 'outside');
  const outsideVideo = writeFile(path.join(outside, 'face.mp4'), 'outside-face');
  fs.mkdirSync(path.join(fixture.workspace.dir, 'assets', 'faces'), { recursive: true });
  fs.symlinkSync(outside, path.join(fixture.workspace.dir, 'assets', 'linked'), 'dir');
  fs.symlinkSync(outsideVideo, path.join(fixture.workspace.dir, 'assets', 'faces', 'linked.mp4'));
  fs.mkdirSync(path.join(fixture.workspace.dir, 'assets', 'faces', 'directory.mp4'));
  const references = [
    'assets/linked/face.mp4',
    'assets/faces/linked.mp4',
    'assets/faces/directory.mp4',
  ];
  for (let index = 0; index < references.length; index += 1) {
    await t.test(String(index), () => {
      assert.throws(() => prepareRenderMediaBundle({
        ...bundleInput(fixture, [{ scene: 'fullscreen', faceSrc: references[index] }]),
        temporaryId: `55555555-5555-4555-8555-${String(index).padStart(12, '0')}`,
      }), /symbolic link|regular file|symlink/i);
      assert.equal(fs.readFileSync(outsideVideo, 'utf8'), 'outside-face');
    });
  }
});

test('custom face source replacement during its bounded copy aborts and cleans owned bytes', (t) => {
  const fixture = makeFixture(t);
  const reference = 'assets/faces/custom.mp4';
  const customPath = writeFile(
    path.join(fixture.workspace.dir, ...reference.split('/')),
    Buffer.alloc(160 * 1024, 9),
  );
  const descriptors = new Map();
  let replaced = false;
  const racingFs = {
    ...trackedFs,
    openSync(filename, flags, mode) {
      const descriptor = fs.openSync(filename, flags, mode);
      descriptors.set(descriptor, filename);
      return descriptor;
    },
    closeSync(descriptor) {
      descriptors.delete(descriptor);
      return fs.closeSync(descriptor);
    },
    readSync(descriptor, buffer, offset, length, position) {
      const count = fs.readSync(descriptor, buffer, offset, length, position);
      if (!replaced && descriptors.get(descriptor) === customPath && position >= 64 * 1024) {
        replaced = true;
        const replacement = `${customPath}.replacement`;
        fs.writeFileSync(replacement, 'foreign-custom');
        fs.renameSync(replacement, customPath);
      }
      return count;
    },
  };
  let invoked = false;

  assert.throws(() => withRenderMediaBundle({
    ...bundleInput(fixture, [{ scene: 'fullscreen', faceSrc: reference }]),
    fileSystem: racingFs,
  }, () => {
    invoked = true;
  }), /identity|changed/i);
  assert.equal(replaced, true);
  assert.equal(invoked, false);
  assert.equal(fs.readFileSync(customPath, 'utf8'), 'foreign-custom');
  assert.equal(fs.existsSync(path.join(
    fixture.root, 'public', '.automontage', `lesson-demo-${FIRST_ID}`,
  )), false);
});

test('custom bundle same-size mutation inside a successful callback fails before cleanup', (t) => {
  const fixture = makeFixture(t);
  const reference = 'assets/faces/custom.mp4';
  writeFile(path.join(fixture.workspace.dir, ...reference.split('/')), 'custom-video-bytes');
  let bundlePath;

  assert.throws(() => withRenderMediaBundle(
    bundleInput(fixture, [{ scene: 'fullscreen', faceSrc: reference }]),
    (lease) => {
      bundlePath = path.join(lease.directory, path.basename(lease.props.scenes[0].faceSrc));
      const original = fs.readFileSync(bundlePath);
      fs.writeFileSync(bundlePath, Buffer.alloc(original.length, 0x78));
      return 'rendered';
    },
  ), /bundle file|identity|hash|changed/i);
  assert.equal(fs.existsSync(bundlePath), false);
});

test('custom bundle append and overwrite after copy abort before the callback', async (t) => {
  for (const mutation of ['append', 'overwrite']) {
    await t.test(mutation, () => {
      const fixture = makeFixture(t);
      const reference = 'assets/faces/custom.mp4';
      writeFile(path.join(fixture.workspace.dir, ...reference.split('/')), 'custom-video-bytes');
      const descriptors = new Map();
      let mutated = false;
      const isCustomBundle = (filename) => typeof filename === 'string'
        && /[\\/]\.automontage[\\/].*[\\/]media-2\.mp4$/.test(filename);
      const mutatingFs = {
        ...trackedFs,
        openSync(filename, flags, mode) {
          const descriptor = fs.openSync(filename, flags, mode);
          descriptors.set(descriptor, filename);
          return descriptor;
        },
        closeSync(descriptor) {
          const filename = descriptors.get(descriptor);
          if (!mutated && isCustomBundle(filename)) {
            mutated = true;
            if (mutation === 'append') fs.appendFileSync(filename, 'append');
            else {
              const bytes = fs.readFileSync(filename);
              bytes[0] ^= 0xff;
              fs.writeFileSync(filename, bytes);
            }
          }
          descriptors.delete(descriptor);
          return fs.closeSync(descriptor);
        },
      };
      let invoked = false;

      assert.throws(() => withRenderMediaBundle({
        ...bundleInput(fixture, [{ scene: 'fullscreen', faceSrc: reference }]),
        fileSystem: mutatingFs,
      }, () => {
        invoked = true;
      }), /bundle|identity|hash|changed/i);
      assert.equal(mutated, true);
      assert.equal(invoked, false);
    });
  }
});

test('custom bundle ctime drift during hash is accepted only after a complete stable rehash', (t) => {
  const fixture = makeFixture(t);
  const reference = 'assets/faces/custom.mp4';
  writeFile(path.join(fixture.workspace.dir, ...reference.split('/')), Buffer.alloc(96 * 1024, 7));
  const descriptors = new Map();
  let destinationClosed = false;
  let driftAtNextFstat = false;
  let ctimeOffset = 0n;
  let postDriftReads = 0;
  const isCustomBundle = (filename) => typeof filename === 'string'
    && /[\\/]\.automontage[\\/].*[\\/]media-2\.mp4$/.test(filename);
  const shifted = (stat) => {
    if (ctimeOffset === 0n) return stat;
    const proxy = Object.create(stat);
    Object.defineProperty(proxy, 'ctimeNs', { value: stat.ctimeNs + ctimeOffset });
    return proxy;
  };
  const fileProviderFs = {
    ...trackedFs,
    openSync(filename, flags, mode) {
      const descriptor = fs.openSync(filename, flags, mode);
      descriptors.set(descriptor, filename);
      return descriptor;
    },
    closeSync(descriptor) {
      const filename = descriptors.get(descriptor);
      const result = fs.closeSync(descriptor);
      descriptors.delete(descriptor);
      if (isCustomBundle(filename)) destinationClosed = true;
      return result;
    },
    readSync(descriptor, ...args) {
      const filename = descriptors.get(descriptor);
      const bytesRead = fs.readSync(descriptor, ...args);
      if (destinationClosed && isCustomBundle(filename)) {
        if (ctimeOffset > 0n) postDriftReads += 1;
        else driftAtNextFstat = true;
      }
      return bytesRead;
    },
    fstatSync(descriptor, options) {
      const filename = descriptors.get(descriptor);
      if (driftAtNextFstat && isCustomBundle(filename)) {
        driftAtNextFstat = false;
        ctimeOffset = 1n;
      }
      const stat = fs.fstatSync(descriptor, options);
      return isCustomBundle(filename) ? shifted(stat) : stat;
    },
    lstatSync(filename, options) {
      const stat = fs.lstatSync(filename, options);
      return isCustomBundle(filename) ? shifted(stat) : stat;
    },
  };
  let invoked = false;

  assert.equal(withRenderMediaBundle({
    ...bundleInput(fixture, [{ scene: 'fullscreen', faceSrc: reference }]),
    fileSystem: fileProviderFs,
  }, () => {
    invoked = true;
    return 'rendered';
  }), 'rendered');
  assert.equal(invoked, true);
  assert.equal(ctimeOffset, 1n);
  assert.ok(postDriftReads >= 2, postDriftReads);
});

test('custom bundle success and render failure both remove every owned snapshot', (t) => {
  const fixture = makeFixture(t);
  const reference = 'assets/faces/custom.mp4';
  writeFile(path.join(fixture.workspace.dir, ...reference.split('/')), 'custom-video');
  const input = bundleInput(fixture, [{ scene: 'fullscreen', faceSrc: reference }]);
  let successDirectory;
  assert.equal(withRenderMediaBundle(input, (lease) => {
    successDirectory = lease.directory;
    assert.deepEqual(fs.readdirSync(lease.directory).sort(), ['media-1.mp4', 'media-2.mp4']);
    return 'rendered';
  }), 'rendered');
  assert.equal(fs.existsSync(successDirectory), false);

  let failureDirectory;
  assert.throws(() => withRenderMediaBundle({ ...input, temporaryId: SECOND_ID }, (lease) => {
    failureDirectory = lease.directory;
    throw new Error('custom render failed');
  }), /custom render failed/);
  assert.equal(fs.existsSync(failureDirectory), false);
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
    ...trackedFs,
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
  let bundleDirectory = null;
  let movedDirectory = null;
  let replaced = false;
  const racingFs = {
    ...trackedFs,
    mkdirSync(target, options) {
      const result = fs.mkdirSync(target, options);
      if (path.basename(target) === `lesson-demo-${FIRST_ID}`) {
        bundleDirectory = target;
        movedDirectory = `${target}.owned`;
      }
      return result;
    },
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
    ...trackedFs,
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

test('the same public alias remains isolated across independent render roots', (t) => {
  const fixture = makeFixture(t);
  const input = bundleInput(fixture, []);
  const first = prepareRenderMediaBundle(input);
  const second = prepareRenderMediaBundle(input);

  assert.notEqual(first.publicDirectory, second.publicDirectory);
  assert.equal(first.props.faceSrc, second.props.faceSrc);
  assert.equal(fs.readFileSync(path.join(first.directory, 'media-1.mp4'), 'utf8'), 'speaker-bytes');
  first.cleanup();
  assert.equal(fs.readFileSync(path.join(second.directory, 'media-1.mp4'), 'utf8'), 'speaker-bytes');
  second.cleanup();
});

test('cleanup claims its owned directory before an original-path replacement and never recursively removes foreign data', (t) => {
  const fixture = makeFixture(t);
  let bundleDirectory = null;
  let movedByOldCleanup = null;
  let injected = false;
  let recursiveRemovalCalls = 0;
  const racingFs = {
    ...trackedFs,
    renameSync(source, destination) {
      const result = fs.renameSync(source, destination);
      if (!injected && source === bundleDirectory && destination.includes('.cleanup-')) {
        injected = true;
        fs.mkdirSync(bundleDirectory);
        fs.writeFileSync(path.join(bundleDirectory, 'foreign.txt'), 'foreign');
      }
      return result;
    },
    rmSync(target, options) {
      if (options?.recursive) recursiveRemovalCalls += 1;
      if (!injected && target === bundleDirectory && options?.recursive) {
        injected = true;
        fs.renameSync(bundleDirectory, movedByOldCleanup);
        fs.mkdirSync(bundleDirectory);
        fs.writeFileSync(path.join(bundleDirectory, 'foreign.txt'), 'foreign');
      }
      return fs.rmSync(target, options);
    },
  };
  const lease = prepareRenderMediaBundle({
    ...bundleInput(fixture, []),
    fileSystem: racingFs,
  });
  bundleDirectory = lease.directory;
  movedByOldCleanup = `${bundleDirectory}.old-owned`;

  assert.throws(() => lease.cleanup(), /unexpected files|cleanup refused/i);

  assert.equal(injected, true);
  assert.equal(recursiveRemovalCalls, 0);
  assert.equal(fs.readFileSync(path.join(bundleDirectory, 'foreign.txt'), 'utf8'), 'foreign');
  assert.equal(fs.existsSync(movedByOldCleanup), false);
  assert.deepEqual(
    fs.readdirSync(path.dirname(bundleDirectory)).filter((name) => name.includes('.cleanup-')),
    [],
  );
});

test('cleanup claim race refuses a pre-rename foreign swap without deleting either directory', (t) => {
  const fixture = makeFixture(t);
  let bundleDirectory = null;
  let movedOwned = null;
  let injected = false;
  const racingFs = {
    ...trackedFs,
    renameSync(source, destination) {
      if (!injected && source === bundleDirectory && destination.includes('.cleanup-')) {
        injected = true;
        fs.renameSync(bundleDirectory, movedOwned);
        fs.mkdirSync(bundleDirectory);
        fs.writeFileSync(path.join(bundleDirectory, 'foreign.txt'), 'foreign');
      }
      return fs.renameSync(source, destination);
    },
  };
  const lease = prepareRenderMediaBundle({
    ...bundleInput(fixture, []),
    fileSystem: racingFs,
  });
  bundleDirectory = lease.directory;
  movedOwned = `${bundleDirectory}.owned-by-lease`;

  assert.throws(() => lease.cleanup(), /replaced directory|claim/i);

  const tombstone = fs.readdirSync(path.dirname(bundleDirectory))
    .find((name) => name.includes('.cleanup-'));
  assert.ok(tombstone);
  assert.equal(fs.readFileSync(path.join(
    path.dirname(bundleDirectory), tombstone, 'bundle', 'foreign.txt',
  ), 'utf8'), 'foreign');
  assert.equal(fs.readFileSync(path.join(movedOwned, 'media-1.mp4'), 'utf8'), 'speaker-bytes');
});

test('cleanup resumes after a transient post-rename identity read and reclaims its claimed bundle', (t) => {
  const fixture = makeFixture(t);
  let bundleDirectory = null;
  let claimedDirectory = null;
  let failClaimRead = false;
  const transientFs = {
    ...trackedFs,
    renameSync(source, destination) {
      const result = fs.renameSync(source, destination);
      if (source === bundleDirectory && destination.includes('.cleanup-')) {
        claimedDirectory = destination;
        failClaimRead = true;
      }
      return result;
    },
    lstatSync(target, options) {
      if (failClaimRead && target === claimedDirectory) {
        failClaimRead = false;
        const error = new Error('transient post-rename lstat failure');
        error.code = 'EIO';
        throw error;
      }
      return fs.lstatSync(target, options);
    },
  };
  const lease = prepareRenderMediaBundle({
    ...bundleInput(fixture, []),
    fileSystem: transientFs,
  });
  bundleDirectory = lease.directory;

  assert.throws(() => lease.cleanup(), /transient post-rename/);
  assert.equal(fs.readFileSync(path.join(claimedDirectory, 'media-1.mp4'), 'utf8'), 'speaker-bytes');
  assert.doesNotThrow(() => lease.cleanup());
  assert.equal(fs.existsSync(claimedDirectory), false);
  assert.equal(fs.existsSync(path.dirname(bundleDirectory)), false);
});

test('cleanup retry retains a foreign directory substituted after an unverified claim', (t) => {
  const fixture = makeFixture(t);
  let bundleDirectory = null;
  let claimedDirectory = null;
  let failClaimRead = false;
  const transientFs = {
    ...trackedFs,
    renameSync(source, destination) {
      const result = fs.renameSync(source, destination);
      if (source === bundleDirectory && destination.includes('.cleanup-')) {
        claimedDirectory = destination;
        failClaimRead = true;
      }
      return result;
    },
    lstatSync(target, options) {
      if (failClaimRead && target === claimedDirectory) {
        failClaimRead = false;
        const error = new Error('transient post-rename lstat failure');
        error.code = 'EIO';
        throw error;
      }
      return fs.lstatSync(target, options);
    },
  };
  const lease = prepareRenderMediaBundle({
    ...bundleInput(fixture, []),
    fileSystem: transientFs,
  });
  bundleDirectory = lease.directory;

  assert.throws(() => lease.cleanup(), /transient post-rename/);
  const movedOwned = `${claimedDirectory}.owned`;
  fs.renameSync(claimedDirectory, movedOwned);
  fs.mkdirSync(claimedDirectory);
  fs.writeFileSync(path.join(claimedDirectory, 'foreign.txt'), 'foreign');

  assert.throws(() => lease.cleanup(), /identity|claim|replaced/i);
  assert.equal(fs.readFileSync(path.join(claimedDirectory, 'foreign.txt'), 'utf8'), 'foreign');
  assert.equal(fs.readFileSync(path.join(movedOwned, 'media-1.mp4'), 'utf8'), 'speaker-bytes');
});

test('cleanup reconciles one uncertain tombstone create without choosing a second path', async (t) => {
  await t.test('transient first lstat reuses and reclaims the exact empty candidate', () => {
    const fixture = makeFixture(t);
    let cleanupContainer = null;
    let cleanupMkdirCalls = 0;
    let failFirstLstat = false;
    const transientFs = {
      ...trackedFs,
      mkdirSync(target, options) {
        if (!path.basename(target).includes('.cleanup-')) return fs.mkdirSync(target, options);
        cleanupMkdirCalls += 1;
        cleanupContainer = target;
        const result = fs.mkdirSync(target, options);
        if (cleanupMkdirCalls === 1) failFirstLstat = true;
        return result;
      },
      lstatSync(target, options) {
        if (failFirstLstat && target === cleanupContainer) {
          failFirstLstat = false;
          const error = new Error('transient post-mkdir lstat failure');
          error.code = 'EIO';
          throw error;
        }
        return fs.lstatSync(target, options);
      },
    };
    const lease = prepareRenderMediaBundle({
      ...bundleInput(fixture, []),
      fileSystem: transientFs,
    });

    assert.throws(() => lease.cleanup(), /transient post-mkdir lstat/);
    assert.equal(fs.existsSync(cleanupContainer), true);
    assert.doesNotThrow(() => lease.cleanup());
    assert.equal(cleanupMkdirCalls, 1);
    assert.equal(fs.existsSync(cleanupContainer), false);
    assert.equal(fs.existsSync(path.dirname(cleanupContainer)), false);
  });

  await t.test('mkdir wrapper throwing after creation retains the unproven candidate', () => {
    const fixture = makeFixture(t);
    let cleanupContainer = null;
    let cleanupMkdirCalls = 0;
    const transientFs = {
      ...trackedFs,
      mkdirSync(target, options) {
        if (!path.basename(target).includes('.cleanup-')) return fs.mkdirSync(target, options);
        cleanupMkdirCalls += 1;
        cleanupContainer = target;
        const result = fs.mkdirSync(target, options);
        if (cleanupMkdirCalls === 1) {
          const error = new Error('transient post-mkdir syscall failure');
          error.code = 'EIO';
          throw error;
        }
        return result;
      },
    };
    const lease = prepareRenderMediaBundle({
      ...bundleInput(fixture, []),
      fileSystem: transientFs,
    });

    assert.throws(() => lease.cleanup(), /transient post-mkdir syscall/);
    assert.equal(fs.existsSync(cleanupContainer), true);
    assert.throws(() => lease.cleanup(), /container|foreign|ownership|uncertain|refused/i);
    assert.equal(cleanupMkdirCalls, 1);
    assert.equal(fs.existsSync(cleanupContainer), true);
  });

  await t.test('mkdir fails before creation and retry creates the same candidate', () => {
    const fixture = makeFixture(t);
    const attemptedContainers = [];
    let failFirstMkdir = true;
    const transientFs = {
      ...trackedFs,
      mkdirSync(target, options) {
        if (!path.basename(target).includes('.cleanup-')) return fs.mkdirSync(target, options);
        attemptedContainers.push(target);
        if (failFirstMkdir) {
          failFirstMkdir = false;
          const error = new Error('transient pre-mkdir failure');
          error.code = 'EIO';
          throw error;
        }
        return fs.mkdirSync(target, options);
      },
    };
    const lease = prepareRenderMediaBundle({
      ...bundleInput(fixture, []),
      fileSystem: transientFs,
    });

    assert.throws(() => lease.cleanup(), /transient pre-mkdir/);
    assert.doesNotThrow(() => lease.cleanup());
    assert.equal(attemptedContainers.length, 2);
    assert.equal(new Set(attemptedContainers).size, 1);
    assert.equal(fs.existsSync(attemptedContainers[0]), false);
  });

  await t.test('mkdir fails before creation and retry refuses a foreign empty candidate', () => {
    const fixture = makeFixture(t);
    let cleanupContainer = null;
    let failFirstMkdir = true;
    let cleanupMkdirCalls = 0;
    const transientFs = {
      ...trackedFs,
      mkdirSync(target, options) {
        if (!path.basename(target).includes('.cleanup-')) return fs.mkdirSync(target, options);
        cleanupMkdirCalls += 1;
        cleanupContainer = target;
        if (failFirstMkdir) {
          failFirstMkdir = false;
          const error = new Error('transient pre-mkdir failure');
          error.code = 'EIO';
          throw error;
        }
        return fs.mkdirSync(target, options);
      },
    };
    const lease = prepareRenderMediaBundle({
      ...bundleInput(fixture, []),
      fileSystem: transientFs,
    });

    assert.throws(() => lease.cleanup(), /transient pre-mkdir/);
    fs.mkdirSync(cleanupContainer);

    assert.throws(() => lease.cleanup(), /container|foreign|ownership|uncertain|refused/i);
    assert.equal(cleanupMkdirCalls, 1);
    assert.equal(fs.existsSync(cleanupContainer), true);
  });

  await t.test('identity captured before first pathname lstat rejects an empty replacement', () => {
    const fixture = makeFixture(t);
    let cleanupContainer = null;
    let failFirstLstat = false;
    const transientFs = {
      ...trackedFs,
      mkdirSync(target, options) {
        if (!path.basename(target).includes('.cleanup-')) return fs.mkdirSync(target, options);
        cleanupContainer = target;
        const result = fs.mkdirSync(target, options);
        failFirstLstat = true;
        return result;
      },
      lstatSync(target, options) {
        if (failFirstLstat && target === cleanupContainer) {
          failFirstLstat = false;
          const error = new Error('transient first pathname lstat failure');
          error.code = 'EIO';
          throw error;
        }
        return fs.lstatSync(target, options);
      },
    };
    const lease = prepareRenderMediaBundle({
      ...bundleInput(fixture, []),
      fileSystem: transientFs,
    });

    assert.throws(() => lease.cleanup(), /transient first pathname lstat/);
    const movedOwned = `${cleanupContainer}.owned`;
    fs.renameSync(cleanupContainer, movedOwned);
    fs.mkdirSync(cleanupContainer);

    assert.throws(() => lease.cleanup(), /identity|container|foreign|refused/i);
    assert.equal(fs.existsSync(cleanupContainer), true);
    assert.equal(fs.existsSync(movedOwned), true);
  });

  await t.test('captured candidate identity replacement is retained', () => {
    const fixture = makeFixture(t);
    let leaseBase = null;
    let cleanupContainer = null;
    let failBaseCheck = false;
    const transientFs = {
      ...trackedFs,
      mkdirSync(target, options) {
        if (!path.basename(target).includes('.cleanup-')) return fs.mkdirSync(target, options);
        cleanupContainer = target;
        const result = fs.mkdirSync(target, options);
        failBaseCheck = true;
        return result;
      },
      lstatSync(target, options) {
        if (failBaseCheck && target === leaseBase) {
          failBaseCheck = false;
          const error = new Error('transient post-capture base failure');
          error.code = 'EIO';
          throw error;
        }
        return fs.lstatSync(target, options);
      },
    };
    const lease = prepareRenderMediaBundle({
      ...bundleInput(fixture, []),
      fileSystem: transientFs,
    });
    leaseBase = path.dirname(lease.directory);

    assert.throws(() => lease.cleanup(), /transient post-capture base/);
    const movedOwned = `${cleanupContainer}.owned`;
    fs.renameSync(cleanupContainer, movedOwned);
    fs.mkdirSync(cleanupContainer);

    assert.throws(() => lease.cleanup(), /identity|container|foreign|refused/i);
    assert.equal(fs.existsSync(cleanupContainer), true);
    assert.equal(fs.existsSync(movedOwned), true);
  });

  await t.test('identity captured before an empty-check failure rejects replacement', () => {
    const fixture = makeFixture(t);
    let cleanupContainer = null;
    let failEmptyCheck = false;
    const transientFs = {
      ...trackedFs,
      mkdirSync(target, options) {
        if (!path.basename(target).includes('.cleanup-')) return fs.mkdirSync(target, options);
        cleanupContainer = target;
        const result = fs.mkdirSync(target, options);
        failEmptyCheck = true;
        return result;
      },
      readdirSync(target, options) {
        if (failEmptyCheck && target === cleanupContainer) {
          failEmptyCheck = false;
          const error = new Error('transient container empty-check failure');
          error.code = 'EIO';
          throw error;
        }
        return fs.readdirSync(target, options);
      },
    };
    const lease = prepareRenderMediaBundle({
      ...bundleInput(fixture, []),
      fileSystem: transientFs,
    });

    assert.throws(() => lease.cleanup(), /transient container empty-check/);
    const movedOwned = `${cleanupContainer}.owned`;
    fs.renameSync(cleanupContainer, movedOwned);
    fs.mkdirSync(cleanupContainer);

    assert.throws(() => lease.cleanup(), /identity|container|foreign|refused/i);
    assert.equal(fs.existsSync(cleanupContainer), true);
    assert.equal(fs.existsSync(movedOwned), true);
  });

  await t.test('nonempty unverified candidate is retained', () => {
    const fixture = makeFixture(t);
    let cleanupContainer = null;
    let failFirstLstat = false;
    const transientFs = {
      ...trackedFs,
      mkdirSync(target, options) {
        if (!path.basename(target).includes('.cleanup-')) return fs.mkdirSync(target, options);
        cleanupContainer = target;
        const result = fs.mkdirSync(target, options);
        failFirstLstat = true;
        return result;
      },
      lstatSync(target, options) {
        if (failFirstLstat && target === cleanupContainer) {
          failFirstLstat = false;
          const error = new Error('transient post-mkdir lstat failure');
          error.code = 'EIO';
          throw error;
        }
        return fs.lstatSync(target, options);
      },
    };
    const lease = prepareRenderMediaBundle({
      ...bundleInput(fixture, []),
      fileSystem: transientFs,
    });

    assert.throws(() => lease.cleanup(), /transient post-mkdir lstat/);
    fs.writeFileSync(path.join(cleanupContainer, 'foreign.txt'), 'foreign');

    assert.throws(() => lease.cleanup(), /container|tombstone|foreign|empty|refused/i);
    assert.equal(fs.readFileSync(path.join(cleanupContainer, 'foreign.txt'), 'utf8'), 'foreign');
  });

  await t.test('an arbitrary EEXIST candidate is never adopted', () => {
    const fixture = makeFixture(t);
    let cleanupContainer = null;
    let injected = false;
    const transientFs = {
      ...trackedFs,
      mkdirSync(target, options) {
        if (!path.basename(target).includes('.cleanup-') || injected) {
          return fs.mkdirSync(target, options);
        }
        injected = true;
        cleanupContainer = target;
        fs.mkdirSync(target, options);
        return fs.mkdirSync(target, options);
      },
    };
    const lease = prepareRenderMediaBundle({
      ...bundleInput(fixture, []),
      fileSystem: transientFs,
    });

    assert.throws(() => lease.cleanup(), /exist/i);
    assert.throws(() => lease.cleanup(), /container|foreign|ownership|refused/i);
    assert.equal(fs.existsSync(cleanupContainer), true);
  });
});

test('cleanup retries partial unlink and tombstone rmdir failures without leaking owned paths', async (t) => {
  await t.test('partial unlink', () => {
    const fixture = makeFixture(t);
    writeFile(path.join(fixture.workspace.dir, 'assets', 'broll', 'image.png'), 'image');
    let unlinkCalls = 0;
    let failed = false;
    const transientFs = {
      ...trackedFs,
      unlinkSync(target) {
        unlinkCalls += 1;
        if (!failed && unlinkCalls === 2) {
          failed = true;
          const error = new Error('transient unlink failure');
          error.code = 'EIO';
          throw error;
        }
        return fs.unlinkSync(target);
      },
    };
    const lease = prepareRenderMediaBundle({
      ...bundleInput(fixture, [{ scene: 'broll', brollSrc: 'assets/broll/image.png' }]),
      fileSystem: transientFs,
    });

    assert.throws(() => lease.cleanup(), /transient unlink/);
    assert.doesNotThrow(() => lease.cleanup());
    assert.equal(fs.existsSync(lease.directory), false);
  });

  await t.test('unlink completes before reporting a transient failure', () => {
    const fixture = makeFixture(t);
    let failed = false;
    const transientFs = {
      ...trackedFs,
      unlinkSync(target) {
        const result = fs.unlinkSync(target);
        if (!failed) {
          failed = true;
          const error = new Error('transient post-unlink failure');
          error.code = 'EIO';
          throw error;
        }
        return result;
      },
    };
    const lease = prepareRenderMediaBundle({
      ...bundleInput(fixture, []),
      fileSystem: transientFs,
    });

    assert.throws(() => lease.cleanup(), /transient post-unlink/);
    assert.doesNotThrow(() => lease.cleanup());
    assert.equal(fs.existsSync(lease.directory), false);
  });

  await t.test('bundle rmdir completes before reporting a transient failure', () => {
    const fixture = makeFixture(t);
    let failed = false;
    const transientFs = {
      ...trackedFs,
      rmdirSync(target) {
        const result = fs.rmdirSync(target);
        if (!failed && path.basename(target) === 'bundle') {
          failed = true;
          const error = new Error('transient post-bundle-rmdir failure');
          error.code = 'EIO';
          throw error;
        }
        return result;
      },
    };
    const lease = prepareRenderMediaBundle({
      ...bundleInput(fixture, []),
      fileSystem: transientFs,
    });

    assert.throws(() => lease.cleanup(), /transient post-bundle-rmdir/);
    assert.doesNotThrow(() => lease.cleanup());
    assert.equal(fs.existsSync(lease.directory), false);
  });

  await t.test('tombstone container rmdir', () => {
    const fixture = makeFixture(t);
    let failed = false;
    let cleanupContainer = null;
    const transientFs = {
      ...trackedFs,
      rmdirSync(target) {
        if (!failed && path.basename(target).includes('.cleanup-')) {
          failed = true;
          cleanupContainer = target;
          const error = new Error('transient tombstone rmdir failure');
          error.code = 'EIO';
          throw error;
        }
        return fs.rmdirSync(target);
      },
    };
    const lease = prepareRenderMediaBundle({
      ...bundleInput(fixture, []),
      fileSystem: transientFs,
    });

    assert.throws(() => lease.cleanup(), /transient tombstone/);
    assert.equal(fs.existsSync(cleanupContainer), true);
    assert.doesNotThrow(() => lease.cleanup());
    assert.equal(fs.existsSync(cleanupContainer), false);
  });

  await t.test('tombstone rmdir completes before reporting a transient failure', () => {
    const fixture = makeFixture(t);
    let failed = false;
    let cleanupContainer = null;
    const transientFs = {
      ...trackedFs,
      rmdirSync(target) {
        const result = fs.rmdirSync(target);
        if (!failed && path.basename(target).includes('.cleanup-')) {
          failed = true;
          cleanupContainer = target;
          const error = new Error('transient post-tombstone-rmdir failure');
          error.code = 'EIO';
          throw error;
        }
        return result;
      },
    };
    const lease = prepareRenderMediaBundle({
      ...bundleInput(fixture, []),
      fileSystem: transientFs,
    });

    assert.throws(() => lease.cleanup(), /transient post-tombstone-rmdir/);
    assert.equal(fs.existsSync(cleanupContainer), false);
    assert.doesNotThrow(() => lease.cleanup());
  });
});

test('ctime-only File Provider drift is re-pinned only after a full bundle hash check', async (t) => {
  const driftPoints = [
    { label: 'after destination close 1', afterClose: 1 },
    { label: 'after destination close 2', afterClose: 2 },
    { label: 'after destination close 3', afterClose: 3 },
    { label: 'during the final hash', duringFinalHash: true },
  ];
  for (const driftPoint of driftPoints) {
    await t.test(`ctime drift ${driftPoint.label}`, () => {
      const fixture = makeFixture(t);
      const descriptors = new Map();
      let destinationCloses = 0;
      let destinationReads = 0;
      let ctimeOffset = 0n;
      let driftAtNextFstat = false;
      let postDriftReads = 0;
      const isOwnedBundleFile = (filename) => typeof filename === 'string'
        && /[\\/]\.automontage[\\/].*[\\/]media-1\.mp4$/.test(filename);
      const withCtimeOffset = (stat) => {
        if (ctimeOffset === 0n) return stat;
        const shifted = Object.create(stat);
        Object.defineProperty(shifted, 'ctimeNs', {
          configurable: true,
          enumerable: true,
          value: stat.ctimeNs + ctimeOffset,
        });
        return shifted;
      };
      const fileProviderFs = {
        ...trackedFs,
        openSync(filename, flags, mode) {
          const descriptor = fs.openSync(filename, flags, mode);
          descriptors.set(descriptor, filename);
          return descriptor;
        },
        closeSync(descriptor) {
          const filename = descriptors.get(descriptor);
          const result = fs.closeSync(descriptor);
          descriptors.delete(descriptor);
          if (isOwnedBundleFile(filename)) {
            destinationCloses += 1;
            if (destinationCloses === driftPoint.afterClose) ctimeOffset += 1n;
          }
          return result;
        },
        fstatSync(descriptor, options) {
          if (driftAtNextFstat && isOwnedBundleFile(descriptors.get(descriptor))) {
            ctimeOffset += 1n;
            driftAtNextFstat = false;
          }
          const stat = fs.fstatSync(descriptor, options);
          return isOwnedBundleFile(descriptors.get(descriptor)) ? withCtimeOffset(stat) : stat;
        },
        lstatSync(filename, options) {
          const stat = fs.lstatSync(filename, options);
          return isOwnedBundleFile(filename) ? withCtimeOffset(stat) : stat;
        },
        readSync(descriptor, ...args) {
          const ownedBundleFile = isOwnedBundleFile(descriptors.get(descriptor));
          if (ctimeOffset > 0n && ownedBundleFile) {
            postDriftReads += 1;
          }
          const bytesRead = fs.readSync(descriptor, ...args);
          if (ownedBundleFile) {
            destinationReads += 1;
            if (driftPoint.duringFinalHash && destinationReads === 3) {
              driftAtNextFstat = true;
            }
          }
          return bytesRead;
        },
      };
      let invoked = false;

      const result = withRenderMediaBundle({
        ...bundleInput(fixture, []),
        fileSystem: fileProviderFs,
      }, () => {
        invoked = true;
        return 'rendered';
      });

      assert.equal(result, 'rendered');
      assert.equal(invoked, true);
      assert.equal(ctimeOffset, 1n);
      assert.ok(postDriftReads > 0, 'ctime re-pin must re-read and hash the owned bytes');
      assert.equal(fs.existsSync(path.join(
        fixture.root, 'public', '.automontage', `lesson-demo-${FIRST_ID}`,
      )), false);
    });
  }

  for (const driftPhase of ['after close', 'during hash']) {
    await t.test(`continuous ctime drift ${driftPhase} stays bounded`, () => {
      const fixture = makeFixture(t);
      const descriptors = new Map();
      let ctimeOffset = 0n;
      let destinationCloses = 0;
      let driftAtNextFstat = false;
      let hashDrifts = 0;
      let invoked = false;
      const isOwnedBundleFile = (filename) => typeof filename === 'string'
        && /[\\/]\.automontage[\\/].*[\\/]media-1\.mp4$/.test(filename);
      const withCtimeOffset = (stat) => {
        if (ctimeOffset === 0n) return stat;
        const shifted = Object.create(stat);
        Object.defineProperty(shifted, 'ctimeNs', {
          configurable: true,
          enumerable: true,
          value: stat.ctimeNs + ctimeOffset,
        });
        return shifted;
      };
      const unstableFileProviderFs = {
        ...trackedFs,
        openSync(filename, flags, mode) {
          const descriptor = fs.openSync(filename, flags, mode);
          descriptors.set(descriptor, filename);
          return descriptor;
        },
        closeSync(descriptor) {
          const filename = descriptors.get(descriptor);
          const result = fs.closeSync(descriptor);
          descriptors.delete(descriptor);
          if (isOwnedBundleFile(filename)) {
            destinationCloses += 1;
            if (driftPhase === 'after close') ctimeOffset += 1n;
          }
          return result;
        },
        fstatSync(descriptor, options) {
          const filename = descriptors.get(descriptor);
          if (driftAtNextFstat && isOwnedBundleFile(filename)) {
            ctimeOffset += 1n;
            hashDrifts += 1;
            driftAtNextFstat = false;
          }
          const stat = fs.fstatSync(descriptor, options);
          return isOwnedBundleFile(filename) ? withCtimeOffset(stat) : stat;
        },
        lstatSync(filename, options) {
          const stat = fs.lstatSync(filename, options);
          return isOwnedBundleFile(filename) ? withCtimeOffset(stat) : stat;
        },
        readSync(descriptor, ...args) {
          const filename = descriptors.get(descriptor);
          const bytesRead = fs.readSync(descriptor, ...args);
          if (driftPhase === 'during hash' && destinationCloses > 0
            && isOwnedBundleFile(filename)) {
            driftAtNextFstat = true;
          }
          return bytesRead;
        },
      };

      assert.throws(() => withRenderMediaBundle({
        ...bundleInput(fixture, []),
        fileSystem: unstableFileProviderFs,
      }, () => {
        invoked = true;
      }), driftPhase === 'during hash'
        ? /ctime did not stabilize while hashing/
        : /ctime did not stabilize before render/);
      if (driftPhase === 'during hash') assert.equal(hashDrifts, 3);
      else assert.equal(destinationCloses, 4);
      assert.equal(invoked, false);
      assert.equal(fs.existsSync(path.join(
        fixture.root, 'public', '.automontage', `lesson-demo-${FIRST_ID}`,
      )), false);
    });
  }
});

test('ctime re-pin rejects changed bytes even when every non-ctime field is projected unchanged', (t) => {
  const fixture = makeFixture(t);
  const descriptors = new Map();
  let baselineIdentity = null;
  let mutated = false;
  const isOwnedBundleFile = (filename) => typeof filename === 'string'
    && /[\\/]\.automontage[\\/].*[\\/]media-1\.mp4$/.test(filename);
  const projectIdentity = (stat) => {
    if (!mutated || !baselineIdentity) return stat;
    const projected = Object.create(stat);
    for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'mode', 'nlink']) {
      Object.defineProperty(projected, key, {
        configurable: true, enumerable: true, value: baselineIdentity[key],
      });
    }
    Object.defineProperty(projected, 'ctimeNs', {
      configurable: true, enumerable: true, value: baselineIdentity.ctimeNs + 1n,
    });
    return projected;
  };
  const adversarialFs = {
    ...trackedFs,
    openSync(filename, flags, mode) {
      const descriptor = fs.openSync(filename, flags, mode);
      descriptors.set(descriptor, filename);
      return descriptor;
    },
    closeSync(descriptor) {
      const filename = descriptors.get(descriptor);
      const result = fs.closeSync(descriptor);
      descriptors.delete(descriptor);
      if (!mutated && isOwnedBundleFile(filename)) {
        baselineIdentity = fs.lstatSync(filename, { bigint: true });
        const bytes = fs.readFileSync(filename);
        bytes[0] ^= 0xff;
        fs.writeFileSync(filename, bytes);
        mutated = true;
      }
      return result;
    },
    fstatSync(descriptor, options) {
      const stat = fs.fstatSync(descriptor, options);
      return isOwnedBundleFile(descriptors.get(descriptor)) ? projectIdentity(stat) : stat;
    },
    lstatSync(filename, options) {
      const stat = fs.lstatSync(filename, options);
      return isOwnedBundleFile(filename) ? projectIdentity(stat) : stat;
    },
  };
  let invoked = false;

  assert.throws(() => withRenderMediaBundle({
    ...bundleInput(fixture, []),
    fileSystem: adversarialFs,
  }, () => {
    invoked = true;
  }), /bundle file hash changed before render/);
  assert.equal(mutated, true);
  assert.equal(invoked, false);
});

test('ctime re-pin rejects a same-size mutation after the verified bytes were read', (t) => {
  const fixture = makeFixture(t);
  const descriptors = new Map();
  let baselineIdentity = null;
  let destinationClosed = false;
  let ctimeOffset = 0n;
  let destinationReads = 0;
  let hashReadFinished = false;
  let mutated = false;
  const isOwnedBundleFile = (filename) => typeof filename === 'string'
    && /[\\/]\.automontage[\\/].*[\\/]media-1\.mp4$/.test(filename);
  const projectIdentity = (stat) => {
    if (!destinationClosed || !baselineIdentity) return stat;
    const projected = Object.create(stat);
    for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'mode', 'nlink']) {
      Object.defineProperty(projected, key, {
        configurable: true, enumerable: true, value: baselineIdentity[key],
      });
    }
    Object.defineProperty(projected, 'ctimeNs', {
      configurable: true,
      enumerable: true,
      value: baselineIdentity.ctimeNs + ctimeOffset,
    });
    return projected;
  };
  const adversarialFs = {
    ...trackedFs,
    openSync(filename, flags, mode) {
      const descriptor = fs.openSync(filename, flags, mode);
      descriptors.set(descriptor, filename);
      return descriptor;
    },
    closeSync(descriptor) {
      const filename = descriptors.get(descriptor);
      const result = fs.closeSync(descriptor);
      descriptors.delete(descriptor);
      if (!destinationClosed && isOwnedBundleFile(filename)) {
        baselineIdentity = fs.lstatSync(filename, { bigint: true });
        destinationClosed = true;
        ctimeOffset = 1n;
      }
      return result;
    },
    fstatSync(descriptor, options) {
      const filename = descriptors.get(descriptor);
      if (destinationClosed && hashReadFinished && !mutated && isOwnedBundleFile(filename)) {
        const bytes = fs.readFileSync(filename);
        bytes[0] ^= 0xff;
        fs.writeFileSync(filename, bytes);
        mutated = true;
        ctimeOffset = 2n;
      }
      const stat = fs.fstatSync(descriptor, options);
      return isOwnedBundleFile(filename) ? projectIdentity(stat) : stat;
    },
    lstatSync(filename, options) {
      const stat = fs.lstatSync(filename, options);
      return isOwnedBundleFile(filename) ? projectIdentity(stat) : stat;
    },
    readSync(descriptor, ...args) {
      const filename = descriptors.get(descriptor);
      const bytesRead = fs.readSync(descriptor, ...args);
      if (isOwnedBundleFile(filename)) {
        destinationReads += 1;
        if (destinationClosed && destinationReads === 3) hashReadFinished = true;
      }
      return bytesRead;
    },
  };
  let invoked = false;

  assert.throws(() => withRenderMediaBundle({
    ...bundleInput(fixture, []),
    fileSystem: adversarialFs,
  }, () => {
    invoked = true;
  }), /identity changed while hashing|hash changed before render/);
  assert.equal(destinationClosed, true);
  assert.equal(mutated, true);
  assert.ok(destinationReads >= 2);
  assert.equal(invoked, false);
});

test('same-inode destination mutation after fsync or lease return aborts before the render callback', async (t) => {
  for (const mutation of ['append', 'overwrite']) {
    for (const mutateAfterClose of [1, 2, 3]) {
      await t.test(`${mutation} after destination close ${mutateAfterClose}`, () => {
        const fixture = makeFixture(t);
        const descriptors = new Map();
        let destinationCloses = 0;
        let mutated = false;
        const mutatingFs = {
          ...trackedFs,
          openSync(filename, flags, mode) {
            const descriptor = fs.openSync(filename, flags, mode);
            descriptors.set(descriptor, filename);
            return descriptor;
          },
          closeSync(descriptor) {
            const filename = descriptors.get(descriptor);
            if (filename && /[\\/]\.automontage[\\/].*[\\/]media-1\.mp4$/.test(filename)) {
              destinationCloses += 1;
              if (!mutated && destinationCloses === mutateAfterClose) {
                mutated = true;
                if (mutation === 'append') {
                  fs.appendFileSync(filename, 'appended-after-fsync');
                } else {
                  const bytes = fs.readFileSync(filename);
                  bytes[0] ^= 0xff;
                  fs.writeFileSync(filename, bytes);
                }
              }
            }
            descriptors.delete(descriptor);
            return fs.closeSync(descriptor);
          },
        };
        let invoked = false;

        assert.throws(() => withRenderMediaBundle({
          ...bundleInput(fixture, []),
          fileSystem: mutatingFs,
        }, () => {
          invoked = true;
        }), /destination|bundle.*changed|hash|identity/i);
        assert.equal(mutated, true);
        assert.equal(invoked, false);
        assert.equal(fs.existsSync(path.join(
          fixture.root, 'public', '.automontage', `lesson-demo-${FIRST_ID}`,
        )), false);
      });
    }
  }
});

test('trusted roots reject symlink aliases above the immediate storage directory', async (t) => {
  await t.test('source chain', () => {
    const fixture = makeFixture(t);
    const realParent = path.join(fixture.directory, 'real-source-parent');
    const aliasParent = path.join(fixture.directory, 'source-alias');
    const realSource = writeFile(path.join(realParent, 'nested', 'speaker.mp4'), 'aliased-source');
    fs.symlinkSync(realParent, aliasParent, 'dir');
    const aliasSource = path.join(aliasParent, 'nested', 'speaker.mp4');
    const input = bundleInput(fixture, []);
    input.sourcePath = aliasSource;
    input.approvedBrief.source = aliasSource;

    assert.throws(() => prepareRenderMediaBundle(input), /symbolic link|symlink/i);
    assert.equal(fs.readFileSync(realSource, 'utf8'), 'aliased-source');
  });

  await t.test('project chain', () => {
    const fixture = makeFixture(t);
    const realParent = path.join(fixture.directory, 'real-project-parent');
    const aliasParent = path.join(fixture.directory, 'project-alias');
    const realWorkspace = path.join(realParent, 'nested-project');
    writeFile(path.join(realWorkspace, 'assets', 'broll', 'image.png'), 'image');
    fs.symlinkSync(realParent, aliasParent, 'dir');
    const input = bundleInput(fixture, [{ scene: 'broll', brollSrc: 'assets/broll/image.png' }]);
    input.workspace = { dir: path.join(aliasParent, 'nested-project') };

    assert.throws(() => prepareRenderMediaBundle(input), /symbolic link|symlink/i);
  });

  await t.test('repository chain', () => {
    const fixture = makeFixture(t);
    const realParent = path.join(fixture.directory, 'real-repository-parent');
    const aliasParent = path.join(fixture.directory, 'repository-alias');
    fs.mkdirSync(path.join(realParent, 'nested-repository', 'public'), { recursive: true });
    fs.symlinkSync(realParent, aliasParent, 'dir');
    const input = bundleInput(fixture, []);
    input.root = path.join(aliasParent, 'nested-repository');

    assert.throws(() => prepareRenderMediaBundle(input), /symbolic link|symlink/i);
  });
});

test('trusted roots allow only the exact stable macOS first-level aliases', async (t) => {
  await t.test('real root-owned /tmp alias', { skip: process.platform !== 'darwin' }, () => {
    assert.equal(fs.lstatSync('/tmp').isSymbolicLink(), true);
    assert.equal(fs.realpathSync('/tmp'), '/private/tmp');
    const fixture = makeFixture(t, '/tmp');
    const lease = prepareRenderMediaBundle(bundleInput(fixture, []));

    assert.equal(fs.existsSync(path.join(lease.directory, 'media-1.mp4')), true);
    lease.cleanup();
  });

  await t.test('writable non-root first-level alias', { skip: process.platform !== 'darwin' }, () => {
    const fixture = makeFixture(t, '/tmp');
    const untrustedFs = {
      ...trackedFs,
      lstatSync(target, options) {
        const stat = fs.lstatSync(target, options);
        if (path.resolve(target) !== '/tmp' || !stat.isSymbolicLink()) return stat;
        return new Proxy(stat, {
          get(value, property, receiver) {
            if (property === 'uid') return 501n;
            if (property === 'mode') return value.mode | 0o022n;
            return Reflect.get(value, property, receiver);
          },
        });
      },
    };

    assert.throws(() => prepareRenderMediaBundle({
      ...bundleInput(fixture, []),
      fileSystem: untrustedFs,
    }), /trusted|symbolic link|alias|owner|writable/i);
  });
});

test('inode dedup rejects incompatible media roles and never rewrites an image to the source extension', (t) => {
  const fixture = makeFixture(t);
  const imageReference = 'assets/broll/images/hardlink.webp';
  const imagePath = path.join(fixture.workspace.dir, ...imageReference.split('/'));
  fs.mkdirSync(path.dirname(imagePath), { recursive: true });
  fs.linkSync(fixture.sourcePath, imagePath);
  const input = bundleInput(fixture, [{
    scene: 'broll',
    brollMedia: {
      kind: 'image',
      src: imageReference,
      sha256: sha256(fs.readFileSync(fixture.sourcePath)),
      fit: 'cover',
    },
  }]);
  let invoked = false;

  assert.throws(() => withRenderMediaBundle(input, () => {
    invoked = true;
  }), /incompatible|role|extension/i);
  assert.equal(invoked, false);
});

test('primitive operation throws survive cleanup failure without being masked', async (t) => {
  const values = [0, false, null, undefined];
  for (let index = 0; index < values.length; index += 1) {
    await t.test(String(values[index]), () => {
      const fixture = makeFixture(t);
      const input = {
        ...bundleInput(fixture, []),
        temporaryId: `99999999-9999-4999-8999-99999999999${index}`,
      };
      let caught = Symbol('not thrown');
      try {
        withRenderMediaBundle(input, (lease) => {
          const moved = `${lease.directory}.owned`;
          fs.renameSync(lease.directory, moved);
          fs.mkdirSync(lease.directory);
          fs.writeFileSync(path.join(lease.directory, 'foreign.txt'), 'foreign');
          throw values[index];
        });
      } catch (error) {
        caught = error;
      }
      assert.equal(caught, values[index]);
    });
  }
});
