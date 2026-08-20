# Video B-roll Media Import — Design Specification

**Status:** approved design, implementation not started

**Date:** 2026-08-21

**Product:** AutoMontage-Agent Review Workbench and lesson renderer

**Compatibility target:** existing image-only briefs, approved revisions, Dynamic renders, and source-audio timing remain unchanged

## 1. Summary

Review Workbench will accept images and video files from the browser, store normalized media inside the project currently open for editing, and let the user assign the media to an existing `broll` scene. Video b-roll supports a frame-snapped clip start, `contain` or `cover` fitting, and three per-clip audio modes: `mute`, `mix`, and `replace`.

The feature is intentionally not a general non-linear editor. Scene start and end still come from the lesson brief. Uploading a file never changes a brief by itself. A selected asset becomes renderable only after the existing validate → new draft → explicit approval workflow.

## 2. Goals

1. Upload an image or video through the edit-enabled Review Workbench.
2. Store the resulting asset only inside the project currently bound to the review server.
3. Make browser preview reliable even when the bundled Chromium cannot decode the render master.
4. Add video b-roll to the official lesson `broll` scene without changing the other six official scenes.
5. Support explicit `mute`, `mix`, and `replace` audio behavior per video clip.
6. Preserve old `brollSrc` image briefs and all existing approval invariants.
7. Snapshot every referenced local asset for one render so a file cannot change underneath Remotion.
8. Fail closed on malformed, oversized, unsupported, replaced, or incomplete uploads.
9. Cover each module with RED → GREEN tests and finish with a real browser-to-render acceptance run.

## 3. Non-goals

- No asset deletion, replacement, renaming, or cross-project moving in V1.
- No arbitrary filesystem picker on the server and no browser-supplied destination path.
- No multi-track editor, ripple editing, clip splitting, speed control, looping, keyframes, crop handles, or free placement.
- No secondary audio waveform or multiband audio mixer.
- No remote URL import, cloud storage, external transcoding service, or background job queue.
- No client-side Remotion rendering.
- No migration of existing components from `OffthreadVideo` to `@remotion/media` in this feature.
- No mutation of an existing draft or approved brief; save still creates a new draft revision.

## 4. Existing behavior that must remain stable

- `scripts/lesson/brief.js` permits AVIF/GIF/JPEG/PNG/WebP in legacy `brollSrc` and rejects audio/video.
- `src/scenes/scenes.jsx` renders the current lesson b-roll as an image.
- `src/blocks/BrollFullscreen.jsx` already proves server-rendered muted video through `OffthreadVideo` in the Dynamic composition.
- `src/SceneDirector.jsx` plays the source audio once from composition frame zero.
- Review routes use a loopback-only server, unpredictable bearer token, exact Origin checks, a read-only default, opaque asset ids, and fresh disk state for validate/save.
- Review JSON bodies stay capped at 256 KiB. The media endpoint must not weaken or reuse that limit.
- Approved source, theme, output geometry, FPS, scene order, and absolute source timing remain protected.
- `scripts/finish.js` applies the final mix-wide `loudnorm=I=-14:TP=-1.5:LRA=11` exactly once.

## 5. Chosen architecture

The chosen approach is a normalized media pipeline:

```text
browser file
  → authenticated streaming quarantine
  → extension/MIME/size checks
  → ffprobe content validation
  → normalized render master
  → browser-safe preview proxy when video
  → atomic project publication
  → opaque Review asset descriptor
  → allowlisted scene commands
  → server-materialized draft reference and SHA-256
  → approved brief
  → one render asset bundle under public/.automontage
  → Remotion
  → owned bundle cleanup
```

The render master and browser preview are separate by design:

- Images become a rewritten WebP master. The same file is safe for preview and render.
- Videos become an H.264/AAC MP4 master for render plus a VP8/Opus WebM proxy for Review Workbench.
- The original upload exists only in quarantine and is removed after success or failure.

This avoids relying on the source container or codec and avoids the observed failure where bundled Chromium could not decode an otherwise renderable H.264 fixture.

## 6. Project storage layout

Each successful import owns one UUID directory. Browser input never contributes directory segments.

```text
<project>/
  assets/broll/
    images/<uuid>/
      media.webp
      asset.json
    video/<uuid>/
      media.mp4
      asset.json
  previews/broll/
    <uuid>.webm
```

`asset.json` is server-generated canonical JSON with this exact shape:

```json
{
  "version": 1,
  "id": "4af36be4-0b26-4e6f-bd48-8bdd2215a4f1",
  "label": "product-demo.mov",
  "mediaKind": "video",
  "canonicalSha256": "64 lowercase hexadecimal characters",
  "previewSha256": "64 lowercase hexadecimal characters",
  "width": 1920,
  "height": 1080,
  "fps": 25,
  "durationSec": 18.4,
  "hasAudio": true
}
```

Rules:

- `additionalProperties` are rejected when reading metadata.
- `id` must equal the containing directory name.
- `mediaKind` is exactly `image` or `video`.
- `label` is display-only, NFKC-normalized, contains no control characters, and is at most 255 UTF-8 bytes.
- `canonicalSha256` is calculated from the normalized master, not from the original upload.
- `previewSha256` is calculated from the WebM proxy for video and is `null` for images.
- Canonical media filenames are fixed (`media.webp` or `media.mp4`).
- Preview location is derived from the UUID and never accepted from metadata.
- Images have `fps: 0`, `durationSec: 0`, and `hasAudio: false`.
- Project source, asset metadata, and preview paths remain relative in project-owned state.

The preview proxy is a cache-like derivative. It is required for video selection, but it never enters a brief and is never copied into a final render lease.

## 7. Upload protocol

### 7.1 Endpoint

The edit-only endpoint is:

```text
POST /api/assets/import
```

It receives the file as the raw request body, not JSON, base64, or multipart. This avoids a new multipart dependency and permits bounded streaming.

Required request properties:

- Existing `Authorization: Bearer <session token>`.
- Existing exact loopback `Origin`.
- Edit-enabled review session.
- `Content-Length` as a positive canonical decimal integer.
- `X-Automontage-Filename` as one `encodeURIComponent(file.name)` value.
- `Content-Type` in the quick-check allowlist.

The browser does not set `Content-Length` manually; its `XMLHttpRequest` file body supplies it. The server requires it to enforce disk and request limits before accepting bytes.

### 7.2 Limits

Video limits are fixed for V1:

- Maximum request size: 1 GiB (`1,073,741,824` bytes).
- Maximum duration: 30 minutes (`1,800` seconds).
- Maximum dimension: 4,096 pixels.
- Maximum pixel count: 8,847,360 pixels, allowing landscape or portrait 4K.
- Accepted filename extensions: `.mp4`, `.mov`, `.m4v`, `.webm`.
- Accepted quick-check MIME types: `video/mp4`, `video/quicktime`, `video/x-m4v`, `video/webm`, and `application/octet-stream`.

Image limits are fixed for V1:

- Maximum request size: 25 MiB (`26,214,400` bytes).
- Maximum dimension: 12,000 pixels.
- Maximum pixel count: 100,000,000 pixels.
- Accepted extensions: `.avif`, `.gif`, `.jpeg`, `.jpg`, `.png`, `.webp`.
- Accepted quick-check MIME types: the matching `image/*` types and `application/octet-stream`.

`Content-Type` and the filename extension are only fast rejection signals. ffprobe/ffmpeg-decoded content remains authoritative.

Before reading the body, the server verifies that free space in the target filesystem is at least:

```text
4 × Content-Length + 512 MiB
```

The conservative reserve covers quarantine, the normalized master, preview proxy, and temporary encoder output.

### 7.3 Response

The request stays open through normalization. `XMLHttpRequest.upload` reports byte progress; after upload reaches 100%, the UI changes from `Загрузка` to indeterminate `Обработка` until the server replies.

Success returns `201`:

```json
{
  "ok": true,
  "asset": {
    "id": "asset-7",
    "kind": "project",
    "mediaKind": "video",
    "label": "product-demo.mov",
    "url": "/media/assets/asset-7",
    "previewUrl": "/media/assets/asset-7/preview",
    "width": 1920,
    "height": 1080,
    "durationSec": 18.4,
    "hasAudio": true,
    "capabilities": {
      "preview": true,
      "brollImage": false,
      "brollVideo": true
    }
  }
}
```

No absolute path, canonical project reference, SHA-256, temporary name, ffmpeg output, or stack trace reaches the browser.

### 7.4 Status codes

- `400`: malformed filename header, length, or protocol.
- `401`: missing or invalid session token.
- `403`: wrong Origin.
- `405`: wrong method or read-only session.
- `409`: another import is active or current media identity changed.
- `413`: image/video byte limit exceeded.
- `415`: extension or quick MIME allowlist rejection.
- `422`: decode failure, wrong real media kind, missing primary video stream, duration/geometry limit, or unusable normalized output.
- `507`: insufficient disk space.
- `500`: fixed generic internal error.

User-facing messages are fixed Russian copy mapped from status/code. Internal paths and tool stderr remain server-side only.

## 8. Ingest transaction and process lifecycle

One review runtime owns a single import semaphore. A second import returns `409 MEDIA_IMPORT_BUSY` before consuming its body.

The transaction is:

1. Authenticate token, Origin, method, edit permission, exact route, headers, limits, and disk reserve.
2. Reserve the import semaphore.
3. Create an unpredictable quarantine directory outside `public/`, with owner-only permissions and no symlink traversal.
4. Stream into an exclusive `O_CREAT | O_EXCL | O_NOFOLLOW` regular file while counting bytes.
5. Require the received count to equal `Content-Length`, fsync, and close the descriptor.
6. Run ffprobe with argv-only process invocation and a bounded output buffer.
7. Validate real streams, dimensions, pixel count, duration, and supported decode.
8. Produce normalized outputs inside quarantine.
9. Probe and fully decode-test the normalized master; probe the video proxy when present.
10. Calculate master SHA-256, calculate proxy SHA-256 when present, and create canonical `asset.json`.
11. Create hidden owned staging destinations beside the final asset and preview locations.
12. Publish the video preview first; publish the complete asset directory last by atomic rename.
13. Refresh the runtime asset registry, allocate/preserve an opaque `asset-N`, and return its descriptor.
14. Remove quarantine and release the semaphore in `finally`.

If any step fails, no final asset directory is published. A preview orphan can exist only if the process dies between the preview and asset-directory renames; startup/refresh cleanup may remove a preview whose UUID has no matching regular asset directory. Cleanup never follows symlinks and only removes a path whose identity matches the process-owned staging record.

If the browser disconnects while ffmpeg is running, the server aborts the child with `SIGTERM`, waits for exit, performs owned cleanup, and returns no asset. `SIGKILL` cleanup is not promised; UUID staging and refresh cleanup make remnants identifiable without broad deletion.

### 8.1 Image normalization

- Decode the first visual frame only; animated GIF import becomes a still image in V1.
- Apply orientation.
- Remove metadata.
- Encode lossless-alpha-capable WebP at quality 90.
- Fully decode the resulting WebP before publication.

### 8.2 Video normalization

Render master:

- Container: MP4.
- Video: H.264, `yuv420p`, CRF 18, `preset=medium`.
- Rotation metadata is applied to pixels and removed.
- Output FPS equals the current brief output FPS.
- Audio, when present: AAC, 48 kHz, stereo, 160 kbit/s.
- No silent audio stream is synthesized when the upload has no audio.
- `+faststart` is enabled and source metadata is removed.

Browser proxy:

- Container: WebM.
- Video: VP8, maximum dimension 1,280 pixels, aspect preserved, maximum 30 FPS.
- Audio, when present: Opus, 48 kHz, stereo, 96 kbit/s.
- Proxy contains the full normalized duration so the user can choose any valid start.

No per-asset loudness normalization occurs during ingest. Relative clip volume is controlled by Remotion, and the existing final pass normalizes the complete mix once.

## 9. Asset registry and serving

The broad Review registry continues to describe images, video, and audio for preview, but selection uses explicit capabilities:

```json
{
  "preview": true,
  "brollImage": true,
  "brollVideo": false
}
```

Rules:

- A normalized imported image receives `brollImage: true`.
- A normalized imported video receives `brollVideo: true` only if canonical metadata and its WebM proxy are both valid regular files whose SHA-256 values match `asset.json`.
- A manually placed video without the server-generated asset bundle remains preview-only in V1.
- Audio-only files remain preview-only and cannot enter b-roll.
- Legacy public/project images keep image b-roll capability.
- The registry records device, inode, size, and nanosecond mtime for the canonical and preview files. Any mismatch expires the handle with existing `409`/`404` behavior.
- Initial registration and every reconstruction after server restart verify the canonical and proxy hashes before granting b-roll capability. Requests within that runtime then use the registered file identities rather than rehashing every byte-range response.
- Canonical media is served at `/media/assets/:id`; a video proxy is served at `/media/assets/:id/preview`.
- Both routes require the current session token and serve only a previously registered regular-file snapshot with byte-range support.
- The browser never receives the project reference or asset hash through state or upload responses.

## 10. Browser interaction

### 10.1 Import control

- `Добавить медиа` exists only in edit mode.
- Native file input accepts the V1 extension allowlist.
- Import locks timeline boundaries, b-roll selectors, undo, redo, validate, save, and a second import.
- The user sees filename, byte progress, then `Проверяем и готовим предпросмотр…`.
- A successful import refreshes canonical state and adds the asset to the media lane.
- Import never dispatches a brief command and never automatically selects the new asset.
- Errors leave the current commands and validated diff unchanged unless the server reports an existing media identity conflict, in which case the current conflict quarantine rules apply.

### 10.2 Media lane

- Images show the existing thumbnail.
- Videos show a proxy thumbnail/poster, duration, dimensions, and `со звуком` or `без звука`.
- The original display label is rendered as text only.
- Video playback always uses the authenticated proxy URL.

### 10.3 B-roll scene control

Each existing `broll` scene keeps one asset selector. After selecting video, the control shows:

1. A small proxy player with native controls.
2. `Начать с текущего места`, which reads `currentTime` and dispatches a frame-snapped start command.
3. Fit selector:
   - `contain` label: `Вписать целиком` and default for video.
   - `cover` label: `Заполнить кадр`.
4. Audio selector:
   - `mute` label: `Без звука` and default.
   - `mix` label: `Тихо поверх голоса`.
   - `replace` label: `Вместо голоса`.

For a video without audio, `mix` and `replace` are disabled and `mute` is forced. Images show only fit, defaulting to `cover`.

The scene end remains authoritative. The UI displays the derived used interval but has no independent end handle. If the remaining media is shorter than the scene, validate rejects the command and Save stays disabled.

## 11. Brief contract and backward compatibility

Legacy image scenes remain valid without byte changes:

```json
{
  "scene": "broll",
  "brollSrc": "broll/example.png"
}
```

New or reselected assets use `brollMedia`. Exactly one of `brollSrc` and `brollMedia` is permitted.

Image media:

```json
{
  "kind": "image",
  "src": "assets/broll/images/<uuid>/media.webp",
  "sha256": "64 lowercase hexadecimal characters",
  "fit": "cover"
}
```

Video media:

```json
{
  "kind": "video",
  "src": "assets/broll/video/<uuid>/media.mp4",
  "sha256": "64 lowercase hexadecimal characters",
  "trimStartSec": 12.4,
  "fit": "contain",
  "audioMode": "replace"
}
```

Schema rules:

- `additionalProperties: false` at every new object level.
- `src` is a canonical project/public relative reference; absolute paths, URLs, browser pseudo-paths, backslashes, dot segments, and opaque ids are forbidden in persisted JSON.
- `sha256` is required for `brollMedia` and server-materialized from the current registered file.
- `fit` is exactly `contain` or `cover`.
- Image media forbids `trimStartSec` and `audioMode`.
- Video `trimStartSec` is finite, non-negative, and snapped to the composition frame grid before persistence.
- Video `audioMode` is exactly `mute`, `mix`, or `replace`.
- `mix` and `replace` require a real audio stream.
- `trimStartFrame + sceneDurationInFrames` must not exceed the canonical clip duration in composition frames.
- Draft validation resolves and re-probes the asset; approval repeats the check; render verifies the approved SHA-256 while copying into its snapshot.

The browser sends only opaque asset ids and numeric/enum settings. It never sends `src`, SHA-256, media metadata, or filesystem paths.

The browser-safe state never returns persisted `src` or `sha256`. When the current registry can resolve the persisted reference and hash, the server projects it to this UI-only shape:

```json
{
  "kind": "video",
  "assetId": "asset-7",
  "trimStartSec": 12.4,
  "fit": "contain",
  "audioMode": "replace"
}
```

This UI-only object is never written to disk. If the persisted media cannot be resolved to the current registry, the browser receives an unresolved-media diagnostic without the original reference or hash, and editing/saving that scene remains blocked.

## 12. Review command model

The command allowlist gains exact-key commands:

```text
replace-broll(sceneIndex, assetId)
set-broll-fit(sceneIndex, fit)
set-broll-video-start(sceneIndex, trimStartSec)
set-broll-audio-mode(sceneIndex, audioMode)
```

Behavior:

- `replace-broll` verifies the current server registry and sets safe defaults: image → `cover`; video → `contain`, frame zero, `mute`.
- Video-only commands reject a selected image or an ineligible/non-broll scene.
- `set-broll-audio-mode` rejects `mix`/`replace` when `hasAudio` is false.
- Start seconds are converted to integer composition frames on the server and persisted as `frame / fps`.
- Undo/redo stores these commands using the existing immutable replay model.
- Any extra key, path, hash, negative/NaN/infinite number, unsupported enum, or unknown command fails closed.
- The server returns browser-safe diffs for asset, fit, clip start, and audio mode.
- Existing `409` quarantine semantics apply to upload-related state refresh and every new command.

## 13. Remotion scene and audio behavior

### 13.1 Visual layer

`SceneBroll` delegates to a focused b-roll media layer:

- Legacy `brollSrc` and `brollMedia.kind=image` render through `Img`.
- `brollMedia.kind=video` renders through the already installed `OffthreadVideo`.
- Video `trimBefore` is `round(trimStartSec × compositionFps)`.
- The existing scene `Sequence` remains the visible duration boundary.
- `contain` preserves the whole screen recording; `cover` fills and crops.
- Source speaker video remains globally trimmed by `sourceStartFrame`; b-roll video starts from its own approved local clip offset.
- Scene sequences are premounted for one composition second without changing their visible start/end.

### 13.2 Clip audio

Let:

```text
MIX_GAIN = 10 ^ (-18 / 20) = approximately 0.1258925
FADE_FRAMES = max(1, round(0.12 × fps))

for localFrame in 0..durationFrames-1:
  fadeIn = clamp(localFrame / FADE_FRAMES, 0, 1)
  fadeOut = clamp((durationFrames - 1 - localFrame) / FADE_FRAMES, 0, 1)
  envelope = min(fadeIn, fadeOut)
```

Clip volume behavior:

- `mute`: `muted=true`, no clip audio enters the render.
- `mix`: clip volume is `MIX_GAIN × envelope`.
- `replace`: clip volume is `envelope`.
- For a scene shorter than 240 ms, the two ramps meet at the midpoint; the peak remains below or equal to the target rather than creating a discontinuity.

### 13.3 Source audio

The single global source `Audio` remains mounted from composition frame zero. Its volume callback uses absolute composition frames:

- `mute` and `mix` scenes leave source volume at `1`.
- During `replace`, source volume is `1 - envelope`; for a scene long enough to reach a plateau this crossfades `1 → 0`, stays at zero, then returns `0 → 1`.
- Non-overlap brief validation guarantees at most one replace interval per frame.
- The global 42.5 ms finish advance moves the already mixed track as one unit, so source and b-roll audio retain their relative sync.
- The existing final `-14 LUFS` normalization runs once on the complete mix.

## 14. Render asset bundle

The current one-file source lease is extended by a new bundle API without changing the existing exported function's behavior for Dynamic callers.

For lesson render:

1. Collect the approved source and all local `brollSrc`/`brollMedia.src` references.
2. Resolve project references only inside the current workspace and public references only inside repository `public/`.
3. Leave legacy remote image URLs unchanged for backward compatibility; new `brollMedia` never permits URLs.
4. Deduplicate identical resolved files.
5. Open every local source with `O_RDONLY | O_NOFOLLOW`, verify regular-file identity, and copy through descriptors into one exclusive `public/.automontage/<namespace>-<uuid>/` directory.
6. While copying `brollMedia`, calculate SHA-256 from the opened bytes and require an exact match with the approved brief.
7. Give every leased file a generated basename and preserve only the required safe extension.
8. Rewrite a cloned props object to the returned `staticFile()`-compatible bundle paths.
9. Render and finish through the existing lifecycle.
10. Remove only the owned bundle after render success or failure, using exact parent/name/type/identity checks.

The approved JSON, project asset, public library asset, and previous renders are never modified. A hash mismatch cancels render before Remotion starts.

## 15. Security and integrity requirements

- The server remains bound to loopback and does not gain remote-listen behavior.
- Authentication and exact Origin checks happen before upload bytes are consumed.
- The upload endpoint exists only under `--edit`.
- Raw upload has its own 1 GiB/25 MiB limits; JSON edit routes retain 256 KiB.
- Filename, MIME, extension, ffprobe streams, decoded output, and final regular-file identity are separate checks; no one check is trusted alone.
- No user string enters a shell command. ffmpeg/ffprobe always receive an argv array and `shell: false`.
- Generated UUIDs determine all filesystem ownership. Display names never determine paths.
- Every directory segment is checked for symlinks; staged and final files use exclusive creation and no-follow where supported.
- Project containment is checked before and after long-running media processes.
- Asset and preview publication is atomic; incomplete media never enters the registry.
- Registered media snapshot includes device, inode, size, and nanosecond mtime.
- Brief SHA-256 freezes the actual normalized bytes selected and approved.
- Browser responses expose opaque handles and fixed errors, never local paths, hashes, stderr, or stack traces.
- Media responses keep `X-Content-Type-Options: nosniff`, CSP `media-src 'self'`, token protection, and byte-range behavior.
- One active import limits CPU, disk, and ffmpeg contention.
- No imported media enters Git; project media and previews remain under ignored project workspaces.

## 16. Failure semantics

- Upload failure: current brief, command stacks, manifest, approved files, and media registry remain unchanged.
- Normalization failure: quarantine and owned staged outputs are removed; no asset is returned.
- Preview failure: video asset is not published as selectable b-roll.
- State conflict during/after import: browser enters the existing conflict quarantine and never silently replays commands.
- Validate/save media mismatch: fixed `422` and no draft publication.
- Approval media mismatch: approval aborts and the draft remains draft.
- Render hash/path/identity mismatch: render aborts before Remotion and no render manifest entry becomes successful.
- Browser reload after a successful upload: the server reconstructs the asset descriptor from the UUID bundle and metadata.
- Server restart with a stale hidden stage/orphan preview: only UUID-shaped, identity-checked remnants without a published asset counterpart are eligible for owned cleanup.

## 17. Testing strategy

### 17.1 Unit and security tests

- Exact upload header parsing and status mapping.
- 1 GiB video and 25 MiB image boundary behavior without allocating those payloads in memory.
- Wrong/missing length, early EOF, overflow, chunk tricks, double extension, null/control characters, encoded traversal, Windows paths, and excessive label length.
- MIME spoofing and extension/content disagreement.
- ffprobe invalid JSON, no video stream, oversized geometry/pixel count, over-30-minute duration, absent/present audio, VFR input, rotated input, and decoder failure.
- Quarantine exclusive creation, symlink parents, dangling symlinks, parent replacement during ffmpeg, abort cleanup, timeout cleanup, and preview/asset publish rollback.
- Single-import semaphore and release on every failure path.
- Strict `asset.json` parsing and canonical UUID/path derivation.
- Registry capability split for legacy image, normalized image, normalized video, manual video, audio, missing proxy, replaced canonical, and replaced proxy.
- Command exact keys, media-kind eligibility, defaults, frame snapping, duration bound, audio eligibility, immutable replay, undo/redo, and unsupported diff rejection.
- Schema backward compatibility plus mutual exclusion of `brollSrc`/`brollMedia`.
- Approval and render SHA-256 verification.
- Bundle deduplication, descriptor copy, safe rewrite, cleanup isolation, and concurrent render leases.
- Audio-volume helpers at pre-fade, first frame, midpoint, final fade, short-scene crossover, and adjacent non-overlapping scenes for multiple FPS values.

### 17.2 Browser tests

- Import control is absent in read-only mode and available in edit mode.
- Real image upload progress → processing → thumbnail, without auto-selection.
- Real VP8/WebM and MOV/MP4 fixture imports produce a playable authenticated proxy.
- Upload locks all mutations and a second import.
- Failed/aborted upload restores controls and leaves commands unchanged.
- Video selection defaults to contain/start zero/mute.
- `Начать с текущего места` snaps to output FPS.
- No-audio video disables mix/replace.
- Fit/audio/start participate in undo/redo and validated diff.
- Conflict during refresh retains the existing synchronous quarantine rules.
- Save creates one new draft and leaves approved bytes unchanged.

### 17.3 Render and media acceptance

A real temporary project must complete:

```text
browser upload:
  JPEG image
  MOV or MP4 with audio
  MP4 or WebM without audio
→ assign three b-roll scenes
→ configure mute / mix / replace
→ validate
→ save new draft
→ approve with canonical CLI
→ render with canonical CLI
→ full decode
→ ffprobe geometry/FPS/duration/audio
→ contact sheet visual QA
→ A/V sync probes before, inside, and after replace scene
→ prove previous approved brief and render are unchanged
```

Release gates remain:

```bash
npm test
npm run test:review-ui
npm audit --audit-level=high
npm run check:release
git diff --check
```

The existing documented five-moderate `file-type` chain remains the only accepted audit exception. No new high/critical finding and no unrelated dependency upgrade is allowed.

## 18. Documentation and release impact

Implementation must update in the same change set:

- `README.md`: browser import and user workflow.
- `ARCHITECTURE.md`: ingest transaction, asset bundle, new brief contract, and audio paths.
- `docs/TEMPLATES.md`: video b-roll fields and approval examples.
- `TESTING.md`: focused upload/audio/render acceptance commands.
- `DECISIONS.md`: normalized dual-file video strategy, V1 `OffthreadVideo`, and no deletion/overwrite.
- `CHANGELOG.md`: new compatible feature under `[Unreleased]`.
- `schema/lesson-brief.schema.json`: strict `brollMedia` union.

This is a backward-compatible feature and will require a minor version increase when released. Planning and implementation do not tag, push, merge, release, deploy, or change the package version unless the user separately authorizes the release step.

## 19. Definition of done

The feature is complete only when all of the following are true:

1. Images and allowed video formats upload through the edit-enabled browser into the bound project.
2. No browser input can select a destination path or expose a local path/hash.
3. Video preview works through the generated authenticated WebM proxy.
4. New media can be selected only for an existing `broll` scene.
5. Video clip start, fit, and all three audio modes persist through a new draft and explicit approval.
6. Old `brollSrc` briefs behave unchanged.
7. Render uses one immutable owned snapshot and verifies new-media hashes before Remotion.
8. `mute`, `mix`, and `replace` match the specified 120 ms curves and final loudness path.
9. Failures publish neither partial assets nor partial drafts and never mutate approved files.
10. Focused, full Node, Chromium, audit, release, decode, visual, and A/V sync gates pass on the final committed HEAD.
