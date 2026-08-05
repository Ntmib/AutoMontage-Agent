const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  createOrOpenProject,
  nextBriefPaths,
  nextRenderPaths,
  resolveProjectPath,
} = require('./workspace');

const SAFE_LEGACY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function assertSafeLegacyId(id) {
  if (typeof id !== 'string' || !SAFE_LEGACY_ID.test(id)) {
    throw new Error('--id должен быть безопасным token: буквы, цифры, _ или -');
  }
  return id;
}

function resolveOutputDestination({ cwd, outdir, outputName }) {
  if (typeof outputName !== 'string' || !SAFE_LEGACY_ID.test(outputName)) {
    throw new Error('output name должен быть безопасным token');
  }
  const outputRoot = path.resolve(cwd, outdir);
  const destination = path.resolve(outputRoot, `${outputName}.mp4`);
  const relative = path.relative(outputRoot, destination);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..'
    || path.isAbsolute(relative)) {
    throw new Error('output destination должен оставаться внутри outdir');
  }
  return destination;
}

function lstatIfPresent(candidate, fileSystem) {
  try {
    return fileSystem.lstatSync(candidate);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'ENOTDIR') {
      throw new Error(`output export: parent не является directory: ${candidate}`);
    }
    throw error;
  }
}

function assertDirectoryEntry(candidate, stat) {
  if (stat.isSymbolicLink()) {
    throw new Error(`output export: symbolic link запрещён: ${candidate}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`output export: parent не является directory: ${candidate}`);
  }
}

function assertRealpathContained(root, candidate, fileSystem) {
  const rootReal = fileSystem.realpathSync(root);
  const candidateReal = fileSystem.realpathSync(candidate);
  const relative = path.relative(rootReal, candidateReal);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('output export: realpath выходит за пределы безопасного каталога');
  }
}

function ensureSafeOutputDirectory(cwd, outputRoot, fileSystem) {
  let anchor = path.resolve(cwd);
  const relative = path.relative(anchor, outputRoot);
  if (path.isAbsolute(relative)) {
    throw new Error('output export: outdir находится на другом filesystem root');
  }
  const segments = relative.split(path.sep).filter(Boolean);
  while (segments[0] === '..') {
    anchor = path.dirname(anchor);
    segments.shift();
  }

  const anchorStat = lstatIfPresent(anchor, fileSystem);
  if (!anchorStat) throw new Error(`output export: anchor directory не существует: ${anchor}`);
  assertDirectoryEntry(anchor, anchorStat);
  const anchorReal = fileSystem.realpathSync(anchor);
  let current = anchor;
  for (const segment of segments) {
    if (segment === '..') throw new Error('output export: invalid outdir traversal');
    current = path.join(current, segment);
    let stat = lstatIfPresent(current, fileSystem);
    if (!stat) {
      try {
        fileSystem.mkdirSync(current);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      stat = lstatIfPresent(current, fileSystem);
      if (!stat) throw new Error(`output export: не удалось создать directory: ${current}`);
    }
    assertDirectoryEntry(current, stat);
    const currentReal = fileSystem.realpathSync(current);
    const realRelative = path.relative(anchorReal, currentReal);
    if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`)
      || path.isAbsolute(realRelative)) {
      throw new Error('output export: realpath outdir выходит за безопасный anchor');
    }
  }
  return outputRoot;
}

function assertSafeFinalDestination(destination, outputRoot, fileSystem) {
  const stat = lstatIfPresent(destination, fileSystem);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    throw new Error(`output export: final symbolic link запрещён: ${destination}`);
  }
  if (!stat.isFile()) {
    throw new Error(`output export: final destination должен быть regular file: ${destination}`);
  }
  assertRealpathContained(outputRoot, destination, fileSystem);
}

function copyFileToDescriptor(source, sourceStat, destination, fileSystem) {
  const constants = fileSystem.constants || fs.constants;
  const sourceFd = fileSystem.openSync(source, constants.O_RDONLY);
  let destinationFd;
  let destinationIdentity;
  try {
    destinationFd = fileSystem.openSync(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
      sourceStat.mode & 0o777,
    );
    const createdStat = fileSystem.fstatSync(destinationFd);
    destinationIdentity = { dev: createdStat.dev, ino: createdStat.ino };
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const bytesRead = fileSystem.readSync(sourceFd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        written += fileSystem.writeSync(destinationFd, buffer, written, bytesRead - written);
      }
      position += bytesRead;
    }
    fileSystem.fsyncSync(destinationFd);
    return destinationIdentity;
  } catch (error) {
    if (destinationFd !== undefined) fileSystem.closeSync(destinationFd);
    destinationFd = undefined;
    const stat = lstatIfPresent(destination, fileSystem);
    if (stat && !stat.isSymbolicLink() && stat.isFile()
      && stat.dev === destinationIdentity?.dev && stat.ino === destinationIdentity?.ino) {
      fileSystem.unlinkSync(destination);
    }
    throw error;
  } finally {
    if (destinationFd !== undefined) fileSystem.closeSync(destinationFd);
    fileSystem.closeSync(sourceFd);
  }
}

function copyOutputFile({
  cwd,
  outdir,
  outputName,
  source,
  fileSystem = fs,
  temporaryId = randomUUID,
}) {
  const destination = resolveOutputDestination({ cwd, outdir, outputName });
  const outputRoot = path.dirname(destination);
  const resolvedSource = path.resolve(source);
  const sourceStat = fileSystem.statSync(resolvedSource);
  if (!sourceStat.isFile()) throw new Error('output export: source должен быть regular file');

  ensureSafeOutputDirectory(cwd, outputRoot, fileSystem);
  assertSafeFinalDestination(destination, outputRoot, fileSystem);
  const token = String(temporaryId()).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token)) {
    throw new Error('output export: temporaryId должен быть UUID');
  }
  const temporary = path.join(outputRoot, `.${outputName}.export-${token}.tmp`);
  let temporaryIdentity;
  try {
    temporaryIdentity = copyFileToDescriptor(resolvedSource, sourceStat, temporary, fileSystem);
    ensureSafeOutputDirectory(cwd, outputRoot, fileSystem);
    assertSafeFinalDestination(destination, outputRoot, fileSystem);
    assertRealpathContained(outputRoot, temporary, fileSystem);
    fileSystem.renameSync(temporary, destination);
    temporaryIdentity = null;
    return destination;
  } finally {
    if (temporaryIdentity) {
      const stat = lstatIfPresent(temporary, fileSystem);
      if (stat && stat.isFile() && !stat.isSymbolicLink()
        && stat.dev === temporaryIdentity.dev && stat.ino === temporaryIdentity.ino) {
        fileSystem.unlinkSync(temporary);
      }
    }
  }
}

function legacyPaths(root, id, kind) {
  assertSafeLegacyId(id);
  const out = path.join(root, 'out');
  const briefStem = kind === 'scenario' ? `${id}.scenario` : `${id}.lesson`;
  const propsName = kind === 'lesson' ? `${id}.lesson.props.json` : `${id}.props.json`;
  return {
    briefJson: path.join(out, `${briefStem}.json`),
    briefMarkdown: kind === 'lesson' ? path.join(out, `${briefStem}.md`) : null,
    scenarioJson: path.join(out, `${id}.scenario.json`),
    props: path.join(out, propsName),
    raw: path.join(out, `${id}.raw.mp4`),
    final: path.join(out, `${id}.mp4`),
    render: null,
    transcript: path.join(out, `${id}.transcript.json`),
    captions: path.join(out, `${id}.captions.js`),
  };
}

function resolveProjectDirectory(root, projectName, projectDir) {
  if (projectDir) return path.resolve(projectDir);
  if (!projectName) return null;
  const namedDirectory = path.join(root, 'projects', projectName);
  if (fs.existsSync(path.join(namedDirectory, 'project.json'))) return namedDirectory;
  return null;
}

function assertInsideProject(projectDir, candidate) {
  const relative = path.relative(projectDir, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('brief должен находиться внутри проекта');
  }
}

function createBuildContext({
  root,
  cwd,
  video,
  projectName = null,
  projectDir = null,
  versionLabel = 'render',
  action = 'render',
  kind = 'lesson',
  id = 'out',
  now = new Date(),
}) {
  const resolvedRoot = path.resolve(root);
  const resolvedCwd = path.resolve(cwd);
  const resolvedVideo = path.resolve(resolvedCwd, video);
  const isProjectMode = Boolean(projectName || projectDir);
  assertSafeLegacyId(id);

  if (!isProjectMode) {
    const paths = legacyPaths(resolvedRoot, id, kind);
    return {
      video: resolvedVideo,
      project: null,
      paths,
      resolveBrief(input) {
        return path.resolve(resolvedCwd, input);
      },
    };
  }

  const existingProjectDir = resolveProjectDirectory(resolvedRoot, projectName, projectDir);
  const project = createOrOpenProject({
    baseDir: path.join(resolvedRoot, 'projects'),
    name: existingProjectDir ? undefined : projectName,
    projectDir: existingProjectDir,
    sourcePath: resolvedVideo,
    now,
  });
  const briefPaths = nextBriefPaths(project, kind);
  const renderPaths = action === 'render' ? nextRenderPaths(project, versionLabel) : null;
  const paths = {
    briefJson: briefPaths.jsonPath,
    briefMarkdown: kind === 'lesson' ? briefPaths.markdownPath : null,
    briefRevision: briefPaths.revision,
    scenarioJson: kind === 'scenario' ? briefPaths.jsonPath : null,
    props: renderPaths ? renderPaths.propsPath : null,
    raw: renderPaths ? renderPaths.rawPath : null,
    final: renderPaths ? renderPaths.finalPath : null,
    render: renderPaths,
    transcript: resolveProjectPath(project.dir, project.manifest.transcript.words, {
      label: 'manifest.transcript.words',
      mustExist: false,
    }),
    captions: resolveProjectPath(project.dir, project.manifest.transcript.captions, {
      label: 'manifest.transcript.captions',
      mustExist: false,
    }),
  };

  return {
    video: project.sourcePath,
    project,
    paths,
    resolveBrief(input) {
      const candidate = path.isAbsolute(input)
        ? path.resolve(input)
        : path.resolve(project.dir, input);
      assertInsideProject(project.dir, candidate);
      const relativePath = path.relative(project.dir, candidate).split(path.sep).join('/');
      return resolveProjectPath(project.dir, relativePath, {
        label: 'project brief path',
        mustExist: true,
        type: 'file',
      });
    },
  };
}

module.exports = {
  assertSafeLegacyId,
  copyOutputFile,
  createBuildContext,
  legacyPaths,
  resolveOutputDestination,
};
