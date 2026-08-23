import { Img, OffthreadVideo, staticFile, useVideoConfig } from 'remotion';

export const MIX_GAIN = 10 ** (-18 / 20);

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const mediaSrc = (value) => (value && /^https?:\/\//.test(value) ? value : staticFile(value));

export const fadeFramesForFps = (fps) => Math.max(1, Math.round(0.12 * fps));

export const brollEnvelope = ({ localFrame, durationInFrames, fps }) => {
  const fade = fadeFramesForFps(fps);
  const fadeIn = clamp01(localFrame / fade);
  const fadeOut = clamp01((durationInFrames - 1 - localFrame) / fade);
  return Math.min(fadeIn, fadeOut);
};

export const brollClipVolume = ({ mode, localFrame, durationInFrames, fps }) => {
  if (mode === 'mute') return 0;
  const envelope = brollEnvelope({ localFrame, durationInFrames, fps });
  if (mode === 'mix') return MIX_GAIN * envelope;
  if (mode === 'replace') return envelope;
  return 0;
};

export const sourceVolumeForFrame = ({ frame, scenes, fps }) => {
  const active = scenes.find(({ from, durationInFrames, audioMode }) => (
    audioMode === 'replace'
      && frame >= from
      && frame < from + durationInFrames
  ));
  if (!active) return 1;
  return 1 - brollEnvelope({
    localFrame: frame - active.from,
    durationInFrames: active.durationInFrames,
    fps,
  });
};

export const brollMediaPresentation = (media, fps) => ({
  objectFit: media?.fit || 'cover',
  trimBefore: media?.kind === 'video' ? Math.round(media.trimStartSec * fps) : 0,
  muted: media?.kind === 'video' && media.audioMode === 'mute',
});

export const BrollMedia = ({ media, legacySrc, durationInFrames }) => {
  const { fps } = useVideoConfig();
  const source = media?.src || legacySrc;
  if (!source) return null;
  const presentation = brollMediaPresentation(media, fps);

  const style = {
    width: '100%',
    height: '100%',
    objectFit: presentation.objectFit,
    objectPosition: '50% 40%',
    filter: 'brightness(0.85)',
  };

  if (media?.kind !== 'video') {
    return <Img src={mediaSrc(source)} style={style} />;
  }

  const mode = media.audioMode;
  const volume = mode === 'mute'
    ? undefined
    : (localFrame) => brollClipVolume({
      mode,
      localFrame,
      durationInFrames,
      fps,
    });
  return <OffthreadVideo
    src={mediaSrc(source)}
    trimBefore={presentation.trimBefore}
    style={style}
    muted={presentation.muted}
    volume={volume}
  />;
};
