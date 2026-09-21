# Design sources

| Folder | What | In git |
| --- | --- | --- |
| `session-manager/` | The current handoff: the Nocturne design (v3) — `README-v3.md` is the spec, `session-manager-v3.html` and `_ds/` the reference, `app-icon.svg` the icon source for `launcher/make-icon.mjs` | yes (since 2026-09-21) |
| `peek-mascot/` | The peek mascot handoff (Nocturne C1): `README.md` is the spec, keyframes and SVG are recreated verbatim in `web/src/mascot/` | yes, except `support.js` |
| `archive/handoff-v1/` | The first hi-fi handoff (2026-07-20), superseded for visuals by Nocturne | yes |

Both handoffs are the user's own design files, tracked since 2026-09-21 (his
call), so `tests/nocturne-tokens.test.ts` and `tests/ui-mascot-view.test.ts`
compare against them on every machine and in CI. Two things are left out on
purpose: the `*:Zone.Identifier` files Windows adds to downloads, and
`peek-mascot/support.js` — the design tool's generated runtime, third-party
code without a licence statement (the prototype HTML needs it to render, so it
stays on the author's disk, gitignored). The mock project paths inside the two
prototype HTML files read `/home/you/…`, the repo's placeholder.

How the design is applied in the app: `web/DESIGN.md`.
