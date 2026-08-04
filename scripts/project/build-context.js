const fs = require('node:fs');
const path = require('node:path');

const {
  createOrOpenProject,
  nextBriefPaths,
  nextRenderPaths,
} = require('./workspace');

function legacyPaths(root, id, kind) {
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
      return candidate;
    },
  };
}

module.exports = {
  createBuildContext,
  legacyPaths,
};
