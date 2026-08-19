const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  readProjectManifest,
  resolveProjectPath,
} = require('../project/workspace');
const { validateLessonBrief } = require('../lesson/brief');
const { auditBriefTiming } = require('./timing-audit');
const { listReviewAssets } = require('./assets');

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
  return result;
}

function loadReviewState({
  root,
  projectDir,
  briefPath,
  editable = false,
  waveformAvailable = false,
} = {}) {
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
      baseHash: hash(brief),
      manifestHash: hash(manifest),
    },
    output: {
      width: brief.output.width,
      height: brief.output.height,
      fps: brief.output.fps,
      durationInFrames: brief.output.durationInFrames,
    },
    source: { url: '/media/source' },
    brief: {
      status: brief.status,
      title: brief.title,
      scenes: brief.scenes.map(browserScene),
    },
    transcript,
    assets: listReviewAssets({ root, workspace }),
    timing: auditBriefTiming({ brief, transcript: transcript.segments }),
    waveform: waveformAvailable ? { url: '/media/waveform' } : null,
  };
}

module.exports = { loadReviewState };
