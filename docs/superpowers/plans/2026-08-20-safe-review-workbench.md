# Safe Review Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить локальный экран проверки и безопасной корректировки lesson-монтажа, не меняя существующий путь `draft → approved → Remotion → ffmpeg` и не создавая второй рендер-движок.

**Architecture:** Новый Review Workbench запускается отдельной командой и по умолчанию работает только на чтение. Он читает project workspace через существующие безопасные resolver-функции, показывает исходник, сцены, речь и waveform, а в явно включённом edit-режиме отправляет на сервер только белый список команд; сохранение всегда создаёт новую draft-ревизию. `scripts/build.js`, `SceneDirector.jsx`, семь официальных сцен, approval gate, Remotion и ffmpeg остаются источником истины для финала.

**Tech Stack:** Node.js 20 CommonJS, встроенный `node:http`, vanilla browser ES modules, HTML5 Video, ffmpeg waveform preview, AJV, `node:test`, Playwright Chromium, существующие Remotion 4.0.504 и React 19 без новых runtime-зависимостей.

**Spec:** `knowledge/opencut-analysis-2026-08-19.md`

## Global Constraints

- Реализацию начинать в отдельной ветке/worktree `codex/review-workbench`, не в `main`.
- До реализации сохранить результаты `npm test`, `npm run demo`, `npm run check:release` и `npm run smoke:release` как baseline.
- Старые команды `automontage <video>`, `demo`, `doctor`, `--project`, `--project-dir`, `--brief` не меняют поведение.
- Review запускается только явной командой `automontage review --project-dir <path>`.
- Режим по умолчанию read-only; запись разрешается только с явным `--edit`.
- Ни один draft не передаётся в Remotion. Review показывает исходник и монтажную разметку, а не имитирует финальный renderer.
- Approved JSON/Markdown никогда не перезаписываются и не удаляются.
- Любое сохранение Review создаёт новую пару `vNN-draft.lesson.json` + `.md` и новую запись в `project.json`.
- `source`, `theme`, `output.aspect`, `output.width`, `output.height`, `output.fps` и `output.durationInFrames` нельзя менять из Review.
- Автоматический ripple по всем последующим сценам запрещён: lesson использует глобальный таймкод непрерывного исходника.
- Безопасная timing-правка двигает одну общую границу: `scenes[i].end === scenes[i + 1].start`; более поздние сцены не сдвигаются.
- В первой версии доступны только timing boundary и замена b-roll на уже зарегистрированный безопасный asset. Свободное редактирование текста, произвольные эффекты, keyframes, masks и новый тип сцены не входят в scope.
- Сервер слушает только `127.0.0.1`; каждый `/api/*` и `/media/*` запрос требует случайный session token, POST дополнительно проверяет `Origin`, CORS не включается. Статический shell не содержит project-данных и может загрузиться без token.
- API не возвращает абсолютные пути, токены, переменные окружения или содержимое `.env`.
- Все filesystem-пути проходят через `resolveProjectPath()` или отдельный realpath containment check; symlink traversal запрещён.
- Никаких новых runtime-зависимостей. Playwright остаётся devDependency.
- Каждый production-шаг начинается с падающего теста и заканчивается полным `npm test`.
- После изменений синхронно обновляются `README.md`, `ARCHITECTURE.md`, `docs/TEMPLATES.md`, `TESTING.md`, `DECISIONS.md` и `CHANGELOG.md`.
- Push, tag и GitHub Release выполняются только после отдельного явного разрешения.

---

## Chosen Approach

Рассмотрены три пути:

1. **Встроить или форкнуть OpenCut** - отклонено: текущая версия переписывается, Classic архивирован, project/headless API нет.
2. **Встроить редактор в Remotion Studio** - отклонено: это связывает критический approval/render-контур с UI API Studio и повышает риск пропустить draft в renderer.
3. **Изолированный localhost Review Workbench** - выбран: отдельная команда, ноль новых runtime-зависимостей, старый pipeline ничего о Review не знает.

## Target File Structure

```text
scripts/review/
├── cli.js                 # разбор review-флагов и lifecycle локального сервера
├── server.js              # loopback HTTP, token/origin/body/security gates
├── model.js               # project manifest + brief + transcript → публичный ReviewState
├── assets.js              # allowlist project/public assets без утечки host paths
├── media-time.js          # rational FPS, frame/tick conversions
├── timing-audit.js        # frame/word alignment и безопасные подсказки
├── waveform.js            # ffmpeg argv и атомарный waveform cache
├── commands.js            # белый список чистых edit-команд
└── diff.js                # человекочитаемый diff base → candidate

review/
├── index.html             # статический shell без inline scripts
├── app.js                 # session state, API, mode, save orchestration
├── timeline.js            # lanes, boundary handles, playhead
├── player-sync.js         # video time ↔ timeline playhead
└── styles.css             # адаптивный UI

playwright.config.js       # отдельный Chromium project только для Review UI

tests/
├── review-compatibility.test.js
├── review-media-time.test.js
├── review-model.test.js
├── review-server-security.test.js
├── review-waveform.test.js
├── review-commands.test.js
├── review-draft-save.test.js
├── review-cli.test.js
└── review-ui.spec.js
```

## Public Interfaces

```js
frameRateFromFps(fps) -> { numerator, denominator }
secondsToFrame(seconds, rate, mode = 'round') -> integer
frameToSeconds(frame, rate) -> number
auditBriefTiming({ brief, transcript }) -> { errors, warnings, suggestions }

loadReviewState({ root, projectDir, briefPath, editable }) -> ReviewState
resolveReviewAsset({ root, workspace, reference }) -> AssetDescriptor | null
startReviewServer({ root, projectDir, editable, host, port, open }) -> Promise<ReviewServer>

applyReviewCommand({ brief, command, assetIds }) -> lessonBrief
applyReviewCommands({ brief, commands, assetIds }) -> lessonBrief
diffLessonBrief({ before, after }) -> ReviewDiff[]

saveDraftRevision(workspace, { baseJsonPath, brief, fileSystem, temporaryId })
  -> { revision, jsonPath, markdownPath }
```

`ReviewState` содержит только browser-safe данные:

```js
{
  project: { id, name },
  session: { editable, baseRevision, baseHash, manifestHash },
  output: { width, height, fps, durationInFrames },
  source: { url: '/media/source' },
  brief: { status, title, scenes },
  transcript: { segments, words },
  assets: [{ id, kind, label, url }],
  timing: { errors, warnings, suggestions },
  waveform: { url: '/media/waveform' } | null
}
```

---

### Task 0: Freeze the Working Pipeline with Compatibility Tests

**Files:**
- Create: `tests/review-compatibility.test.js`
- Read only: `scripts/build.js`, `scripts/lesson/brief.js`, `scripts/lesson/workflow.js`

**Interfaces:**
- Consumes: `buildReelScenesProps()` and `examples/lesson-neutral-approved.json`.
- Produces: regression proof that Review work cannot silently change render props or approval behavior.

- [ ] **Step 1: Record the clean baseline**

Run:

```bash
git status --short
npm test
npm run demo
npm run check:release
npm run smoke:release
```

Expected: existing tests, demo, release hygiene and smoke render pass before feature code is touched. Record exact test counts and generated media metadata in the implementation session journal.

- [ ] **Step 2: Write the failing compatibility test**

```js
test('review additions do not change canonical lesson props', () => {
  const brief = require('../examples/lesson-neutral-approved.json');
  const props = buildReelScenesProps({ brief, theme: { id: 'fixture' } });
  assert.deepEqual(props.scenes, brief.scenes);
  assert.equal(props.fps, 25);
  assert.equal(props.durationInFrames, 350);
  assert.equal(props.faceSrc, 'source.mp4');
  assert.equal(props.audioSrc, 'source.mp4');
});

test('draft remains forbidden at the renderer boundary', () => {
  const draft = { ...require('../examples/lesson-neutral-approved.json'), status: 'draft' };
  assert.throws(() => buildReelScenesProps({ brief: draft, theme: {} }), /approved/);
});
```

- [ ] **Step 3: Run the focused test**

Run: `node --test tests/review-compatibility.test.js`

Expected: PASS immediately. This task is a characterization test; if it fails, fix the test assumption, not production behavior.

- [ ] **Step 4: Commit the guardrail when commits are authorized**

```bash
git add tests/review-compatibility.test.js
git commit -m "test: freeze lesson render compatibility"
```

---

### Task 1: Add Read-Only Frame-Accurate Timing Audit

**Files:**
- Create: `scripts/review/media-time.js`
- Create: `scripts/review/timing-audit.js`
- Create: `tests/review-media-time.test.js`

**Interfaces:**
- Produces the four timing functions defined in Public Interfaces.
- Does not modify `scripts/source-timing.js`, brief schema or render props.

- [ ] **Step 1: Write failing rational-FPS tests**

```js
test('represents standard NTSC rates without float drift', () => {
  assert.deepEqual(frameRateFromFps(30000 / 1001), { numerator: 30000, denominator: 1001 });
  assert.equal(secondsToFrame(10.01, { numerator: 30000, denominator: 1001 }), 300);
  assert.equal(frameToSeconds(300, { numerator: 30000, denominator: 1001 }), 10.01);
});

test('reports but does not rewrite off-frame scene boundaries', () => {
  const brief = fixtureBrief({ fps: 25, scenes: [
    { scene: 'fullscreen', start: 0, end: 1.013, caption: 'A' },
    { scene: 'fullscreen', start: 1.013, end: 2, caption: 'B' },
  ] });
  const audit = auditBriefTiming({ brief, transcript: [] });
  assert.equal(audit.errors.length, 0);
  assert.equal(audit.suggestions[0].suggestedSeconds, 1);
  assert.equal(brief.scenes[0].end, 1.013);
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/review-media-time.test.js`

Expected: FAIL because timing modules do not exist.

- [ ] **Step 3: Implement the pure time primitives**

```js
const TICKS_PER_SECOND = 120_000;
const STANDARD_RATES = [
  { fps: 24000 / 1001, numerator: 24000, denominator: 1001 },
  { fps: 30000 / 1001, numerator: 30000, denominator: 1001 },
  { fps: 60000 / 1001, numerator: 60000, denominator: 1001 },
];

function secondsToFrame(seconds, rate, mode = 'round') {
  const raw = seconds * rate.numerator / rate.denominator;
  return ({ floor: Math.floor, ceil: Math.ceil, round: Math.round })[mode](raw);
}
```

Reject non-finite/negative seconds, invalid ratios and unknown `mode`. `auditBriefTiming` returns suggestions and never mutates its inputs.

- [ ] **Step 4: Verify GREEN and the old timing tests**

Run: `node --test tests/review-media-time.test.js tests/source-timing.test.js && npm test`

Expected: all focused and existing tests pass; `scripts/source-timing.js` remains unchanged.

- [ ] **Step 5: Commit when authorized**

```bash
git add scripts/review/media-time.js scripts/review/timing-audit.js tests/review-media-time.test.js
git commit -m "feat(review): audit scene timing without changing renders"
```

---

### Task 2: Build the Browser-Safe Review State

**Files:**
- Create: `scripts/review/model.js`
- Create: `scripts/review/assets.js`
- Create: `tests/helpers/review-project.js`
- Create: `tests/review-model.test.js`

**Interfaces:**
- Consumes: `createOrOpenProject()`, `readProjectManifest()`, `resolveProjectPath()`, `validateLessonBrief()`, `auditBriefTiming()`.
- Produces: `loadReviewState()` and `resolveReviewAsset()`.

- [ ] **Step 1: Write a reusable temporary project fixture**

```js
function makeReviewProject(t, { briefStatus = 'draft' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Create through public workspace APIs, then write registered transcript/brief fixtures.
  return { root, workspace, briefPath };
}
```

The helper must use real temp files and the production workspace API; it must not bypass manifest validation.

- [ ] **Step 2: Write failing state-model tests**

```js
test('review state exposes scenes and words without host paths', () => {
  const state = loadReviewState({ root: ROOT, projectDir, editable: false });
  assert.equal(state.session.editable, false);
  assert.equal(state.source.url, '/media/source');
  assert.equal(state.brief.status, 'draft');
  assert.ok(state.transcript.words.length > 0);
  assert.doesNotMatch(JSON.stringify(state), /\/Users\/|C:\\Users\\/);
});

test('review rejects an unregistered brief and escaping asset path', () => {
  assert.throws(() => loadReviewState({ projectDir, briefPath: '../../outside.json' }), /project|brief/i);
  assert.equal(resolveReviewAsset({ root: ROOT, workspace, reference: '../../secret' }), null);
});
```

- [ ] **Step 3: Verify RED**

Run: `node --test tests/review-model.test.js`

Expected: FAIL because model/assets modules do not exist.

- [ ] **Step 4: Implement model loading and asset allowlisting**

Resolve `currentBrief` through the manifest. Flatten faster-whisper segments into `{text,start,end}` words. Assets may resolve only inside `project/assets/` or the repository's real, non-symlinked `public/` directory; return opaque ids such as `asset-1`, never filesystem paths.

- [ ] **Step 5: Verify model, traversal and full suite**

Run: `node --test tests/review-model.test.js tests/project-workspace.test.js && npm test`

Expected: state is JSON-serializable, no host paths leak, traversal/symlink cases fail closed.

- [ ] **Step 6: Commit when authorized**

```bash
git add scripts/review/model.js scripts/review/assets.js tests/helpers/review-project.js tests/review-model.test.js
git commit -m "feat(review): build safe project review state"
```

---

### Task 3: Add the Loopback-Only Review Server and CLI Command

**Files:**
- Create: `scripts/review/server.js`
- Create: `scripts/review/cli.js`
- Create: `tests/review-server-security.test.js`
- Create: `tests/review-cli.test.js`
- Modify: `scripts/cli.js:16-63`

**Interfaces:**
- Produces: `parseReviewOptions(argv)`, `startReviewServer(options)`.
- Adds: `automontage review --project-dir <path> [--edit] [--no-open] [--port <number>]`.
- Does not forward review arguments to `scripts/build.js`.

- [ ] **Step 1: Write failing CLI routing tests**

```js
test('review requires an existing project directory', () => {
  assert.throws(() => parseReviewOptions(['--project-dir', '']), /project-dir/);
});

test('review is read-only unless edit is explicit', () => {
  assert.deepEqual(parseReviewOptions(['--project-dir', '/work/reel']), {
    projectDir: path.resolve('/work/reel'), editable: false, open: true, port: 0,
  });
});
```

- [ ] **Step 2: Write failing server security tests**

Assert these literal outcomes:

```js
assert.equal(server.address().address, '127.0.0.1');
assert.equal((await request('/api/state')).status, 401);
assert.equal((await request('/api/state', { token })).status, 200);
assert.equal((await post('/api/validate', {}, { token, origin: 'https://evil.test' })).status, 403);
assert.equal((await request('/../../.env', { token })).status, 404);
```

Also test 413 for bodies larger than 256 KiB, `Cache-Control: no-store`, CSP, `X-Content-Type-Options: nosniff`, and no `Access-Control-Allow-Origin` header.

- [ ] **Step 3: Verify RED**

Run: `node --test tests/review-cli.test.js tests/review-server-security.test.js`

Expected: FAIL because CLI/server modules do not exist.

- [ ] **Step 4: Implement secure session startup**

```js
const token = randomBytes(32).toString('base64url');
const server = http.createServer((request, response) => routeRequest({
  request, response, token, origin, state,
}));
server.listen({ host: '127.0.0.1', port });
```

Open the browser at `http://127.0.0.1:<port>/#token=<token>` so the token is not sent in the initial HTTP request or server logs. `app.js` reads the fragment, clears it with `history.replaceState`, uses `Authorization: Bearer <token>` for fetch, and appends the token only to opaque `/media/*` URLs required by native `<video>`/`<img>`. Send `Referrer-Policy: no-referrer`. Every `/api/*` and `/media/*` request must validate the token. Only GET/HEAD are available in read-only mode. Static paths are a fixed map of five files under `review/`; never join an arbitrary URL to disk.

- [ ] **Step 5: Dispatch `review` before the build path**

In `scripts/cli.js`, handle `argv[0] === 'review'` before creating `buildJs`. Launch the review CLI with `execFileSync(process.execPath, [...])`; keep `shell: false` and existing cwd behavior.

- [ ] **Step 6: Verify GREEN and legacy CLI compatibility**

Run: `node --test tests/review-cli.test.js tests/review-server-security.test.js tests/project-cli-options.test.js && npm test`

Expected: new server/CLI tests pass and legacy command tests remain unchanged.

- [ ] **Step 7: Commit when authorized**

```bash
git add scripts/review/server.js scripts/review/cli.js scripts/cli.js tests/review-cli.test.js tests/review-server-security.test.js
git commit -m "feat(review): add secure local review command"
```

---

### Task 4: Build the Read-Only Timeline UI

**Files:**
- Create: `review/index.html`
- Create: `review/app.js`
- Create: `review/timeline.js`
- Create: `review/player-sync.js`
- Create: `review/styles.css`
- Create: `playwright.config.js`
- Create: `tests/review-ui.spec.js`

**Interfaces:**
- Consumes: `GET /api/state`, authenticated `/media/source` and opaque asset URLs.
- Produces no filesystem or API writes in read-only mode.

- [ ] **Step 1: Write failing Playwright acceptance tests**

```js
test('read-only review shows source, scenes and transcript without edit controls', async ({ page }) => {
  await page.goto(reviewUrl);
  await expect(page.getByRole('heading', { name: /проверка монтажа/i })).toBeVisible();
  await expect(page.locator('[data-scene]')).toHaveCount(2);
  await expect(page.locator('[data-transcript-word]')).not.toHaveCount(0);
  await expect(page.getByRole('button', { name: /сохранить/i })).toHaveCount(0);
});
```

Add a narrow viewport check at 360 px and assert no horizontal page overflow.

- [ ] **Step 2: Verify RED**

Run: `npx playwright test tests/review-ui.spec.js --project=chromium`

Expected: FAIL because the static UI does not exist.

- [ ] **Step 3: Implement the minimal semantic shell**

`index.html` contains a real `<video controls>`, timeline `<section>`, transcript `<ol>` and diagnostics `<section>`. Use `<script type="module" src="/app.js">`; no inline script, remote font, CDN or analytics.

Configure a named Playwright project so every command in this plan is reproducible:

```js
module.exports = {
  testDir: './tests',
  testMatch: 'review-ui.spec.js',
  projects: [{ name: 'chromium', use: { browserName: 'chromium', headless: true } }],
};
```

- [ ] **Step 4: Implement synchronized read-only lanes**

```js
export function sceneAtTime(scenes, seconds) {
  return scenes.findIndex((scene) => seconds >= scene.start && seconds < scene.end);
}

export function seekPlayer(video, seconds) {
  video.currentTime = Math.max(0, seconds);
}
```

Render lanes for source, scenes, transcript and assets. Clicking a scene or word seeks the source video. `requestAnimationFrame` updates one playhead; honor `prefers-reduced-motion` and do not auto-play.

- [ ] **Step 5: Verify desktop, mobile and keyboard behavior**

Run: `npx playwright test tests/review-ui.spec.js --project=chromium`

Expected: timeline works at 736 and 360 px, all clickable items are buttons, Space remains the native video control, and no edit/save control appears.

- [ ] **Step 6: Verify full Node suite and commit**

Run: `npm test`

```bash
git add review playwright.config.js tests/review-ui.spec.js
git commit -m "feat(review): add read-only lesson timeline"
```

---

### Task 5: Add Optional Cached Waveform Preview

**Files:**
- Create: `scripts/review/waveform.js`
- Create: `tests/review-waveform.test.js`
- Modify: `scripts/review/model.js`
- Modify: `scripts/review/server.js`
- Modify: `review/timeline.js`

**Interfaces:**
- Produces: `buildWaveformCommand(input, output)` and `ensureWaveformPreview({ workspace, sourcePath, runToolImpl })`.
- Writes only an owned `previews/review-waveform-<fingerprint>.png`; it never changes `project.json` or a brief.

- [ ] **Step 1: Write failing argv and cache tests**

```js
test('waveform invokes ffmpeg with separate argv', () => {
  assert.deepEqual(buildWaveformCommand('/tmp/a;touch pwn.mp4', '/tmp/wave.png'), {
    command: 'ffmpeg',
    args: ['-y', '-i', path.resolve('/tmp/a;touch pwn.mp4'), '-filter_complex',
      'aformat=channel_layouts=mono,showwavespic=s=2400x180:colors=white',
      '-frames:v', '1', path.resolve('/tmp/wave.png')],
  });
});
```

Test cache reuse, source fingerprint change, temp cleanup on ffmpeg failure, symlink refusal and absence of manifest changes.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/review-waveform.test.js`

Expected: FAIL because waveform module does not exist.

- [ ] **Step 3: Implement atomic best-effort generation**

Use `runTool(command, args, { stage: 'review waveform' })`, write to an unpredictable adjacent temp, verify it is a regular file, then rename. If ffmpeg is unavailable or fails, return `{ available: false, warning }`; Review must still start.

- [ ] **Step 4: Show waveform without making it a dependency**

Return `waveform: null` when unavailable. The UI reserves no blank panel; it adds the image only when the state contains a URL.

- [ ] **Step 5: Verify focused, security and full suites**

Run: `node --test tests/review-waveform.test.js tests/process-security.test.js && npm test`

Expected: waveform tests pass and no process/security regression appears.

- [ ] **Step 6: Commit when authorized**

```bash
git add scripts/review/waveform.js scripts/review/model.js scripts/review/server.js review/timeline.js tests/review-waveform.test.js
git commit -m "feat(review): add optional local waveform"
```

---

### Task 6: Add Pure, Whitelisted Edit Commands and Diff

**Files:**
- Create: `scripts/review/commands.js`
- Create: `scripts/review/diff.js`
- Create: `tests/review-commands.test.js`

**Interfaces:**
- Produces: `applyReviewCommand()`, `applyReviewCommands()`, `diffLessonBrief()`.
- Supported command types: `move-boundary`, `replace-broll`.
- Commands always start from a deep clone and never mutate the registered base brief.

- [ ] **Step 1: Write failing boundary tests**

```js
test('move-boundary changes only the adjacent end and start', () => {
  const before = fixtureBriefWithThreeScenes();
  const after = applyReviewCommand({
    brief: before,
    command: { type: 'move-boundary', leftSceneIndex: 0, seconds: 4.2 },
    assetIds: new Set(),
  });
  assert.equal(after.scenes[0].end, 4.2);
  assert.equal(after.scenes[1].start, 4.2);
  assert.deepEqual(after.scenes[2], before.scenes[2]);
  assert.deepEqual(before, fixtureBriefWithThreeScenes());
});
```

Add failures for first/last boundary, overlaps, zero-duration scenes, non-finite values, unknown command type and attempts to change approved identity fields.

- [ ] **Step 2: Write failing asset and diff tests**

```js
assert.throws(() => applyReviewCommand({
  brief, command: { type: 'replace-broll', sceneIndex: 1, assetId: 'unknown' }, assetIds,
}), /asset/);

assert.deepEqual(diffLessonBrief({ before, after }), [{
  kind: 'boundary', leftScene: 0, rightScene: 1, from: 4, to: 4.2,
}]);
```

- [ ] **Step 3: Verify RED**

Run: `node --test tests/review-commands.test.js`

Expected: FAIL because command/diff modules do not exist.

- [ ] **Step 4: Implement command replay and immutable identity checks**

After every command, run `validateLessonBrief(candidate)`. Force `candidate.status = 'draft'`. Compare `source`, `theme` and the complete `output` object to the base and reject any difference.

- [ ] **Step 5: Verify GREEN and full suite**

Run: `node --test tests/review-commands.test.js tests/lesson-brief.test.js && npm test`

Expected: command tests pass; existing brief validation remains unchanged.

- [ ] **Step 6: Commit when authorized**

```bash
git add scripts/review/commands.js scripts/review/diff.js tests/review-commands.test.js
git commit -m "feat(review): add safe lesson edit commands"
```

---

### Task 7: Save Every Edit as a New Atomic Draft Revision

**Files:**
- Modify: `scripts/project/workspace.js:426-623,759-774`
- Create: `tests/review-draft-save.test.js`

**Interfaces:**
- Produces: `saveDraftRevision()` from `scripts/project/workspace.js`.
- Consumes: registered base brief, validated candidate from Task 6, existing `nextBriefPaths()`, `stageOwnedSiblingFile()` and `formatBriefMarkdown()`.

- [ ] **Step 1: Write failing atomic-save tests**

```js
test('review save creates a new draft and preserves approved base bytes', () => {
  const before = fs.readFileSync(approvedPath);
  const saved = saveDraftRevision(workspace, {
    baseJsonPath: approvedPath,
    brief: candidate,
    temporaryId: () => 'review-safe-id',
  });
  assert.equal(path.basename(saved.jsonPath), 'v02-draft.lesson.json');
  assert.deepEqual(fs.readFileSync(approvedPath), before);
  assert.equal(readProjectManifest(workspace.dir).currentBrief, 'brief/v02-draft.lesson.json');
});
```

Add table-driven I/O failures for manifest, Markdown and JSON commit. Each case must retain the previous manifest/currentBrief, leave the base bytes untouched and remove owned temp files.

- [ ] **Step 2: Write failing stale-session and no-op tests**

Reject save when `baseJsonPath` is no longer registered/current unless the caller explicitly reopened that base. Reject an empty command list with `ничего не изменено` instead of creating a duplicate revision.

- [ ] **Step 3: Verify RED**

Run: `node --test tests/review-draft-save.test.js`

Expected: FAIL because `saveDraftRevision()` does not exist.

- [ ] **Step 4: Implement the same commit order as approval**

Stage manifest, Markdown and JSON first. Commit manifest, then Markdown, then JSON so a renderable-looking file appears last. On failure remove committed Review outputs and restore the old manifest with the existing rollback pattern. Force `status: 'draft'` before serialization.

- [ ] **Step 5: Verify project invariants and full suite**

Run: `node --test tests/review-draft-save.test.js tests/project-workspace.test.js && npm test`

Expected: atomic-save tests and all existing project rollback/security tests pass.

- [ ] **Step 6: Commit when authorized**

```bash
git add scripts/project/workspace.js tests/review-draft-save.test.js
git commit -m "feat(projects): save review edits as new drafts"
```

---

### Task 8: Expose Edit API Only Behind `--edit`

**Files:**
- Modify: `scripts/review/server.js`
- Modify: `scripts/review/model.js`
- Modify: `tests/review-server-security.test.js`

**Interfaces:**
- Adds: `POST /api/validate` and `POST /api/save` only for editable sessions.
- Request body: `{ baseRevision, baseHash, manifestHash, commands }`.
- Server reloads the base from disk, verifies the hash, replays commands and never accepts a full replacement brief from the browser.

- [ ] **Step 1: Write failing authorization and concurrency tests**

```js
assert.equal((await post('/api/save', payload, readOnlySession)).status, 405);
assert.equal((await post('/api/save', payload, editSession)).status, 201);
assert.equal((await post('/api/save', stalePayload, editSession)).status, 409);
```

Add 400 for malformed JSON/unknown commands, 422 for invalid timing, 403 for wrong Origin/token and 500 with generic body for injected filesystem failure. Server logs may contain the internal error but must not return host paths.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/review-server-security.test.js`

Expected: POST cases fail because edit routes are absent.

- [ ] **Step 3: Implement canonical server-side replay**

```js
const base = loadRegisteredBrief(workspace, body.baseRevision);
assertHash(base, body.baseHash);
assertHash(workspace.manifest, body.manifestHash);
const candidate = applyReviewCommands({ brief: base, commands: body.commands, assetIds });
const diff = diffLessonBrief({ before: base, after: candidate });
```

`/api/validate` returns `{ ok, diff, timing }` without writing. `/api/save` first rejects a changed manifest with 409, then calls `saveDraftRevision()` only when diff is non-empty and returns the new opaque revision/path relative to the project.

- [ ] **Step 4: Verify security, concurrency and full suite**

Run: `node --test tests/review-server-security.test.js tests/review-commands.test.js tests/review-draft-save.test.js && npm test`

Expected: all edit routes fail closed and read-only behavior remains identical.

- [ ] **Step 5: Commit when authorized**

```bash
git add scripts/review/server.js scripts/review/model.js tests/review-server-security.test.js
git commit -m "feat(review): gate validated draft saves behind edit mode"
```

---

### Task 9: Add Boundary Editing, Undo/Redo and Save UX

**Files:**
- Modify: `review/app.js`
- Modify: `review/timeline.js`
- Modify: `review/styles.css`
- Modify: `tests/review-ui.spec.js`

**Interfaces:**
- Browser keeps `commands[]` and `redoStack[]` in memory.
- Dragging a boundary appends one `move-boundary` command after snapping to a frame/nearby word.
- Save sends the command list; successful save reloads the new draft as the session base.

- [ ] **Step 1: Write failing edit-mode UI tests**

```js
test('edit mode moves only one shared boundary and can undo it', async ({ page }) => {
  await page.goto(editUrl);
  const thirdBefore = await page.locator('[data-scene="2"]').getAttribute('data-start');
  await dragBoundary(page, 0, 4.2);
  await expect(page.locator('[data-scene="0"]')).toHaveAttribute('data-end', '4.2');
  await expect(page.locator('[data-scene="1"]')).toHaveAttribute('data-start', '4.2');
  await expect(page.locator('[data-scene="2"]')).toHaveAttribute('data-start', thirdBefore);
  await page.getByRole('button', { name: /отменить/i }).click();
  await expect(page.locator('[data-scene="0"]')).toHaveAttribute('data-end', '4');
});
```

Add tests for redo, keyboard buttons, visible diff, invalid red boundary, read-only absence, b-roll allowlist selection and successful save creating a new draft without changing approved files.

- [ ] **Step 2: Verify RED**

Run: `npx playwright test tests/review-ui.spec.js --project=chromium`

Expected: edit-mode cases fail because controls are absent.

- [ ] **Step 3: Implement in-memory command history**

```js
function dispatch(command) {
  commands.push(command);
  redoStack.length = 0;
  void validateCommands();
}

function undo() {
  const command = commands.pop();
  if (command) redoStack.push(command);
  void validateCommands();
}
```

Do not calculate the authoritative candidate in the browser. UI may show an optimistic handle while dragging, but after drop it must render the server's `/api/validate` result.

- [ ] **Step 4: Implement safe snapping**

Choose the nearest of: exact dragged time, nearest frame, nearest word start/end within 120 ms. Display the chosen reason (`кадр` or `слово`) and allow Escape to cancel the drag. Never move the first scene start, final scene end or non-adjacent scenes.

- [ ] **Step 5: Implement diff and save confirmation**

The confirmation lists each changed boundary/asset and the destination revision, then calls `/api/save`. On 409 reload state and retain unsaved commands for comparison; do not retry automatically.

- [ ] **Step 6: Verify full browser behavior**

Run: `npx playwright test tests/review-ui.spec.js --project=chromium`

Expected: read-only/edit, desktop/mobile, undo/redo, diff, save and stale-session cases pass.

- [ ] **Step 7: Verify Node suite and commit**

Run: `npm test`

```bash
git add review tests/review-ui.spec.js
git commit -m "feat(review): add safe boundary editing and undo"
```

---

### Task 10: CI, Documentation, Release Candidate and Final Proof

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `docs/TEMPLATES.md`
- Modify: `TESTING.md`
- Modify: `DECISIONS.md`
- Modify: `CHANGELOG.md`
- Modify: `scripts/check-release.js` if the new public `review/` tree needs explicit hygiene coverage

**Interfaces:**
- Adds scripts: `review`, `test:review-ui`.
- Documents Review as optional and local-only; existing build commands remain canonical.
- Produces a release-ready minor version only after all acceptance gates pass.

- [ ] **Step 1: Add package scripts without new dependencies**

```json
{
  "scripts": {
    "review": "node scripts/review/cli.js",
    "test:review-ui": "playwright test tests/review-ui.spec.js --project=chromium"
  }
}
```

Merge these keys into the existing scripts object; run `npm install --package-lock-only` only if npm changes the lock root scripts metadata.

- [ ] **Step 2: Add a separate browser CI job**

The job uses Node 20, `npm ci --no-audit --no-fund`, `npx playwright install --with-deps chromium`, then `npm run test:review-ui`. Keep the existing Node test job unchanged so Review browser setup cannot hide ordinary unit regressions.

- [ ] **Step 3: Update documentation with exact behavior**

Document:

```bash
automontage review --project-dir projects/2026.08.20_demo
automontage review --project-dir projects/2026.08.20_demo --edit
```

State explicitly: read-only default, no draft render, new revision on save, approved immutable, no global ripple, localhost/token security, waveform fallback, supported edits and excluded effects/keyframes/masks.

- [ ] **Step 4: Record the architectural decision**

In `DECISIONS.md`, compare OpenCut fork, Remotion Studio coupling and isolated Review Workbench. Record why the third option wins and why lesson boundary editing is adjacent-only instead of ripple.

- [ ] **Step 5: Run static and unit verification**

Run:

```bash
npm test
npm run test:review-ui
npm audit --audit-level=high
npm run check:release
git diff --check
```

Expected: all unit/regression/UI tests pass, audit has no unaccepted high/critical issue, release tree has no personal path/media/secret, diff has no whitespace errors.

- [ ] **Step 6: Run the original media baseline again**

Run:

```bash
npm run demo
npm run smoke:release
```

Expected: the same compositions, geometry, FPS, frame counts, audio presence and A/V drift limits as Task 0. Review must not appear anywhere in render props or Remotion input.

- [ ] **Step 7: Run a real project acceptance scenario**

On a copied local project fixture:

1. Open read-only Review and confirm no project file changes.
2. Open `--edit`, move one boundary and undo it.
3. Move it again, save, and verify a new draft pair plus one manifest entry.
4. Compare approved file hashes before/after; they must match.
5. Approve the new draft through the existing `approve-brief.js`, not through Review.
6. Render through the existing `--brief` command and complete visual/decode/A-V QA.

- [ ] **Step 8: Prepare SemVer release metadata only after acceptance**

Because this is a compatible feature, prepare `1.3.0` in `package.json`, `package-lock.json`, README version marker and a dated `CHANGELOG.md` section. Re-run `npm run check:release` and `npm run smoke:release`. Do not tag, push or publish without separate approval.

- [ ] **Step 9: Commit the verified release candidate when authorized**

```bash
git add package.json package-lock.json .github/workflows/ci.yml README.md ARCHITECTURE.md docs/TEMPLATES.md TESTING.md DECISIONS.md CHANGELOG.md scripts/check-release.js
git commit -m "docs: document safe review workflow"
```

---

## Acceptance Checklist

- [ ] `automontage review --project-dir <path>` starts read-only and never calls Remotion.
- [ ] Closing a read-only session leaves `project.json`, all brief files and render history byte-identical.
- [ ] `--edit` is required for POST routes and visible edit controls.
- [ ] Every `/api/*` and `/media/*` request requires the random session token; POST rejects a foreign Origin.
- [ ] Traversal, symlink, oversized body, unknown command and stale-session tests fail closed.
- [ ] Timing audit reports frame/word suggestions without rewriting the brief.
- [ ] Boundary editing changes only two adjacent fields and never shifts later scenes.
- [ ] Approved JSON/Markdown hashes never change.
- [ ] Save creates a new draft revision atomically or rolls back fully.
- [ ] Undo/redo stays in memory until explicit save.
- [ ] Waveform failure does not prevent Review startup.
- [ ] Existing CLI, approval, render, project workspace and release tests remain green.
- [ ] Demo and release smoke preserve composition, dimensions, FPS, frames, audio and A/V drift criteria.
- [ ] Documentation explains both supported scope and deliberately excluded OpenCut features.

## Explicitly Deferred Modules

These are not part of this implementation because they raise risk without solving the current approval problem:

- OpenCut runtime, project format, renderer, MCP or headless integration;
- global ripple edit for lesson scenes;
- arbitrary scene-type conversion;
- free text editing that can introduce claims absent from the transcript;
- keyframes, masks, filters and effects registry;
- browser-side video export;
- cloud storage, account system or remote collaboration.

Each deferred capability requires its own design/spec/plan after Review Workbench 1.3.0 has passed real-project acceptance.
