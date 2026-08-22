#!/usr/bin/env node
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { chromium } = require('playwright');

const { formatBriefMarkdown } = require('./lesson/brief');
const {
  createOrOpenProject,
  nextRenderPaths,
  publishBriefRevision,
  readProjectManifest,
  resolveProjectPath,
  runRenderLifecycle,
} = require('./project/workspace');
const { startReviewServer } = require('./review/server');

const ROOT = path.resolve(__dirname, '..');
const RESULT_PREFIX = 'AUTOMONTAGE_ACCEPTANCE_RESULT=';
const OUTPUT_WIDTH = 320;
const OUTPUT_HEIGHT = 180;
const OUTPUT_FPS = 25;
const OUTPUT_DURATION_SEC = 5;
const SOURCE_TONE_HZ = 220;
const CLIP_TONE_HZ = 880;

function checked(command, args, {
  cwd = ROOT,
  env = process.env,
  encoding = 'utf8',
  maxBuffer = 64 * 1024 * 1024,
  timeout = 10 * 60 * 1000,
  stage = path.basename(command),
} = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding,
    env,
    maxBuffer,
    shell: false,
    timeout,
  });
  if (result.error || result.status !== 0 || result.signal) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8')
      : String(result.stderr || '');
    const stdout = Buffer.isBuffer(result.stdout)
      ? result.stdout.toString('utf8')
      : String(result.stdout || '');
    throw new Error(`${stage} failed: ${result.error?.message || result.signal || result.status}\n${stderr || stdout}`);
  }
  return result;
}

function executableInPath(name, searchPath = process.env.PATH || '') {
  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
    } catch (_) {
      // Try the next PATH entry.
    }
  }
  return null;
}

function encoderList(ffmpeg) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-encoders'], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
  });
  return result.status === 0 ? `${result.stdout || ''}${result.stderr || ''}` : '';
}

function toolchainCandidate(directory) {
  if (!directory) return null;
  const ffmpeg = path.join(directory, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const ffprobe = path.join(directory, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  if (!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe)) return null;
  const encoders = encoderList(ffmpeg);
  if (!/\blibwebp\b/.test(encoders)
    || !/\blibx264\b/.test(encoders)
    || !/\blibvpx\b/.test(encoders)
    || !/\blibopus\b/.test(encoders)
    || !/^\s*A\S*\s+aac\s/m.test(encoders)) return null;
  const version = checked(ffmpeg, ['-hide_banner', '-version'], {
    stage: 'ffmpeg version',
  }).stdout.split(/\r?\n/, 1)[0];
  return {
    directory: path.resolve(directory),
    ffmpeg: fs.realpathSync(ffmpeg),
    ffprobe: fs.realpathSync(ffprobe),
    version,
    libwebp: true,
  };
}

function selectMediaToolchain() {
  const directories = [];
  if (process.env.AUTOMONTAGE_FFMPEG_DIR) {
    directories.push(path.resolve(process.env.AUTOMONTAGE_FFMPEG_DIR));
  }
  const current = executableInPath(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (current) directories.push(path.dirname(current));
  const brew = spawnSync('brew', ['--prefix', 'ffmpeg-full'], {
    encoding: 'utf8', shell: false,
  });
  if (brew.status === 0 && brew.stdout.trim()) {
    directories.push(path.join(brew.stdout.trim(), 'bin'));
  }
  const unique = [...new Set(directories)];
  for (const directory of unique) {
    const candidate = toolchainCandidate(directory);
    if (candidate) return candidate;
  }
  throw new Error(
    'ffmpeg with libwebp, libx264, libvpx, libopus and AAC is required; '
    + 'set AUTOMONTAGE_FFMPEG_DIR to a compatible ffmpeg/ffprobe bin directory',
  );
}

function prependToolchain(toolchain) {
  process.env.PATH = [toolchain.directory, process.env.PATH || ''].filter(Boolean).join(path.delimiter);
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function hashBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function cloneLogValue(value, seen = new WeakSet()) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'bigint') return String(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      ...(typeof value.code === 'string' ? { code: value.code } : {}),
      message: value.message,
      ...(typeof value.stack === 'string' ? { stack: value.stack } : {}),
    };
  }
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => cloneLogValue(entry, seen));
  const cloned = {};
  try {
    for (const [key, entry] of Object.entries(value)) cloned[key] = cloneLogValue(entry, seen);
  } catch (_) {
    return String(value);
  }
  return cloned;
}

function makeFixtures(directory, ffmpeg) {
  fs.mkdirSync(directory, { recursive: true });
  const fixtures = {
    source: path.join(directory, 'source-speaker.mp4'),
    image: path.join(directory, 'accept-image.jpg'),
    silent: path.join(directory, 'accept-silent.mp4'),
    audio: path.join(directory, 'accept-audio.mp4'),
  };
  checked(ffmpeg, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}:rate=${OUTPUT_FPS}:duration=${OUTPUT_DURATION_SEC}`,
    '-f', 'lavfi', '-i', `sine=frequency=${SOURCE_TONE_HZ}:sample_rate=48000:duration=${OUTPUT_DURATION_SEC}`,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-shortest',
    fixtures.source,
  ], { stage: 'generate source fixture' });
  checked(ffmpeg, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=1',
    '-vf', 'drawbox=x=35:y=30:w=570:h=300:color=yellow@0.9:t=8',
    '-frames:v', '1', '-q:v', '2', fixtures.image,
  ], { stage: 'generate JPEG fixture' });
  checked(ffmpeg, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=90x160:rate=25:duration=3',
    '-vf', 'drawgrid=w=18:h=16:t=2:c=white@0.8',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an',
    fixtures.silent,
  ], { stage: 'generate silent video fixture' });
  checked(ffmpeg, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'smptebars=size=320x180:rate=25',
    '-f', 'lavfi', '-i', `sine=frequency=${CLIP_TONE_HZ}:sample_rate=48000:duration=4`,
    '-t', '4', '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-shortest',
    fixtures.audio,
  ], { stage: 'generate audio video fixture' });
  return fixtures;
}

function baseBrief(workspace) {
  const legacy = ['assets', 'broll', 'legacy.jpg'].join('/');
  const broll = (start, end, number) => ({
    scene: 'broll',
    start,
    end,
    brollSrc: legacy,
    headCream: `СЦЕНА ${number}`,
    headOrange: 'B-ROLL',
  });
  return {
    version: 1,
    status: 'draft',
    source: workspace.sourcePath,
    theme: 'lesson-neutral',
    title: 'VIDEO B-ROLL ACCEPTANCE',
    output: {
      aspect: 'horizontal',
      width: OUTPUT_WIDTH,
      height: OUTPUT_HEIGHT,
      fps: OUTPUT_FPS,
      durationInFrames: OUTPUT_FPS * OUTPUT_DURATION_SEC,
    },
    corrections: [],
    scenes: [
      broll(0, 1, 1),
      broll(1, 2, 2),
      broll(2, 3, 3),
      broll(3, 4, 4),
      { scene: 'fullscreen', start: 4, end: 5, caption: 'ИСТОЧНИК ВЕРНУЛСЯ' },
    ],
  };
}

function createAcceptanceProject(artifactRoot, fixtures) {
  const projectDir = path.join(artifactRoot, 'project');
  const workspace = createOrOpenProject({
    projectDir,
    name: 'Video b-roll acceptance',
    sourcePath: fixtures.source,
    now: new Date('2026-08-21T12:00:00.000Z'),
  });
  fs.copyFileSync(fixtures.image, path.join(projectDir, 'assets', 'broll', 'legacy.jpg'));
  writeJson(path.join(projectDir, 'transcript', 'words.json'), [{
    start: 0,
    end: OUTPUT_DURATION_SEC,
    text: 'Проверяем изображение тихое видео смешанный звук замену и возврат голоса',
    words: [
      { w: 'Проверяем', s: 0, e: 0.5 },
      { w: 'изображение', s: 0.5, e: 1 },
      { w: 'тихое', s: 1, e: 1.5 },
      { w: 'видео', s: 1.5, e: 2 },
      { w: 'смешанный', s: 2, e: 2.5 },
      { w: 'звук', s: 2.5, e: 3 },
      { w: 'замену', s: 3, e: 4 },
      { w: 'возврат', s: 4, e: 4.5 },
      { w: 'голоса', s: 4.5, e: 5 },
    ],
  }]);
  const brief = baseBrief(workspace);
  const draft = publishBriefRevision(workspace, {
    kind: 'lesson',
    brief,
    markdown: formatBriefMarkdown(brief),
    status: 'draft',
    theme: brief.theme,
    aspect: brief.output.aspect,
  });
  return { workspace, draft };
}

function runNodeCli(args, stage) {
  return checked(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, THEMES_EXT: '' },
    stage,
  });
}

function approveDraft(projectDir, draftRelativePath) {
  runNodeCli([
    path.join(ROOT, 'scripts', 'project', 'approve-brief.js'),
    projectDir,
    draftRelativePath,
  ], 'approve brief CLI');
  return draftRelativePath.replace('-draft.lesson.json', '-approved.lesson.json');
}

function createPriorRender(projectDir) {
  const workspace = createOrOpenProject({ projectDir });
  const render = nextRenderPaths(workspace, 'prior');
  const final = runRenderLifecycle(workspace, {
    version: render.version,
    label: render.label,
    dir: render.dir,
    briefPath: resolveProjectPath(projectDir, workspace.manifest.currentBrief, {
      label: 'prior approved brief', mustExist: true, type: 'file',
    }),
  }, () => {
    fs.copyFileSync(workspace.sourcePath, render.finalPath, fs.constants.COPYFILE_EXCL);
    return render.finalPath;
  });
  return { render, final };
}

async function closeServer(server) {
  if (!server || !server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  )));
}

async function poll(action, predicate, label, timeoutMs = 30_000) {
  const started = Date.now();
  let value;
  while (Date.now() - started < timeoutMs) {
    value = await action();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} timed out (last value: ${String(value)})`);
}

async function importFromBrowser(page, filePath) {
  const responsePromise = page.waitForResponse((response) => (
    response.url().endsWith('/api/assets/import')
    && response.request().method() === 'POST'
  ));
  await page.locator('[data-media-input]').setInputFiles(filePath);
  const response = await responsePromise;
  assert.equal(response.status(), 201);
  await poll(
    () => page.locator('[data-media-import-status]').getAttribute('data-phase'),
    (phase) => phase === 'success',
    `browser import ${path.basename(filePath)}`,
    180_000,
  );
  await page.locator('[data-asset-label]', { hasText: path.basename(filePath) }).waitFor();
}

async function waitForPlayable(video) {
  await video.waitFor({ state: 'visible' });
  await poll(
    () => video.evaluate((element) => element.readyState),
    (readyState) => readyState > 0,
    'authenticated browser video preview',
    30_000,
  );
}

async function validatedCommand(page, operation, evidence) {
  const responsePromise = page.waitForResponse((response) => (
    response.url().endsWith('/api/validate')
    && response.request().method() === 'POST'
  ));
  await operation();
  const response = await responsePromise;
  const body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body));
  evidence.push({ request: response.request().postDataJSON(), response: body });
  return body;
}

async function configureVideoScene(page, {
  sceneIndex,
  label,
  currentTime,
  fit,
  audioMode,
}, validations) {
  let controls = page.locator(`[data-broll-scene="${sceneIndex}"]`);
  await validatedCommand(page, () => (
    controls.locator('[data-broll-select]').selectOption({ label })
  ), validations);
  controls = page.locator(`[data-broll-scene="${sceneIndex}"]`);
  const player = controls.locator('video[data-broll-video]');
  await waitForPlayable(player);
  await player.evaluate((video, seconds) => { video.currentTime = seconds; }, currentTime);
  await validatedCommand(page, () => (
    controls.getByRole('button', { name: /начать с текущего места/i }).click()
  ), validations);
  if (await controls.locator('[data-broll-fit]').inputValue() !== fit) {
    await validatedCommand(page, () => (
      controls.locator('[data-broll-fit]').selectOption(fit)
    ), validations);
  }
  if (await controls.locator('[data-broll-audio]').inputValue() !== audioMode) {
    await validatedCommand(page, () => (
      controls.locator('[data-broll-audio]').selectOption(audioMode)
    ), validations);
  }
}

async function authenticatedBytes(session, pathname, { range = false } = {}) {
  const headers = { Authorization: `Bearer ${session.token}` };
  if (range) headers.Range = 'bytes=0-63';
  const response = await fetch(`${session.origin}${pathname}`, { headers });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { response, bytes };
}

async function authenticatedState(session) {
  const response = await fetch(`${session.origin}/api/state`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function exerciseSanitizedFailureLog({ session, projectDir, serverLogs }) {
  const manifestPath = path.join(projectDir, 'project.json');
  const original = fs.readFileSync(manifestPath);
  let response;
  try {
    fs.writeFileSync(manifestPath, '{');
    response = await fetch(`${session.origin}/api/state`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    assert.equal(response.status, 500);
  } finally {
    fs.writeFileSync(manifestPath, original);
  }
  assert.ok(fs.readFileSync(manifestPath).equals(original));
  const body = await response.text();
  await poll(
    () => serverLogs.length,
    (length) => length > 0,
    'sanitized Review failure log',
  );
  assert.equal(body, 'Request rejected');
  return { status: 500, body };
}

function browserSafeAsset(asset) {
  assert.deepEqual(Object.keys(asset).sort(), [
    'audioDurationSec', 'capabilities', 'durationSec', 'fps', 'hasAudio', 'height', 'id', 'kind', 'label',
    'mediaKind', 'previewUrl', 'url', 'width',
  ].filter((key) => key !== 'previewUrl' || asset.mediaKind === 'video').sort());
  const serialized = JSON.stringify(asset);
  assert.doesNotMatch(serialized, /assets\/broll\/(?:images|video)|[a-f0-9]{64}|\/Users\//);
  return {
    id: asset.id,
    label: asset.label,
    mediaKind: asset.mediaKind,
    hasAudio: asset.hasAudio,
    url: asset.url,
    previewUrl: asset.previewUrl || null,
  };
}

async function exerciseReview({ projectDir, fixtures, screenshotPath, browserEvidencePath }) {
  const serverLogs = [];
  const session = await startReviewServer({
    root: ROOT,
    projectDir,
    editable: true,
    open: false,
    logger: { error: (...values) => serverLogs.push(values.map((value) => cloneLogValue(value))) },
    runToolImpl: (command, args) => checked(command, args, { stage: 'review waveform' }),
  });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.setDefaultTimeout(180_000);
  const consoleMessages = [];
  const pageErrors = [];
  const validations = [];
  try {
    page.on('console', (message) => consoleMessages.push(message.text()));
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(session.url, { waitUntil: 'networkidle' });
    await page.locator('[data-review-ready]').waitFor({ state: 'visible' });
    await poll(
      () => page.locator('[data-edit-status]').textContent(),
      (text) => /изменени[йя] нет/i.test(text || ''),
      'editable Review readiness',
    );

    const selectionsBefore = await page.locator('[data-broll-select]')
      .evaluateAll((elements) => elements.map((element) => element.value));
    assert.equal(selectionsBefore.length, 4);
    const uploadBodies = [];
    for (const file of [fixtures.image, fixtures.silent, fixtures.audio]) {
      await importFromBrowser(page, file);
      const state = await authenticatedState(session);
      const asset = state.assets.find((candidate) => candidate.label === path.basename(file));
      assert.ok(asset, `imported descriptor missing for ${path.basename(file)}`);
      uploadBodies.push({ ok: true, asset });
    }
    assert.deepEqual(
      await page.locator('[data-broll-select]')
        .evaluateAll((elements) => elements.map((element) => element.value)),
      selectionsBefore,
    );
    assert.match(await page.locator('[data-edit-status]').textContent(), /изменени[йя] нет/i);

    const uploads = uploadBodies.map(({ asset }) => browserSafeAsset(asset));
    const imageMedia = await authenticatedBytes(session, uploads[0].url);
    assert.equal(imageMedia.response.status, 200);
    assert.match(imageMedia.response.headers.get('content-type') || '', /^image\/webp/);
    assert.ok(imageMedia.bytes.length > 0);
    assert.equal((await fetch(`${session.origin}${uploads[0].url}`)).status, 401);

    for (const upload of uploads.slice(1)) {
      const proxy = await authenticatedBytes(session, upload.previewUrl, { range: true });
      assert.equal(proxy.response.status, 206);
      assert.match(proxy.response.headers.get('content-type') || '', /^video\/webm/);
      assert.equal(proxy.bytes.length, 64);
      assert.equal((await fetch(`${session.origin}${upload.previewUrl}`)).status, 401);
      const item = page.locator('[data-asset-label]', { hasText: upload.label })
        .locator('xpath=ancestor::li[1]');
      await waitForPlayable(item.locator('video[data-asset-video]'));
    }

    await validatedCommand(page, () => (
      page.locator('[data-broll-scene="0"] [data-broll-select]')
        .selectOption({ label: path.basename(fixtures.image) })
    ), validations);
    await configureVideoScene(page, {
      sceneIndex: 1,
      label: path.basename(fixtures.silent),
      currentTime: 0.419,
      fit: 'contain',
      audioMode: 'mute',
    }, validations);
    await configureVideoScene(page, {
      sceneIndex: 2,
      label: path.basename(fixtures.audio),
      currentTime: 0.819,
      fit: 'cover',
      audioMode: 'mix',
    }, validations);
    await configureVideoScene(page, {
      sceneIndex: 3,
      label: path.basename(fixtures.audio),
      currentTime: 1.219,
      fit: 'contain',
      audioMode: 'replace',
    }, validations);

    const visibleText = await page.locator('body').innerText();
    for (const label of [
      'Добавить медиа', 'Начать с текущего места', 'Вписать целиком',
      'Заполнить кадр', 'Без звука', 'Тихо поверх голоса', 'Вместо голоса', 'Сохранить',
    ]) assert.match(visibleText, new RegExp(label, 'i'));
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const saveResponsePromise = page.waitForResponse((response) => (
      response.url().endsWith('/api/save') && response.request().method() === 'POST'
    ));
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: /^сохранить$/i }).click();
    const saveResponse = await saveResponsePromise;
    const saveBody = await saveResponse.json();
    assert.equal(saveResponse.status(), 201, JSON.stringify(saveBody));
    const state = await authenticatedState(session);
    const controlledFailure = await exerciseSanitizedFailureLog({
      session, projectDir, serverLogs,
    });

    const evidence = {
      uploadResponses: uploadBodies,
      validations,
      save: saveBody,
      state,
      consoleMessages,
      pageErrors,
      serverLogs,
      controlledFailure,
      labelsVerified: true,
      uploadDidNotAutoSelect: true,
      authenticatedPreviews: true,
    };
    writeJson(browserEvidencePath, evidence);
    return { uploads, saveBody, evidence };
  } finally {
    await page.close();
    await browser.close();
    await closeServer(session.server);
    if (session.handoffPath) assert.equal(fs.existsSync(session.handoffPath), false);
  }
}

function sanitizeScenes(draft) {
  return draft.scenes.slice(0, 4).map((scene) => ({
    mediaKind: scene.brollMedia.kind,
    fit: scene.brollMedia.fit,
    ...(scene.brollMedia.kind === 'video' ? {
      trimStartSec: scene.brollMedia.trimStartSec,
      audioMode: scene.brollMedia.audioMode,
    } : {}),
  }));
}

function evidenceLeaves(value, keys = [], leaves = []) {
  if (value === null || value === undefined) return leaves;
  if (typeof value !== 'object') {
    leaves.push({ keys, value: String(value) });
    return leaves;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => evidenceLeaves(entry, [...keys, String(index)], leaves));
    return leaves;
  }
  for (const [key, entry] of Object.entries(value)) {
    evidenceLeaves(entry, [...keys, key], leaves);
  }
  return leaves;
}

function stringContainsHostPath(value, keys) {
  const key = keys.at(-1);
  const allowedMediaUrl = (key === 'url' || key === 'previewUrl')
    && /^\/media(?:\/|$)/.test(value);
  const embeddedWindowsRoot = /(?:^|[\s"'([{=:])\\(?!\\)[^\s"'`),;}\]]/.test(value);
  if ((path.win32.isAbsolute(value) && !allowedMediaUrl)
    || /[A-Za-z]:[\\/]/.test(value)
    || /\\\\[^\\]/.test(value)
    || embeddedWindowsRoot) return true;
  const candidates = [];
  if (path.posix.isAbsolute(value)) candidates.push(value);
  const token = /(?:^|[\s"'`([{=:])(\/(?!\/)[^\s"'`),;}\]]+)/g;
  for (const match of value.matchAll(token)) candidates.push(match[1]);
  return candidates.some((candidate) => !(
    (key === 'url' || key === 'previewUrl') && /^\/media(?:\/|$)/.test(candidate)
  ));
}

function assertBrowserPrivacy({ evidence, requireFailureLog = false }) {
  const leaves = evidenceLeaves(evidence);
  const absolutePathLeak = leaves.some(({ keys, value }) => stringContainsHostPath(value, keys));
  const mediaHashLeak = leaves.some(({ keys, value }) => {
    const hashes = value.match(/[a-f0-9]{64}/gi) || [];
    if (hashes.length === 0 && !/assets\/broll\/(?:images|video)\//.test(value)) return false;
    const key = keys.at(-1);
    const parent = keys.at(-2);
    const allowedCasHash = keys[0] !== 'serverLogs'
      && (parent === 'session' || parent === 'request')
      && (key === 'baseHash' || key === 'manifestHash');
    return !(hashes.length === 1 && hashes[0] === value
      && allowedCasHash);
  });
  const loggedFailureExercised = Array.isArray(evidence.serverLogs)
    && evidence.serverLogs.length > 0
    && evidence.controlledFailure?.status === 500
    && evidence.controlledFailure?.body === 'Request rejected';
  assert.equal(absolutePathLeak, false);
  assert.equal(mediaHashLeak, false);
  if (requireFailureLog) assert.equal(loggedFailureExercised, true);
  return { absolutePathLeak, mediaHashLeak, loggedFailureExercised };
}

function renderApproved(projectDir, approvedRelativePath) {
  const workspace = createOrOpenProject({ projectDir });
  runNodeCli([
    path.join(ROOT, 'scripts', 'build.js'),
    workspace.sourcePath,
    '--template', 'lesson',
    '--project-dir', projectDir,
    '--brief', approvedRelativePath,
    '--version-label', 'video-broll-acceptance',
  ], 'canonical lesson render');
  const manifest = readProjectManifest(projectDir);
  const final = resolveProjectPath(projectDir, manifest.final, {
    label: 'acceptance final', mustExist: true, type: 'file',
  });
  return { manifest, final };
}

function rational(value) {
  const [numerator, denominator = '1'] = String(value).split('/');
  const result = Number(numerator) / Number(denominator);
  if (!Number.isFinite(result) || result <= 0) throw new Error(`invalid rational: ${value}`);
  return result;
}

function probeFinal(file, ffprobe) {
  const output = checked(ffprobe, [
    '-v', 'error', '-count_frames',
    '-show_entries',
    'stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,nb_read_frames,duration,sample_rate,channels:format=duration',
    '-of', 'json', file,
  ], { stage: 'final ffprobe' }).stdout;
  const data = JSON.parse(output);
  const video = data.streams.find((stream) => stream.codec_type === 'video');
  const audio = data.streams.find((stream) => stream.codec_type === 'audio');
  assert.ok(video && audio, 'final must contain video and audio');
  const fps = rational(video.avg_frame_rate === '0/0' ? video.r_frame_rate : video.avg_frame_rate);
  const durationSec = Number(data.format.duration);
  const frames = Number(video.nb_read_frames || Math.round(durationSec * fps));
  return {
    width: Number(video.width),
    height: Number(video.height),
    fps,
    durationSec,
    frames,
    videoCodec: video.codec_name,
    audioCodec: audio.codec_name,
    audioSampleRate: Number(audio.sample_rate),
    audioChannels: Number(audio.channels),
  };
}

function fullyDecode(file, ffmpeg) {
  checked(ffmpeg, [
    '-v', 'error', '-i', file,
    '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-',
  ], { stage: 'full final decode' });
}

function toneMagnitude(file, centerSec, frequency, ffmpeg) {
  const duration = 0.4;
  const sampleRate = 48_000;
  const result = checked(ffmpeg, [
    '-v', 'error', '-ss', String(centerSec - (duration / 2)), '-t', String(duration),
    '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(sampleRate),
    '-f', 'f32le', 'pipe:1',
  ], { encoding: null, maxBuffer: 4 * 1024 * 1024, stage: `audio ${frequency}Hz @ ${centerSec}s` });
  const samples = result.stdout;
  const count = Math.floor(samples.length / 4);
  assert.ok(count > sampleRate * 0.35, 'audio measurement window is incomplete');
  let real = 0;
  let imaginary = 0;
  let weightSum = 0;
  for (let index = 0; index < count; index += 1) {
    const sample = samples.readFloatLE(index * 4);
    const weight = 0.5 - (0.5 * Math.cos((2 * Math.PI * index) / (count - 1)));
    const angle = (2 * Math.PI * frequency * index) / sampleRate;
    real += sample * weight * Math.cos(angle);
    imaginary -= sample * weight * Math.sin(angle);
    weightSum += weight;
  }
  return (2 * Math.hypot(real, imaginary)) / weightSum;
}

function measureAudio(file, ffmpeg) {
  const window = (time) => ({
    source: toneMagnitude(file, time, SOURCE_TONE_HZ, ffmpeg),
    clip: toneMagnitude(file, time, CLIP_TONE_HZ, ffmpeg),
  });
  const result = {
    before: window(2.5),
    inside: window(3.5),
    after: window(4.5),
  };
  assert.ok(result.before.source > result.inside.source * 8);
  assert.ok(result.after.source > result.inside.source * 8);
  assert.ok(result.inside.clip > result.before.clip * 3);
  assert.ok(result.inside.clip > result.after.clip * 12);
  return result;
}

function frameStatistics(file, frame, ffmpeg) {
  const result = checked(ffmpeg, [
    '-v', 'error', '-ss', String(frame / OUTPUT_FPS), '-i', file,
    '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1',
  ], { encoding: null, maxBuffer: OUTPUT_WIDTH * OUTPUT_HEIGHT * 4, stage: `sample frame ${frame}` });
  const bytes = result.stdout;
  assert.equal(bytes.length, OUTPUT_WIDTH * OUTPUT_HEIGHT * 3);
  let sum = 0;
  let sumSquares = 0;
  for (const value of bytes) {
    sum += value;
    sumSquares += value * value;
  }
  const mean = sum / bytes.length;
  return { mean, variance: (sumSquares / bytes.length) - (mean * mean) };
}

function createContactSheet(file, destination, framesDirectory, ffmpeg) {
  fs.mkdirSync(framesDirectory, { recursive: true });
  const frames = [12, 25, 37, 50, 62, 75, 87, 100, 112];
  for (const frame of frames) {
    checked(ffmpeg, [
      '-y', '-v', 'error', '-ss', String(frame / OUTPUT_FPS), '-i', file,
      '-frames:v', '1', '-update', '1', path.join(framesDirectory, `frame-${String(frame).padStart(3, '0')}.png`),
    ], { stage: `write control frame ${frame}` });
  }
  const inputs = frames.map((frame) => path.join(framesDirectory, `frame-${String(frame).padStart(3, '0')}.png`));
  const args = ['-y', '-v', 'error'];
  for (const input of inputs) args.push('-i', input);
  const layout = [
    '0_0', '320_0', '640_0', '960_0', '1280_0',
    '0_180', '320_180', '640_180', '960_180',
  ].join('|');
  args.push(
    '-filter_complex', `${inputs.map((_, index) => `[${index}:v]`).join('')}xstack=inputs=9:layout=${layout}:fill=white[out]`,
    '-map', '[out]', '-frames:v', '1', '-update', '1', destination,
  );
  checked(ffmpeg, args, { stage: 'contact sheet' });
  const boundaries = [25, 50, 75, 100].map((frame) => ({ frame, ...frameStatistics(file, frame, ffmpeg) }));
  for (const sample of boundaries) {
    assert.ok(sample.mean > 10 && sample.variance > 100, `blank transition frame ${sample.frame}`);
  }
  return { frames, boundaries };
}

async function runAcceptance() {
  const toolchain = selectMediaToolchain();
  prependToolchain(toolchain);
  const id = `${Date.now()}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  const artifactRoot = path.join(ROOT, 'tmp', 'video-broll-acceptance', id);
  const fixturesDirectory = path.join(artifactRoot, 'fixtures');
  const evidenceDirectory = path.join(artifactRoot, 'evidence');
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const fixtures = makeFixtures(fixturesDirectory, toolchain.ffmpeg);
  const setup = createAcceptanceProject(artifactRoot, fixtures);
  const projectDir = setup.workspace.dir;
  const baseDraftRelative = path.relative(projectDir, setup.draft.jsonPath).split(path.sep).join('/');
  const priorApprovedRelative = approveDraft(projectDir, baseDraftRelative);
  const priorApprovedPath = resolveProjectPath(projectDir, priorApprovedRelative, {
    label: 'prior approved brief', mustExist: true, type: 'file',
  });
  const priorRender = createPriorRender(projectDir);
  const baselineManifest = readProjectManifest(projectDir);
  const priorApprovedBytes = fs.readFileSync(priorApprovedPath);
  const priorRenderBytes = fs.readFileSync(priorRender.render.finalPath);
  const priorBriefEntries = JSON.parse(JSON.stringify(baselineManifest.briefs));
  const priorRenderEntries = JSON.parse(JSON.stringify(baselineManifest.renders));

  const browserScreenshot = path.join(evidenceDirectory, 'review-configured.png');
  const browserEvidence = path.join(evidenceDirectory, 'browser-evidence.json');
  const reviewed = await exerciseReview({
    projectDir,
    fixtures,
    screenshotPath: browserScreenshot,
    browserEvidencePath: browserEvidence,
  });
  const draftPath = resolveProjectPath(projectDir, reviewed.saveBody.path, {
    label: 'saved Review draft', mustExist: true, type: 'file',
  });
  const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
  const scenes = sanitizeScenes(draft);
  const expectedScenes = [
    { mediaKind: 'image', fit: 'cover' },
    { mediaKind: 'video', fit: 'contain', trimStartSec: 0.4, audioMode: 'mute' },
    { mediaKind: 'video', fit: 'cover', trimStartSec: 0.8, audioMode: 'mix' },
    { mediaKind: 'video', fit: 'contain', trimStartSec: 1.2, audioMode: 'replace' },
  ];
  assert.deepEqual(scenes, expectedScenes);
  const privacy = assertBrowserPrivacy({
    evidence: reviewed.evidence,
    requireFailureLog: true,
  });

  const manifestAfterSave = readProjectManifest(projectDir);
  const newDrafts = manifestAfterSave.briefs.filter((entry) => (
    entry.status === 'draft'
    && !priorBriefEntries.some((prior) => prior.jsonPath === entry.jsonPath)
  ));
  assert.equal(newDrafts.length, 1);
  const approvedRelative = approveDraft(projectDir, reviewed.saveBody.path);
  const rendered = renderApproved(projectDir, approvedRelative);

  assert.ok(fs.readFileSync(priorApprovedPath).equals(priorApprovedBytes));
  assert.ok(fs.readFileSync(priorRender.render.finalPath).equals(priorRenderBytes));
  assert.deepEqual(rendered.manifest.briefs.slice(0, priorBriefEntries.length), priorBriefEntries);
  assert.deepEqual(rendered.manifest.renders.slice(0, priorRenderEntries.length), priorRenderEntries);
  assert.equal(rendered.manifest.renders.length, priorRenderEntries.length + 1);
  const latest = rendered.manifest.renders.find((entry) => entry.dir === rendered.manifest.latestRender);
  assert.ok(latest && latest.status === 'complete');
  assert.notEqual(rendered.manifest.latestRender, baselineManifest.latestRender);

  fullyDecode(rendered.final, toolchain.ffmpeg);
  const probe = probeFinal(rendered.final, toolchain.ffprobe);
  assert.equal(probe.width, OUTPUT_WIDTH);
  assert.equal(probe.height, OUTPUT_HEIGHT);
  assert.equal(probe.fps, OUTPUT_FPS);
  assert.ok(probe.durationSec >= 4.9 && probe.durationSec <= 5.1);
  assert.equal(probe.videoCodec, 'h264');
  assert.equal(probe.audioCodec, 'aac');
  assert.ok(probe.audioSampleRate >= 44_100);
  const audio = measureAudio(rendered.final, toolchain.ffmpeg);
  const contactSheet = path.join(evidenceDirectory, 'contact-sheet.png');
  const visual = createContactSheet(
    rendered.final,
    contactSheet,
    path.join(evidenceDirectory, 'frames'),
    toolchain.ffmpeg,
  );

  const resultJson = path.join(evidenceDirectory, 'result.json');
  const result = {
    ok: true,
    ffmpeg: toolchain,
    uploads: reviewed.uploads.map(({ id, label, mediaKind, hasAudio }) => ({
      id, label, mediaKind, hasAudio,
    })),
    scenes,
    probe,
    audio,
    visual,
    immutable: {
      priorApprovedBytes: true,
      priorRenderBytes: true,
      priorBriefEntries: true,
      priorRenderEntry: true,
      oneNewDraft: true,
      oneNewRender: true,
      latestRenderAdvanced: true,
    },
    privacy,
    manifest: {
      beforeRenderCount: priorRenderEntries.length,
      afterRenderCount: rendered.manifest.renders.length,
      latestRender: rendered.manifest.latestRender,
    },
    artifacts: {
      root: artifactRoot,
      projectDir,
      final: rendered.final,
      contactSheet,
      browserScreenshot,
      browserEvidence,
      resultJson,
    },
  };
  writeJson(resultJson, result);
  return result;
}

async function main() {
  const result = await runAcceptance();
  console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`video b-roll acceptance failed: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { assertBrowserPrivacy, runAcceptance };
