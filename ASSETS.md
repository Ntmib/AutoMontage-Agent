# Public asset provenance

This file is the source of truth for every binary asset tracked by Git. Each data row is
machine-readable and must contain exactly six cells. A binary may be added only together
with its origin, author or license, reproducible source, and redistribution basis.

Repository-authored renders and CSS fixtures listed below are released with the project
under the root [MIT license](LICENSE). Font software remains under its own SIL Open Font
License 1.1; the complete license text for each font is tracked beside the binary.

| Path | Kind | Origin | Author / license | Source or generator | Redistribution basis |
|---|---|---|---|---|---|
| `docs/previews/lesson-presentation.png` | PNG documentation preview | Local Remotion still of the neutral `LessonSeq` fixture | AutoMontage-Agent contributors / MIT | `node scripts/generate-doc-preview.js` | Repository-authored render released under the project MIT license |
| `examples/demo-preview.mp4` | MP4 public demo | Local Remotion render of the neutral demo source and scenario | AutoMontage-Agent contributors / MIT | `node scripts/generate-demo-source.js`, then `npm run demo`, then copy `out/demo.mp4` here | Repository-authored render released under the project MIT license |
| `examples/demo-source.mp4` | MP4 neutral fixture | Locally generated solid-color video with silent mono audio | AutoMontage-Agent contributors / MIT | `node scripts/generate-demo-source.js` | Repository-authored fixture released under the project MIT license |
| `public/broll/growth.png` | PNG neutral b-roll | Local HTML and CSS render | AutoMontage-Agent contributors / MIT | `node scripts/shot-broll.js` from `scripts/broll-growth.html` | Repository-authored fixture released under the project MIT license |
| `public/broll/iphone.png` | PNG neutral b-roll | Local HTML and CSS render | AutoMontage-Agent contributors / MIT | `node scripts/shot-mocks.js` from `scripts/iphone-mock.html` | Repository-authored fixture released under the project MIT license |
| `public/broll/screenshot.png` | PNG neutral b-roll | Local HTML and CSS render | AutoMontage-Agent contributors / MIT | `node scripts/shot-mocks.js` from `scripts/screenshot-mock.html` | Repository-authored fixture released under the project MIT license |
| `public/fonts/JetBrainsMono.ttf` | TTF variable font | Google Fonts copy of JetBrains Mono | JetBrains Mono Project Authors / SIL OFL 1.1 in `public/fonts/OFL-JetBrainsMono.txt` | [Google Fonts repository](https://github.com/google/fonts/tree/main/ofl/jetbrainsmono) | Redistribution permitted by OFL 1.1 with the tracked license text |
| `public/fonts/Onest.ttf` | TTF variable font | Google Fonts copy of Onest | Onest Project Authors / SIL OFL 1.1 in `public/fonts/OFL-Onest.txt` | [Google Fonts repository](https://github.com/google/fonts/tree/main/ofl/onest) | Redistribution permitted by OFL 1.1 with the tracked license text |
| `public/fonts/Oswald.ttf` | TTF variable font | Google Fonts copy of Oswald | Oswald Project Authors / SIL OFL 1.1 in `public/fonts/OFL-Oswald.txt` | [Google Fonts repository](https://github.com/google/fonts/tree/main/ofl/oswald) | Redistribution permitted by OFL 1.1 with the tracked license text |

## Policy

- Third-party media without a recorded source and redistribution grant is not accepted.
- Brand names may be rendered as plain text or neutral CSS markers, but third-party logo
  files are not redistributed by the public fixture set.
- Regenerated binary output may differ byte-for-byte across ffmpeg, Chromium, or Remotion
  versions; its visual content and inputs remain reproducible from the listed command.
