const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Ajv = require('ajv');

const projectSchema = require('../../schema/project.schema.json');
const projectManifestValidator = new Ajv({ allErrors: true }).compile(projectSchema);

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
  const manifestPath = path.join(path.resolve(projectDir), 'project.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`project.json не найден: ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return validateProjectManifest(manifest, { projectDir });
}

function writeProjectManifest(projectDir, manifest) {
  const manifestPath = path.join(path.resolve(projectDir), 'project.json');
  const temporaryPath = `${manifestPath}.tmp`;
  const validatedManifest = validateProjectManifest(manifest, { projectDir });
  fs.writeFileSync(temporaryPath, `${JSON.stringify(validatedManifest, null, 2)}\n`);
  fs.renameSync(temporaryPath, manifestPath);
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
  for (const directory of directories) {
    fs.mkdirSync(path.join(projectDir, directory), { recursive: true });
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
  return {
    revision,
    jsonPath: path.join(workspace.dir, 'brief', `${prefix}.json`),
    markdownPath: path.join(workspace.dir, 'brief', `${prefix}.md`),
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

function approveBrief(workspace, draftJsonPath) {
  const draftRelativePath = relativeProjectPath(workspace, path.resolve(draftJsonPath));
  const draftEntry = workspace.manifest.briefs.find(
    (brief) => brief.jsonPath === draftRelativePath,
  );
  if (!draftEntry) throw new Error('черновик не зарегистрирован в project.json');
  const draftPath = resolveProjectPath(workspace.dir, draftEntry.jsonPath, {
    label: 'manifest.briefs[].jsonPath',
    mustExist: true,
    type: 'file',
  });
  if (!/-draft\.[^.]+\.json$/i.test(draftPath)) {
    throw new Error('имя черновика должно содержать -draft');
  }
  const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
  if (draft.status !== 'draft') throw new Error('утвердить можно только brief со статусом draft');

  const approvedJsonPath = draftPath.replace(/-draft(\.[^.]+\.json)$/i, '-approved$1');
  const approvedJsonRelativePath = relativeProjectPath(workspace, approvedJsonPath);
  resolveProjectPath(workspace.dir, approvedJsonRelativePath, {
    label: 'approved brief JSON path',
    mustExist: false,
  });
  const draftMarkdownPath = draftEntry.markdownPath
    ? resolveProjectPath(workspace.dir, draftEntry.markdownPath, {
      label: 'manifest.briefs[].markdownPath',
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
      mustExist: false,
    });
  }
  fs.writeFileSync(approvedJsonPath, `${JSON.stringify({ ...draft, status: 'approved' }, null, 2)}\n`);

  if (approvedMarkdownPath) {
    const markdown = fs.readFileSync(draftMarkdownPath, 'utf8');
    fs.writeFileSync(approvedMarkdownPath, markdown.replace(/Статус:\s*draft/i, 'Статус: approved'));
  }

  recordBrief(workspace, {
    revision: draftEntry.revision,
    jsonPath: approvedJsonPath,
    markdownPath: approvedMarkdownPath,
    status: 'approved',
    theme: draftEntry.theme,
    aspect: draftEntry.aspect,
  });
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
  const dir = path.join(
    workspace.dir,
    'renders',
    `${formatVersion(version)}-${safeLabel}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return {
    version,
    label: safeLabel,
    dir,
    propsPath: path.join(dir, 'props.json'),
    rawPath: path.join(dir, 'raw.mp4'),
    finalPath: path.join(dir, 'final.mp4'),
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
