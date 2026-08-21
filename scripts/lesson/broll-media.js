const path = require('path');

const BROLL_MEDIA_KINDS = new Set(['image', 'video']);
const BROLL_FITS = new Set(['contain', 'cover']);
const BROLL_AUDIO_MODES = new Set(['mute', 'mix', 'replace']);
const OPAQUE_ASSET_ID = /^asset-\d+$/;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function isCanonicalBrollReference(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return false;
  if (value.includes('\\') || path.posix.isAbsolute(value) || URL_SCHEME.test(value)) return false;
  if (OPAQUE_ASSET_ID.test(value)) return false;

  const segments = value.split('/');
  if (segments[0] === 'media') return false;
  return segments.every((segment) => {
    if (segment.length === 0) return false;
    try {
      const decoded = decodeURIComponent(segment);
      return decoded !== '.' && decoded !== '..' && !decoded.includes('\\') && !decoded.includes('\0');
    } catch (_) {
      return false;
    }
  });
}

function frameSnapSeconds(seconds, fps) {
  if (!Number.isFinite(seconds) || seconds < 0 || !Number.isFinite(fps) || fps <= 0) {
    throw new TypeError('b-roll frame time is invalid');
  }
  return Math.round(seconds * fps) / fps;
}

function sceneDurationFrames(scene, fps) {
  if (!scene || !Number.isFinite(scene.start) || !Number.isFinite(scene.end) || scene.end < scene.start) {
    throw new TypeError('b-roll scene time is invalid');
  }
  frameSnapSeconds(0, fps);
  return Math.round((scene.end - scene.start) * fps);
}

function videoEndFrame({ trimStartSec, scene, fps }) {
  return Math.round(frameSnapSeconds(trimStartSec, fps) * fps) + sceneDurationFrames(scene, fps);
}

module.exports = {
  BROLL_AUDIO_MODES,
  BROLL_FITS,
  BROLL_MEDIA_KINDS,
  frameSnapSeconds,
  isCanonicalBrollReference,
  sceneDurationFrames,
  videoEndFrame,
};
