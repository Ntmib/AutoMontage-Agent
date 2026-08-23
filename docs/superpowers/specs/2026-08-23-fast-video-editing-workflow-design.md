# Fast Video Editing Workflow Design

**Date:** 2026-08-23

**Problem:** A routine client video required several hours because the project mixed three different jobs: editing the video, extending the shared engine, and inventing substitute previews. Review Workbench showed the source and timeline but not the rendered Remotion result. The strict `draft -> approved -> render` rule then prevented a truthful visual preview before approval.

**Goal:** Every future lesson video must move from source to a truthful, editable draft preview without changing shared engine code. Final export remains protected by explicit approval.

## 1. Product contract

The workflow has two separate output lanes:

1. **Draft preview lane**
   - accepts only the current persisted `draft` brief;
   - uses the same `ReelScenes` Remotion composition, theme, fonts, scene components, media resolution, and audio finishing pipeline as final export;
   - differs only by lower render scale/quality, optional frame range, and a visible `ЧЕРНОВИК` watermark;
   - writes only inside `<project>/previews/`;
   - never updates `renders/`, `latestRender`, or `final/`;
   - cannot be mistaken for an approved final.

2. **Approved final lane**
   - continues to reject every brief whose status is not `approved`;
   - keeps the current source/theme/aspect/media identity checks;
   - writes versioned output to `renders/` and publishes the canonical `final/` only after success.

The approved boundary must not be weakened to implement preview. Preview receives its own explicit API and lifecycle.

## 2. One truthful preview

The canonical user-facing artifact is `<project>/previews/current-preview.mp4`. It is an atomic copy or pointer to an immutable revision file such as `previews/v03-draft-full.mp4`.

Every preview must carry metadata visible in Review Workbench:

- brief revision;
- `full` or `excerpt`;
- source time range for an excerpt;
- generation time;
- resolution and FPS;
- `draft` status.

Review Workbench must label its two players unambiguously:

- `ИСХОДНИК` - raw/master source used to edit words and scene boundaries;
- `СМОНТИРОВАННЫЙ ПРЕДПРОСМОТР` - actual Remotion draft preview.

No hand-written HTML imitation and no FFmpeg-drawn imitation may be used for design approval.

## 3. Fast preview profile

Default draft preview profile:

- composition: `ReelScenes`;
- scale: `0.5` for 1920x1080 or 1080x1920 input;
- codec: H.264;
- CRF: 28;
- audio: the same voice normalization, AAC compensation, music gain, and sidechain-ducking order as final;
- range: full video unless `--from-sec` and `--to-sec` are both supplied;
- browser: open `current-preview.mp4` automatically unless `--no-open` is supplied.

Preview range boundaries are snapped to the brief FPS. The UI and final response must always say whether the file is full or an excerpt.
The full preview is authoritative for final audio balance. A range preview is a diagnostic for cuts,
timing, layout, and local music behavior; because loudness measurement runs on the selected range,
it must not be used to approve whole-video loudness.

## 4. Client-delivery mode

The `reel-turnkey` skill gets a hard project boundary:

- while editing a client video, write only inside that video's ignored `projects/<id>/` workspace;
- do not edit `src/`, `scripts/`, `schema/`, shared tests, public docs, or a private theme;
- choose from documented scene capabilities and presets;
- if a requested result is unsupported, finish the video with the closest existing supported option or report the exact missing capability as a separate engine task;
- never develop the engine inside the active video revision without explicit user authorization.

This boundary is the main protection against turning one edit into product development.

## 5. Reusable source editing

Repeated speech, pauses, and duplicate explanations must be handled through a project cut list, not a custom FFmpeg command.

The source edit contract stores ordered `keep` ranges with optional notes. One command:

1. validates and frame-snaps ranges;
2. renders a new immutable source master;
3. remaps word timestamps into the new master timeline;
4. fully decodes the result;
5. atomically makes that master and transcript current while keeping older revisions.

Changing the source master always invalidates the current draft preview and requires a new brief revision. It must never modify the original imported source.

## 6. Stable scene capability catalog

The official seven scene types remain unchanged. Their reusable variants must be documented and regression-tested so an agent fills properties instead of editing components:

- talking head with text in negative space;
- progressively timed bullets/steps;
- full-screen product screencast using the master voice and muted b-roll audio;
- standard image/video b-roll fit, trim, and audio modes;
- final fade to dark with title movement to center;
- horizontal and vertical safe-zone behavior;
- theme-provided fonts and complementary color tokens.

Two public golden briefs, one horizontal and one vertical, must cover these capabilities without private assets.

## 7. Audio invariant

Both preview and final use the same ordered pipeline:

1. render picture plus clean master voice;
2. compensate Remotion/AAC latency;
3. normalize the clean voice;
4. mix music with sidechain ducking;
5. do not loud-normalize the combined mix again.

QA measures the voice stem and music-under-speech stem separately. Whole-file LUFS alone is not an acceptance test for ducking.

## 8. Proportional verification

Verification depends on what changed:

- brief, cuts, text, or media assignment: validate the current project, render/decode preview, inspect control frames;
- music settings: render a short real-composition excerpt and measure stems;
- shared engine/schema change: focused regression tests first, then full `npm test` once before completion;
- release: full release checks and smoke render.

Running the full repository suite after every client revision is explicitly forbidden in client-delivery mode.

## 9. Speed and quality measurements

The implementation must record wall-clock timings for a 60-second horizontal and vertical fixture:

- draft preview render;
- final render;
- second preview after a text-only brief change.

Acceptance criteria:

- one command produces a truthful full preview from a saved draft;
- the preview uses no custom project code or generated HTML;
- the same brief produces visually equivalent final frames when the watermark and scale are ignored;
- draft preview is at least twice as fast as final render on the same machine and fixture;
- a failed preview leaves the previous `current-preview.mp4` intact;
- a draft still cannot enter the final render lifecycle;
- a normal video task changes no shared engine files.

## 10. Non-goals

- Building a full non-linear editor in Review Workbench.
- Allowing Review Workbench to approve or publish a final.
- Adding new scene types for one client's stylistic preference.
- Replacing Remotion with FFmpeg mockups.
- Requiring a browser extension or separate computer-control setting.
