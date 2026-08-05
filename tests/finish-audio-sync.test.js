const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REMOTION_AUDIO_ADVANCE_MS,
  buildFinishAudioFilter,
} = require('../scripts/finish-audio');
const { finishEncodeCommand } = require('../scripts/finish');

test('Remotion audio compensation advances voice by the measured AAC delay', () => {
  assert.equal(REMOTION_AUDIO_ADVANCE_MS, 42.5);
  assert.equal(
    buildFinishAudioFilter(REMOTION_AUDIO_ADVANCE_MS),
    'atrim=start=0.0425,asetpts=PTS-STARTPTS,loudnorm=I=-14:TP=-1.5:LRA=11',
  );
});

test('finish audio filter leaves timing untouched without compensation', () => {
  assert.equal(
    buildFinishAudioFilter(0),
    'loudnorm=I=-14:TP=-1.5:LRA=11',
  );
});

test('finish caps filtered audio at the copied video duration', () => {
  const command = finishEncodeCommand('input.mp4', 'output.mp4', {
    hdrMode: 'off',
    sharpen: false,
    lanczos: null,
    audioAdvanceMs: REMOTION_AUDIO_ADVANCE_MS,
  }, false);

  assert.ok(command.args.includes('-shortest'));
});
