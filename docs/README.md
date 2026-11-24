# Documentation

The detail behind the [front page](../README.md).

| Document | What it covers |
| --- | --- |
| [features.md](features.md) | What the app does, feature by feature, and how it works underneath (sessions as server-side objects, the backend's lifetime, session history) |
| [install.md](install.md) | What you need, the Setup step by step, running it, updating (in-app and by hand), uninstalling, and what is worth knowing (unsigned exe, local only, dropped files) |
| [development.md](development.md) | Running from a clone, developing inside WSL, the test suite's timeouts, the sticky port, CI, and the test-only environment seams |
| [release.md](release.md) | How a tag becomes a release: the workflow, its artifacts, `npm run release`, dry runs and dispatched builds |
| [app-data.md](app-data.md) | Every file in `~/.ai-session-manager/`: what it holds, its mode, when it is written and removed, and what `server.log` records |
| [restart-and-recovery.md](restart-and-recovery.md) | `Restart service` step by step, `POST /api/restart`, its environment variables, a backend crash, and recovery after WSL stops (cause, `Restart`, resume) |
| [github.md](github.md) | Connecting GitHub: a pasted token or the device flow, what Disconnect does, how the credential is stored |
| [images/](images/) | Screenshots used by the front page |

Elsewhere in the repository:

- The launcher, its switches and troubleshooting: [launcher/README.md](../launcher/README.md)
- The Windows Setup's build: [installer/README.md](../installer/README.md)
- Architecture, decisions, hard constraints: [.claude/PROJECT-SCOPE.md](../.claude/PROJECT-SCOPE.md)
- How code is written: [CONTRIBUTING.md](../CONTRIBUTING.md); how tests are written: [tests/README.md](../tests/README.md)
- Frontend design system: [web/DESIGN.md](../web/DESIGN.md)
- Wire contract (REST, WebSocket, discovery file): `shared/protocol.ts` and its `protocol-*.ts` topic modules
- Reporting a vulnerability: [SECURITY.md](../SECURITY.md)
