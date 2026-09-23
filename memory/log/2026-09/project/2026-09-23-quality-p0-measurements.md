---
type: log
created: 2026-09-23
updated: 2026-09-23
tags: [quality, performance, measurement]
---
# 2026-09-23 — P0: what the app costs, measured

Part P0 of `.claude/plans/PLAN-QUALITY.md`: measure, then the user picks.
Ryzen 7 7800X3D, WSL2, Node 24, headless Chromium 149 (software WebGL — so
render and stall numbers are pessimistic for WebView2), own scratch backend,
`bash --norc -i` sessions. Nothing in the repo changed. Follows
[[2026-09-23-quality-q0]].

| Area | Number |
| --- | --- |
| Bundle | `index-*.js` 786 kB raw / 228 kB gzip; xterm 43 %, WebGL addon 15 %, icons 7 %, Files panel 6 %; 4 woff2 fonts ~330 kB |
| Boot to prompt painted | 160 ms cold, 199 ms warm — the warm cache never hits: no `Cache-Control`/`ETag` on static files, 1.2 MB every load |
| Boot resizes | 2 per pane (190x48, then back to 152x46 55 ms later) |
| Idle, page + 4 sessions | 42 req/min (20 × `/api/sessions`, 20 × `client-log` only to log that poll), backend 0.07 % of a core, page 0.19 % |
| Mascot page alone | 60 req/min, 36 kB/min |
| **Scrollback replay** | every split/close/tab switch re-sends each pane's full 1 MiB ring as ~1.28 MB JSON: split 2→3 3.8 MB and a 240 ms stall, tab switch to a 4-pane tab 5.1 MB and 0.8–1.1 s until usable; the client keeps only 5000 lines, so ~68 % is parsed and discarded |
| Memory | backend 107 MiB + ~0.4 MiB per idle session (up to 4 with a full ring); does not drop after sessions end |
| Log | idle 64 lines / 5.8 kB per minute, 94 % the poll; a 10 MiB generation fills in ~30 h |
| Throughput | `seq 1 200000`: 0.5 s in 1 pane, 1 s in 4; the page, not the backend, is the bottleneck; JSON framing +54 % bytes |

Ranked proposals (gain · effort · risk): (1) keep panes that did not move
on split/close instead of replaying them — M, touches the resize seam; tab
switch still replays unless inactive tabs stay mounted (memory + WebGL
context limit: a user trade-off); (2) replay only the last ~5000 lines —
S–M, −68 % on every attach; (3) quiet the poll's log lines — S, against
the "log everything" decision (user's call); (4) the double resize at boot
— S–M, resize seam; (5) cache headers for hashed `/assets/*` — S, gain
unmeasurable here; (6) binary WS frames — protocol change, not worth it on
loopback; (7) lazy chunks — ~5 ms, not worth it; (8) push instead of
polling — not for resources, only for a faster attention signal (UX call);
(9) memory — document only; (10) backend startup — fine locally.

Not measured: anything inside the WebView2 host (real GPU, the
Windows→WSL relay, the mascot overlay), the Windows cold start, an hour-long
idle, real `claude` sessions.
