const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  readProjectManifest,
  resolveProjectPath,
} = require('../project/workspace');
const { validateLessonBrief } = require('../lesson/brief');
const { auditBriefTiming } = require('./timing-audit');
const { listReviewAssetRecords, listReviewAssets } = require('./assets');

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function projectRelativePath(projectDir, filePath) {
  const relative = path.relative(projectDir, filePath);
  return relative.split(path.sep).join('/');
}

function resolveRegisteredBrief(projectDir, manifest, briefPath) {
  const storedPath = briefPath === undefined ? manifest.currentBrief : briefPath;
  if (typeof storedPath !== 'string' || storedPath.length === 0) {
    throw new Error('review brief is not selected in the project manifest');
  }

  let absolutePath;
  try {
    absolutePath = resolveProjectPath(projectDir, storedPath, {
      label: 'review brief path',
      mustExist: true,
      type: 'file',
    });
  } catch (_) {
    throw new Error('review brief path must stay inside the project workspace');
  }
  const relativePath = projectRelativePath(projectDir, absolutePath);
  const entry = manifest.briefs.find((brief) => brief.jsonPath === relativePath);
  if (!entry) throw new Error('review brief is not registered in the project manifest');
  return { entry, absolutePath };
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    throw new Error(`review ${label} must be valid JSON`);
  }
}

function normalizeTranscript(transcript) {
  if (!Array.isArray(transcript)) throw new Error('review transcript must be an array of segments');
  const segments = [];
  const words = [];
  for (const segment of transcript) {
    const start = Number(segment && segment.start);
    const end = Number(segment && segment.end);
    const text = String((segment && segment.text) || '').trim();
    if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start && text) {
      segments.push({ text, start, end });
    }
    for (const word of (Array.isArray(segment && segment.words) ? segment.words : [])) {
      const wordText = String((word && (word.w ?? word.word)) || '').trim();
      const wordStart = Number(word && (word.s ?? word.start));
      const wordEnd = Number(word && (word.e ?? word.end));
      if (wordText && Number.isFinite(wordStart) && Number.isFinite(wordEnd)
        && wordStart >= 0 && wordEnd >= wordStart) {
        words.push({ text: wordText, start: wordStart, end: wordEnd });
      }
    }
  }
  return { segments, words };
}

function browserScene(scene) {
  const result = { ...scene };
  delete result.faceSrc;
  delete result.brollSrc;
  if (result.brollMediaBlocked === true) {
    delete result.brollMediaBlocked;
    delete result.brollMedia;
    result.brollMediaDiagnostic = { code: 'unresolved-media', locked: true };
  }
  return result;
}

function buildReviewCandidateBase({ canonicalBrief, assetFiles } = {}) {
  if (!(assetFiles instanceof Map)) throw new Error('review asset registry is invalid');
  let candidate;
  try {
    candidate = structuredClone(canonicalBrief);
  } catch (_) {
    throw new Error('review brief is invalid');
  }
  if (!Array.isArray(candidate?.scenes)) throw new Error('review brief is invalid');
  for (const scene of candidate.scenes) {
    if (scene?.scene !== 'broll' || !scene.brollMedia) continue;
    const persisted = scene.brollMedia;
    let resolved = null;
    for (const [assetId, asset] of assetFiles) {
      const capability = persisted.kind === 'image'
        ? asset.capabilities?.brollImage
        : asset.capabilities?.brollVideo;
      if (asset.mediaKind === persisted.kind && capability === true
        && asset.reference === persisted.src
        && asset.canonicalSha256 === persisted.sha256) {
        resolved = { assetId, asset };
        break;
      }
    }
    delete scene.brollSrc;
    if (!resolved) {
      delete scene.brollMedia;
      scene.brollMediaBlocked = true;
      continue;
    }
    scene.brollMedia = persisted.kind === 'video'
      ? {
        kind: 'video',
        assetId: resolved.assetId,
        trimStartSec: persisted.trimStartSec,
        fit: persisted.fit,
        audioMode: persisted.audioMode,
      }
      : { kind: 'image', assetId: resolved.assetId, fit: persisted.fit };
  }
  return candidate;
}

function buildReviewStateFromEdit({ state, brief, timing } = {}) {
  return {
    ...state,
    output: {
      width: brief.output.width,
      height: brief.output.height,
      fps: brief.output.fps,
      durationInFrames: brief.output.durationInFrames,
    },
    brief: {
      status: brief.status,
      title: brief.title,
      scenes: brief.scenes.map(browserScene),
    },
    timing,
  };
}

function loadReviewBase({ projectDir, briefPath } = {}) {
  if (typeof projectDir !== 'string' || projectDir.length === 0) {
    throw new Error('review project directory is required');
  }
  const resolvedProjectDir = path.resolve(projectDir);
  const manifest = readProjectManifest(resolvedProjectDir);
  const workspace = { dir: resolvedProjectDir, manifest };
  const { entry, absolutePath: briefFilePath } = resolveRegisteredBrief(
    resolvedProjectDir,
    manifest,
    briefPath,
  );
  const brief = readJson(briefFilePath, 'brief');
  const validation = validateLessonBrief(brief);
  if (!validation.ok) throw new Error('review brief is invalid');
  if (brief.status !== entry.status) {
    throw new Error('review brief status does not match the project manifest');
  }
  return {
    workspace,
    entry,
    briefFilePath,
    brief,
    baseHash: hash(brief),
    manifestHash: hash(manifest),
  };
}

function buildReviewState({
  root,
  base,
  assetFiles,
  editable = false,
  waveformAvailable = false,
} = {}) {
  const {
    workspace,
    entry,
    brief,
    baseHash,
    manifestHash,
  } = base;
  const resolvedProjectDir = workspace.dir;
  const { manifest } = workspace;
  const registry = assetFiles instanceof Map
    ? assetFiles
    : new Map(listReviewAssetRecords({ root, projectDir: resolvedProjectDir })
      .map((asset, index) => [`asset-${index + 1}`, asset]));
  const reviewBrief = buildReviewCandidateBase({ canonicalBrief: brief, assetFiles: registry });
  const preview = manifest.currentPreview || null;

  let transcriptPath;
  try {
    transcriptPath = resolveProjectPath(resolvedProjectDir, manifest.transcript.words, {
      label: 'review transcript path',
      mustExist: true,
      type: 'file',
    });
  } catch (_) {
    throw new Error('review transcript must stay inside the project workspace');
  }
  const transcript = normalizeTranscript(readJson(transcriptPath, 'transcript'));

  return {
    project: { id: manifest.id, name: manifest.name },
    session: {
      editable: Boolean(editable),
      baseRevision: entry.revision,
      baseHash,
      manifestHash,
    },
    output: {
      width: brief.output.width,
      height: brief.output.height,
      fps: brief.output.fps,
      durationInFrames: brief.output.durationInFrames,
    },
    source: { url: '/media/source' },
    currentPreview: preview ? {
      url: '/media/current-preview',
      kind: preview.kind,
      fromSec: preview.fromSec,
      toSec: preview.toSec,
      width: preview.width,
      height: preview.height,
      fps: preview.fps,
      generatedAt: preview.generatedAt,
    } : null,
    brief: {
      status: reviewBrief.status,
      title: reviewBrief.title,
      scenes: reviewBrief.scenes.map(browserScene),
    },
    transcript,
    assets: listReviewAssets({ root, workspace }),
    timing: auditBriefTiming({ brief, words: transcript.words }),
    waveform: waveformAvailable ? { url: '/media/waveform' } : null,
  };
}

function loadReviewState({
  root,
  projectDir,
  briefPath,
  editable = false,
  waveformAvailable = false,
} = {}) {
  const base = loadReviewBase({ projectDir, briefPath });
  return buildReviewState({ root, base, editable, waveformAvailable });
}

module.exports = {
  buildReviewState,
  buildReviewStateFromEdit,
  buildReviewCandidateBase,
  loadReviewBase,
  loadReviewState,
};
