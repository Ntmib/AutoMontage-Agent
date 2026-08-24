const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { remotionRenderCommand } = require('../scripts/build-commands');
const {
  withPreviewMediaBundle,
  withRenderMediaBundle,
} = require('../scripts/render-media-bundle');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-render-win-'));
  const root = path.join(directory, 'repository');
  const workspace = { dir: path.join(directory, 'project') };
  const sourcePath = path.join(workspace.dir, 'source', 'speaker.mp4');
  const customReference = 'assets/faces/custom.mp4';
  const customPath = path.join(workspace.dir, ...customReference.split('/'));
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.mkdirSync(path.dirname(customPath), { recursive: true });
  fs.writeFileSync(sourcePath, 'main-video');
  fs.writeFileSync(customPath, 'custom-video');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { root, workspace, sourcePath, customReference };
}

function input(item, temporaryId) {
  const scenes = [{ scene: 'fullscreen', faceSrc: item.customReference }];
  return {
    root: item.root,
    workspace: item.workspace,
    props: {
      faceSrc: 'source.mp4',
      audioSrc: 'source.mp4',
      scenes,
    },
    approvedBrief: {
      status: 'approved',
      source: item.sourcePath,
      scenes,
    },
    sourcePath: item.sourcePath,
    sourceAlias: 'source.mp4',
    namespace: 'windows portable',
    temporaryId,
  };
}

test('portable lesson bundle snapshots custom video and supplies its isolated publicDir argv', (t) => {
  const item = fixture(t);
  let temporaryRoot;
  let publicDirectory;
  let bundleDirectory;

  const result = withRenderMediaBundle(
    input(item, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    (lease) => {
      publicDirectory = lease.publicDirectory;
      temporaryRoot = path.dirname(publicDirectory);
      bundleDirectory = lease.directory;
      assert.equal(path.isAbsolute(publicDirectory), true);
      assert.equal(publicDirectory.startsWith(`${item.root}${path.sep}`), false);
      assert.equal(lease.props.audioSrc, lease.props.faceSrc);
      assert.notEqual(lease.props.scenes[0].faceSrc, lease.props.faceSrc);
      assert.equal(
        fs.readFileSync(path.join(bundleDirectory, path.basename(lease.props.faceSrc)), 'utf8'),
        'main-video',
      );
      assert.equal(
        fs.readFileSync(path.join(
          bundleDirectory,
          path.basename(lease.props.scenes[0].faceSrc),
        ), 'utf8'),
        'custom-video',
      );

      const command = remotionRenderCommand(
        { command: process.execPath, argsPrefix: ['remotion-cli.js'] },
        {
          entry: 'src/index.js',
          composition: 'ReelScenes',
          output: path.join(item.workspace.dir, 'raw.mp4'),
          props: path.join(item.workspace.dir, 'props.json'),
          publicDir: publicDirectory,
        },
      );
      const publicDirIndex = command.args.indexOf('--public-dir');
      assert.ok(publicDirIndex > 0);
      assert.equal(command.args[publicDirIndex + 1], publicDirectory);
      return 'rendered';
    },
  );

  assert.equal(result, 'rendered');
  assert.equal(fs.existsSync(bundleDirectory), false);
  assert.equal(fs.existsSync(publicDirectory), false);
  assert.equal(fs.existsSync(temporaryRoot), false);
});

test('portable lesson bundle cleans its isolated publicDir after a render error', (t) => {
  const item = fixture(t);
  let temporaryRoot;
  let publicDirectory;
  let bundleDirectory;
  let invoked = false;

  assert.throws(() => withRenderMediaBundle(
    input(item, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
    (lease) => {
      invoked = true;
      publicDirectory = lease.publicDirectory;
      temporaryRoot = path.dirname(publicDirectory);
      bundleDirectory = lease.directory;
      throw new Error('portable render failure');
    },
  ), /portable render failure/);
  assert.equal(invoked, true);
  assert.equal(fs.existsSync(bundleDirectory), false);
  assert.equal(fs.existsSync(publicDirectory), false);
  assert.equal(fs.existsSync(temporaryRoot), false);
});

test('portable draft preview bundle uses the same isolated snapshot boundary', (t) => {
  const item = fixture(t);
  const draftInput = input(item, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  draftInput.previewBrief = { ...draftInput.approvedBrief, status: 'draft' };
  delete draftInput.approvedBrief;
  draftInput.props.draftPreview = true;
  let publicDirectory;

  const result = withPreviewMediaBundle(draftInput, (lease) => {
    publicDirectory = lease.publicDirectory;
    assert.equal(path.isAbsolute(publicDirectory), true);
    assert.equal(publicDirectory.startsWith(`${item.root}${path.sep}`), false);
    assert.equal(lease.props.draftPreview, true);
    assert.equal(
      fs.readFileSync(path.join(lease.directory, path.basename(lease.props.faceSrc)), 'utf8'),
      'main-video',
    );
    return 'previewed';
  });

  assert.equal(result, 'previewed');
  assert.equal(fs.existsSync(publicDirectory), false);
});
