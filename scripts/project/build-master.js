#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Ajv = require('ajv');

const sourceEditSchema = require('../../schema/source-edit.schema.json');
const { configureMediaToolPath } = require('../env');
const { probeVideo } = require('../media-probe');
const { runTool } = require('../process');
const { collectWords } = require('../tighten');
const { runTrim } = require('../trim-media');
const {
  readProjectManifest,
  resolveProjectPath,
  withProjectMutation,
} = require('./workspace');

const validateSchema = new Ajv({ allErrors: true }).compile(sourceEditSchema);
const SAFE_TOKEN = /^[A-Za-z0-9_-]+$/;

function formatSchemaError(error) {
  const suffix = error.keyword === 'required' ? `.${error.params.missingProperty}` : '';
  return `source edit${error.instancePath || ''}${suffix}: ${error.message}`;
}

function isFrameBoundary(value, fps) {
  return Math.abs((value * fps) - Math.round(value * fps)) <= 1e-6;
}

function validateSourceEdit(edit, { sourceRevision, sourceDuration } = {}) {
  if (!validateSchema(edit)) {
    throw new Error((validateSchema.errors || []).map(formatSchemaError).join('\n'));
  }
  if (!Number.isSafeInteger(sourceRevision) || edit.sourceRevision !== sourceRevision) {
    throw new Error('source edit revision does not match the active source revision');
  }
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) {
    throw new Error('source duration is invalid');
  }
  let previousEnd = -1;
  for (const [index, range] of edit.keep.entries()) {
    if (range.end <= range.start) throw new Error(`keep[${index}] must have end > start`);
    if (range.start < previousEnd) throw new Error(`keep[${index}] overlaps the previous range`);
    if (range.end > sourceDuration + 1e-6) {
      throw new Error(`keep[${index}] exceeds source duration`);
    }
    if (!isFrameBoundary(range.start, edit.fps) || !isFrameBoundary(range.end, edit.fps)) {
      throw new Error(`keep[${index}] must use exact frame boundaries`);
    }
    previousEnd = range.end;
  }
  return structuredClone(edit);
}

function roundedTime(value, fps) {
  const precision = Math.max(3, Math.ceil(Math.log10(fps || 1)) + 2);
  return Number(value.toFixed(precision));
}

function remapTranscriptWords(words, keepRanges, fps) {
  if (!Array.isArray(words) || !Array.isArray(keepRanges) || !keepRanges.length) {
    throw new Error('transcript remap requires words and keep ranges');
  }
  const ranges = keepRanges.map(({ start, end }) => ({ start: Number(start), end: Number(end) }));
  const prefix = [];
  let kept = 0;
  for (const range of ranges) {
    prefix.push(kept);
    kept += range.end - range.start;
  }
  const mapped = [];
  for (const word of words) {
    const start = Number(word.s);
    const end = Number(word.e);
    const overlaps = ranges
      .map((range, index) => ({
        index,
        start: Math.max(start, range.start),
        end: Math.min(end, range.end),
      }))
      .filter((overlap) => overlap.end > overlap.start);
    if (!overlaps.length) continue;
    const first = overlaps[0];
    const last = overlaps.at(-1);
    const mappedStart = prefix[first.index] + first.start - ranges[first.index].start;
    const mappedEnd = prefix[last.index] + last.end - ranges[last.index].start;
    mapped.push({
      ...word,
      s: roundedTime(mappedStart, fps),
      e: roundedTime(mappedEnd, fps),
    });
  }
  return mapped.sort((left, right) => left.s - right.s || left.e - right.e);
}

function projectRelative(projectDir, target) {
  const relative = path.relative(projectDir, path.resolve(target));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw new Error('master path must stay inside the project workspace');
  }
  return relative.split(path.sep).join('/');
}

function safeToken(temporaryId) {
  const value = String(temporaryId());
  if (!SAFE_TOKEN.test(value)) throw new Error('master temporary id is unsafe');
  return value;
}

function statRegular(fileSystem, target) {
  const stat = fileSystem.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('master stage must be a regular file');
  return stat;
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function removeOwned(fileSystem, target, expected) {
  try {
    const current = fileSystem.lstatSync(target);
    if (!current.isSymbolicLink() && current.isFile() && sameIdentity(current, expected)) {
      fileSystem.unlinkSync(target);
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
}

function fsyncFile(fileSystem, target) {
  const descriptor = fileSystem.openSync(target, 'r+');
  try {
    const stat = fileSystem.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('master stage must be a regular file');
    fileSystem.fsyncSync(descriptor);
    return stat;
  } finally {
    fileSystem.closeSync(descriptor);
  }
}

function writeExclusiveStage(fileSystem, target, bytes) {
  const descriptor = fileSystem.openSync(target, 'wx', 0o600);
  try {
    fileSystem.writeFileSync(descriptor, bytes);
    fileSystem.fsyncSync(descriptor);
    return fileSystem.fstatSync(descriptor);
  } finally {
    fileSystem.closeSync(descriptor);
  }
}

function normalizeSourceMetadata(source) {
  return {
    ...source,
    originalLocalPath: source.originalLocalPath || source.localPath,
    revision: Number.isSafeInteger(source.revision) ? source.revision : 1,
    history: Array.isArray(source.history) ? source.history : [],
  };
}

function resolveRequestedEdit(workspace, requested, fileSystem) {
  const stored = path.isAbsolute(requested) ? projectRelative(workspace.dir, requested) : requested;
  return resolveProjectPath(workspace.dir, stored, {
    label: 'source edit path', fileSystem, mustExist: true, type: 'file',
  });
}

function buildMaster({ projectDir, editPath }, dependencies = {}) {
  const fileSystem = dependencies.fileSystem || fs;
  const runTrimImpl = dependencies.runTrimImpl || runTrim;
  const runToolImpl = dependencies.runToolImpl || runTool;
  const probeVideoImpl = dependencies.probeVideoImpl || probeVideo;
  const now = dependencies.now || (() => new Date());
  const temporaryId = dependencies.temporaryId || randomUUID;
  const resolvedProjectDir = path.resolve(projectDir || '');
  if (!projectDir || !editPath) throw new Error('master requires --project-dir and --edit');
  const manifest = readProjectManifest(resolvedProjectDir);
  const workspace = { dir: resolvedProjectDir, manifest };
  const editAbsolute = resolveRequestedEdit(workspace, editPath, fileSystem);
  const edit = JSON.parse(fileSystem.readFileSync(editAbsolute, 'utf8'));
  const source = normalizeSourceMetadata(manifest.source);
  const sourcePath = resolveProjectPath(workspace.dir, source.localPath, {
    label: 'active source path', fileSystem, mustExist: true, type: 'file',
  });
  const sourceProbe = probeVideoImpl(sourcePath, { stage: 'master source probe' });
  const normalizedEdit = validateSourceEdit(edit, {
    sourceRevision: source.revision,
    sourceDuration: sourceProbe.duration,
  });
  if (Math.abs(sourceProbe.fps - normalizedEdit.fps) > 1e-6) {
    throw new Error('source edit FPS does not match the active source');
  }
  const nextRevision = source.revision + 1;
  const suffix = `v${String(nextRevision).padStart(2, '0')}`;
  const sourceRelative = `input/source-${suffix}.mp4`;
  const transcriptRelative = `transcript/words-${suffix}.json`;
  const destination = resolveProjectPath(workspace.dir, sourceRelative, {
    label: 'master revision path', fileSystem, mustExist: false, type: 'file',
  });
  const transcriptDestination = resolveProjectPath(workspace.dir, transcriptRelative, {
    label: 'master transcript path', fileSystem, mustExist: false, type: 'file',
  });
  if (fileSystem.existsSync(destination) || fileSystem.existsSync(transcriptDestination)) {
    throw new Error('master revision already exists');
  }
  const transcriptPath = resolveProjectPath(workspace.dir, manifest.transcript.words, {
    label: 'active transcript path', fileSystem, mustExist: true, type: 'file',
  });
  const words = collectWords(JSON.parse(fileSystem.readFileSync(transcriptPath, 'utf8')));
  const remapped = remapTranscriptWords(words, normalizedEdit.keep, normalizedEdit.fps);
  const duration = normalizedEdit.keep.reduce((sum, range) => sum + range.end - range.start, 0);
  const transcriptBytes = Buffer.from(`${JSON.stringify([{
    start: 0,
    end: roundedTime(duration, normalizedEdit.fps),
    text: remapped.map((word) => word.w).join(' '),
    words: remapped,
  }], null, 2)}\n`);
  const token = safeToken(temporaryId);
  const sourceStage = resolveProjectPath(workspace.dir, `input/.source-${suffix}-${token}.tmp.mp4`, {
    label: 'master source stage', fileSystem, mustExist: false, type: 'file',
  });
  const transcriptStage = resolveProjectPath(
    workspace.dir,
    `transcript/.words-${suffix}-${token}.tmp.json`,
    { label: 'master transcript stage', fileSystem, mustExist: false, type: 'file' },
  );
  const editRelative = projectRelative(workspace.dir, editAbsolute);
  let sourceStageIdentity = null;
  let transcriptStageIdentity = null;
  let sourceCommittedIdentity = null;
  let transcriptCommittedIdentity = null;
  try {
    return withProjectMutation(workspace, (transaction) => {
      const active = normalizeSourceMetadata(transaction.manifest.source);
      if (active.revision !== source.revision || active.localPath !== source.localPath) {
        throw new Error('source revision changed before master publication');
      }
      runTrimImpl({
        input: sourcePath,
        output: sourceStage,
        intervals: normalizedEdit.keep.map(({ start, end }) => [start, end]),
        audioFadeSec: 0.04,
        precision: 6,
      });
      sourceStageIdentity = fsyncFile(fileSystem, sourceStage);
      runToolImpl('ffmpeg', ['-v', 'error', '-i', sourceStage, '-f', 'null', '-'], {
        stage: 'master decode',
      });
      const outputProbe = probeVideoImpl(sourceStage, { stage: 'master output probe' });
      if (Math.abs(outputProbe.duration - duration) > Math.max(0.08, 1 / normalizedEdit.fps)
        || Math.abs(outputProbe.fps - normalizedEdit.fps) > 1e-6
        || outputProbe.width !== sourceProbe.width || outputProbe.height !== sourceProbe.height) {
        throw new Error('master output does not match the source edit');
      }
      transcriptStageIdentity = writeExclusiveStage(fileSystem, transcriptStage, transcriptBytes);
      fileSystem.linkSync(sourceStage, destination);
      sourceCommittedIdentity = statRegular(fileSystem, destination);
      fileSystem.linkSync(transcriptStage, transcriptDestination);
      transcriptCommittedIdentity = statRegular(fileSystem, transcriptDestination);

      const entry = {
        revision: nextRevision,
        localPath: sourceRelative,
        editPath: editRelative,
        transcriptPath: transcriptRelative,
      };
      const nextManifest = structuredClone(transaction.manifest);
      nextManifest.source = {
        ...active,
        localPath: sourceRelative,
        revision: nextRevision,
        history: [...active.history, entry],
      };
      nextManifest.transcript.words = transcriptRelative;
      nextManifest.currentPreview = null;
      nextManifest.updatedAt = now().toISOString();
      workspace.manifest = transaction.commitManifest(nextManifest, { purpose: 'master-manifest' });
      return {
        revision: nextRevision,
        duration: roundedTime(duration, normalizedEdit.fps),
        removedDuration: roundedTime(sourceProbe.duration - duration, normalizedEdit.fps),
        sourcePath: destination,
        transcriptPath: transcriptDestination,
      };
    }, { fileSystem, temporaryId });
  } catch (error) {
    if (transcriptCommittedIdentity) removeOwned(fileSystem, transcriptDestination, transcriptCommittedIdentity);
    if (sourceCommittedIdentity) removeOwned(fileSystem, destination, sourceCommittedIdentity);
    throw error;
  } finally {
    if (transcriptStageIdentity) removeOwned(fileSystem, transcriptStage, transcriptStageIdentity);
    if (sourceStageIdentity) removeOwned(fileSystem, sourceStage, sourceStageIdentity);
  }
}

function parseMasterOptions(argv) {
  const options = { projectDir: null, editPath: null };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    if (key === '--project-dir') options.projectDir = value;
    else if (key === '--edit') options.editPath = value;
    else throw new Error(`unknown master option: ${key}`);
  }
  if (!options.projectDir || !options.editPath) {
    throw new Error('master requires --project-dir and --edit');
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  try {
    configureMediaToolPath();
    const result = buildMaster(parseMasterOptions(argv));
    console.log(`✅ source revision: ${result.revision}`);
    console.log(`   duration: ${result.duration.toFixed(2)} sec`);
    console.log(`   removed: ${result.removedDuration.toFixed(2)} sec`);
    console.log(`   transcript: ${result.transcriptPath}`);
  } catch (error) {
    console.error(`❌ master отменён: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  buildMaster,
  main,
  parseMasterOptions,
  remapTranscriptWords,
  validateSourceEdit,
};
