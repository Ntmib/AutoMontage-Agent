const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createOrOpenProject,
  nextBriefPaths,
  recordBrief,
  writeProjectManifest,
} = require('../../scripts/project/workspace');
const { formatBriefMarkdown } = require('../../scripts/lesson/brief');

function makeReviewProject(t, { briefStatus = 'draft' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const sourcePath = path.join(root, 'camera.mp4');
  fs.writeFileSync(sourcePath, 'video fixture');
  const workspace = createOrOpenProject({
    projectDir: path.join(root, 'project'),
    name: 'Review fixture',
    sourcePath,
    now: new Date('2026-08-20T12:00:00.000Z'),
  });
  const briefPaths = nextBriefPaths(workspace);
  const transcript = [{
    start: 0,
    end: 4,
    text: 'Первый фрагмент речи',
    words: [
      { w: 'Первый', s: 0, e: 0.4 },
      { w: 'фрагмент', s: 0.5, e: 1.1 },
      { w: 'речи', s: 1.2, e: 1.6 },
    ],
  }];
  const brief = {
    version: 1,
    status: briefStatus,
    source: sourcePath,
    theme: 'lesson-neutral',
    title: 'Безопасная проверка',
    output: {
      aspect: 'horizontal',
      width: 1920,
      height: 1080,
      fps: 25,
      durationInFrames: 100,
    },
    corrections: [],
    scenes: [
      { scene: 'fullscreen', start: 0, end: 2, caption: 'ПЕРВАЯ СЦЕНА' },
      { scene: 'fullscreen', start: 2, end: 4, caption: 'ВТОРАЯ СЦЕНА' },
    ],
  };

  fs.writeFileSync(
    path.join(workspace.dir, 'transcript', 'words.json'),
    `${JSON.stringify(transcript, null, 2)}\n`,
  );
  fs.writeFileSync(briefPaths.jsonPath, `${JSON.stringify(brief, null, 2)}\n`);
  fs.writeFileSync(briefPaths.markdownPath, formatBriefMarkdown(brief));
  recordBrief(workspace, {
    revision: briefPaths.revision,
    jsonPath: briefPaths.jsonPath,
    markdownPath: briefPaths.markdownPath,
    status: briefStatus,
    theme: 'lesson-neutral',
    aspect: 'horizontal',
  });

  return {
    root,
    workspace,
    projectDir: workspace.dir,
    briefPath: briefPaths.jsonPath,
    transcript,
  };
}

function registerHigherBrief(fixture, { revision = 5 } = {}) {
  const manifestPath = path.join(fixture.workspace.dir, 'project.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const currentBrief = JSON.parse(fs.readFileSync(fixture.briefPath, 'utf8'));
  const prefix = `v${String(revision).padStart(2, '0')}-draft.lesson`;
  const jsonPath = `brief/${prefix}.json`;
  const markdownPath = `brief/${prefix}.md`;
  const higherBrief = { ...currentBrief, status: 'draft' };
  fs.writeFileSync(path.join(fixture.workspace.dir, jsonPath), `${JSON.stringify(higherBrief, null, 2)}\n`);
  fs.writeFileSync(path.join(fixture.workspace.dir, markdownPath), formatBriefMarkdown(higherBrief));
  manifest.briefs.push({
    revision,
    jsonPath,
    markdownPath,
    status: 'draft',
    theme: higherBrief.theme,
    aspect: higherBrief.output.aspect,
  });
  writeProjectManifest(fixture.workspace.dir, manifest);
  fixture.workspace.manifest = manifest;
  return { jsonPath, markdownPath };
}

module.exports = { makeReviewProject, registerHigherBrief };
