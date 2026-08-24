const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDraftPreviewProps, buildReelScenesProps } = require('../scripts/lesson/brief');

test('review additions do not change canonical lesson props', () => {
  const brief = require('../examples/lesson-neutral-approved.json');
  const props = buildReelScenesProps({ brief, theme: { id: 'fixture' } });
  assert.deepEqual(props.scenes, brief.scenes);
  assert.equal(props.fps, 25);
  assert.equal(props.durationInFrames, 350);
  assert.equal(props.faceSrc, 'source.mp4');
  assert.equal(props.audioSrc, 'source.mp4');
});

test('draft remains forbidden at the renderer boundary', () => {
  const draft = { ...require('../examples/lesson-neutral-approved.json'), status: 'draft' };
  assert.throws(() => buildReelScenesProps({ brief: draft, theme: {} }), /approved/);
});

test('review draft props use a separate marked preview boundary', () => {
  const draft = { ...require('../examples/lesson-neutral-approved.json'), status: 'draft' };
  const props = buildDraftPreviewProps({ brief: draft, theme: { id: 'fixture' } });

  assert.equal(props.draftPreview, true);
  assert.deepEqual(props.scenes, draft.scenes);
});
