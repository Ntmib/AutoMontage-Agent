const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { resolveProjectPath } = require('../project/workspace');
const { runTool } = require('../process');

const WAVEFORM_FILTER = 'aformat=channel_layouts=mono,showwavespic=s=2400x180:colors=white';
const UNAVAILABLE_WARNING = 'Waveform preview is unavailable; review opened without it.';

function buildWaveformCommand(input, output) {
  return {
    command: 'ffmpeg',
    args: [
      '-y',
      '-i',
      path.resolve(input),
      '-filter_complex',
      WAVEFORM_FILTER,
      '-frames:v',
      '1',
      path.resolve(output),
    ],
  };
}

function lstatIfPresent(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
    throw error;
  }
}

function removeTemporary(filePath) {
  const stat = lstatIfPresent(filePath);
  if (!stat) return;
  if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmdirSync(filePath);
  else fs.unlinkSync(filePath);
}

function sourceFingerprint(workspaceDir, sourcePath) {
  const relative = path.relative(workspaceDir, path.resolve(sourcePath));
  const resolvedSource = resolveProjectPath(workspaceDir, relative, {
    label: 'review waveform source',
    mustExist: true,
    type: 'file',
  });
  const stat = fs.statSync(resolvedSource, { bigint: true });
  const identity = JSON.stringify({
    path: relative.split(path.sep).join('/'),
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  });
  return {
    fingerprint: crypto.createHash('sha256').update(identity).digest('hex'),
    sourcePath: resolvedSource,
  };
}

function ensureWaveformPreview({ workspace, sourcePath, runToolImpl = runTool } = {}) {
  let temporaryPath = null;
  try {
    if (!workspace || typeof workspace.dir !== 'string') {
      throw new Error('review waveform workspace is required');
    }
    const workspaceDir = path.resolve(workspace.dir);
    const source = sourceFingerprint(workspaceDir, sourcePath);
    const previewDirectory = resolveProjectPath(workspaceDir, 'previews', {
      label: 'review waveform preview directory',
    });
    fs.mkdirSync(previewDirectory, { recursive: true, mode: 0o700 });
    resolveProjectPath(workspaceDir, 'previews', {
      label: 'review waveform preview directory',
      mustExist: true,
      type: 'directory',
    });

    const filename = `review-waveform-${source.fingerprint}.png`;
    const destination = resolveProjectPath(workspaceDir, `previews/${filename}`, {
      label: 'review waveform cache',
      type: 'file',
    });
    const cached = lstatIfPresent(destination);
    if (cached) {
      if (cached.isSymbolicLink() || !cached.isFile()) throw new Error('unsafe waveform cache');
      return { available: true, path: destination };
    }

    const temporaryFilename = `${filename}.tmp-review-${crypto.randomUUID()}.png`;
    temporaryPath = resolveProjectPath(workspaceDir, `previews/${temporaryFilename}`, {
      label: 'review waveform temporary file',
    });
    if (lstatIfPresent(temporaryPath)) throw new Error('waveform temporary file exists');

    const command = buildWaveformCommand(source.sourcePath, temporaryPath);
    runToolImpl(command.command, command.args, { stage: 'review waveform' });

    const generated = lstatIfPresent(temporaryPath);
    if (!generated || generated.isSymbolicLink() || !generated.isFile()) {
      throw new Error('waveform output must be a regular file');
    }
    const destinationBeforeRename = lstatIfPresent(destination);
    if (destinationBeforeRename) {
      if (destinationBeforeRename.isSymbolicLink() || !destinationBeforeRename.isFile()) {
        throw new Error('unsafe waveform cache');
      }
      return { available: true, path: destination };
    }
    fs.renameSync(temporaryPath, destination);
    temporaryPath = null;
    const committed = fs.lstatSync(destination);
    if (committed.isSymbolicLink() || !committed.isFile()) {
      throw new Error('waveform cache must be a regular file');
    }
    return { available: true, path: destination };
  } catch (_) {
    return { available: false, warning: UNAVAILABLE_WARNING };
  } finally {
    if (temporaryPath) {
      try {
        removeTemporary(temporaryPath);
      } catch (_) {
        // Best-effort cleanup must not prevent Review startup.
      }
    }
  }
}

module.exports = {
  buildWaveformCommand,
  ensureWaveformPreview,
};
