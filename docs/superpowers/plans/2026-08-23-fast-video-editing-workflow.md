# Fast Video Editing Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every future lesson video produce a truthful, browser-viewable Remotion draft preview and reusable source edit without modifying shared engine code during the client job.

**Architecture:** Keep the approved final boundary unchanged and add a separate draft-preview boundary that reuses `ReelScenes`, safe media materialization, finishing, and music ducking but can publish only to the project's `previews/` directory. Add a versioned source-cut contract and a documented scene capability catalog so routine speech cuts, screencasts, progressive text, negative-space layouts, and endings are data, not one-off engine development.

**Tech Stack:** Node.js 20 CommonJS, React 19, Remotion 4.0.504, ffmpeg/ffprobe, JSON Schema/Ajv, Node test runner, Playwright Chromium.

**Spec:** `docs/superpowers/specs/2026-08-23-fast-video-editing-workflow-design.md`

## Global Constraints

- The seven official lesson scene types remain `fullscreen`, `split`, `bottom-diagram`, `blur-overlay`, `text-only`, `stat`, and `broll`.
- Final render must continue to require `status: "approved"`.
- Draft preview must never update `renders/`, `latestRender`, or `final/`.
- Preview and final must use the same `ReelScenes` composition and post-render audio order.
- Client video work writes only inside `projects/<id>/`; shared code changes are a separate task.
- Source videos, project media, previews, renders, private themes, and absolute personal paths remain outside Git.
- Existing dirty worktree changes must be reviewed and preserved; do not overwrite them while executing this plan.

---

## File map

**New focused modules**

- `scripts/lesson/preview.js` - validates preview-only options and prepares draft preview props/music.
- `scripts/project/preview-workspace.js` - plans immutable preview paths and atomically publishes `current-preview.mp4` metadata without touching final render history.
- `scripts/project/build-master.js` - applies a versioned source cut list and remaps word timestamps.
- `schema/source-edit.schema.json` - contract for ordered keep ranges.
- `docs/SCENE-CATALOG.md` - supported reusable scene capabilities and exact brief properties.
- `examples/lesson-horizontal-workflow-draft.json` - public horizontal golden draft.
- `examples/lesson-vertical-workflow-draft.json` - public vertical golden draft.

**Existing files changed by responsibility**

- `scripts/lesson/brief.js` - expose a draft-safe props builder without weakening the approved builder.
- `scripts/lesson/workflow.js` - keep final preparation and preview preparation separate.
- `scripts/render-media-bundle.js` - share safe media materialization behind separate approved and draft-preview entry points.
- `scripts/build-commands.js` - accept explicit Remotion scale, CRF, and frame-range arguments.
- `scripts/cli.js` - add `automontage preview` and `automontage master` commands.
- `src/SceneDirector.jsx` - render a deterministic draft watermark when `draftPreview` is true.
- `schema/project.schema.json` and `scripts/project/workspace.js` - store current preview and source revision metadata compatibly.
- `scripts/review/model.js`, `scripts/review/server.js`, `review/app.js`, `review/index.html`, `review/styles.css` - expose and display the actual current preview separately from the source player.
- `skills/reel-turnkey/SKILL.md`, `skills/reel-turnkey/evals/evals.json`, `skills/README.md` - enforce client-delivery mode and the new preview flow.
- `AGENTS.md`, `README.md`, `ARCHITECTURE.md`, `docs/TEMPLATES.md`, `docs/REVIEW-WORKBENCH.md`, `TESTING.md`, `DECISIONS.md`, `CHANGELOG.md` - document the same product contract and commands.

---

### Task 1: Freeze the approved boundary and add a separate draft-preview props API

**Files:**
- Modify: `scripts/lesson/brief.js:53-131`
- Modify: `scripts/lesson/workflow.js:30-122`
- Create: `scripts/lesson/preview.js`
- Test: `tests/lesson-brief.test.js`
- Test: `tests/lesson-build.test.js`
- Test: `tests/review-compatibility.test.js`

**Interfaces:**
- Consumes: persisted lesson brief, resolved theme, active source path.
- Produces: `buildDraftPreviewProps({brief, theme, sourceFile})`, `prepareLessonPreview({brief, theme, sourceVideo, fromSec, toSec})`.

- [ ] **Step 1: Write the failing props-boundary tests**

Add exact assertions:

```js
test('draft preview props accept only a valid draft and mark the composition', () => {
  const props = buildDraftPreviewProps({
    brief: makeBrief({ status: 'draft' }),
    theme: 'lesson-neutral',
    sourceFile: 'source.mp4',
  });
  assert.equal(props.draftPreview, true);
  assert.equal(props.faceSrc, 'source.mp4');
  assert.equal(props.audioSrc, 'source.mp4');
});

test('approved final props still reject draft', () => {
  assert.throws(
    () => buildReelScenesProps({ brief: makeBrief({ status: 'draft' }), theme: {} }),
    /approved|утвержд/,
  );
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
node --test tests/lesson-brief.test.js tests/lesson-build.test.js tests/review-compatibility.test.js
```

Expected: FAIL because `buildDraftPreviewProps` and `prepareLessonPreview` do not exist.

- [ ] **Step 3: Split common props creation from status-specific gates**

In `scripts/lesson/brief.js`, introduce an unexported `buildLessonProps()` and two exported boundaries:

```js
function buildDraftPreviewProps({ brief, theme, sourceFile = 'source.mp4' }) {
  const result = validateLessonBrief(brief);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  if (brief.status !== 'draft') throw new Error('предпросмотр требует текущий draft');
  return { ...buildLessonProps({ brief, theme, sourceFile, includeMusic: false }), draftPreview: true };
}

function buildReelScenesProps(options) {
  ensureApproved(options.brief);
  return buildLessonProps(options);
}
```

Do not add a flag that makes `buildReelScenesProps()` accept drafts.

- [ ] **Step 4: Implement preview preparation with source and range checks**

Create `scripts/lesson/preview.js` with:

```js
function prepareLessonPreview({ brief, theme, sourceVideo, fromSec = 0, toSec = null })
```

It must:

- require `brief.status === 'draft'`;
- compare `path.resolve(brief.source)` with `path.resolve(sourceVideo)`;
- snap `fromSec` and `toSec` to `brief.output.fps`;
- reject `fromSec < 0`, `toSec <= fromSec`, and `toSec` beyond composition duration;
- return `{composition: 'ReelScenes', props, music, range}`;
- call the same `buildLessonMusicMixArgs()` used by final render.

- [ ] **Step 5: Add workflow regression tests**

Cover:

- draft preview succeeds against the frozen source;
- draft preview rejects another source;
- approved brief is rejected by preview;
- range snaps to FPS;
- preview and final create equal scene/theme/geometry props after removing `draftPreview`;
- final preparation still rejects a draft.

- [ ] **Step 6: Run focused tests**

Run:

```bash
node --test tests/lesson-brief.test.js tests/lesson-build.test.js tests/review-compatibility.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit the isolated boundary**

```bash
git add scripts/lesson/brief.js scripts/lesson/workflow.js scripts/lesson/preview.js tests/lesson-brief.test.js tests/lesson-build.test.js tests/review-compatibility.test.js
git commit -m "feat: add isolated lesson draft preview boundary"
```

---

### Task 2: Reuse safe media materialization without granting a draft final-render lease

**Files:**
- Modify: `scripts/render-media-bundle.js`
- Test: `tests/render-media-bundle.test.js`
- Test: `tests/render-media-bundle-windows.test.js`

**Interfaces:**
- Consumes: draft preview props, draft brief, source path, project workspace.
- Produces: `withPreviewMediaBundle(input, operation)` while preserving `withRenderMediaBundle(input, operation)`.

- [ ] **Step 1: Write failing security tests**

Add these guarantees:

```js
test('draft can acquire only an ephemeral preview media bundle', async () => {
  const result = await withPreviewMediaBundle(draftInput, (lease) => ({
    faceSrc: lease.props.faceSrc,
    publicDirectory: lease.publicDirectory,
  }));
  assert.match(result.faceSrc, /^\.automontage\//);
  assert.equal(fs.existsSync(result.publicDirectory), false);
});

test('draft still cannot acquire an approved render media bundle', () => {
  assert.throws(() => withRenderMediaBundle(draftInput, () => {}), /approved|утвержд/);
});
```

Also assert that preview materialization:

- resolves only canonical project/public media;
- verifies file identity and hashes before and after the callback;
- never writes inside repository `public/`;
- removes its ephemeral directory on success, failure, and signal;
- preserves Windows no-follow behavior.

- [ ] **Step 2: Run the focused bundle tests and verify failure**

```bash
node --test tests/render-media-bundle.test.js tests/render-media-bundle-windows.test.js
```

Expected: FAIL because `withPreviewMediaBundle` is missing.

- [ ] **Step 3: Extract one internal materializer with an explicit policy object**

Use an unexported function:

```js
function withLessonMediaBundle(input, operation, policy) {
  // policy.requireStatus is 'approved' or 'draft'
  // policy.purpose is 'render' or 'preview'
}
```

Export only two closed wrappers:

```js
const withRenderMediaBundle = (input, operation) =>
  withLessonMediaBundle(input, operation, { requireStatus: 'approved', purpose: 'render' });

const withPreviewMediaBundle = (input, operation) =>
  withLessonMediaBundle(input, operation, { requireStatus: 'draft', purpose: 'preview' });
```

Do not export the generic internal function.

- [ ] **Step 4: Run bundle tests**

```bash
node --test tests/render-media-bundle.test.js tests/render-media-bundle-windows.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit the media boundary**

```bash
git add scripts/render-media-bundle.js tests/render-media-bundle.test.js tests/render-media-bundle-windows.test.js
git commit -m "refactor: share safe media leases with draft previews"
```

---

### Task 3: Render a low-resolution draft through the real composition and real audio pipeline

**Files:**
- Modify: `scripts/build-commands.js:55-76`
- Modify: `src/SceneDirector.jsx:49-93`
- Create: `scripts/project/preview-workspace.js`
- Create: `scripts/preview.js`
- Modify: `scripts/cli.js:17-134`
- Modify: `package.json`
- Test: `tests/build-security.test.js`
- Create: `tests/lesson-preview.test.js`
- Create: `tests/scene-draft-preview.test.js`

**Interfaces:**
- Consumes: `automontage preview --project-dir <dir> --brief <draft.json> [--from-sec N --to-sec N] [--no-open]`.
- Produces: immutable `previews/vNN-draft-{full|START-END}.mp4` plus atomic `previews/current-preview.mp4`.

- [ ] **Step 1: Write failing Remotion command tests**

Assert the exact preview argv includes:

```js
assert.deepEqual(command.args.slice(-7), [
  '--codec=h264', '--log=error', '--scale=0.5', '--crf=28',
  '--frames=250-499', '--concurrency=50%', '--overwrite',
]);
```

Keep final-render defaults unchanged when optional preview fields are absent.

- [ ] **Step 2: Extend `remotionRenderCommand()` with typed optional settings**

Add options:

```js
scale = null,
crf = null,
frameRange = null,
concurrency = null,
overwrite = false,
```

Validate them before building argv. Never interpolate a shell string.

- [ ] **Step 3: Add the deterministic watermark test**

`tests/scene-draft-preview.test.js` must verify that `SceneDirector.jsx` renders the literal `ЧЕРНОВИК` only when `draftPreview === true`, above all scenes, inside safe margins, with no theme font substitution.

- [ ] **Step 4: Implement the watermark**

Extend the component signature:

```jsx
export const SceneDirector = ({ draftPreview = false, ...props }) => {
```

Render a fixed, low-opacity top-right watermark after scene layers. It must not alter scene layout or final output when false.

- [ ] **Step 5: Write preview lifecycle tests before implementation**

Cover:

- successful preview writes an immutable revision and atomically replaces `current-preview.mp4`;
- failed Remotion, finish, or music mix leaves the previous current preview byte-identical;
- the preview path stays under `previews/` and rejects symlinks/path traversal;
- preview never calls `runRenderLifecycle()` or updates final render history;
- music runs after voice normalization and no whole-mix loudnorm runs afterward;
- `--from-sec` without `--to-sec`, or vice versa, fails before Remotion;
- output metadata says `full` or the exact source range.

- [ ] **Step 6: Implement `scripts/project/preview-workspace.js`**

Export:

```js
planPreview(workspace, { briefPath, range })
publishCurrentPreview(workspace, planned, stagedMp4, metadata)
```

Use project path resolvers and same-directory staging. Publish metadata only after the MP4 is fully decoded.

- [ ] **Step 7: Implement `scripts/preview.js`**

The command must execute exactly:

1. open project and current draft;
2. `prepareLessonPreview()`;
3. `withPreviewMediaBundle()`;
4. Remotion `ReelScenes` with `--scale=0.5 --crf=28` and optional `--frames`;
5. `finish.js` for clean voice normalization/AAC compensation;
6. `mix-music.js` for sidechain if music exists;
7. full decode plus ffprobe;
8. atomic preview publication;
9. system-browser open unless `--no-open`.

- [ ] **Step 8: Route `automontage preview` and add package script**

Add:

```json
"preview": "node scripts/preview.js"
```

Route the CLI subcommand through `execFileSync()` with `shell: false` semantics, matching `doctor` and `review` safety.

- [ ] **Step 9: Run focused preview tests**

```bash
node --test tests/build-security.test.js tests/lesson-preview.test.js tests/scene-draft-preview.test.js tests/music-ducking.test.js tests/finish-audio-sync.test.js
```

Expected: PASS.

- [ ] **Step 10: Run a real 10-second preview smoke test**

Create a temporary draft copy of `examples/lesson-neutral-approved.json`, set `status` to `draft`, and run the preview command with a 10-second range. Verify H.264/AAC, expected half-scale geometry, exact FPS, full decode, watermark, and audible ducking.

- [ ] **Step 11: Commit the preview renderer**

```bash
git add scripts/build-commands.js src/SceneDirector.jsx scripts/project/preview-workspace.js scripts/preview.js scripts/cli.js package.json package-lock.json tests/build-security.test.js tests/lesson-preview.test.js tests/scene-draft-preview.test.js
git commit -m "feat: render truthful low-resolution lesson previews"
```

---

### Task 4: Show the actual rendered preview inside Review Workbench

**Files:**
- Modify: `schema/project.schema.json`
- Modify: `scripts/project/workspace.js`
- Modify: `scripts/review/model.js`
- Modify: `scripts/review/server.js`
- Modify: `review/index.html`
- Modify: `review/app.js`
- Modify: `review/styles.css`
- Test: `tests/project-workspace.test.js`
- Test: `tests/review-model.test.js`
- Test: `tests/review-server-security.test.js`
- Test: `tests/review-ui.spec.js`

**Interfaces:**
- Consumes: optional `manifest.currentPreview` metadata.
- Produces: token-protected `/media/current-preview` with HTTP Range support and a clearly labeled second player.

- [ ] **Step 1: Add failing backward-compatibility and publication tests**

The project schema must accept old manifests with no preview and new manifests with:

```json
{
  "currentPreview": {
    "filePath": "previews/v03-draft-full.mp4",
    "briefPath": "brief/v03-draft.lesson.json",
    "kind": "full",
    "fromSec": 0,
    "toSec": 94.28,
    "width": 960,
    "height": 540,
    "fps": 25,
    "generatedAt": "2026-08-23T17:05:00.000Z"
  }
}
```

Assert every stored path remains canonical and inside the workspace.

- [ ] **Step 2: Add failing Review state/server tests**

Verify:

- no preview returns `currentPreview: null`;
- a valid preview returns metadata and only `/media/current-preview`, never an absolute path;
- stale, symlinked, replaced, or hash-mismatched files return 404;
- byte ranges return 206 and correct `Content-Range`;
- another session token cannot access the media.

- [ ] **Step 3: Implement manifest migration and Review state**

Keep `currentPreview` optional for version-1 projects. Resolve and identity-check the file at request time, not only at server startup.

- [ ] **Step 4: Add the second player with explicit labels**

The UI copy must be exactly:

- `ИСХОДНИК` / `Видео для правок речи и границ`;
- `СМОНТИРОВАННЫЙ ПРЕДПРОСМОТР` / `Настоящий Remotion-результат`;
- badge `ПОЛНЫЙ РОЛИК` or `ФРАГМЕНТ 00:31.50–00:57.50`;
- empty state `Предпросмотр ещё не собран`.

Do not overlay the source and preview players. The user must never mistake one for the other.

- [ ] **Step 5: Add Playwright coverage**

Check desktop and narrow layouts, full/excerpt labels, source/preview seeking, and preview refresh after manifest update.

- [ ] **Step 6: Run focused Review tests**

```bash
node --test tests/project-workspace.test.js tests/review-model.test.js tests/review-server-security.test.js
npx playwright test tests/review-ui.spec.js --project=chromium --grep "rendered preview|source player"
```

Expected: PASS.

- [ ] **Step 7: Commit browser preview integration**

```bash
git add schema/project.schema.json scripts/project/workspace.js scripts/review/model.js scripts/review/server.js review/index.html review/app.js review/styles.css tests/project-workspace.test.js tests/review-model.test.js tests/review-server-security.test.js tests/review-ui.spec.js
git commit -m "feat: show rendered draft preview in Review Workbench"
```

---

### Task 5: Turn speech cuts into a reusable project cut list

**Files:**
- Create: `schema/source-edit.schema.json`
- Create: `scripts/project/build-master.js`
- Modify: `scripts/trim-media.js`
- Modify: `schema/project.schema.json`
- Modify: `scripts/project/workspace.js`
- Modify: `scripts/cli.js`
- Create: `tests/source-edit.test.js`
- Modify: `tests/trimming-security.test.js`
- Modify: `tests/project-workspace.test.js`

**Interfaces:**
- Consumes: `automontage master --project-dir <dir> --edit edit/vNN-source.json`.
- Produces: immutable `input/source-vNN.mp4`, `transcript/words-vNN.json`, and an atomically selected active source revision.

- [ ] **Step 1: Define the failing schema tests**

The source edit file must have this exact shape:

```json
{
  "version": 1,
  "sourceRevision": 1,
  "fps": 25,
  "keep": [
    {"start": 0, "end": 32.72, "note": "хук и боль"},
    {"start": 64.31, "end": 125.87, "note": "одно подробное объяснение"}
  ]
}
```

Reject overlaps, gaps outside source duration, non-frame boundaries, empty ranges, and source revision mismatch.

- [ ] **Step 2: Write timestamp-remapping tests**

Define and test:

```js
remapTranscriptWords(words, keepRanges, fps)
```

Words fully outside keep ranges disappear. Words crossing a cut snap to the nearest retained frame. Later words shift by the exact duration removed before them. Output stays sorted and has no negative timestamps.

- [ ] **Step 3: Write immutable publication tests**

Assert:

- original `input/source.mp4` remains byte-identical;
- every master gets a new revision path;
- failed encode/decode leaves active source and transcript unchanged;
- selecting a new master clears `currentPreview` because it is stale;
- an existing draft is not silently rewritten or approved.

- [ ] **Step 4: Implement the source edit builder**

Reuse `runTrim()` instead of assembling a new FFmpeg filter in `build-master.js`. Use a temporary output, full decode, ffprobe, and same-directory no-replace publication.

- [ ] **Step 5: Extend project source metadata compatibly**

Store:

```json
"source": {
  "originalPath": "...",
  "originalLocalPath": "input/source.mp4",
  "localPath": "input/source-v02.mp4",
  "revision": 2,
  "history": [
    {
      "revision": 2,
      "localPath": "input/source-v02.mp4",
      "editPath": "edit/v02-source.json",
      "transcriptPath": "transcript/words-v02.json"
    }
  ]
}
```

Migrate old manifests in memory by treating their `localPath` as revision 1 and `originalLocalPath`.

- [ ] **Step 6: Add `automontage master` routing**

The command must print the new master duration, removed duration, source revision, and transcript path. It must not invoke Whisper again.

- [ ] **Step 7: Run focused source-edit tests**

```bash
node --test tests/source-edit.test.js tests/trimming-security.test.js tests/project-workspace.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit reusable source editing**

```bash
git add schema/source-edit.schema.json scripts/project/build-master.js scripts/trim-media.js schema/project.schema.json scripts/project/workspace.js scripts/cli.js tests/source-edit.test.js tests/trimming-security.test.js tests/project-workspace.test.js
git commit -m "feat: add versioned source cut lists"
```

---

### Task 6: Stabilize the scene library as data and golden fixtures

**Files:**
- Create: `docs/SCENE-CATALOG.md`
- Create: `examples/lesson-horizontal-workflow-draft.json`
- Create: `examples/lesson-vertical-workflow-draft.json`
- Modify: `schema/lesson-brief.schema.json`
- Modify: `src/scenes/scenes.jsx`
- Modify: `scripts/gen-brief.js`
- Modify: `tests/lesson-brief.test.js`
- Modify: `tests/scene-split-gradient.test.js`
- Create: `tests/scene-capability-catalog.test.js`

**Interfaces:**
- Consumes: existing seven official scene types and their documented properties.
- Produces: a complete capability catalog and two public drafts that exercise routine editing without component changes.

- [ ] **Step 1: Inventory existing one-off scene properties**

Before editing, compare the dirty worktree with `HEAD` and list every new property, including `side-overlay`, `stepStartsSec`, `showSpeakerPip`, and `centerOnFade`. Keep only properties that solve a repeatable user need and have a regression test.

- [ ] **Step 2: Write catalog conformance tests**

For every property named in `docs/SCENE-CATALOG.md`, assert:

- JSON Schema accepts the documented example;
- the owning scene reads that property;
- the horizontal and vertical golden drafts validate;
- no eighth automatic scene type is introduced.

- [ ] **Step 3: Finish reusable variants with TDD**

The golden drafts must cover:

- speaker on one side, timed text in negative space on the other;
- gradual bullet/step entry tied to word timestamps;
- full-screen video b-roll with `audioMode: "mute"` and no speaker PiP;
- image/video fit and trim;
- final one-second fade with title movement to center;
- theme font/color use, not local FFmpeg font lookup.

Do not add a new scene type for any of these behaviors.

- [ ] **Step 4: Update the generation prompt**

Teach `scripts/gen-brief.js` to select documented variants. Add explicit prompt rules:

- a requested screencast means actual video b-roll, never screenshot zoom/pan;
- points enter on the matching spoken phrase;
- negative space is preferred over splitting the source frame;
- product demo b-roll uses the master voice by default;
- endings keep at least one second for fade/title motion.

- [ ] **Step 5: Run focused catalog tests**

```bash
node --test tests/lesson-brief.test.js tests/scene-split-gradient.test.js tests/scene-capability-catalog.test.js
```

Expected: PASS.

- [ ] **Step 6: Render golden control frames**

Render at least one frame for each catalog capability from both golden drafts. Compare geometry, fonts, safe zones, and b-roll fit. Do not add rendered media to Git.

- [ ] **Step 7: Commit the reusable scene contract**

```bash
git add docs/SCENE-CATALOG.md examples/lesson-horizontal-workflow-draft.json examples/lesson-vertical-workflow-draft.json schema/lesson-brief.schema.json src/scenes/scenes.jsx scripts/gen-brief.js tests/lesson-brief.test.js tests/scene-split-gradient.test.js tests/scene-capability-catalog.test.js
git commit -m "feat: stabilize reusable lesson scene capabilities"
```

---

### Task 7: Correct agent instructions and proportional QA

**Files:**
- Modify: `AGENTS.md`
- Modify: `skills/reel-turnkey/SKILL.md`
- Modify: `skills/reel-turnkey/evals/evals.json`
- Modify: `skills/README.md`
- Create: `scripts/qa-preview.js`
- Modify: `package.json`
- Create: `tests/qa-preview.test.js`
- Modify: `TESTING.md`

**Interfaces:**
- Consumes: active project workspace and `current-preview.mp4`.
- Produces: deterministic client-delivery rules and `npm run qa:preview -- --project-dir <dir>`.

- [ ] **Step 1: Write failing skill evals for the corrected behavior**

Add cases that expect the agent to:

- build a real draft preview before asking for visual approval;
- say `полный ролик` or exact excerpt range;
- refuse to create HTML/FFmpeg design mockups;
- keep all client work inside the project folder;
- create a separate engine task if a capability is truly missing;
- avoid `npm test` for a brief-only revision;
- preserve the final approved-only gate.

- [ ] **Step 2: Replace the contradictory skill instruction**

Replace `Не рендерируй draft` with the exact two-lane rule:

```md
- Draft разрешено рендерить только командой `automontage preview`: тот же ReelScenes,
  watermark, пониженное качество, выход только в `previews/`.
- Финальный рендер, `renders/` и `final/` по-прежнему требуют явного «утверждаю»
  и отдельной approved-копии.
```

- [ ] **Step 3: Add client-delivery mode to the skill**

The section must say:

```md
Во время монтажа одного ролика не меняй `src/`, `scripts/`, `schema/`, общие тесты,
документацию и тему. Все изменения ролика живут в `projects/<id>/`.
Если возможности не хватает, не разрабатывай её внутри ролика: закончи ближайшим
поддержанным вариантом и вынеси доработку движка в отдельную задачу.
```

- [ ] **Step 4: Implement preview QA**

`scripts/qa-preview.js` must verify:

- current preview exists and fully decodes;
- geometry/FPS match preview metadata;
- first and last frames exist;
- full/excerpt range is explicit;
- voice and music-under-speech are measured separately when music exists;
- no final render metadata changed during preview generation.

- [ ] **Step 5: Add proportional test commands**

Add package scripts:

```json
"test:video-edit": "node --test tests/lesson-preview.test.js tests/source-edit.test.js tests/qa-preview.test.js",
"qa:preview": "node scripts/qa-preview.js"
```

`TESTING.md` must define when to use `test:video-edit`, focused engine tests, full `npm test`, and release smoke tests.

- [ ] **Step 6: Run skill and QA tests**

```bash
node --test tests/qa-preview.test.js tests/lesson-preview.test.js tests/source-edit.test.js
npm run test:video-edit
```

Expected: PASS.

- [ ] **Step 7: Commit agent and QA rules**

```bash
git add AGENTS.md skills/reel-turnkey/SKILL.md skills/reel-turnkey/evals/evals.json skills/README.md scripts/qa-preview.js package.json package-lock.json tests/qa-preview.test.js TESTING.md
git commit -m "docs: enforce fast client video delivery workflow"
```

---

### Task 8: Synchronize user documentation and architectural decisions

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `docs/TEMPLATES.md`
- Modify: `docs/REVIEW-WORKBENCH.md`
- Modify: `DECISIONS.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: verified behavior from Tasks 1-7.
- Produces: one consistent public workflow and command reference.

- [ ] **Step 1: Update the public quick path**

Document these commands with real paths and outputs:

```bash
automontage <source.mp4> --template lesson --project "Название"
automontage master --project-dir <project> --edit edit/v02-source.json
automontage review --project-dir <project> --edit
automontage preview --project-dir <project> --brief brief/v03-draft.lesson.json
automontage preview --project-dir <project> --brief brief/v03-draft.lesson.json --from-sec 31.5 --to-sec 57.5
node scripts/project/approve-brief.js <project> brief/v03-draft.lesson.json
automontage <project>/input/source-v02.mp4 --template lesson --project-dir <project> --brief brief/v03-approved.lesson.json --version-label final
```

- [ ] **Step 2: Correct Review Workbench documentation**

State that the source player is for timing/editing and the rendered preview player is the WYSIWYG result. Remove every statement implying that draft cannot be rendered at all; retain the final-render prohibition.

- [ ] **Step 3: Record architectural decisions**

`DECISIONS.md` must explain:

- why preview has a separate boundary instead of weakening approval;
- why it reuses `ReelScenes` and audio finishing;
- why HTML/FFmpeg visual mockups are prohibited;
- why client-delivery mode cannot edit the engine;
- why source cuts are versioned data;
- rejected alternative: full editor inside Review Workbench.

- [ ] **Step 4: Update architecture and changelog**

Add the preview lane, current-preview publication, source-revision lifecycle, and QA profiles to `ARCHITECTURE.md`. Add one `[Unreleased]` entry to `CHANGELOG.md` after behavior is verified.

- [ ] **Step 5: Check documentation consistency**

Run:

```bash
rg -n "draft.*не рендер|не рендер.*draft|rendering draft" AGENTS.md README.md ARCHITECTURE.md TESTING.md docs skills
git diff --check
```

Expected: no blanket draft-render prohibition remains; only final render is approved-only.

- [ ] **Step 6: Commit synchronized documentation**

```bash
git add README.md ARCHITECTURE.md docs/TEMPLATES.md docs/REVIEW-WORKBENCH.md DECISIONS.md CHANGELOG.md
git commit -m "docs: document truthful draft preview workflow"
```

---

### Task 9: Benchmark, full verification, and release gate

**Files:**
- Create: `scripts/benchmark-preview.js`
- Create: `tests/preview-final-equivalence.test.js`
- Modify: `TESTING.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: horizontal/vertical golden drafts and demo media.
- Produces: measured preview/final timings and evidence that preview matches final except for scale/watermark.

- [ ] **Step 1: Write the equivalence regression test**

For the same draft data and an approved copy, compare control frames after resizing preview to final geometry and masking only the watermark bounds. Use a documented image-distance tolerance; fail on missing text, different layout, different font, different b-roll frame, or different theme colors.

- [ ] **Step 2: Implement the benchmark command**

`scripts/benchmark-preview.js` must record JSON with:

```json
{
  "fixture": "horizontal-60s",
  "previewColdMs": 0,
  "previewWarmMs": 0,
  "finalMs": 0,
  "previewToFinalRatio": 0
}
```

Run both horizontal and vertical fixtures. Do not commit generated media or machine-specific benchmark output.

- [ ] **Step 3: Run the focused end-to-end path**

```bash
npm run test:video-edit
node --test tests/preview-final-equivalence.test.js
npm run test:review-ui -- --project=chromium
```

Expected: PASS.

- [ ] **Step 4: Run the full repository gate once**

```bash
npm test
npm run check:release
npm run smoke:release
git diff --check
```

Expected: all non-heavy tests pass, heavy skips remain explained, release check and smoke render pass.

- [ ] **Step 5: Measure acceptance criteria**

Verify and record in the implementation summary:

- one preview command from a saved draft;
- preview at least 2x faster than final on both fixtures;
- second text-only preview completes without transcription or media re-import;
- failed preview preserves previous current preview;
- draft final render still fails before Remotion;
- Review labels source versus rendered preview correctly;
- no private paths, media, or theme files are staged.

- [ ] **Step 6: Update changelog only with measured claims**

Do not write a percentage or time improvement that was not produced by the benchmark. Add the exact supported commands and safety guarantees.

- [ ] **Step 7: Commit verification assets**

```bash
git add scripts/benchmark-preview.js tests/preview-final-equivalence.test.js TESTING.md CHANGELOG.md
git commit -m "test: verify fast preview and final equivalence"
```

---

## Implementation order and stop points

1. **Tasks 1-4 are P0.** They remove the misleading-preview loop. Do not begin source-edit or catalog work until a real draft preview is visible in Review Workbench.
2. **Tasks 5-7 are P1.** They remove repeated manual cuts, one-off scene development, and excessive QA from future client jobs.
3. **Tasks 8-9 are the release gate.** Documentation claims only verified behavior.

After Task 4, run one real internal video through draft preview before continuing. If preview differs from final composition or audio, stop and fix that boundary; do not add more workflow features on top of a false preview.

## Self-review

- Spec coverage: draft/final separation, truthful preview, browser distinction, source cuts, stable scene catalog, audio order, client-delivery boundary, proportional tests, and benchmarks all map to Tasks 1-9.
- Placeholder scan: no unresolved implementation placeholders remain.
- Type consistency: `buildDraftPreviewProps`, `prepareLessonPreview`, `withPreviewMediaBundle`, `planPreview`, `publishCurrentPreview`, and `remapTranscriptWords` have one spelling throughout.
- Safety: no task permits a draft into `runRenderLifecycle()` or the final publisher.
