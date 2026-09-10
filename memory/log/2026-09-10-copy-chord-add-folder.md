---
type: log
created: 2026-09-10
updated: 2026-09-10
tags: [log, terminal, clipboard, projects, fix]
---
# 2026-09-10 — copy from a terminal + add an existing folder FIXED

User reports while testing the A2 build: "ik mag niks kopieren vanuit de
sessies, wel plakken" and "toevoegen van een project werkt niet … directory
already exists and is not empty". Neither was an A1–A3 regression.

- **Copy never existed.** Only paste chords were built (2026-09-08). xterm
  serves native `copy` events, but the only key that fires one is Ctrl+C,
  which xterm turns into `^C`. Now Ctrl+Shift+C / Ctrl+Insert copy the
  selection (`navigator.clipboard.writeText`) ONLY while one exists; without
  a selection they are left alone (xterm sends no bytes for them anyway).
  Scope doc's "exactly two extra chords" → four.
- **Add-existing lost since phase 2a.** `POST /api/projects` without `create`
  (register) had no UI caller; the dialog always sent `create:true`.
  `GET /api/fs/list` now returns `empty` (same test as `assertVacant`), the
  dialog probes a browsed folder: non-empty → "Add this folder" (no git init),
  empty/missing/unknown → Create project with git init (2026-07-24 default
  kept). First cut sent EVERY browsed folder to add (fs/list had dirs only) —
  caught by the orchestrator before review.
- Review caught: a stale intent after a re-pick could register an empty
  folder without git init (button now held while probing), a sticky
  auto-filled name, duplicate registrations (client guard "This folder is
  already a project."), and a false overlay note. Security CLEAN.
- Test-engineer proved a pre-existing bug: ANY 403 counted as a lost token,
  so the picker on an unreadable folder reloaded the page. `isAuthFailure`:
  403 is auth only for `forbidden host` / `forbidden origin` (or no body).
- Suite 1219 → 1259.

Backlog: server-side dedupe for register mode; clipboard write in the real
WebView2 host is unverified from WSL; the Edge `--app` fallback opens
DevTools on Ctrl+Shift+C without a selection (WebView2 host is immune).
A7 brief must carry the add intent (v3 tabs have no slot for it).

**User-verified 2026-09-10** in the Windows dev window (A1–A3 + both fixes): "ziet er goed uit. Alles werkt".
