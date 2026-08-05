const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { formatBriefMarkdown } = require('../scripts/lesson/brief');

const {
  approveBrief,
  createOrOpenProject,
  formatProjectId,
  nextBriefPaths,
  nextRenderPaths,
  publishFinal,
  readProjectManifest,
  recordBrief,
  recordRender,
  resolveProjectPath,
  runRenderLifecycle,
  slugifyProjectName,
  writeProjectManifest,
} = require('../scripts/project/workspace');
const { prepareLessonRender } = require('../scripts/lesson/workflow');

function makeFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-project-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, 'camera.MP4');
  fs.writeFileSync(sourcePath, 'video');
  return { dir, sourcePath };
}

test('project id uses a full dotted date and latin slug', () => {
  assert.equal(formatProjectId({
    date: new Date('2026-08-05T12:00:00Z'),
    name: 'Монтаж Claude Code',
  }), '2026.08.05_montazh-claude-code');
});

test('project slug rejects a name with no letters or digits', () => {
  assert.throws(() => slugifyProjectName('...'), /названи/);
});

test('manifest rejects traversal and non-canonical final paths without touching an outside file', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Manifest paths',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const sentinelPath = path.join(fixture.dir, 'outside.mp4');
  fs.writeFileSync(sentinelPath, 'do-not-touch');
  const maliciousPaths = [
    '../../outside.mp4',
    '../outside.mp4',
    '/tmp/outside.mp4',
    'C:\\temp\\outside.mp4',
    'C:outside.mp4',
    '..\\..\\outside.mp4',
    'renders/../outside.mp4',
    'renders//final.mp4',
  ];

  for (const maliciousPath of maliciousPaths) {
    const manifest = { ...workspace.manifest, final: maliciousPath };
    fs.writeFileSync(
      path.join(workspace.dir, 'project.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    assert.throws(
      () => readProjectManifest(workspace.dir),
      /final/,
      `read rejects ${JSON.stringify(maliciousPath)} with the field name`,
    );
    assert.throws(
      () => writeProjectManifest(workspace.dir, manifest),
      /final/,
      `write rejects ${JSON.stringify(maliciousPath)} with the field name`,
    );
    assert.equal(fs.readFileSync(sentinelPath, 'utf8'), 'do-not-touch');
  }

  const validManifest = { ...workspace.manifest, final: 'renders/final/final.mp4' };
  fs.writeFileSync(
    path.join(workspace.dir, 'project.json'),
    `${JSON.stringify(validManifest, null, 2)}\n`,
  );
  assert.equal(readProjectManifest(workspace.dir).final, 'renders/final/final.mp4');
});

test('manifest rejects a final path that escapes through a symbolic link', (t) => {
  const fixture = makeFixture(t);
  const projectDir = path.join(fixture.dir, 'project');
  const workspace = createOrOpenProject({
    projectDir,
    name: 'Symbolic link',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const outsideDir = path.join(fixture.dir, 'outside');
  fs.mkdirSync(outsideDir);
  fs.symlinkSync('../../outside', path.join(workspace.dir, 'renders', 'link'), 'dir');
  const manifest = { ...workspace.manifest, final: 'renders/link/final.mp4' };
  fs.writeFileSync(
    path.join(workspace.dir, 'project.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  assert.throws(() => readProjectManifest(workspace.dir), /final.*symbolic link/i);
  assert.equal(fs.existsSync(path.join(outsideDir, 'final.mp4')), false);
});

test('project paths reject dangling final and intermediate symlinks before creating outside data', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    projectDir: path.join(fixture.dir, 'project'),
    name: 'Dangling links',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const outsideFinal = path.join(fixture.dir, 'outside-final.json');
  const outsideDirectory = path.join(fixture.dir, 'outside-directory');
  fs.symlinkSync(outsideFinal, path.join(workspace.dir, 'brief', 'dangling-final.json'));
  fs.symlinkSync(outsideDirectory, path.join(workspace.dir, 'renders', 'dangling-dir'));

  assert.throws(
    () => resolveProjectPath(workspace.dir, 'brief/dangling-final.json', { mustExist: false }),
    /symbolic link/i,
  );
  assert.throws(
    () => resolveProjectPath(workspace.dir, 'renders/dangling-dir/owned.json', { mustExist: false }),
    /symbolic link/i,
  );
  assert.equal(fs.existsSync(outsideFinal), false);
  assert.equal(fs.existsSync(outsideDirectory), false);
});

test('manifest write ignores a predictable temp symlink and publishes a regular manifest', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    projectDir: path.join(fixture.dir, 'project'),
    name: 'Safe manifest temp',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const sentinel = path.join(fixture.dir, 'manifest-sentinel.json');
  fs.writeFileSync(sentinel, 'outside-must-survive');
  fs.symlinkSync(sentinel, path.join(workspace.dir, 'project.json.tmp'));

  const updated = { ...workspace.manifest, updatedAt: '2026-08-06T00:00:00.000Z' };
  writeProjectManifest(workspace.dir, updated);

  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside-must-survive');
  assert.equal(fs.lstatSync(path.join(workspace.dir, 'project.json')).isFile(), true);
  assert.equal(fs.lstatSync(path.join(workspace.dir, 'project.json')).isSymbolicLink(), false);
  assert.equal(readProjectManifest(workspace.dir).updatedAt, updated.updatedAt);
});

test('manifest rejects non-canonical slugs and accepts canonical lowercase tokens', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    projectDir: path.join(fixture.dir, 'project'),
    name: 'Canonical slug',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });

  for (const slug of ['../outside', 'nested/slug', 'Uppercase', 'two--hyphens', '-leading']) {
    assert.throws(
      () => writeProjectManifest(workspace.dir, { ...workspace.manifest, slug }),
      /manifest\/slug/,
      slug,
    );
  }
  assert.doesNotThrow(() => writeProjectManifest(workspace.dir, {
    ...workspace.manifest,
    slug: 'safe-project-01',
  }));
});

test('manifest migration adds the canonical transcript paths before validation', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Legacy manifest',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const legacyManifest = { ...workspace.manifest };
  delete legacyManifest.transcript;
  fs.writeFileSync(
    path.join(workspace.dir, 'project.json'),
    `${JSON.stringify(legacyManifest, null, 2)}\n`,
  );

  assert.deepEqual(readProjectManifest(workspace.dir).transcript, {
    words: 'transcript/words.json',
    captions: 'transcript/captions.js',
  });
});

test('manifest rejects traversal in every workspace-owned path field', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Every manifest path',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const brief = {
    revision: 1,
    jsonPath: 'brief/v01.lesson.json',
    markdownPath: 'brief/v01.lesson.md',
    status: 'draft',
    theme: null,
    aspect: null,
  };
  const render = {
    version: 1,
    label: 'complete',
    dir: 'renders/v01-complete',
    briefPath: 'brief/v01.lesson.json',
    status: 'complete',
  };
  const cases = [
    ['manifest.source.localPath', (manifest) => { manifest.source.localPath = '../../sentinel.mp4'; }],
    ['manifest.transcript.words', (manifest) => { manifest.transcript.words = '../../sentinel.mp4'; }],
    ['manifest.transcript.captions', (manifest) => { manifest.transcript.captions = '../../sentinel.mp4'; }],
    ['manifest.briefs[0].jsonPath', (manifest) => {
      manifest.briefs = [{ ...brief, jsonPath: '../../sentinel.mp4' }];
    }],
    ['manifest.briefs[0].markdownPath', (manifest) => {
      manifest.briefs = [{ ...brief, markdownPath: '../../sentinel.mp4' }];
    }],
    ['manifest.currentBrief', (manifest) => {
      manifest.briefs = [{ ...brief, jsonPath: '../../sentinel.mp4' }];
      manifest.currentBrief = '../../sentinel.mp4';
    }],
    ['manifest.renders[0].dir', (manifest) => {
      manifest.renders = [{ ...render, dir: '../../sentinel.mp4' }];
    }],
    ['manifest.renders[0].briefPath', (manifest) => {
      manifest.renders = [{ ...render, briefPath: '../../sentinel.mp4' }];
    }],
    ['manifest.latestRender', (manifest) => {
      manifest.renders = [{ ...render, dir: '../../sentinel.mp4' }];
      manifest.latestRender = '../../sentinel.mp4';
    }],
    ['manifest.final', (manifest) => { manifest.final = '../../sentinel.mp4'; }],
  ];

  for (const [label, mutate] of cases) {
    const manifest = JSON.parse(JSON.stringify(workspace.manifest));
    mutate(manifest);
    assert.throws(() => writeProjectManifest(workspace.dir, manifest), new RegExp(label.replace(/[.[\]]/g, '\\$&')));
  }
});

test('project creation copies one source and creates the full workspace', (t) => {
  const fixture = makeFixture(t);
  const baseDir = path.join(fixture.dir, 'projects');
  const workspace = createOrOpenProject({
    baseDir,
    name: 'Тест ролик',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });

  assert.equal(path.basename(workspace.dir), '2026.08.05_test-rolik');
  assert.equal(fs.readFileSync(workspace.sourcePath, 'utf8'), 'video');
  assert.ok(fs.existsSync(path.join(workspace.dir, 'assets/music')));
  assert.ok(fs.existsSync(path.join(workspace.dir, 'assets/broll')));
  assert.ok(fs.existsSync(path.join(workspace.dir, 'brief')));
  assert.ok(fs.existsSync(path.join(workspace.dir, 'transcript')));
  assert.ok(fs.existsSync(path.join(workspace.dir, 'previews')));
  assert.ok(fs.existsSync(path.join(workspace.dir, 'renders')));
  assert.ok(fs.existsSync(path.join(workspace.dir, 'final')));
  assert.equal(workspace.manifest.source.localPath, 'input/source.mp4');
  assert.equal(workspace.manifest.transcript.words, 'transcript/words.json');
  assert.equal(workspace.manifest.transcript.captions, 'transcript/captions.js');
  assert.equal(readProjectManifest(workspace.dir).id, '2026.08.05_test-rolik');
});

test('existing project opens without copying its source again', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Test reel',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  fs.writeFileSync(workspace.sourcePath, 'kept');

  const reopened = createOrOpenProject({ projectDir: workspace.dir });

  assert.equal(reopened.dir, workspace.dir);
  assert.equal(fs.readFileSync(reopened.sourcePath, 'utf8'), 'kept');
});

test('existing project rejects a different source', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Test reel',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const otherSource = path.join(fixture.dir, 'other.mp4');
  fs.writeFileSync(otherSource, 'other');

  assert.throws(
    () => createOrOpenProject({ projectDir: workspace.dir, sourcePath: otherSource }),
    /другой исходник/,
  );
});

test('first brief and render allocation reject project directory symlinks before writing outside', (t) => {
  const fixture = makeFixture(t);

  for (const [directory, allocate] of [
    ['brief', (workspace) => nextBriefPaths(workspace)],
    ['renders', (workspace) => nextRenderPaths(workspace, 'First')],
  ]) {
    const workspace = createOrOpenProject({
      baseDir: path.join(fixture.dir, 'projects'),
      name: `Symlink ${directory}`,
      sourcePath: fixture.sourcePath,
      now: new Date('2026-08-05T12:00:00Z'),
    });
    const outsideDir = path.join(fixture.dir, `outside-${directory}`);
    const sentinelPath = path.join(outsideDir, 'sentinel.txt');
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(sentinelPath, `outside-${directory}`);
    fs.rmdirSync(path.join(workspace.dir, directory));
    fs.symlinkSync(outsideDir, path.join(workspace.dir, directory), 'dir');

    assert.throws(() => createOrOpenProject({ projectDir: workspace.dir }), /symbolic link/i);
    assert.throws(() => allocate(workspace), /symbolic link/i);
    assert.equal(fs.readFileSync(sentinelPath, 'utf8'), `outside-${directory}`);
    assert.deepEqual(fs.readdirSync(outsideDir), ['sentinel.txt']);
  }
});

test('brief revisions advance from manifest history', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Versioned brief',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });

  const first = nextBriefPaths(workspace);
  assert.equal(path.basename(first.jsonPath), 'v01-draft.lesson.json');
  assert.equal(path.basename(first.markdownPath), 'v01-draft.lesson.md');

  recordBrief(workspace, {
    revision: first.revision,
    jsonPath: first.jsonPath,
    markdownPath: first.markdownPath,
    status: 'draft',
    theme: 'lesson-neutral',
    aspect: 'source',
  });

  assert.equal(path.basename(nextBriefPaths(workspace).jsonPath), 'v02-draft.lesson.json');
  const manifest = readProjectManifest(workspace.dir);
  assert.equal(manifest.currentBrief, 'brief/v01-draft.lesson.json');
  assert.equal(manifest.briefs[0].theme, 'lesson-neutral');
});

test('approval freezes a reviewed draft under an approved filename', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Approved brief',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const draft = nextBriefPaths(workspace);
  const draftBrief = {
    version: 1,
    status: 'draft',
    source: fixture.sourcePath,
    title: 'Утверждённый brief',
    output: {
      aspect: 'horizontal',
      width: 1920,
      height: 1080,
      fps: 30,
      durationInFrames: 240,
    },
    corrections: [],
    scenes: [],
  };
  fs.writeFileSync(draft.jsonPath, JSON.stringify(draftBrief));
  fs.writeFileSync(draft.markdownPath, formatBriefMarkdown(draftBrief));
  recordBrief(workspace, {
    revision: draft.revision,
    jsonPath: draft.jsonPath,
    markdownPath: draft.markdownPath,
    status: 'draft',
  });

  const approved = approveBrief(workspace, draft.jsonPath);

  assert.equal(path.basename(approved.jsonPath), 'v01-approved.lesson.json');
  assert.equal(path.basename(approved.markdownPath), 'v01-approved.lesson.md');
  assert.equal(JSON.parse(fs.readFileSync(approved.jsonPath, 'utf8')).status, 'approved');
  const markdown = fs.readFileSync(approved.markdownPath, 'utf8');
  assert.match(markdown, /^Статус: `approved`$/m);
  assert.equal((markdown.match(/^Статус:/gm) || []).length, 1);
  assert.doesNotMatch(markdown, /^Статус: `draft`$/m);
  assert.equal(
    readProjectManifest(workspace.dir).currentBrief,
    'brief/v01-approved.lesson.json',
  );
});

test('approval leaves no outputs when approved Markdown generation fails', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Malformed approved brief',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const draft = nextBriefPaths(workspace);
  fs.writeFileSync(draft.jsonPath, JSON.stringify({ status: 'draft', scenes: [] }));
  fs.writeFileSync(draft.markdownPath, 'Статус: `draft`\n');
  recordBrief(workspace, {
    revision: draft.revision,
    jsonPath: draft.jsonPath,
    markdownPath: draft.markdownPath,
    status: 'draft',
  });

  assert.throws(() => approveBrief(workspace, draft.jsonPath), /aspect/);

  const approvedJsonPath = draft.jsonPath.replace('-draft.lesson.json', '-approved.lesson.json');
  const approvedMarkdownPath = draft.markdownPath.replace('-draft.lesson.md', '-approved.lesson.md');
  assert.equal(fs.existsSync(approvedJsonPath), false);
  assert.equal(fs.existsSync(approvedMarkdownPath), false);
  const manifest = readProjectManifest(workspace.dir);
  assert.equal(manifest.briefs.length, 1);
  assert.equal(manifest.briefs[0].status, 'draft');
  assert.equal(manifest.currentBrief, 'brief/v01-draft.lesson.json');
});

function makeApprovalFailureFixture(t, name) {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    projectDir: path.join(fixture.dir, `project-${name}`),
    name,
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const draft = nextBriefPaths(workspace);
  const brief = {
    version: 1,
    status: 'draft',
    source: fixture.sourcePath,
    theme: 'lesson-neutral',
    title: 'Atomic approval',
    output: {
      aspect: 'horizontal',
      width: 1920,
      height: 1080,
      fps: 30,
      durationInFrames: 240,
    },
    corrections: [],
    scenes: [{ scene: 'fullscreen', start: 0, end: 8, caption: 'SAFE' }],
  };
  fs.writeFileSync(draft.jsonPath, `${JSON.stringify(brief, null, 2)}\n`);
  fs.writeFileSync(draft.markdownPath, formatBriefMarkdown(brief));
  recordBrief(workspace, {
    revision: draft.revision,
    jsonPath: draft.jsonPath,
    markdownPath: draft.markdownPath,
    status: 'draft',
    theme: 'lesson-neutral',
    aspect: 'horizontal',
  });
  return {
    fixture,
    workspace,
    draft,
    approvedJson: draft.jsonPath.replace('-draft.lesson.json', '-approved.lesson.json'),
    approvedMarkdown: draft.markdownPath.replace('-draft.lesson.md', '-approved.lesson.md'),
  };
}

test('approval rolls back manifest and outputs when a destination commit fails', async (t) => {
  for (const destination of ['project.json', 'approved Markdown', 'approved JSON']) {
    await t.test(destination, () => {
      const state = makeApprovalFailureFixture(t, destination.replace(' ', '-'));
      const failedPath = destination === 'project.json'
        ? path.join(state.workspace.dir, 'project.json')
        : destination === 'approved Markdown'
          ? state.approvedMarkdown
          : state.approvedJson;
      const failingFs = {
        ...fs,
        renameSync(source, target) {
          if (path.resolve(target) === path.resolve(failedPath)) {
            throw new Error(`simulated ${destination} failure`);
          }
          return fs.renameSync(source, target);
        },
      };

      assert.throws(
        () => approveBrief(state.workspace, state.draft.jsonPath, {
          fileSystem: failingFs,
          temporaryId: () => '12345678-1234-4123-8123-123456789abc',
        }),
        new RegExp(`simulated ${destination}`),
      );

      assert.equal(fs.existsSync(state.approvedJson), false);
      assert.equal(fs.existsSync(state.approvedMarkdown), false);
      const manifest = readProjectManifest(state.workspace.dir);
      assert.equal(manifest.currentBrief, 'brief/v01-draft.lesson.json');
      assert.deepEqual(manifest.briefs.map((entry) => entry.status), ['draft']);
      assert.deepEqual(
        fs.readdirSync(path.join(state.workspace.dir, 'brief')).filter((entry) => entry.includes('.tmp-')),
        [],
      );
      assert.deepEqual(
        fs.readdirSync(state.workspace.dir).filter((entry) => entry.includes('.tmp-')),
        [],
      );
      assert.throws(() => {
        const leaked = JSON.parse(fs.readFileSync(state.approvedJson, 'utf8'));
        return prepareLessonRender({
          brief: leaked,
          theme: 'lesson-neutral',
          sourceVideo: state.fixture.sourcePath,
        });
      }, /ENOENT/);
    });
  }
});

test('approval cleans owned temps when staging a manifest or Markdown write fails', async (t) => {
  for (const purpose of ['approval-manifest', 'approval-markdown']) {
    await t.test(purpose, () => {
      const state = makeApprovalFailureFixture(t, `stage-${purpose}`);
      const handles = new Map();
      const failingFs = {
        ...fs,
        openSync(target, flags, mode) {
          const handle = fs.openSync(target, flags, mode);
          handles.set(handle, target);
          return handle;
        },
        writeFileSync(target, data, options) {
          if (typeof target === 'number' && handles.get(target).includes(`.tmp-${purpose}-`)) {
            throw new Error(`simulated ${purpose} stage write failure`);
          }
          return fs.writeFileSync(target, data, options);
        },
        closeSync(handle) {
          handles.delete(handle);
          return fs.closeSync(handle);
        },
      };

      assert.throws(
        () => approveBrief(state.workspace, state.draft.jsonPath, {
          fileSystem: failingFs,
          temporaryId: () => '12345678-1234-4123-8123-123456789abc',
        }),
        new RegExp(`simulated ${purpose}`),
      );
      assert.equal(fs.existsSync(state.approvedJson), false);
      assert.equal(fs.existsSync(state.approvedMarkdown), false);
      assert.deepEqual(
        fs.readdirSync(state.workspace.dir).filter((entry) => entry.includes('.tmp-')),
        [],
      );
      assert.deepEqual(
        fs.readdirSync(path.join(state.workspace.dir, 'brief')).filter((entry) => entry.includes('.tmp-')),
        [],
      );
      assert.equal(readProjectManifest(state.workspace.dir).currentBrief, 'brief/v01-draft.lesson.json');
    });
  }
});

test('render versions keep history and publish one canonical final', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Versioned render',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });

  const first = nextRenderPaths(workspace, 'Новая музыка');
  assert.equal(path.basename(first.dir), 'v01-novaya-muzyka');
  assert.equal(path.basename(first.propsPath), 'props.json');
  assert.equal(path.basename(first.rawPath), 'raw.mp4');
  assert.equal(path.basename(first.finalPath), 'final.mp4');
  fs.writeFileSync(first.finalPath, 'render');

  recordRender(workspace, {
    version: first.version,
    label: first.label,
    dir: first.dir,
    status: 'complete',
  });

  assert.equal(path.basename(nextRenderPaths(workspace, 'Ducking').dir), 'v02-ducking');
  const canonicalFinal = publishFinal(workspace, first.finalPath);
  assert.equal(fs.readFileSync(canonicalFinal, 'utf8'), 'render');
  const manifest = readProjectManifest(workspace.dir);
  assert.equal(manifest.latestRender, 'renders/v01-novaya-muzyka');
  assert.equal(manifest.final, 'final/versioned-render.mp4');
});

test('render status updates one manifest entry instead of duplicating a version', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Render lifecycle',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const render = nextRenderPaths(workspace, 'Ducking');

  recordRender(workspace, {
    version: render.version,
    label: render.label,
    dir: render.dir,
    status: 'started',
  });
  recordRender(workspace, {
    version: render.version,
    label: render.label,
    dir: render.dir,
    status: 'complete',
  });

  const manifest = readProjectManifest(workspace.dir);
  assert.equal(manifest.renders.length, 1);
  assert.equal(manifest.renders[0].status, 'complete');
});

test('render lifecycle publishes final only after successful work', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Lifecycle success',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const render = nextRenderPaths(workspace, 'First');

  const destination = runRenderLifecycle(workspace, render, () => {
    fs.writeFileSync(render.finalPath, 'new-final');
    return render.finalPath;
  });

  const manifest = readProjectManifest(workspace.dir);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'new-final');
  assert.equal(manifest.latestRender, 'renders/v01-first');
  assert.equal(manifest.renders[0].status, 'complete');
});

test('render lifecycle records stage failures and retains the previous final', async (t) => {
  for (const failedStage of ['render', 'finish', 'music']) {
    await t.test(failedStage, () => {
      const fixture = makeFixture(t);
      const workspace = createOrOpenProject({
        baseDir: path.join(fixture.dir, 'projects'),
        name: `Failure ${failedStage}`,
        sourcePath: fixture.sourcePath,
        now: new Date('2026-08-05T12:00:00Z'),
      });
      const previous = nextRenderPaths(workspace, 'Previous');
      fs.writeFileSync(previous.finalPath, 'previous-final');
      recordRender(workspace, { ...previous, status: 'complete' });
      const canonical = publishFinal(workspace, previous.finalPath);
      const previousHash = fs.readFileSync(canonical, 'utf8');
      const attempted = nextRenderPaths(workspace, 'Attempted');

      assert.throws(() => runRenderLifecycle(workspace, attempted, () => {
        throw new Error(`${failedStage} failed`);
      }), new RegExp(`${failedStage} failed`));

      const manifest = readProjectManifest(workspace.dir);
      assert.equal(fs.readFileSync(canonical, 'utf8'), previousHash);
      assert.equal(manifest.latestRender, 'renders/v01-previous');
      assert.equal(manifest.renders.at(-1).status, 'failed');
      assert.equal(manifest.renders.length, 2);
    });
  }
});

test('publish failure records failed and retains the previous final', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Publish failure',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const previous = nextRenderPaths(workspace, 'Previous');
  fs.writeFileSync(previous.finalPath, 'previous-final');
  recordRender(workspace, { ...previous, status: 'complete' });
  const canonical = publishFinal(workspace, previous.finalPath);
  const attempted = nextRenderPaths(workspace, 'Attempted');
  fs.writeFileSync(attempted.finalPath, 'attempted-final');

  assert.throws(() => runRenderLifecycle(
    workspace,
    attempted,
    () => attempted.finalPath,
    { publish: () => { throw new Error('publish failed'); } },
  ), /publish failed/);

  const manifest = readProjectManifest(workspace.dir);
  assert.equal(fs.readFileSync(canonical, 'utf8'), 'previous-final');
  assert.equal(manifest.latestRender, 'renders/v01-previous');
  assert.equal(manifest.renders.at(-1).status, 'failed');
});

test('atomic final publish removes a failed temporary copy and preserves canonical final', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Atomic publish',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const render = nextRenderPaths(workspace, 'Attempt');
  fs.writeFileSync(render.finalPath, 'replacement');
  const canonical = path.join(workspace.dir, workspace.manifest.final);
  fs.writeFileSync(canonical, 'previous-final');
  const failingFs = {
    ...fs,
    renameSync() {
      throw new Error('rename failed');
    },
  };

  assert.throws(
    () => publishFinal(workspace, render.finalPath, { fileSystem: failingFs }),
    /rename failed/,
  );

  assert.equal(fs.readFileSync(canonical, 'utf8'), 'previous-final');
  assert.deepEqual(
    fs.readdirSync(path.dirname(canonical)).filter((name) => name.includes('.tmp-')),
    [],
  );
});

test('manifest requires currentBrief to match a registered brief and latestRender to match a complete render', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Manifest cross references',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });

  assert.throws(() => writeProjectManifest(workspace.dir, {
    ...workspace.manifest,
    currentBrief: 'brief/unregistered.lesson.json',
  }), /currentBrief.*briefs\[\]/);

  assert.throws(() => writeProjectManifest(workspace.dir, {
    ...workspace.manifest,
    renders: [{
      version: 1,
      label: 'unfinished',
      dir: 'renders/v01-unfinished',
      briefPath: null,
      status: 'started',
    }],
    latestRender: 'renders/v01-unfinished',
  }), /latestRender.*complete/);
});

test('publish final rejects an in-memory traversal manifest and leaves the outside sentinel unchanged', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Traversal publish',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const render = nextRenderPaths(workspace, 'Contained');
  fs.writeFileSync(render.finalPath, 'contained-render');
  const sentinelPath = path.join(fixture.dir, 'sentinel.mp4');
  fs.writeFileSync(sentinelPath, 'outside-must-survive');
  const maliciousWorkspace = {
    ...workspace,
    manifest: { ...workspace.manifest, final: '../../sentinel.mp4' },
  };

  let caught;
  try {
    publishFinal(maliciousWorkspace, render.finalPath);
  } catch (error) {
    caught = error;
  }

  assert.match(caught && caught.message, /manifest\.final/);
  assert.equal(fs.readFileSync(sentinelPath, 'utf8'), 'outside-must-survive');

  const containedWorkspace = {
    ...workspace,
    manifest: { ...workspace.manifest, final: 'renders/final/final.mp4' },
  };
  const published = publishFinal(containedWorkspace, render.finalPath);
  assert.equal(published, path.join(workspace.dir, 'renders/final/final.mp4'));
  assert.equal(fs.readFileSync(published, 'utf8'), 'contained-render');
});
