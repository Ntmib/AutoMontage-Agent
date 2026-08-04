const fs = require('node:fs');
const path = require('node:path');

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

function readProjectManifest(projectDir) {
  const manifestPath = path.join(path.resolve(projectDir), 'project.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`project.json не найден: ${manifestPath}`);
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function writeProjectManifest(projectDir, manifest) {
  const manifestPath = path.join(path.resolve(projectDir), 'project.json');
  const temporaryPath = `${manifestPath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(temporaryPath, manifestPath);
}

function ensureProjectDirectories(projectDir) {
  const directories = [
    'input',
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
    sourcePath: path.join(projectDir, manifest.source.localPath),
    manifest,
  };
}

function assertMatchingSource(projectDir, manifest, sourcePath) {
  if (!sourcePath) return;
  const resolvedSource = path.resolve(sourcePath);
  const originalSource = path.resolve(manifest.source.originalPath);
  const localSource = path.resolve(projectDir, manifest.source.localPath);
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
    assertMatchingSource(resolvedProjectDir, manifest, sourcePath);
    ensureProjectDirectories(resolvedProjectDir);
    if (!fs.existsSync(path.join(resolvedProjectDir, manifest.source.localPath))) {
      throw new Error('локальная копия исходника проекта не найдена');
    }
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
    briefs: [],
    renders: [],
    currentBrief: null,
    latestRender: null,
    final: path.posix.join('final', `${slug}.mp4`),
  };

  ensureProjectDirectories(resolvedProjectDir);
  fs.copyFileSync(originalPath, path.join(resolvedProjectDir, localPath), fs.constants.COPYFILE_EXCL);
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

function publishFinal(workspace, renderFinalPath) {
  const sourcePath = path.resolve(renderFinalPath);
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error(`финальный рендер не найден: ${sourcePath}`);
  }
  relativeProjectPath(workspace, sourcePath);
  const destination = path.join(workspace.dir, workspace.manifest.final);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(sourcePath, destination);
  workspace.manifest.updatedAt = new Date().toISOString();
  writeProjectManifest(workspace.dir, workspace.manifest);
  return destination;
}

module.exports = {
  createOrOpenProject,
  formatProjectId,
  nextBriefPaths,
  nextRenderPaths,
  publishFinal,
  readProjectManifest,
  recordBrief,
  recordRender,
  slugifyProjectName,
  writeProjectManifest,
};
