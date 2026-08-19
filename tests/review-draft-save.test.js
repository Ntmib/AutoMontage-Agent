const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { formatBriefMarkdown } = require('../scripts/lesson/brief');
const {
  approveBrief,
  createOrOpenProject,
  nextBriefPaths,
  readProjectManifest,
  recordBrief,
  saveDraftRevision,
} = require('../scripts/project/workspace');

const TEMPORARY_ID = 'review-safe-id';

function makeReviewWorkspace(t, { approved = true, name = 'review-save' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-review-save-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'camera.mp4');
  fs.writeFileSync(sourcePath, 'source-video');
  const workspace = createOrOpenProject({
    projectDir: path.join(root, `project-${name}`),
    name,
    sourcePath,
    now: new Date('2026-08-20T08:00:00.000Z'),
  });
  const brollPath = path.join(workspace.dir, 'assets', 'broll', 'diagram.png');
  fs.writeFileSync(brollPath, 'safe-image');

  const first = nextBriefPaths(workspace);
  const draftBrief = {
    version: 1,
    status: 'draft',
    source: workspace.manifest.source.localPath,
    theme: 'lesson-neutral',
    title: 'Atomic review save',
    output: {
      aspect: 'horizontal',
      width: 1920,
      height: 1080,
      fps: 25,
      durationInFrames: 250,
    },
    corrections: [],
    scenes: [
      { scene: 'fullscreen', start: 0, end: 4, caption: 'ПЕРВАЯ СЦЕНА' },
      {
        scene: 'broll',
        start: 4,
        end: 7,
        brollSrc: 'assets/broll/diagram.png',
        headCream: 'ПОКАЗЫВАЕМ',
        headOrange: 'СХЕМУ',
      },
      {
        scene: 'split',
        start: 7,
        end: 10,
        headCream: 'ФИНАЛЬНЫЙ',
        headOrange: 'БЛОК',
        bullets: ['Одна', 'Две'],
      },
    ],
  };
  fs.writeFileSync(first.jsonPath, `${JSON.stringify(draftBrief, null, 2)}\n`);
  fs.writeFileSync(first.markdownPath, formatBriefMarkdown(draftBrief));
  recordBrief(workspace, {
    revision: first.revision,
    jsonPath: first.jsonPath,
    markdownPath: first.markdownPath,
    status: 'draft',
    theme: draftBrief.theme,
    aspect: draftBrief.output.aspect,
  });

  const savedBase = approved ? approveBrief(workspace, first.jsonPath) : first;
  const baseBrief = JSON.parse(fs.readFileSync(savedBase.jsonPath, 'utf8'));
  return {
    root,
    workspace,
    baseJsonPath: savedBase.jsonPath,
    baseMarkdownPath: savedBase.markdownPath,
    baseBrief,
  };
}

function editedCandidate(baseBrief) {
  const candidate = structuredClone(baseBrief);
  candidate.status = 'draft';
  candidate.scenes[0].end = 4.25;
  candidate.scenes[1].start = 4.25;
  return candidate;
}

function expectedDraftPaths(workspace) {
  return {
    jsonPath: path.join(workspace.dir, 'brief', 'v02-draft.lesson.json'),
    markdownPath: path.join(workspace.dir, 'brief', 'v02-draft.lesson.md'),
  };
}

function tempEntries(workspace) {
  return [workspace.dir, path.join(workspace.dir, 'brief')]
    .flatMap((directory) => fs.readdirSync(directory)
      .filter((entry) => entry.includes('.tmp-'))
      .map((entry) => path.join(directory, entry)))
    .sort();
}

function assertSaveFailurePreserved(state, before, foreignTempPath) {
  const outputs = expectedDraftPaths(state.workspace);
  assert.deepEqual(fs.readFileSync(path.join(state.workspace.dir, 'project.json')), before.manifest);
  assert.deepEqual(fs.readFileSync(state.baseJsonPath), before.baseJson);
  assert.deepEqual(fs.readFileSync(state.baseMarkdownPath), before.baseMarkdown);
  assert.equal(fs.existsSync(outputs.jsonPath), false);
  assert.equal(fs.existsSync(outputs.markdownPath), false);
  assert.equal(readProjectManifest(state.workspace.dir).currentBrief, before.currentBrief);
  assert.equal(state.workspace.manifest.currentBrief, before.currentBrief);
  assert.deepEqual(tempEntries(state.workspace), foreignTempPath ? [foreignTempPath] : []);
}

function failureFileSystem({ stagePurpose = null, commitPurpose = null }) {
  const handles = new Map();
  return {
    ...fs,
    openSync(target, flags, mode) {
      const handle = fs.openSync(target, flags, mode);
      handles.set(handle, target);
      return handle;
    },
    writeFileSync(target, data, options) {
      const openPath = typeof target === 'number' ? handles.get(target) : null;
      if (openPath && stagePurpose && openPath.includes(`.tmp-${stagePurpose}-`)) {
        throw new Error(`simulated ${stagePurpose} stage failure`);
      }
      return fs.writeFileSync(target, data, options);
    },
    closeSync(handle) {
      handles.delete(handle);
      return fs.closeSync(handle);
    },
    renameSync(source, target) {
      if (commitPurpose && source.includes(`.tmp-${commitPurpose}-`)) {
        throw new Error(`simulated ${commitPurpose} commit failure`);
      }
      return fs.renameSync(source, target);
    },
  };
}

test('review save publishes manifest, Markdown, then JSON and preserves approved bytes', (t) => {
  const state = makeReviewWorkspace(t, { name: 'ordered-approved' });
  const beforeJson = fs.readFileSync(state.baseJsonPath);
  const beforeMarkdown = fs.readFileSync(state.baseMarkdownPath);
  const outputs = expectedDraftPaths(state.workspace);
  const commits = [];
  const observingFs = {
    ...fs,
    renameSync(source, target) {
      if (source.includes('.tmp-review-draft-manifest-')) {
        assert.equal(fs.existsSync(outputs.markdownPath), false);
        assert.equal(fs.existsSync(outputs.jsonPath), false);
        commits.push('manifest');
      } else if (source.includes('.tmp-review-draft-markdown-')) {
        assert.equal(readProjectManifest(state.workspace.dir).currentBrief, 'brief/v02-draft.lesson.json');
        assert.equal(fs.existsSync(outputs.markdownPath), false);
        assert.equal(fs.existsSync(outputs.jsonPath), false);
        commits.push('markdown');
      } else if (source.includes('.tmp-review-draft-json-')) {
        assert.equal(readProjectManifest(state.workspace.dir).currentBrief, 'brief/v02-draft.lesson.json');
        assert.equal(fs.existsSync(outputs.markdownPath), true);
        assert.equal(fs.existsSync(outputs.jsonPath), false);
        commits.push('json');
      }
      return fs.renameSync(source, target);
    },
  };

  const candidate = editedCandidate(state.baseBrief);
  candidate.status = 'approved';
  const expectedDraft = { ...candidate, status: 'draft' };
  const beforeBriefCount = state.workspace.manifest.briefs.length;
  const saved = saveDraftRevision(state.workspace, {
    baseJsonPath: state.baseJsonPath,
    brief: candidate,
    fileSystem: observingFs,
    temporaryId: () => TEMPORARY_ID,
  });

  assert.deepEqual(commits, ['manifest', 'markdown', 'json']);
  assert.equal(saved.revision, 2);
  assert.equal(saved.jsonPath, outputs.jsonPath);
  assert.equal(saved.markdownPath, outputs.markdownPath);
  assert.deepEqual(fs.readFileSync(state.baseJsonPath), beforeJson);
  assert.deepEqual(fs.readFileSync(state.baseMarkdownPath), beforeMarkdown);
  const persisted = JSON.parse(fs.readFileSync(saved.jsonPath, 'utf8'));
  assert.deepEqual(persisted, expectedDraft);
  assert.equal(persisted.status, 'draft');
  assert.equal(persisted.source, state.baseBrief.source);
  assert.deepEqual(persisted.theme, state.baseBrief.theme);
  assert.deepEqual(persisted.output, state.baseBrief.output);
  assert.match(fs.readFileSync(saved.markdownPath, 'utf8'), /^Статус: `draft`$/m);
  const manifest = readProjectManifest(state.workspace.dir);
  assert.equal(manifest.currentBrief, 'brief/v02-draft.lesson.json');
  assert.equal(manifest.briefs.length, beforeBriefCount + 1);
  assert.deepEqual(manifest.briefs.at(-1), {
    revision: 2,
    jsonPath: 'brief/v02-draft.lesson.json',
    markdownPath: 'brief/v02-draft.lesson.md',
    status: 'draft',
    theme: 'lesson-neutral',
    aspect: 'horizontal',
  });
  assert.deepEqual(tempEntries(state.workspace), []);
});

test('review save also keeps a current draft base byte-for-byte', (t) => {
  const state = makeReviewWorkspace(t, { approved: false, name: 'draft-base' });
  const beforeJson = fs.readFileSync(state.baseJsonPath);
  const beforeMarkdown = fs.readFileSync(state.baseMarkdownPath);

  const saved = saveDraftRevision(state.workspace, {
    baseJsonPath: state.baseJsonPath,
    brief: editedCandidate(state.baseBrief),
    temporaryId: () => TEMPORARY_ID,
  });

  assert.equal(path.basename(saved.jsonPath), 'v02-draft.lesson.json');
  assert.deepEqual(fs.readFileSync(state.baseJsonPath), beforeJson);
  assert.deepEqual(fs.readFileSync(state.baseMarkdownPath), beforeMarkdown);
});

test('review save rolls back every staging and destination commit failure', async (t) => {
  const failures = [
    { kind: 'stage', purpose: 'review-draft-manifest' },
    { kind: 'stage', purpose: 'review-draft-rollback' },
    { kind: 'stage', purpose: 'review-draft-markdown' },
    { kind: 'stage', purpose: 'review-draft-json' },
    { kind: 'commit', purpose: 'review-draft-manifest' },
    { kind: 'commit', purpose: 'review-draft-markdown' },
    { kind: 'commit', purpose: 'review-draft-json' },
  ];

  for (const failure of failures) {
    await t.test(`${failure.kind} ${failure.purpose}`, () => {
      const state = makeReviewWorkspace(t, { name: `${failure.kind}-${failure.purpose}` });
      const manifestPath = path.join(state.workspace.dir, 'project.json');
      const before = {
        manifest: fs.readFileSync(manifestPath),
        baseJson: fs.readFileSync(state.baseJsonPath),
        baseMarkdown: fs.readFileSync(state.baseMarkdownPath),
        currentBrief: state.workspace.manifest.currentBrief,
      };
      const foreignTempPath = path.join(
        state.workspace.dir,
        'brief',
        'unrelated.lesson.json.tmp-foreign-owner-do-not-delete',
      );
      fs.writeFileSync(foreignTempPath, 'foreign-temp');
      const sentinelPath = path.join(state.root, 'outside-sentinel.txt');
      fs.writeFileSync(sentinelPath, 'outside-safe');
      const fileSystem = failureFileSystem({
        stagePurpose: failure.kind === 'stage' ? failure.purpose : null,
        commitPurpose: failure.kind === 'commit' ? failure.purpose : null,
      });

      assert.throws(
        () => saveDraftRevision(state.workspace, {
          baseJsonPath: state.baseJsonPath,
          brief: editedCandidate(state.baseBrief),
          fileSystem,
          temporaryId: () => TEMPORARY_ID,
        }),
        new RegExp(`simulated ${failure.purpose} ${failure.kind} failure`),
      );

      assertSaveFailurePreserved(state, before, foreignTempPath);
      assert.equal(fs.readFileSync(foreignTempPath, 'utf8'), 'foreign-temp');
      assert.equal(fs.readFileSync(sentinelPath, 'utf8'), 'outside-safe');
    });
  }
});

test('review save rejects stale, unregistered and traversing bases before writes', async (t) => {
  const cases = [
    {
      name: 'registered but no longer current',
      basePath(state) {
        return path.join(state.workspace.dir, 'brief', 'v01-draft.lesson.json');
      },
      pattern: /current|stale/i,
    },
    {
      name: 'unregistered inside project',
      basePath(state) {
        const unregistered = path.join(state.workspace.dir, 'brief', 'unregistered.lesson.json');
        fs.writeFileSync(unregistered, JSON.stringify(state.baseBrief));
        return unregistered;
      },
      pattern: /registered|project\.json/i,
    },
    {
      name: 'traversal outside project',
      basePath(state) {
        const outside = path.join(state.root, 'outside-base.json');
        fs.writeFileSync(outside, JSON.stringify(state.baseBrief));
        return path.join(state.workspace.dir, 'brief', '..', '..', path.basename(outside));
      },
      pattern: /inside|путь/i,
    },
  ];

  for (const currentCase of cases) {
    await t.test(currentCase.name, () => {
      const state = makeReviewWorkspace(t, { name: currentCase.name.replaceAll(' ', '-') });
      const beforeManifest = fs.readFileSync(path.join(state.workspace.dir, 'project.json'));
      const beforeBriefNames = fs.readdirSync(path.join(state.workspace.dir, 'brief')).sort();
      assert.throws(() => saveDraftRevision(state.workspace, {
        baseJsonPath: currentCase.basePath(state),
        brief: editedCandidate(state.baseBrief),
        temporaryId: () => TEMPORARY_ID,
      }), currentCase.pattern);
      assert.deepEqual(fs.readFileSync(path.join(state.workspace.dir, 'project.json')), beforeManifest);
      assert.deepEqual(
        fs.readdirSync(path.join(state.workspace.dir, 'brief')).sort(),
        currentCase.name === 'unregistered inside project'
          ? [...beforeBriefNames, 'unregistered.lesson.json'].sort()
          : beforeBriefNames,
      );
      assert.deepEqual(tempEntries(state.workspace), []);
    });
  }
});

test('review save rejects a base replaced by a symlink without touching its target', (t) => {
  const state = makeReviewWorkspace(t, { name: 'symlink-base' });
  const manifestPath = path.join(state.workspace.dir, 'project.json');
  const beforeManifest = fs.readFileSync(manifestPath);
  const outside = path.join(state.root, 'outside-base.json');
  fs.writeFileSync(outside, 'outside-safe');
  fs.unlinkSync(state.baseJsonPath);
  fs.symlinkSync(outside, state.baseJsonPath);

  assert.throws(() => saveDraftRevision(state.workspace, {
    baseJsonPath: state.baseJsonPath,
    brief: editedCandidate(state.baseBrief),
    temporaryId: () => TEMPORARY_ID,
  }), /symbolic link/i);

  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside-safe');
  assert.deepEqual(fs.readFileSync(manifestPath), beforeManifest);
  assert.equal(fs.lstatSync(state.baseJsonPath).isSymbolicLink(), true);
  assert.deepEqual(tempEntries(state.workspace), []);
});

test('review save preserves a newer on-disk current brief when the session is stale', (t) => {
  const state = makeReviewWorkspace(t, { name: 'disk-stale' });
  const manifestPath = path.join(state.workspace.dir, 'project.json');
  const persistedManifest = readProjectManifest(state.workspace.dir);
  persistedManifest.currentBrief = 'brief/v01-draft.lesson.json';
  fs.writeFileSync(manifestPath, `${JSON.stringify(persistedManifest, null, 2)}\n`);
  const newerManifestBytes = fs.readFileSync(manifestPath);
  const beforeBriefNames = fs.readdirSync(path.join(state.workspace.dir, 'brief')).sort();

  assert.throws(() => saveDraftRevision(state.workspace, {
    baseJsonPath: state.baseJsonPath,
    brief: editedCandidate(state.baseBrief),
    temporaryId: () => TEMPORARY_ID,
  }), /current|stale/i);

  assert.deepEqual(fs.readFileSync(manifestPath), newerManifestBytes);
  assert.equal(readProjectManifest(state.workspace.dir).currentBrief, 'brief/v01-draft.lesson.json');
  assert.equal(state.workspace.manifest.currentBrief, 'brief/v01-approved.lesson.json');
  assert.deepEqual(fs.readdirSync(path.join(state.workspace.dir, 'brief')).sort(), beforeBriefNames);
  assert.deepEqual(tempEntries(state.workspace), []);
});

test('review save never follows or removes an unowned predictable temp symlink', (t) => {
  const state = makeReviewWorkspace(t, { name: 'symlink-temp' });
  const before = {
    manifest: fs.readFileSync(path.join(state.workspace.dir, 'project.json')),
    baseJson: fs.readFileSync(state.baseJsonPath),
    baseMarkdown: fs.readFileSync(state.baseMarkdownPath),
    currentBrief: state.workspace.manifest.currentBrief,
  };
  const outside = path.join(state.root, 'outside-temp-target.txt');
  fs.writeFileSync(outside, 'outside-safe');
  const outputs = expectedDraftPaths(state.workspace);
  const unownedTemp = `${outputs.jsonPath}.tmp-review-draft-json-${TEMPORARY_ID}`;
  fs.symlinkSync(outside, unownedTemp);

  assert.throws(() => saveDraftRevision(state.workspace, {
    baseJsonPath: state.baseJsonPath,
    brief: editedCandidate(state.baseBrief),
    temporaryId: () => TEMPORARY_ID,
  }), /EEXIST/);

  assertSaveFailurePreserved(state, before, unownedTemp);
  assert.equal(fs.lstatSync(unownedTemp).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside-safe');
});

test('review save rejects a no-op without allocating another revision', (t) => {
  const state = makeReviewWorkspace(t, { name: 'no-op' });
  const manifestPath = path.join(state.workspace.dir, 'project.json');
  const beforeManifest = fs.readFileSync(manifestPath);
  const beforeBriefNames = fs.readdirSync(path.join(state.workspace.dir, 'brief')).sort();
  const candidate = structuredClone(state.baseBrief);
  candidate.status = 'draft';

  assert.throws(
    () => saveDraftRevision(state.workspace, {
      baseJsonPath: state.baseJsonPath,
      brief: candidate,
      temporaryId: () => TEMPORARY_ID,
    }),
    (error) => error && error.message === 'ничего не изменено',
  );

  assert.deepEqual(fs.readFileSync(manifestPath), beforeManifest);
  assert.deepEqual(fs.readdirSync(path.join(state.workspace.dir, 'brief')).sort(), beforeBriefNames);
  assert.deepEqual(tempEntries(state.workspace), []);
});

test('review save rejects unresolved opaque asset ids and browser media pseudo-paths', async (t) => {
  const cases = [
    ['opaque b-roll id', (candidate) => { candidate.scenes[1].brollSrc = 'asset-2'; }, /asset|opaque/i],
    ['browser asset path', (candidate) => { candidate.scenes[1].brollSrc = '/media/assets/asset-2'; }, /browser|media/i],
    ['browser source path', (candidate) => { candidate.source = '/media/source'; }, /browser|media/i],
    [
      'absolute URL dot segment',
      (candidate) => { candidate.scenes[1].brollSrc = 'http://review.local/./media/assets/asset-2'; },
      /browser|media/i,
    ],
    [
      'percent-encoded parent segment',
      (candidate) => { candidate.scenes[1].brollSrc = 'http://review.local/safe/%2e%2e/media/assets/asset-2'; },
      /browser|media/i,
    ],
    [
      'relative percent-encoded parent segment',
      (candidate) => { candidate.scenes[1].brollSrc = '/safe/%2e%2e/media/source'; },
      /browser|media/i,
    ],
    [
      'absolute URL backslashes',
      (candidate) => { candidate.scenes[1].brollSrc = 'http://review.local\\media\\assets\\asset-2'; },
      /browser|media/i,
    ],
  ];

  for (const [name, mutate, pattern] of cases) {
    await t.test(name, () => {
      const state = makeReviewWorkspace(t, { name: name.replaceAll(' ', '-') });
      const manifestPath = path.join(state.workspace.dir, 'project.json');
      const beforeManifest = fs.readFileSync(manifestPath);
      const beforeBriefNames = fs.readdirSync(path.join(state.workspace.dir, 'brief')).sort();
      const candidate = editedCandidate(state.baseBrief);
      mutate(candidate);

      assert.throws(() => saveDraftRevision(state.workspace, {
        baseJsonPath: state.baseJsonPath,
        brief: candidate,
        temporaryId: () => TEMPORARY_ID,
      }), pattern);
      assert.deepEqual(fs.readFileSync(manifestPath), beforeManifest);
      assert.deepEqual(fs.readdirSync(path.join(state.workspace.dir, 'brief')).sort(), beforeBriefNames);
      assert.deepEqual(tempEntries(state.workspace), []);
    });
  }
});

test('review save accepts canonical project/public refs and safe filenames containing media', async (t) => {
  const cases = [
    ['current project ref', 'assets/broll/diagram.png'],
    ['project media filename', 'assets/broll/social-media-card.png'],
    ['public media ref', 'public/broll/growth.png'],
  ];

  for (const [name, reference] of cases) {
    await t.test(name, () => {
      const state = makeReviewWorkspace(t, { name: name.replaceAll(' ', '-') });
      if (reference === 'assets/broll/social-media-card.png') {
        fs.writeFileSync(path.join(state.workspace.dir, ...reference.split('/')), 'safe-media');
      }
      const candidate = editedCandidate(state.baseBrief);
      candidate.scenes[1].brollSrc = reference;

      const saved = saveDraftRevision(state.workspace, {
        baseJsonPath: state.baseJsonPath,
        brief: candidate,
        temporaryId: () => TEMPORARY_ID,
      });

      assert.equal(JSON.parse(fs.readFileSync(saved.jsonPath, 'utf8')).scenes[1].brollSrc, reference);
      assert.equal(readProjectManifest(state.workspace.dir).currentBrief, 'brief/v02-draft.lesson.json');
    });
  }
});

test('review save CAS preserves a foreign manifest and referenced temp before manifest commit', (t) => {
  const state = makeReviewWorkspace(t, { name: 'cas-before-commit' });
  const manifestPath = path.join(state.workspace.dir, 'project.json');
  const outputs = expectedDraftPaths(state.workspace);
  const jsonTempPath = `${outputs.jsonPath}.tmp-review-draft-json-${TEMPORARY_ID}`;
  const jsonTempRelative = path.relative(state.workspace.dir, jsonTempPath).split(path.sep).join('/');
  const foreignManifest = readProjectManifest(state.workspace.dir);
  foreignManifest.name = 'Foreign writer before commit';
  foreignManifest.updatedAt = '2026-08-20T09:00:00.000Z';
  foreignManifest.briefs.push({
    revision: 99,
    jsonPath: jsonTempRelative,
    markdownPath: null,
    status: 'draft',
    theme: 'lesson-neutral',
    aspect: 'horizontal',
  });
  foreignManifest.currentBrief = jsonTempRelative;
  const foreignManifestBytes = Buffer.from(`${JSON.stringify(foreignManifest, null, 2)}\n`);
  const handles = new Map();
  let injected = false;
  const racingFs = {
    ...fs,
    openSync(target, flags, mode) {
      const handle = fs.openSync(target, flags, mode);
      handles.set(handle, target);
      return handle;
    },
    writeFileSync(target, data, options) {
      const result = fs.writeFileSync(target, data, options);
      const openPath = typeof target === 'number' ? handles.get(target) : null;
      if (!injected && openPath && openPath.includes('.tmp-review-draft-rollback-')) {
        fs.writeFileSync(jsonTempPath, 'foreign-referenced-temp');
        fs.writeFileSync(manifestPath, foreignManifestBytes);
        injected = true;
      }
      return result;
    },
    closeSync(handle) {
      handles.delete(handle);
      return fs.closeSync(handle);
    },
  };

  assert.throws(() => saveDraftRevision(state.workspace, {
    baseJsonPath: state.baseJsonPath,
    brief: editedCandidate(state.baseBrief),
    fileSystem: racingFs,
    temporaryId: () => TEMPORARY_ID,
  }), /concurrent|changed/i);

  assert.equal(injected, true);
  assert.deepEqual(fs.readFileSync(manifestPath), foreignManifestBytes);
  assert.equal(fs.readFileSync(jsonTempPath, 'utf8'), 'foreign-referenced-temp');
  assert.equal(fs.existsSync(outputs.jsonPath), false);
  assert.equal(fs.existsSync(outputs.markdownPath), false);
  assert.equal(readProjectManifest(state.workspace.dir).currentBrief, jsonTempRelative);
  assert.deepEqual(fs.readFileSync(state.baseJsonPath), Buffer.from(`${JSON.stringify(state.baseBrief, null, 2)}\n`));
});

test('review save CAS preserves foreign manifest and referenced outputs after its manifest commit', (t) => {
  const state = makeReviewWorkspace(t, { name: 'cas-after-commit' });
  const manifestPath = path.join(state.workspace.dir, 'project.json');
  const outputs = expectedDraftPaths(state.workspace);
  const jsonTempPath = `${outputs.jsonPath}.tmp-review-draft-json-${TEMPORARY_ID}`;
  const jsonTempRelative = path.relative(state.workspace.dir, jsonTempPath).split(path.sep).join('/');
  const beforeBase = fs.readFileSync(state.baseJsonPath);
  let foreignManifestBytes = null;
  const racingFs = {
    ...fs,
    renameSync(source, target) {
      if (source.includes('.tmp-review-draft-json-')) {
        throw new Error('simulated later JSON failure');
      }
      const result = fs.renameSync(source, target);
      if (source.includes('.tmp-review-draft-markdown-')) {
        const foreignManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        foreignManifest.name = 'Foreign writer after commit';
        foreignManifest.updatedAt = '2026-08-20T10:00:00.000Z';
        foreignManifest.briefs.at(-1).jsonPath = jsonTempRelative;
        foreignManifest.currentBrief = jsonTempRelative;
        foreignManifestBytes = Buffer.from(`${JSON.stringify(foreignManifest, null, 2)}\n`);
        fs.writeFileSync(outputs.markdownPath, 'foreign-referenced-markdown');
        fs.writeFileSync(manifestPath, foreignManifestBytes);
      }
      return result;
    },
  };

  assert.throws(() => saveDraftRevision(state.workspace, {
    baseJsonPath: state.baseJsonPath,
    brief: editedCandidate(state.baseBrief),
    fileSystem: racingFs,
    temporaryId: () => TEMPORARY_ID,
  }), /simulated later JSON failure/);

  assert.ok(foreignManifestBytes);
  assert.deepEqual(fs.readFileSync(manifestPath), foreignManifestBytes);
  assert.equal(fs.readFileSync(outputs.markdownPath, 'utf8'), 'foreign-referenced-markdown');
  assert.equal(JSON.parse(fs.readFileSync(jsonTempPath, 'utf8')).status, 'draft');
  assert.equal(fs.existsSync(outputs.jsonPath), false);
  assert.equal(readProjectManifest(state.workspace.dir).currentBrief, jsonTempRelative);
  assert.deepEqual(fs.readFileSync(state.baseJsonPath), beforeBase);
});

test('review save validates the candidate and preserves protected identity', async (t) => {
  const cases = [
    ['invalid lesson brief', (candidate) => { delete candidate.scenes[0].caption; }, /brief|caption|required/i],
    ['changed source', (candidate) => { candidate.source = 'input/other.mp4'; }, /identity|source/i],
    ['changed theme', (candidate) => { candidate.theme = 'other-theme'; }, /identity|theme/i],
    ['changed full output', (candidate) => { candidate.output.width = 1080; }, /identity|output/i],
  ];

  for (const [name, mutate, pattern] of cases) {
    await t.test(name, () => {
      const state = makeReviewWorkspace(t, { name: name.replaceAll(' ', '-') });
      const manifestPath = path.join(state.workspace.dir, 'project.json');
      const beforeManifest = fs.readFileSync(manifestPath);
      const beforeBriefNames = fs.readdirSync(path.join(state.workspace.dir, 'brief')).sort();
      const candidate = editedCandidate(state.baseBrief);
      mutate(candidate);

      assert.throws(() => saveDraftRevision(state.workspace, {
        baseJsonPath: state.baseJsonPath,
        brief: candidate,
        temporaryId: () => TEMPORARY_ID,
      }), pattern);
      assert.deepEqual(fs.readFileSync(manifestPath), beforeManifest);
      assert.deepEqual(fs.readdirSync(path.join(state.workspace.dir, 'brief')).sort(), beforeBriefNames);
      assert.deepEqual(tempEntries(state.workspace), []);
    });
  }
});
