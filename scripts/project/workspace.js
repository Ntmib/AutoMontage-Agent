const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Ajv = require('ajv');

const projectSchema = require('../../schema/project.schema.json');
const { formatBriefMarkdown } = require('../lesson/brief');
const projectManifestValidator = new Ajv({ allErrors: true }).compile(projectSchema);
const TEMPORARY_ID = /^[A-Za-z0-9_-]+$/;

const CYRILLIC_TO_LATIN = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh',
  з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu',
  я: 'ya',
};

function transliterate(value) {
  return [...value].map((character) => CYRILLIC_TO_LATIN[character] ?? character).join('');
}

function slugifyProjectName(name) {
  const latin = transliterate(String(name || '').trim().toLowerCase());
  const slug = latin.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('название проекта не содержит букв или цифр');
  return slug;
}

function formatProjectId({ date, name }) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error('дата проекта должна быть корректной');
  }
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}.${month}.${day}_${slugifyProjectName(name)}`;
}

function migrateProjectManifest(manifest) {
  if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)
    && !Object.hasOwn(manifest, 'transcript')) {
    manifest.transcript = {
      words: 'transcript/words.json',
      captions: 'transcript/captions.js',
    };
  }
  return manifest;
}

function formatProjectManifestSchemaError(error) {
  const location = error.instancePath || '';
  const missingProperty = error.keyword === 'required'
    ? `.${error.params.missingProperty}`
    : '';
  const extraProperty = error.keyword === 'additionalProperties'
    ? `.${error.params.additionalProperty}`
    : '';
  return `manifest${location}${missingProperty}${extraProperty}: ${error.message}`;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative));
}

function lstatIfPresent(fileSystem, target) {
  try {
    return fileSystem.lstatSync(target);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
    throw error;
  }
}

function assertNoProjectSymlink(root, segments, fileSystem, label) {
  const rootStat = fileSystem.lstatSync(root);
  if (rootStat.isSymbolicLink()) {
    throw new Error(`${label} escapes through a symbolic link`);
  }
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = lstatIfPresent(fileSystem, current);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} escapes through a symbolic link`);
    }
  }
}

function resolveProjectPath(projectDir, storedPath, options = {}) {
  const label = options.label || 'project path';
  const fileSystem = options.fileSystem || fs;
  if (typeof storedPath !== 'string' || storedPath.length === 0 || storedPath.includes('\0')) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  if (path.isAbsolute(storedPath)
    || path.win32.isAbsolute(storedPath)
    || path.win32.parse(storedPath).root !== '') {
    throw new Error(`${label} must stay inside the project workspace`);
  }
  const segments = storedPath.split(/[\\/]/);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${label} must be a canonical relative path`);
  }

  const root = path.resolve(projectDir);
  const candidate = path.resolve(root, ...segments);
  if (!isInside(root, candidate)) {
    throw new Error(`${label} escapes the project workspace`);
  }

  assertNoProjectSymlink(root, segments, fileSystem, label);
  const rootReal = fileSystem.realpathSync(root);
  let ancestor = candidate;
  while (!fileSystem.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const ancestorReal = fileSystem.realpathSync(ancestor);
  if (!isInside(rootReal, ancestorReal)) {
    throw new Error(`${label} escapes through a symbolic link`);
  }

  if (options.mustExist && !fileSystem.existsSync(candidate)) {
    throw new Error(`${label} does not exist`);
  }
  if (fileSystem.existsSync(candidate)) {
    const candidateReal = fileSystem.realpathSync(candidate);
    if (!isInside(rootReal, candidateReal)) {
      throw new Error(`${label} escapes through a symbolic link`);
    }
    const stat = fileSystem.statSync(candidateReal);
    if (options.type === 'file' && !stat.isFile()) throw new Error(`${label} must be a file`);
    if (options.type === 'directory' && !stat.isDirectory()) {
      throw new Error(`${label} must be a directory`);
    }
  }
  return candidate;
}

function safeTemporaryId(temporaryId) {
  const value = String(temporaryId());
  if (!TEMPORARY_ID.test(value)) throw new Error('temporary file id is unsafe');
  return value;
}

function sameFileIdentity(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino;
}

function stageOwnedSiblingFile(destination, data, {
  fileSystem = fs,
  temporaryId = randomUUID,
  purpose = 'write',
} = {}) {
  const temporaryPath = `${destination}.tmp-${purpose}-${safeTemporaryId(temporaryId)}`;
  const constants = fileSystem.constants || fs.constants;
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    | (constants.O_NOFOLLOW || 0);
  let handle = null;
  let identity = null;
  try {
    handle = fileSystem.openSync(temporaryPath, flags, 0o600);
    identity = fileSystem.fstatSync(handle);
    if (!identity.isFile()) throw new Error('temporary project file must be regular');
    fileSystem.writeFileSync(handle, data, { encoding: 'utf8' });
    fileSystem.fsyncSync(handle);
  } catch (error) {
    if (handle !== null) fileSystem.closeSync(handle);
    const current = lstatIfPresent(fileSystem, temporaryPath);
    if (identity && current && sameFileIdentity(identity, current)) {
      fileSystem.unlinkSync(temporaryPath);
    }
    throw error;
  }
  fileSystem.closeSync(handle);

  let committedPath = null;
  return {
    path: temporaryPath,
    commit(target = destination) {
      fileSystem.renameSync(temporaryPath, target);
      committedPath = target;
    },
    cleanupTemp() {
      const current = lstatIfPresent(fileSystem, temporaryPath);
      if (current && sameFileIdentity(identity, current)) fileSystem.unlinkSync(temporaryPath);
    },
    removeCommitted() {
      if (!committedPath) return;
      const current = lstatIfPresent(fileSystem, committedPath);
      if (current && sameFileIdentity(identity, current)) fileSystem.unlinkSync(committedPath);
      committedPath = null;
    },
  };
}

function validateProjectManifest(manifest, { projectDir, fileSystem = fs } = {}) {
  const migratedManifest = migrateProjectManifest(manifest);
  if (!projectManifestValidator(migratedManifest)) {
    throw new Error((projectManifestValidator.errors || [])
      .map(formatProjectManifestSchemaError)
      .join('\n'));
  }
  if (migratedManifest.currentBrief !== null
    && !migratedManifest.briefs.some((brief) => brief.jsonPath === migratedManifest.currentBrief)) {
    throw new Error('manifest.currentBrief must match one manifest.briefs[].jsonPath entry');
  }
  if (migratedManifest.latestRender !== null
    && !migratedManifest.renders.some((render) => (
      render.dir === migratedManifest.latestRender && render.status === 'complete'
    ))) {
    throw new Error('manifest.latestRender must match one complete manifest.renders[].dir entry');
  }
  if (!projectDir) return migratedManifest;

  const paths = [
    ['manifest.source.localPath', migratedManifest.source.localPath],
    ['manifest.transcript.words', migratedManifest.transcript.words],
    ['manifest.transcript.captions', migratedManifest.transcript.captions],
    ['manifest.currentBrief', migratedManifest.currentBrief],
    ['manifest.latestRender', migratedManifest.latestRender],
    ['manifest.final', migratedManifest.final],
  ];
  migratedManifest.briefs.forEach((brief, index) => {
    paths.push([`manifest.briefs[${index}].jsonPath`, brief.jsonPath]);
    if (brief.markdownPath !== null) {
      paths.push([`manifest.briefs[${index}].markdownPath`, brief.markdownPath]);
    }
  });
  migratedManifest.renders.forEach((render, index) => {
    paths.push([`manifest.renders[${index}].dir`, render.dir]);
    if (render.briefPath !== null) {
      paths.push([`manifest.renders[${index}].briefPath`, render.briefPath]);
    }
  });
  for (const [label, storedPath] of paths) {
    if (storedPath !== null) {
      resolveProjectPath(projectDir, storedPath, { label, fileSystem });
    }
  }
  return migratedManifest;
}

function readProjectManifest(projectDir) {
  const resolvedProjectDir = path.resolve(projectDir);
  const manifestPath = resolveProjectPath(resolvedProjectDir, 'project.json', {
    label: 'project.json',
    mustExist: false,
    type: 'file',
  });
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`project.json не найден: ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return validateProjectManifest(manifest, { projectDir: resolvedProjectDir });
}

function writeProjectManifest(projectDir, manifest, {
  fileSystem = fs,
  temporaryId = randomUUID,
} = {}) {
  const resolvedProjectDir = path.resolve(projectDir);
  const manifestPath = resolveProjectPath(resolvedProjectDir, 'project.json', {
    label: 'project.json',
    fileSystem,
    mustExist: false,
    type: 'file',
  });
  const validatedManifest = validateProjectManifest(manifest, {
    projectDir: resolvedProjectDir,
    fileSystem,
  });
  const staged = stageOwnedSiblingFile(
    manifestPath,
    `${JSON.stringify(validatedManifest, null, 2)}\n`,
    { fileSystem, temporaryId, purpose: 'manifest' },
  );
  try {
    staged.commit();
  } finally {
    staged.cleanupTemp();
  }
}

function ensureProjectDirectories(projectDir) {
  const directories = [
    'input',
    'transcript',
    'brief',
    'assets/music',
    'assets/broll',
    'previews',
    'renders',
    'final',
  ];
  fs.mkdirSync(projectDir, { recursive: true });
  for (const directory of directories) {
    const directoryPath = resolveProjectPath(projectDir, directory, {
      label: `project directory ${directory}`,
      mustExist: false,
      type: 'directory',
    });
    fs.mkdirSync(directoryPath, { recursive: true });
    resolveProjectPath(projectDir, directory, {
      label: `project directory ${directory}`,
      mustExist: true,
      type: 'directory',
    });
  }
}

function asWorkspace(projectDir, manifest) {
  return {
    dir: projectDir,
    manifestPath: path.join(projectDir, 'project.json'),
    sourcePath: resolveProjectPath(projectDir, manifest.source.localPath, {
      label: 'manifest.source.localPath',
      mustExist: true,
      type: 'file',
    }),
    manifest,
  };
}

function assertMatchingSource(projectDir, manifest, sourcePath) {
  if (!sourcePath) return;
  const resolvedSource = path.resolve(sourcePath);
  const originalSource = path.resolve(manifest.source.originalPath);
  const localSource = resolveProjectPath(projectDir, manifest.source.localPath, {
    label: 'manifest.source.localPath',
    mustExist: true,
    type: 'file',
  });
  if (resolvedSource !== originalSource && resolvedSource !== localSource) {
    throw new Error('проект уже использует другой исходник');
  }
}

function createOrOpenProject({
  baseDir,
  name,
  projectDir,
  sourcePath,
  now = new Date(),
}) {
  const resolvedProjectDir = projectDir
    ? path.resolve(projectDir)
    : path.join(path.resolve(baseDir), formatProjectId({ date: now, name }));
  const manifestPath = path.join(resolvedProjectDir, 'project.json');

  if (fs.existsSync(manifestPath)) {
    const manifest = readProjectManifest(resolvedProjectDir);
    if (!manifest.transcript) {
      manifest.transcript = {
        words: 'transcript/words.json',
        captions: 'transcript/captions.js',
      };
      writeProjectManifest(resolvedProjectDir, manifest);
    }
    assertMatchingSource(resolvedProjectDir, manifest, sourcePath);
    ensureProjectDirectories(resolvedProjectDir);
    return asWorkspace(resolvedProjectDir, manifest);
  }

  if (!name) throw new Error('для нового проекта нужно название');
  if (!sourcePath) throw new Error('для нового проекта нужен исходник');
  const originalPath = path.resolve(sourcePath);
  if (!fs.existsSync(originalPath) || !fs.statSync(originalPath).isFile()) {
    throw new Error(`исходник не найден: ${originalPath}`);
  }

  const slug = slugifyProjectName(name);
  const id = projectDir ? path.basename(resolvedProjectDir) : formatProjectId({ date: now, name });
  const extension = path.extname(originalPath).toLowerCase() || '.mp4';
  const localPath = path.posix.join('input', `source${extension}`);
  const timestamp = now.toISOString();
  const manifest = {
    version: 1,
    id,
    name,
    slug,
    createdAt: timestamp,
    updatedAt: timestamp,
    source: {
      originalPath,
      localPath,
    },
    transcript: {
      words: 'transcript/words.json',
      captions: 'transcript/captions.js',
    },
    briefs: [],
    renders: [],
    currentBrief: null,
    latestRender: null,
    final: path.posix.join('final', `${slug}.mp4`),
  };

  ensureProjectDirectories(resolvedProjectDir);
  const localSourcePath = resolveProjectPath(resolvedProjectDir, localPath, {
    label: 'manifest.source.localPath',
    mustExist: false,
  });
  fs.copyFileSync(originalPath, localSourcePath, fs.constants.COPYFILE_EXCL);
  writeProjectManifest(resolvedProjectDir, manifest);
  return asWorkspace(resolvedProjectDir, manifest);
}

function formatVersion(number) {
  return `v${String(number).padStart(2, '0')}`;
}

function relativeProjectPath(workspace, filePath) {
  const relative = path.relative(workspace.dir, path.resolve(filePath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('путь должен находиться внутри проекта');
  }
  return relative.split(path.sep).join('/');
}

function nextBriefPaths(workspace, kind = 'lesson') {
  const highestRevision = workspace.manifest.briefs.reduce(
    (highest, brief) => Math.max(highest, Number(brief.revision) || 0),
    0,
  );
  const revision = highestRevision + 1;
  const prefix = `${formatVersion(revision)}-draft.${kind}`;
  resolveProjectPath(workspace.dir, 'brief', {
    label: 'project directory brief',
    mustExist: true,
    type: 'directory',
  });
  return {
    revision,
    jsonPath: resolveProjectPath(workspace.dir, path.posix.join('brief', `${prefix}.json`), {
      label: 'next brief JSON path',
      mustExist: false,
      type: 'file',
    }),
    markdownPath: resolveProjectPath(workspace.dir, path.posix.join('brief', `${prefix}.md`), {
      label: 'next brief Markdown path',
      mustExist: false,
      type: 'file',
    }),
  };
}

function recordBrief(workspace, {
  revision,
  jsonPath,
  markdownPath,
  status,
  theme = null,
  aspect = null,
}) {
  const entry = {
    revision,
    jsonPath: relativeProjectPath(workspace, jsonPath),
    markdownPath: markdownPath ? relativeProjectPath(workspace, markdownPath) : null,
    status,
    theme,
    aspect,
  };
  workspace.manifest.briefs.push(entry);
  workspace.manifest.currentBrief = entry.jsonPath;
  workspace.manifest.updatedAt = new Date().toISOString();
  writeProjectManifest(workspace.dir, workspace.manifest);
  return workspace;
}

function approveBrief(workspace, draftJsonPath, {
  fileSystem = fs,
  temporaryId = randomUUID,
} = {}) {
  const draftRelativePath = relativeProjectPath(workspace, path.resolve(draftJsonPath));
  const draftEntry = workspace.manifest.briefs.find(
    (brief) => brief.jsonPath === draftRelativePath,
  );
  if (!draftEntry) throw new Error('черновик не зарегистрирован в project.json');
  const draftPath = resolveProjectPath(workspace.dir, draftEntry.jsonPath, {
    label: 'manifest.briefs[].jsonPath',
    fileSystem,
    mustExist: true,
    type: 'file',
  });
  if (!/-draft\.[^.]+\.json$/i.test(draftPath)) {
    throw new Error('имя черновика должно содержать -draft');
  }
  const draft = JSON.parse(fileSystem.readFileSync(draftPath, 'utf8'));
  if (draft.status !== 'draft') throw new Error('утвердить можно только brief со статусом draft');

  const approvedJsonPath = draftPath.replace(/-draft(\.[^.]+\.json)$/i, '-approved$1');
  const approvedJsonRelativePath = relativeProjectPath(workspace, approvedJsonPath);
  resolveProjectPath(workspace.dir, approvedJsonRelativePath, {
    label: 'approved brief JSON path',
    fileSystem,
    mustExist: false,
  });
  const draftMarkdownPath = draftEntry.markdownPath
    ? resolveProjectPath(workspace.dir, draftEntry.markdownPath, {
      label: 'manifest.briefs[].markdownPath',
      fileSystem,
      mustExist: true,
      type: 'file',
    })
    : null;
  const approvedMarkdownPath = draftMarkdownPath
    ? draftMarkdownPath.replace(/-draft(\.[^.]+\.md)$/i, '-approved$1')
    : null;
  if (approvedMarkdownPath) {
    resolveProjectPath(workspace.dir, relativeProjectPath(workspace, approvedMarkdownPath), {
      label: 'approved brief Markdown path',
      fileSystem,
      mustExist: false,
    });
  }
  for (const [label, destination] of [
    ['approved brief JSON path', approvedJsonPath],
    ['approved brief Markdown path', approvedMarkdownPath],
  ]) {
    if (destination && lstatIfPresent(fileSystem, destination)) {
      throw new Error(`${label} already exists`);
    }
  }
  const approvedBrief = { ...draft, status: 'approved' };
  const approvedMarkdown = approvedMarkdownPath ? formatBriefMarkdown(approvedBrief) : null;
  const entry = {
    revision: draftEntry.revision,
    jsonPath: approvedJsonRelativePath,
    markdownPath: approvedMarkdownPath
      ? relativeProjectPath(workspace, approvedMarkdownPath)
      : null,
    status: 'approved',
    theme: draftEntry.theme,
    aspect: draftEntry.aspect,
  };
  const nextManifest = JSON.parse(JSON.stringify(workspace.manifest));
  nextManifest.briefs.push(entry);
  nextManifest.currentBrief = entry.jsonPath;
  nextManifest.updatedAt = new Date().toISOString();
  const validatedManifest = validateProjectManifest(nextManifest, {
    projectDir: workspace.dir,
    fileSystem,
  });
  const manifestPath = resolveProjectPath(workspace.dir, 'project.json', {
    label: 'project.json',
    fileSystem,
    mustExist: true,
    type: 'file',
  });
  const oldManifest = fileSystem.readFileSync(manifestPath, 'utf8');
  const stages = [];
  let manifestStage;
  let rollbackStage;
  let markdownStage = null;
  let jsonStage;
  let manifestCommitted = false;
  try {
    manifestStage = stageOwnedSiblingFile(
      manifestPath,
      `${JSON.stringify(validatedManifest, null, 2)}\n`,
      { fileSystem, temporaryId, purpose: 'approval-manifest' },
    );
    stages.push(manifestStage);
    rollbackStage = stageOwnedSiblingFile(manifestPath, oldManifest, {
      fileSystem,
      temporaryId,
      purpose: 'approval-rollback',
    });
    stages.push(rollbackStage);
    if (approvedMarkdownPath) {
      markdownStage = stageOwnedSiblingFile(approvedMarkdownPath, approvedMarkdown, {
        fileSystem,
        temporaryId,
        purpose: 'approval-markdown',
      });
      stages.push(markdownStage);
    }
    jsonStage = stageOwnedSiblingFile(
      approvedJsonPath,
      `${JSON.stringify(approvedBrief, null, 2)}\n`,
      { fileSystem, temporaryId, purpose: 'approval-json' },
    );
    stages.push(jsonStage);

    manifestStage.commit();
    manifestCommitted = true;
    if (markdownStage) markdownStage.commit();
    jsonStage.commit();
  } catch (error) {
    const rollbackErrors = [];
    try {
      if (markdownStage) markdownStage.removeCommitted();
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (manifestCommitted) {
      try {
        rollbackStage.commit(manifestPath);
        manifestCommitted = false;
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length) error.rollbackErrors = rollbackErrors;
    throw error;
  } finally {
    for (const stage of stages) stage.cleanupTemp();
  }
  workspace.manifest = validatedManifest;
  return {
    revision: draftEntry.revision,
    jsonPath: approvedJsonPath,
    markdownPath: approvedMarkdownPath,
  };
}

function nextRenderPaths(workspace, label = 'render') {
  const highestVersion = workspace.manifest.renders.reduce(
    (highest, render) => Math.max(highest, Number(render.version) || 0),
    0,
  );
  const version = highestVersion + 1;
  const safeLabel = slugifyProjectName(label);
  const renderDirectory = path.posix.join('renders', `${formatVersion(version)}-${safeLabel}`);
  resolveProjectPath(workspace.dir, 'renders', {
    label: 'project directory renders',
    mustExist: true,
    type: 'directory',
  });
  const dir = resolveProjectPath(workspace.dir, renderDirectory, {
    label: 'next render directory',
    mustExist: false,
    type: 'directory',
  });
  fs.mkdirSync(dir, { recursive: true });
  resolveProjectPath(workspace.dir, renderDirectory, {
    label: 'next render directory',
    mustExist: true,
    type: 'directory',
  });
  return {
    version,
    label: safeLabel,
    dir,
    propsPath: resolveProjectPath(workspace.dir, path.posix.join(renderDirectory, 'props.json'), {
      label: 'next render props path',
      mustExist: false,
      type: 'file',
    }),
    rawPath: resolveProjectPath(workspace.dir, path.posix.join(renderDirectory, 'raw.mp4'), {
      label: 'next render raw path',
      mustExist: false,
      type: 'file',
    }),
    finalPath: resolveProjectPath(workspace.dir, path.posix.join(renderDirectory, 'final.mp4'), {
      label: 'next render final path',
      mustExist: false,
      type: 'file',
    }),
  };
}

function recordRender(workspace, {
  version,
  label,
  dir,
  briefPath = null,
  status,
}) {
  const entry = {
    version,
    label,
    dir: relativeProjectPath(workspace, dir),
    briefPath: briefPath ? relativeProjectPath(workspace, briefPath) : null,
    status,
  };
  const existingIndex = workspace.manifest.renders.findIndex(
    (render) => Number(render.version) === Number(version),
  );
  if (existingIndex >= 0) {
    workspace.manifest.renders[existingIndex] = {
      ...workspace.manifest.renders[existingIndex],
      ...entry,
    };
  } else {
    workspace.manifest.renders.push(entry);
  }
  if (status === 'complete') workspace.manifest.latestRender = entry.dir;
  workspace.manifest.updatedAt = new Date().toISOString();
  writeProjectManifest(workspace.dir, workspace.manifest);
  return workspace;
}

function publishFinal(workspace, renderFinalPath, {
  fileSystem = fs,
  temporaryId = randomUUID,
} = {}) {
  const sourceRelativePath = relativeProjectPath(workspace, path.resolve(renderFinalPath));
  const sourcePath = resolveProjectPath(workspace.dir, sourceRelativePath, {
    label: 'render final path',
    fileSystem,
    mustExist: true,
    type: 'file',
  });
  const destination = resolveProjectPath(workspace.dir, workspace.manifest.final, {
    label: 'manifest.final',
    fileSystem,
    mustExist: false,
  });
  const temporaryPath = `${destination}.tmp-${temporaryId()}`;
  let temporaryHandle = null;
  fileSystem.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fileSystem.copyFileSync(sourcePath, temporaryPath);
    temporaryHandle = fileSystem.openSync(temporaryPath, 'r');
    fileSystem.fsyncSync(temporaryHandle);
    fileSystem.closeSync(temporaryHandle);
    temporaryHandle = null;
    fileSystem.renameSync(temporaryPath, destination);
    return destination;
  } finally {
    if (temporaryHandle !== null) fileSystem.closeSync(temporaryHandle);
    if (fileSystem.existsSync(temporaryPath)) fileSystem.unlinkSync(temporaryPath);
  }
}

function runRenderLifecycle(workspace, render, operation, {
  publish = publishFinal,
} = {}) {
  if (!workspace) return operation();
  const metadata = {
    version: render.version,
    label: render.label,
    dir: render.dir,
    briefPath: render.briefPath || null,
  };
  recordRender(workspace, { ...metadata, status: 'started' });
  try {
    const renderFinalPath = operation();
    const destination = publish(workspace, renderFinalPath);
    recordRender(workspace, { ...metadata, status: 'complete' });
    return destination;
  } catch (error) {
    try {
      recordRender(workspace, { ...metadata, status: 'failed' });
    } catch (manifestError) {
      error.manifestError = manifestError;
    }
    throw error;
  }
}

module.exports = {
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
  validateProjectManifest,
  writeProjectManifest,
};
