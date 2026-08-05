const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  preparePublicMedia,
  withPublicMediaLease,
} = require('../scripts/public-media');

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-public-media-'));
  fs.mkdirSync(path.join(root, 'public'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeSource(root, name, content) {
  const source = path.join(root, name);
  fs.writeFileSync(source, content);
  return source;
}

test('public media leases isolate simultaneous sources and clean up only themselves', (t) => {
  const root = makeRoot(t);
  const first = preparePublicMedia({
    root,
    sourcePath: writeSource(root, 'first.mp4', 'first bytes'),
    namespace: 'demo',
    temporaryId: '11111111-1111-4111-8111-111111111111',
  });
  const second = preparePublicMedia({
    root,
    sourcePath: writeSource(root, 'second.mov', 'second bytes'),
    namespace: 'demo',
    temporaryId: '22222222-2222-4222-8222-222222222222',
  });

  assert.notEqual(first.publicPath, second.publicPath);
  assert.equal(fs.readFileSync(first.absolutePath, 'utf8'), 'first bytes');
  assert.equal(fs.readFileSync(second.absolutePath, 'utf8'), 'second bytes');

  second.cleanup();
  assert.equal(fs.existsSync(second.absolutePath), false);
  assert.equal(fs.readFileSync(first.absolutePath, 'utf8'), 'first bytes');
  assert.doesNotThrow(() => second.cleanup());

  first.cleanup();
});

test('withPublicMediaLease cleans up after a render error without masking it', (t) => {
  const root = makeRoot(t);
  const source = writeSource(root, 'source.mp4', 'source bytes');
  let leasePath;

  assert.throws(() => withPublicMediaLease({
    root,
    sourcePath: source,
    namespace: 'lesson',
    temporaryId: '33333333-3333-4333-8333-333333333333',
  }, (lease) => {
    leasePath = lease.absolutePath;
    throw new Error('render failed');
  }), /render failed/);

  assert.equal(fs.existsSync(leasePath), false);
});

test('public media sanitizes an unsafe namespace before using it in a path', (t) => {
  const root = makeRoot(t);
  const lease = preparePublicMedia({
    root,
    sourcePath: writeSource(root, 'source.webm', 'source bytes'),
    namespace: '../unsafe namespace/..',
    temporaryId: '44444444-4444-4444-8444-444444444444',
  });

  assert.match(lease.publicPath, /^\.automontage\/[A-Za-z0-9_-]+-[0-9a-f-]+\/source\.webm$/);
  assert.equal(path.dirname(lease.absolutePath), path.join(root, 'public', '.automontage', path.basename(path.dirname(lease.absolutePath))));
  lease.cleanup();
});

test('lease cleanup refuses a symlinked target instead of following it', (t) => {
  const root = makeRoot(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-public-media-outside-'));
  const protectedFile = writeSource(outside, 'protected.txt', 'do not delete');
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const lease = preparePublicMedia({
    root,
    sourcePath: writeSource(root, 'source.mp4', 'source bytes'),
    namespace: 'dynamic',
    temporaryId: '55555555-5555-4555-8555-555555555555',
  });
  const leaseDirectory = path.dirname(lease.absolutePath);
  fs.rmSync(leaseDirectory, { recursive: true, force: true });
  fs.symlinkSync(outside, leaseDirectory, 'dir');

  assert.throws(() => lease.cleanup(), /небезопасный путь/);
  assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'do not delete');
});
