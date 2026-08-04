# Lesson Brief to ReelScenes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перевести `--template lesson` на утверждаемый монтажный лист из 7 готовых сцен и рендер `ReelScenes` с наследованием или явным переопределением аспекта исходника.

**Architecture:** `gen-brief.js` не создаёт React-сцены, а выбирает только из утверждённой библиотеки и выпускает один JSON-источник истины плюс читаемое Markdown-ТЗ. `build.js` без утверждённого brief останавливается после планирования, а с brief рендерит `ReelScenes`; геометрия вывода рассчитывается отдельной чистой функцией.

**Tech Stack:** Node.js 20, CommonJS, `node:test`, Ajv, Remotion 4, FFmpeg/ffprobe.

## Global Constraints

- Работать только в ветке `agent/lesson-presentation`, не в `main`.
- Официальная библиотека состоит ровно из 7 сцен: `fullscreen`, `split`, `bottom-diagram`, `blur-overlay`, `text-only`, `stat`, `broll`.
- `chart` остаётся экспериментальной сценой и не может попасть в автоматически созданный brief.
- По умолчанию ширина, высота и FPS результата равны исходнику.
- Явный `--aspect vertical` даёт 1080x1920, `--aspect horizontal` даёт 1920x1080; FPS остаётся как у исходника.
- Рендер lesson запрещён, пока JSON имеет статус `draft`; разрешён только статус `approved`.
- Тексты сцен строятся только из речи, а исправления распознавания показываются отдельным списком.
- Не использовать U+2014 в изменяемых файлах.
- Не коммитить приватную тему, `public/source.mp4`, пользовательские данные транскрипта, субтитров и b-roll.

---

### Task 1: Геометрия результата

**Files:**
- Create: `scripts/lesson/aspect.js`
- Test: `tests/lesson-aspect.test.js`

**Interfaces:**
- Consumes: `{sourceWidth, sourceHeight, sourceFps, aspect}`.
- Produces: `resolveOutputGeometry(input) -> {aspect, width, height, fps}`.

- [x] **Step 1: Write the failing tests**

```js
test('source preserves exact source geometry', () => {
  assert.deepEqual(resolveOutputGeometry({sourceWidth: 2560, sourceHeight: 1440, sourceFps: 25, aspect: 'source'}),
    {aspect: 'source', width: 2560, height: 1440, fps: 25});
});

test('vertical overrides dimensions but preserves fps', () => {
  assert.deepEqual(resolveOutputGeometry({sourceWidth: 1920, sourceHeight: 1080, sourceFps: 50, aspect: 'vertical'}),
    {aspect: 'vertical', width: 1080, height: 1920, fps: 50});
});

test('horizontal overrides dimensions but preserves fps', () => {
  assert.deepEqual(resolveOutputGeometry({sourceWidth: 1080, sourceHeight: 1920, sourceFps: 30, aspect: 'horizontal'}),
    {aspect: 'horizontal', width: 1920, height: 1080, fps: 30});
});
```

- [x] **Step 2: Run tests and verify RED**

Run: `node --test tests/lesson-aspect.test.js`
Expected: FAIL because `scripts/lesson/aspect.js` does not exist.

- [x] **Step 3: Implement the resolver**

Implement input validation, aliases `9:16` and `16:9`, exact source preservation and the two fixed output presets. Unknown aspects must throw a clear Russian error listing `source`, `vertical`, `horizontal`.

- [x] **Step 4: Run tests and verify GREEN**

Run: `node --test tests/lesson-aspect.test.js`
Expected: all tests PASS.

- [x] **Step 5: Commit**

```bash
git add scripts/lesson/aspect.js tests/lesson-aspect.test.js
git commit -m "feat(lesson): add output aspect resolver"
```

---

### Task 2: Контракт утверждаемого brief

**Files:**
- Create: `schema/lesson-brief.schema.json`
- Create: `scripts/lesson/brief.js`
- Test: `tests/lesson-brief.test.js`

**Interfaces:**
- Consumes: lesson brief object.
- Produces: `validateLessonBrief(brief, {requireApproved})`, `formatBriefMarkdown(brief)`, `buildReelScenesProps(input)`.

- [x] **Step 1: Write failing validation tests**

Tests must prove these consumer-visible rules:

```js
assert.equal(validateLessonBrief(validDraft).ok, true);
assert.match(validateLessonBrief(validDraft, {requireApproved: true}).errors.join('\n'), /не утверждён/);
assert.match(validateLessonBrief({...validDraft, scenes: [{scene: 'chart', start: 0, end: 2}]}).errors.join('\n'), /chart/);
assert.match(validateLessonBrief({...validDraft, scenes: [{scene: 'split', start: 3, end: 2}]}).errors.join('\n'), /end/);
```

Also assert that props contain `faceSrc: 'source.mp4'`, `audioSrc: 'source.mp4'`, approved scenes, output geometry and full source duration.

- [x] **Step 2: Run tests and verify RED**

Run: `node --test tests/lesson-brief.test.js`
Expected: FAIL because the brief module does not exist.

- [x] **Step 3: Implement schema and brief helpers**

The JSON schema must require `version`, `status`, `source`, `theme`, `title`, `output`, `corrections`, `scenes`. Scene-specific required data:

- `fullscreen`: `caption`;
- `split`: `headCream`, `headOrange`, `bullets`;
- `bottom-diagram`: `headCream`, `headOrange`, `steps`;
- `blur-overlay`: `big`, `headCream`, `headOrange`;
- `text-only`: `quoteCream`, `quoteOrange`;
- `stat`: `statCream`, `statOrange`, `headCream`, `headOrange`;
- `broll`: `brollSrc`, `headCream`, `headOrange`.

Semantic validation must reject non-positive intervals, overlaps, an empty scene list and a draft when `requireApproved` is true. Markdown output must include output aspect, scene table and correction table.

- [x] **Step 4: Run tests and verify GREEN**

Run: `node --test tests/lesson-brief.test.js`
Expected: all tests PASS.

- [x] **Step 5: Commit**

```bash
git add schema/lesson-brief.schema.json scripts/lesson/brief.js tests/lesson-brief.test.js
git commit -m "feat(lesson): define approved scene brief"
```

---

### Task 3: Генератор ТЗ из транскрипта

**Files:**
- Create: `scripts/data/proofread-dictionary.json`
- Create: `scripts/gen-brief.js`
- Test: `tests/gen-brief.test.js`

**Interfaces:**
- Consumes: whisper transcript JSON, theme, title, output geometry and optional b-roll list.
- Produces: normalized draft brief JSON and matching Markdown.

- [x] **Step 1: Write failing tests for deterministic behavior**

Tests must run real exported helpers and prove:

```js
const proofread = applyDictionary([{start: 1, end: 3, text: 'Агент от Адая и нейроагенда'}], dictionary);
assert.equal(proofread.segments[0].text, 'Агент от А до Я и нейроагента');
assert.equal(proofread.corrections.length, 2);

const brief = normalizeGeneratedBrief({scenes: [{scene: 'chart', start: 0, end: 2}]}, context);
assert.equal(brief.scenes[0].scene, 'split');
assert.equal(brief.status, 'draft');
```

Add cases for sorting intervals, clipping text arrays and excluding `broll` without an available `brollSrc`.

- [x] **Step 2: Run tests and verify RED**

Run: `node --test tests/gen-brief.test.js`
Expected: FAIL because `gen-brief.js` does not exist.

- [x] **Step 3: Implement dictionary, prompt and normalizer**

Use the existing provider order: Anthropic when `ANTHROPIC_API_KEY` exists, otherwise OpenAI. The prompt must say that it is a director choosing from fixed components, forbid invented facts and forbid `chart`. Specialty scenes with missing required data normalize to `split`; `broll` is allowed only when its file is in the supplied available list. Merge deterministic dictionary corrections with additional LLM corrections.

CLI contract:

```bash
node scripts/gen-brief.js src/data/transcript.json out/id.lesson.json \
  --markdown out/id.lesson.md --theme dima-grunge --title "ТЕМА" \
  --aspect vertical --width 1080 --height 1920 --fps 30 --duration 120
```

- [x] **Step 4: Run tests and verify GREEN**

Run: `node --test tests/gen-brief.test.js`
Expected: all tests PASS.

- [x] **Step 5: Commit**

```bash
git add scripts/data/proofread-dictionary.json scripts/gen-brief.js tests/gen-brief.test.js
git commit -m "feat(lesson): generate reviewable scene briefs"
```

---

### Task 4: Двухступенчатый lesson workflow в build.js

**Files:**
- Modify: `scripts/build.js`
- Modify: `scripts/cli.js`
- Modify: `package.json`
- Test: `tests/lesson-build.test.js`

**Interfaces:**
- Consumes: `--template lesson`, optional `--aspect`, optional `--brief`.
- Produces: draft brief and exit when `--brief` is absent; `ReelScenes` render when approved brief is supplied.

- [x] **Step 1: Write failing workflow tests**

Extract and test `getLessonAction({isLesson, briefFile})` and `prepareLessonRender(...)` so tests assert behavior rather than source text:

```js
assert.equal(getLessonAction({isLesson: true, briefFile: null}), 'plan');
assert.equal(getLessonAction({isLesson: true, briefFile: 'approved.json'}), 'render');
assert.throws(() => prepareLessonRender({brief: draftBrief, sourceMeta}), /не утверждён/);
assert.equal(prepareLessonRender({brief: approvedBrief, sourceMeta}).composition, 'ReelScenes');
```

- [x] **Step 2: Run tests and verify RED**

Run: `node --test tests/lesson-build.test.js`
Expected: FAIL because the workflow helpers do not exist.

- [x] **Step 3: Implement plan mode and approved render mode**

`--template lesson` without `--brief` must transcribe, invoke `gen-brief.js`, print both output paths and exit before Remotion. `--template lesson --brief file.json` must skip LLM and transcription, require `approved`, copy the supplied video to ignored `public/source.mp4`, resolve the external theme, write props with `faceSrc` and `audioSrc`, and render composition `ReelScenes`.

Default lesson theme becomes `dima-grunge`. The approved brief freezes aspect and dimensions; changing aspect requires a new draft and a new approval.

- [x] **Step 4: Run tests and verify GREEN**

Run: `node --test tests/lesson-build.test.js`
Expected: all tests PASS.

- [x] **Step 5: Run the full unit suite**

Run: `npm test`
Expected: all lesson tests PASS with no warnings.

- [x] **Step 6: Commit**

```bash
git add scripts/build.js scripts/cli.js package.json tests/lesson-build.test.js
git commit -m "feat(lesson): render approved briefs with ReelScenes"
```

---

### Task 5: Документация и реальная проверка

**Files:**
- Modify: `docs/TEMPLATES.md`
- Modify: `_progress.md`

**Interfaces:**
- Consumes: completed plan and render commands.
- Produces: user-facing two-stage recipe and verification record.

- [x] **Step 1: Update the lesson documentation**

Document natural default `source`, explicit `vertical` and `horizontal`, draft/approved gate, 7 fixed scenes, private `THEMES_EXT` loading and the fact that `chart` is not part of the official library.

- [x] **Step 2: Verify the draft gate with a fixture transcript**

Run `gen-brief.js` helper tests and validate a fixture draft. Confirm `build.js` refuses it before rendering.

- [x] **Step 3: Render one approved horizontal brief**

Use local `public/source.mp4`, local external `dima-grunge`, a short approved brief and `--frames` only if the render contract supports it without changing approved geometry. Verify with ffprobe: H.264, 1920x1080, source FPS, audio present.

- [x] **Step 4: Render one approved vertical still or short sample from the same horizontal source**

Verify 1080x1920 output and inspect the speaker crop and safe zone visually.

- [x] **Step 5: Check repository hygiene**

Run:

```bash
node -e "const fs=require('fs'); const bad=String.fromCodePoint(0x2014); const files=process.argv.slice(1); for (const f of files) if (fs.existsSync(f) && fs.readFileSync(f,'utf8').includes(bad)) console.log(f)" scripts/gen-brief.js scripts/build.js scripts/cli.js schema/lesson-brief.schema.json docs/TEMPLATES.md _progress.md
git diff --check
git status --short
```

Expected: no U+2014 in task files, no whitespace errors, no private assets staged.

- [x] **Step 6: Commit**

```bash
git add docs/TEMPLATES.md _progress.md docs/superpowers/plans/2026-08-04-lesson-brief-reelscenes.md
git commit -m "docs: document approved lesson workflow"
```
