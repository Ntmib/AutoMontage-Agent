const REMOTION_AUDIO_ADVANCE_MS = 42.5;
const LOUDNORM_FILTER = 'loudnorm=I=-14:TP=-1.5:LRA=11';

function buildFinishAudioFilter(audioAdvanceMs = 0) {
  const advance = Number(audioAdvanceMs);
  if (!Number.isFinite(advance) || advance < 0 || advance > 250) {
    throw new Error('--audio-advance-ms должен быть числом от 0 до 250');
  }
  if (advance === 0) return LOUDNORM_FILTER;

  const seconds = (advance / 1000).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return `atrim=start=${seconds},asetpts=PTS-STARTPTS,${LOUDNORM_FILTER}`;
}

module.exports = {
  REMOTION_AUDIO_ADVANCE_MS,
  buildFinishAudioFilter,
};
