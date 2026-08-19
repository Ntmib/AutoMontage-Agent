const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { test, expect } = require('playwright/test');

const ROOT = path.resolve(__dirname, '..');
const { startReviewServer } = require('../scripts/review/server');
const { makeReviewProject } = require('./helpers/review-project');

let reviewSession;
let reviewUrl;
let cleanups = [];

async function closeServer(server) {
  if (!server || !server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  )));
}

async function openReview(page) {
  await page.goto(reviewUrl);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('[data-review-ready]')).toBeVisible();
}

async function expectNoPageOverflow(page) {
  await expect.poll(() => page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))).toEqual(await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.clientWidth,
  })));
}

test.beforeAll(async () => {
  const fixture = makeReviewProject({ after: (cleanup) => cleanups.push(cleanup) });
  const sourcePath = path.join(fixture.workspace.dir, 'input', 'source.webm');
  const ffmpeg = spawnSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=#15171a:s=640x360:r=25:d=4',
    '-c:v', 'libvpx', '-b:v', '120k', '-an', sourcePath,
  ], { encoding: 'utf8' });
  if (ffmpeg.status !== 0) throw new Error('Unable to create the browser video fixture');
  const manifestPath = path.join(fixture.workspace.dir, 'project.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.source.localPath = 'input/source.webm';
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.copyFileSync(
    path.join(ROOT, 'docs', 'previews', 'lesson-presentation.png'),
    path.join(fixture.workspace.dir, 'assets', 'broll', 'diagram.png'),
  );
  reviewSession = await startReviewServer({
    root: ROOT,
    projectDir: fixture.projectDir,
    open: false,
  });
  reviewUrl = reviewSession.url;
});

test.afterAll(async () => {
  await closeServer(reviewSession && reviewSession.server);
  cleanups.reverse().forEach((cleanup) => cleanup());
  cleanups = [];
});

test('read-only review shows semantic source, lanes and diagnostics without edit controls', async ({ page }) => {
  await openReview(page);

  await expect(page.getByRole('heading', { name: /проверка монтажа/i })).toBeVisible();
  await expect(page.locator('video[controls]')).toHaveCount(1);
  await expect(page.getByRole('region', { name: /таймлайн/i })).toBeVisible();
  await expect(page.locator('ol[data-transcript]')).toBeVisible();
  await expect(page.getByRole('region', { name: /диагностика/i })).toBeVisible();
  await expect(page.locator('[data-lane="source"]')).toBeVisible();
  await expect(page.locator('[data-lane="scenes"]')).toBeVisible();
  await expect(page.locator('[data-lane="transcript"]')).toBeVisible();
  await expect(page.locator('[data-lane="assets"]')).toBeVisible();
  await expect(page.locator('[data-scene]')).toHaveCount(2);
  await expect(page.locator('[data-transcript-word]')).toHaveCount(3);
  await expect(page.getByRole('button', { name: /сохранить|изменить|отменить/i })).toHaveCount(0);

  for (const selector of ['[data-scene]', '[data-transcript-word]', '[data-source-target]']) {
    await expect(page.locator(selector)).not.toHaveCount(0);
    await expect(page.locator(`${selector}:not(button)`)).toHaveCount(0);
  }
  await expect(page.locator('video')).toHaveJSProperty('autoplay', false);
});

test('scene and transcript buttons seek the source and update one synchronized playhead', async ({ page }) => {
  await openReview(page);
  const video = page.locator('video');
  await video.evaluate((element) => (
    element.readyState > 0
      ? undefined
      : new Promise((resolve) => element.addEventListener('loadedmetadata', resolve, { once: true }))
  ));

  await page.locator('[data-scene="1"]').click();
  await expect.poll(() => video.evaluate((element) => element.currentTime)).toBeCloseTo(2, 1);
  await expect(page.locator('[data-scene="1"]')).toHaveAttribute('aria-current', 'true');

  await page.getByRole('button', { name: /^фрагмент/i }).click();
  await expect.poll(() => video.evaluate((element) => element.currentTime)).toBeCloseTo(0.5, 1);
  await expect(page.getByRole('button', { name: /^фрагмент/i })).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('[data-playhead]')).toHaveCount(1);
  await expect.poll(async () => Number(
    await page.locator('[data-playhead]').getAttribute('data-time'),
  ))
    .toBeCloseTo(0.5, 1);
});

test('session token leaves the fragment and stays out of storage, DOM and API query strings', async ({ page }) => {
  const apiRequests = [];
  const mediaRequests = [];
  const assetRequests = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/state')) apiRequests.push(request);
    if (request.url().includes('/media/source')) mediaRequests.push(request);
    if (request.url().includes('/media/assets/')) assetRequests.push(request);
  });

  await openReview(page);

  await expect.poll(() => apiRequests.length).toBe(1);
  expect(new URL(apiRequests[0].url()).search).toBe('');
  expect(apiRequests[0].headers().authorization).toBe(`Bearer ${reviewSession.token}`);
  await expect.poll(() => mediaRequests.length).toBeGreaterThan(0);
  expect(new URL(mediaRequests[0].url()).searchParams.get('token')).toBe(reviewSession.token);
  await expect.poll(() => assetRequests.length).toBeGreaterThan(0);
  expect(new URL(assetRequests[0].url()).searchParams.get('token')).toBe(reviewSession.token);
  expect(await page.evaluate(() => location.hash)).toBe('');
  expect(await page.evaluate(() => ({ ...localStorage }))).toEqual({});
  await expect(page.locator('body')).not.toContainText(reviewSession.token);
  await expect(page.locator(`[value="${reviewSession.token}"]`)).toHaveCount(0);
});

for (const width of [736, 360]) {
  test(`timeline has no page overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openReview(page);
    await expectNoPageOverflow(page);
  });
}

test('keyboard reaches timeline buttons while Space remains native to the video', async ({ page }) => {
  await openReview(page);
  const video = page.locator('video');
  await video.focus();
  await expect(video).toBeFocused();
  await expect.poll(() => video.evaluate((element) => element.paused)).toBe(true);
  await page.keyboard.press('Space');
  await expect.poll(() => video.evaluate((element) => element.paused)).toBe(false);
  await page.keyboard.press('Space');
  await expect.poll(() => video.evaluate((element) => element.paused)).toBe(true);

  const secondScene = page.locator('[data-scene="1"]');
  await secondScene.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => video.evaluate((element) => element.currentTime)).toBeCloseTo(2, 1);
});
