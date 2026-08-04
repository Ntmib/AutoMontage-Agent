# Reel Project Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Каждый новый ролик живёт в отдельной локальной папке `projects/YYYY.MM.DD_latin-slug/`, где хранятся исходник, все ревизии ТЗ, активы, превью, версии рендера и канонический финал.

**Architecture:** Новый модуль `scripts/project/workspace.js` владеет именованием, структурой папок, копией исходника, версиями и `project.json`. `build.js` передаёт модулю все пути в project-режиме, но сохраняет текущий плоский `out/` без `--project`. Навык `reel-turnkey` всегда включает project-режим.

**Tech Stack:** Node.js 20 CommonJS, `node:test`, ffmpeg/ffprobe, Remotion, JSON manifest, Markdown documentation.

## Global Constraints

- Работать только в ветке `agent/lesson-presentation`, не в `main`.
- Формат по умолчанию равен исходнику; `vertical` и `horizontal` остаются явными override.
- Имя папки: `YYYY.MM.DD_<latin-slug>`, например `2026.08.05_claude-code-montage`.
- Кириллица в названии автоматически транслитерируется в латиницу.
- Исходник копируется в project-папку один раз; версии не дублируют исходник.
- Каждый новый plan получает ревизию `vNN`; каждый рендер получает `renders/vNN-<label>/`.
- `final/<slug>.mp4` всегда копирует последний успешный рендер, а все прошлые версии остаются.
- В `project.json` хранятся только относительные project-пути; API-ключей и секретов в нём нет.
- `projects/` локален и полностью игнорируется Git.
- Приватные темы остаются в `THEMES_EXT`; в проект пишется только id темы.
- Новый код пишется только после падающего теста.
- В файлах не использовать U+2014; разрешён U+2013.
- Push не выполнять, только подготовить к нему проверенные коммиты.

---

## Target File Structure

```text
projects/
└── 2026.08.05_claude-code-montage/
    ├── project.json
    ├── input/
    │   └── source.mp4
    ├── brief/
    │   ├── v01-draft.lesson.json
    │   ├── v01-draft.lesson.md
    │   └── v01-approved.lesson.json
    ├── assets/
    │   ├── music/
    │   └── broll/
    ├── previews/
    │   ├── audio-a.mp4
    │   ├── audio-b.mp4
    │   └── contact-sheet.jpg
    ├── renders/
    │   └── v01-ducking/
    │       ├── props.json
    │       ├── raw.mp4
    │       └── final.mp4
    └── final/
        └── claude-code-montage.mp4
```

## Manifest Contract

```json
{
  "version": 1,
  "id": "2026.08.05_claude-code-montage",
  "name": "Claude Code montage",
  "slug": "claude-code-montage",
  "createdAt": "2026-08-05T00:00:00.000Z",
  "updatedAt": "2026-08-05T00:00:00.000Z",
  "source": {
    "originalPath": "/absolute/input/C0027.MP4",
    "localPath": "input/source.mp4"
  },
  "briefs": [],
  "renders": [],
  "currentBrief": null,
  "latestRender": null,
  "final": "final/claude-code-montage.mp4"
}
```

### Task 0: Commit the Existing Public Documentation Baseline

**Files:**
- Commit existing staged public documentation, CI and security files without `src/data/transcript.json` or `src/data/captions.js`.

**Interfaces:**
- Consumes: current staged documentation/security set already validated in the previous task.
- Produces: a clean public baseline commit so project-workspace commits remain reviewable.

- [ ] **Step 1: Inspect the exact staged set**

Run: `git diff --cached --name-status && git diff --cached --check`

Expected: only public docs, CI, hook, `.env.example`, `.gitignore` and deletion of tracked `_progress.md`; no media or transcript data.

- [ ] **Step 2: Re-run baseline verification**

Run: `npm test`

Expected: 49 tests pass.

- [ ] **Step 3: Commit the staged baseline without staging working-tree transcripts**

```bash
git commit -m "chore: add project docs and repository safeguards"
```

- [ ] **Step 4: Verify the remaining worktree**

Run: `git status --short`

Expected: only local tracked transcript/captions changes and new feature work remain.

### Task 1: Project Naming, Structure and Manifest

**Files:**
- Create: `scripts/project/workspace.js`
- Create: `tests/project-workspace.test.js`

**Interfaces:**
- Produces: `slugifyProjectName(name): string`
- Produces: `formatProjectId({date, name}): string`
- Produces: `createOrOpenProject({baseDir, name, projectDir, sourcePath, now}): ProjectWorkspace`
- Produces: `readProjectManifest(projectDir): ProjectManifest`
- Produces: `writeProjectManifest(projectDir, manifest): void`
- `ProjectWorkspace` contains absolute `dir`, `manifestPath`, `sourcePath` and parsed `manifest`.

- [ ] **Step 1: Write failing naming tests**

```js
test('project id uses a full dotted date and latin slug', () => {
  assert.equal(formatProjectId({
    date: new Date('2026-08-05T12:00:00Z'),
    name: 'Монтаж Claude Code',
  }), '2026.08.05_montazh-claude-code');
});

test('project slug rejects a name with no letters or digits', () => {
  assert.throws(() => slugifyProjectName('...'), /названи/);
});
```

- [ ] **Step 2: Run RED for naming**

Run: `node --test tests/project-workspace.test.js`

Expected: FAIL because `scripts/project/workspace.js` does not exist.

- [ ] **Step 3: Implement transliteration and naming**

```js
function slugifyProjectName(name) {
  const latin = transliterate(String(name || '').trim().toLowerCase());
  const slug = latin.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('название проекта не содержит букв или цифр');
  return slug;
}
```

- [ ] **Step 4: Verify GREEN for naming**

Run: `node --test tests/project-workspace.test.js`

Expected: naming tests pass.

- [ ] **Step 5: Write failing filesystem tests**

Use a real `fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-project-'))`, write a small `source.mp4` fixture, then assert literal paths:

```js
assert.equal(path.basename(workspace.dir), '2026.08.05_test-rolik');
assert.equal(fs.readFileSync(workspace.sourcePath, 'utf8'), 'video');
assert.ok(fs.existsSync(path.join(workspace.dir, 'assets/music')));
assert.equal(workspace.manifest.source.localPath, 'input/source.mp4');
```

Add separate tests that reopen the same project idempotently and reject a different source for an existing project.

- [ ] **Step 6: Run RED for filesystem behavior**

Run: `node --test tests/project-workspace.test.js`

Expected: FAIL because project creation and manifest functions are missing.

- [ ] **Step 7: Implement project creation and manifest persistence**

Create exactly these directories: `input`, `brief`, `assets/music`, `assets/broll`, `previews`, `renders`, `final`. Copy the source to `input/source<original-extension>`. Store all project-owned paths in the manifest relative to the project root and reject a source mismatch on resume.

- [ ] **Step 8: Verify GREEN and refactor**

Run: `node --test tests/project-workspace.test.js && npm test`

Expected: all new tests and the existing 49 tests pass.

- [ ] **Step 9: Commit**

```bash
git add scripts/project/workspace.js tests/project-workspace.test.js
git commit -m "feat(projects): add isolated reel workspaces"
```

### Task 2: Brief and Render Version Allocation

**Files:**
- Modify: `scripts/project/workspace.js`
- Modify: `tests/project-workspace.test.js`

**Interfaces:**
- Produces: `nextBriefPaths(workspace): {revision, jsonPath, markdownPath}`
- Produces: `recordBrief(workspace, {revision, jsonPath, markdownPath, status, theme, aspect}): ProjectWorkspace`
- Produces: `nextRenderPaths(workspace, label): {version, label, dir, propsPath, rawPath, finalPath}`
- Produces: `recordRender(workspace, {version, label, dir, briefPath, status}): ProjectWorkspace`
- Produces: `publishFinal(workspace, renderFinalPath): string`

- [ ] **Step 1: Write failing brief revision tests**

```js
assert.equal(path.basename(first.jsonPath), 'v01-draft.lesson.json');
recordBrief(workspace, {revision: 1, jsonPath: first.jsonPath, markdownPath: first.markdownPath, status: 'draft'});
assert.equal(path.basename(nextBriefPaths(workspace).jsonPath), 'v02-draft.lesson.json');
```

- [ ] **Step 2: Run RED for brief revisions**

Run: `node --test tests/project-workspace.test.js`

Expected: FAIL because revision functions are missing.

- [ ] **Step 3: Implement brief revision allocation and recording**

Revision numbers are derived from the manifest, not directory glob order. Persist `currentBrief` as a project-relative JSON path.

- [ ] **Step 4: Verify GREEN for brief revisions**

Run: `node --test tests/project-workspace.test.js`

Expected: brief revision tests pass.

- [ ] **Step 5: Write failing render version tests**

```js
const first = nextRenderPaths(workspace, 'Новая музыка');
assert.equal(path.basename(first.dir), 'v01-novaya-muzyka');
fs.writeFileSync(first.finalPath, 'render');
recordRender(workspace, {version: 1, label: first.label, dir: first.dir, status: 'complete'});
assert.equal(path.basename(nextRenderPaths(workspace, 'Ducking').dir), 'v02-ducking');
assert.equal(fs.readFileSync(publishFinal(workspace, first.finalPath), 'utf8'), 'render');
```

- [ ] **Step 6: Run RED for render versions**

Run: `node --test tests/project-workspace.test.js`

Expected: FAIL because render functions are missing.

- [ ] **Step 7: Implement render allocation, manifest history and canonical final**

Every render directory contains `props.json`, `raw.mp4`, `final.mp4`. `recordRender` appends history and updates `latestRender`; `publishFinal` copies the successful version to `final/<slug>.mp4` without deleting older versions.

- [ ] **Step 8: Verify GREEN and commit**

Run: `node --test tests/project-workspace.test.js && npm test`

```bash
git add scripts/project/workspace.js tests/project-workspace.test.js
git commit -m "feat(projects): version briefs and renders"
```

### Task 3: Route build.js Through Project Workspaces

**Files:**
- Modify: `scripts/build.js:1-430`
- Modify: `tests/lesson-build.test.js`
- Create: `scripts/project/build-context.js`
- Create: `tests/project-build-context.test.js`

**Interfaces:**
- Produces: `createBuildContext({root, cwd, video, projectName, projectDir, versionLabel, now}): BuildContext`
- `BuildContext` exposes `video`, `project`, `briefPaths`, `renderPaths`, `legacy(id)` and `resolveBrief(input)`.
- Consumes all path/version functions from `scripts/project/workspace.js`.

- [ ] **Step 1: Write failing context tests**

Test real temporary directories and literal outcomes:

```js
assert.equal(context.video, path.join(context.project.dir, 'input/source.mp4'));
assert.equal(context.briefPaths.jsonPath, path.join(context.project.dir, 'brief/v01-draft.lesson.json'));
assert.equal(context.resolveBrief('brief/v01-approved.lesson.json'), path.join(context.project.dir, 'brief/v01-approved.lesson.json'));
```

Add a legacy test proving that without `--project` paths remain `out/<id>.lesson.json`, `out/<id>.raw.mp4` and `out/<id>.mp4`.

- [ ] **Step 2: Run RED for build context**

Run: `node --test tests/project-build-context.test.js`

Expected: FAIL because `build-context.js` does not exist.

- [ ] **Step 3: Implement minimal build context**

The context must not render or invoke ffmpeg. It only resolves and creates project-owned paths, allowing unit tests without browser or media dependencies.

- [ ] **Step 4: Verify GREEN for build context**

Run: `node --test tests/project-build-context.test.js`

Expected: project and legacy path tests pass.

- [ ] **Step 5: Write failing lesson integration assertions**

Extend `tests/lesson-build.test.js` so a project brief freezes the copied `input/source.mp4`, project render paths are versioned, and a supplied different source is rejected.

- [ ] **Step 6: Run RED for lesson integration**

Run: `node --test tests/lesson-build.test.js tests/project-build-context.test.js`

Expected: at least one new assertion fails because `build.js` still hardcodes `out/`.

- [ ] **Step 7: Replace hardcoded lesson paths in build.js**

Parse:

```js
const projectName = opt('project', null);
const projectDir = opt('project-dir', null);
const versionLabel = opt('version-label', 'render');
```

When project mode is active:

- use copied project source before ffprobe and brief generation;
- create `brief/vNN-draft.lesson.json` and Markdown;
- resolve a relative `--brief` from the project root;
- render props/raw/final into `renders/vNN-<label>/`;
- run finish and music ducking inside the same render version;
- after success update `project.json` and publish `final/<slug>.mp4`;
- keep `--outdir` as an optional extra copy.

- [ ] **Step 8: Route Dynamic outputs as well**

In project mode, generated Dynamic scenario revisions go to `brief/vNN-draft.scenario.json`, while props/raw/final use the same versioned render directory contract. Without project mode, preserve all existing `out/<id>.*` paths.

- [ ] **Step 9: Verify all path behavior**

Run: `node --test tests/project-build-context.test.js tests/lesson-build.test.js && npm test`

Expected: project tests plus all previous tests pass.

- [ ] **Step 10: Commit**

```bash
git add scripts/build.js scripts/project/build-context.js tests/project-build-context.test.js tests/lesson-build.test.js
git commit -m "feat(projects): route builds into versioned folders"
```

### Task 4: CLI Contract and Turnkey Skill

**Files:**
- Create: `scripts/project/cli-options.js`
- Create: `tests/project-cli-options.test.js`
- Modify: `scripts/cli.js:12-80`
- Modify: `skills/reel-turnkey/SKILL.md`
- Modify: `skills/reel-turnkey/references/brief-package.md`
- Modify: `skills/reel-turnkey/references/qa-checklist.md`

**Interfaces:**
- Produces: `ensureOutputDestination(args, cwd): string[]`
- Project flags: `--project <name-or-id>`, `--project-dir <path>`, `--version-label <label>`.

- [ ] **Step 1: Write failing CLI option tests**

```js
assert.deepEqual(ensureOutputDestination(['video.mp4'], '/work'), ['video.mp4', '--outdir', '/work']);
assert.deepEqual(ensureOutputDestination(['video.mp4', '--project', 'Тема'], '/work'), ['video.mp4', '--project', 'Тема']);
assert.deepEqual(ensureOutputDestination(['video.mp4', '--project-dir', '/work/projects/demo'], '/work'), ['video.mp4', '--project-dir', '/work/projects/demo']);
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/project-cli-options.test.js`

Expected: FAIL because `cli-options.js` does not exist.

- [ ] **Step 3: Implement the option helper and wire CLI help**

Project mode owns its output directory, so the global CLI must not append a duplicate `--outdir`. Legacy mode keeps the current behavior.

- [ ] **Step 4: Verify GREEN**

Run: `node --test tests/project-cli-options.test.js && node scripts/cli.js --help`

Expected: tests pass and help documents all three project flags.

- [ ] **Step 5: Update reel-turnkey**

At intake, derive one Latin project name, run the plan command with `--project "<name>"`, keep music/b-roll/previews inside the returned project directory, approve by copying the reviewed draft to `vNN-approved.lesson.json`, and render with `--project-dir` plus a meaningful `--version-label` such as `first-render`, `new-music` or `ducking`.

- [ ] **Step 6: Validate all skill entry points**

Run the skill-creator `quick_validate.py` for `skills/reel-turnkey`, `.claude/skills/reel-turnkey` and `.codex/skills/reel-turnkey`.

Expected: all three print `Skill is valid!`.

- [ ] **Step 7: Commit**

```bash
git add scripts/cli.js scripts/project/cli-options.js tests/project-cli-options.test.js skills/reel-turnkey
git commit -m "feat(skill): keep each reel in its own project"
```

### Task 5: Public Documentation and Git Privacy

**Files:**
- Modify: `.gitignore`
- Modify: `README.md`
- Modify: `docs/TEMPLATES.md`
- Modify: `ARCHITECTURE.md`
- Modify: `TESTING.md`
- Modify: `DECISIONS.md`
- Modify: `CHANGELOG.md`
- Modify: `skills/README.md`

**Interfaces:**
- Documents the public CLI and the private local project boundary.

- [ ] **Step 1: Add the local project root to ignore rules**

Add exactly:

```gitignore
# локальные проекты роликов: исходники, музыка, версии и финалы
projects/
```

- [ ] **Step 2: Document creation and continuation**

Use these runnable examples:

```bash
node scripts/build.js video.mp4 --template lesson --project "AI agent lesson" --aspect source --theme lesson-neutral
node scripts/build.js video.mp4 --template lesson --project-dir projects/2026.08.05_ai-agent-lesson --brief brief/v01-approved.lesson.json --version-label first-render
node scripts/build.js video.mp4 --template lesson --project-dir projects/2026.08.05_ai-agent-lesson --brief brief/v01-approved.lesson.json --version-label ducking
```

- [ ] **Step 3: Record the architecture decision**

Add a decision stating: `out/` is a legacy/cache path; `projects/` is the user-owned local workspace; project mode is opt-in at CLI level and mandatory in `reel-turnkey`; media never enters Git.

- [ ] **Step 4: Document testing and changelog evidence**

Add project workspace unit tests, manifest/path checks, skill validation and a manual local C0027 migration check to `TESTING.md` and `CHANGELOG.md`.

- [ ] **Step 5: Check public files for privacy and punctuation**

Run:

```bash
rg -n $'\u2014|/Users/|macbook|automontage-dima-brand|OPENAI_API_KEY=' .gitignore README.md docs/TEMPLATES.md ARCHITECTURE.md TESTING.md DECISIONS.md CHANGELOG.md skills scripts/project tests/project-*.test.js
```

Expected: no U+2014, personal paths, private repo names or secret values.

- [ ] **Step 6: Run tests and commit**

Run: `npm test`

```bash
git add .gitignore README.md docs/TEMPLATES.md ARCHITECTURE.md TESTING.md DECISIONS.md CHANGELOG.md skills/README.md
git commit -m "docs: document isolated reel projects"
```

### Task 6: Organize the Existing C0027 Reel Locally

**Files:**
- Create locally, ignored: `projects/2026.08.04_claude-code-montage/**`
- Do not modify or delete existing `out/c0027-*` artifacts.

**Interfaces:**
- Consumes: the existing C0027 source, briefs, contact sheets and v1-v9 MP4 files.
- Produces: a resumable project folder and manifest that a new chat can inspect.

- [ ] **Step 1: Initialize the project with the original C0027 source**

Create `projects/2026.08.04_claude-code-montage` using the workspace module and copy the source once to `input/source.MP4`.

- [ ] **Step 2: Preserve brief history**

Copy the original and v2 Markdown/JSON briefs into `brief/` with revision names. Do not change their content during migration.

- [ ] **Step 3: Preserve render history without deleting out/**

Create these version folders and copy or hard-link the matching final MP4 plus props where available:

```text
v01-first-render
v02-rhythm
v03-new-rap-beat
v04-quieter-music
v05-background-music
v06-minus-15db
v07-half-volume
v08-minus-50db
v09-ducking
```

- [ ] **Step 4: Copy review artifacts**

Place the v2 contact sheet and useful review frames under `previews/`. Place the selected licensed music and its source/license note under `assets/music/` when the local file is available.

- [ ] **Step 5: Publish the accepted final**

Copy or hard-link v9 to `final/claude-code-montage.mp4` and record v9 as `latestRender` in `project.json`.

- [ ] **Step 6: Verify the migrated project**

Check:

- source, brief, v1-v9 and final exist;
- final decodes fully;
- project manifest contains only project-relative owned paths except the historical `source.originalPath`;
- `git status --short` does not list anything under `projects/`.

No commit is created because the entire project directory is private and ignored.

### Task 7: Final Verification and Push Readiness Audit

**Files:**
- Update locally: `_progress.md`, project memory and daily memory.
- No additional production files unless verification finds a defect.

**Interfaces:**
- Produces: a reviewed commit stack ready for an explicitly approved push.

- [ ] **Step 1: Run the full automated suite**

Run:

```bash
npm test
npm run doctor
python3 /Users/macbookledovskih/.agents/skills/skill-creator/scripts/quick_validate.py skills/reel-turnkey
python3 /Users/macbookledovskih/.agents/skills/skill-creator/scripts/quick_validate.py .claude/skills/reel-turnkey
python3 /Users/macbookledovskih/.agents/skills/skill-creator/scripts/quick_validate.py .codex/skills/reel-turnkey
```

Expected: all tests pass, doctor has no required dependency failures, all skill entries are valid.

- [ ] **Step 2: Audit every commit and staged file**

Run:

```bash
git status --short --branch
git log --oneline origin/agent/lesson-presentation..HEAD
git diff origin/agent/lesson-presentation...HEAD --check
```

Confirm that `src/data/transcript.json`, `src/data/captions.js`, `projects/`, `out/`, source video, music and private theme files are absent from commits.

- [ ] **Step 3: Run secret scanning**

Run the configured pre-commit hook through normal commits and run Gitleaks against the branch diff or repository history according to `TESTING.md`.

Expected: zero leaks.

- [ ] **Step 4: Review documentation consistency**

Verify that README, CLI help, `docs/TEMPLATES.md`, architecture, decisions, testing guide and `reel-turnkey` use the same flag names and folder contract.

- [ ] **Step 5: Update local progress and memory**

Record the project folder contract, current C0027 location, commit ids, test count and the fact that push has not occurred.

- [ ] **Step 6: Stop before push**

Report the exact branch, commits, verification evidence and remaining local-only changes. Ask for explicit permission before `git push`.
