const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { assertBrowserPrivacy } = require('../scripts/accept-video-broll');

const ROOT = path.resolve(__dirname, '..');
const RESULT_PREFIX = 'AUTOMONTAGE_ACCEPTANCE_RESULT=';

function runAcceptance() {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'accept-video-broll.js')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env },
    maxBuffer: 32 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  });
}

function parseResult(stdout) {
  const line = String(stdout).split(/\r?\n/).find((entry) => entry.startsWith(RESULT_PREFIX));
  assert.ok(line, 'acceptance runner must print its machine-readable result');
  return JSON.parse(line.slice(RESULT_PREFIX.length));
}

// `npm test` remains the lightweight CI matrix. The exact dedicated command below
// deliberately runs the real Chromium/ffmpeg/Remotion acceptance without a skip.
const acceptanceTest = process.env.npm_lifecycle_event === 'test' ? test.skip : test;

const privacyTest = process.env.npm_lifecycle_event === 'test' ? test : () => {};

privacyTest('acceptance privacy rejects arbitrary host paths and unexpected hashes', () => {
  const casState = {
    session: {
      baseHash: 'a'.repeat(64),
      manifestHash: 'b'.repeat(64),
    },
    source: { url: '/media/source' },
  };
  for (const leakedPath of [
    '/private/work/source.mov', '/opt/media/source.mov', '/var/tmp/source.mov',
    '\\Windows\\System32\\source.mov',
  ]) {
    assert.throws(() => assertBrowserPrivacy({
      evidence: {
        state: casState,
        serverLogs: [['Review request failed', { message: leakedPath }]],
      },
    }));
  }
  assert.throws(() => assertBrowserPrivacy({
    evidence: {
      state: casState,
      response: { canonicalSha256: 'c'.repeat(64) },
    },
  }));
  assert.deepEqual(assertBrowserPrivacy({
    evidence: { state: casState, response: { url: '/media/assets/asset-1' } },
  }), {
    absolutePathLeak: false,
    mediaHashLeak: false,
    loggedFailureExercised: false,
  });
});

acceptanceTest('real browser upload reaches one immutable approved lesson render', {
  timeout: 11 * 60 * 1000,
}, () => {
  const run = runAcceptance();
  assert.equal(run.signal, null, run.stderr || run.stdout);
  assert.equal(run.status, 0, run.stderr || run.stdout);

  const result = parseResult(run.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.ffmpeg.libwebp, true);
  assert.equal(result.uploads.length, 3);
  assert.deepEqual(result.uploads.map(({ mediaKind, hasAudio }) => ({ mediaKind, hasAudio })), [
    { mediaKind: 'image', hasAudio: false },
    { mediaKind: 'video', hasAudio: false },
    { mediaKind: 'video', hasAudio: true },
  ]);
  assert.deepEqual(result.scenes, [
    { mediaKind: 'image', fit: 'cover' },
    { mediaKind: 'video', fit: 'contain', trimStartSec: 0.4, audioMode: 'mute' },
    { mediaKind: 'video', fit: 'cover', trimStartSec: 0.8, audioMode: 'mix' },
    { mediaKind: 'video', fit: 'contain', trimStartSec: 1.2, audioMode: 'replace' },
  ]);

  assert.equal(result.probe.width, 320);
  assert.equal(result.probe.height, 180);
  assert.equal(result.probe.fps, 25);
  assert.ok(result.probe.durationSec >= 4.9 && result.probe.durationSec <= 5.1);
  assert.ok(result.probe.frames >= 124 && result.probe.frames <= 126);
  assert.equal(result.probe.videoCodec, 'h264');
  assert.equal(result.probe.audioCodec, 'aac');

  assert.ok(result.audio.before.source > result.audio.inside.source * 8);
  assert.ok(result.audio.after.source > result.audio.inside.source * 8);
  assert.ok(result.audio.inside.clip > result.audio.before.clip * 3);
  assert.ok(result.audio.inside.clip > result.audio.after.clip * 12);

  assert.deepEqual(result.immutable, {
    priorApprovedBytes: true,
    priorRenderBytes: true,
    priorBriefEntries: true,
    priorRenderEntry: true,
    oneNewDraft: true,
    oneNewRender: true,
    latestRenderAdvanced: true,
  });
  assert.deepEqual(result.privacy, {
    absolutePathLeak: false,
    mediaHashLeak: false,
    loggedFailureExercised: true,
  });

  const evidenceRoot = path.resolve(result.artifacts.root);
  assert.equal(evidenceRoot.startsWith(`${path.join(ROOT, 'tmp')}${path.sep}`), true);
  for (const name of ['final', 'contactSheet', 'browserScreenshot', 'resultJson']) {
    assert.equal(fs.statSync(result.artifacts[name]).isFile(), true, `${name} evidence is missing`);
  }
});
