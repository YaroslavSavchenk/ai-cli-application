# Design sources

| Folder | What | In git |
| --- | --- | --- |
| `session-manager/` | The current handoff: the Nocturne design (v3) — `README-v3.md` is the spec, `session-manager-v3.html` and `_ds/` the reference, `app-icon.svg` the icon source for `launcher/make-icon.mjs` | no — local only (`.git/info/exclude`) |
| `peek-mascot/` | The peek mascot handoff (Nocturne C1): `README.md` is the spec, keyframes and SVG are recreated verbatim in `web/src/mascot/` | no — local only |
| `archive/handoff-v1/` | The first hi-fi handoff (2026-07-20), superseded for visuals by Nocturne | yes |

The two local folders are the user's own design files and are not published
with the repository. Tests that compare against them
(`tests/nocturne-tokens.test.ts`, `tests/ui-mascot-view.test.ts`) skip that
part when the folder is absent; the committed fixture
`tests/fixtures/nocturne-handoff-tokens.json` carries the token values.

How the design is applied in the app: `web/DESIGN.md`.
