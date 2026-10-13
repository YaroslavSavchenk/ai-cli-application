/**
 * The Windows host's source files: `launcher/host/AiSessionManagerHost.cs` and
 * the parts Q6 (2026-10-13, `.claude/plans/quality/PLAN-Q6.md`) cut it into —
 * one `partial class HostApp`, in `launcher/build-host.ps1`'s compile order.
 *
 * `readSources(...HOST_SOURCES)` (`helpers.ts`) is the whole host as ONE text,
 * for a source pin that must hold over every part: a copy in another part must
 * not slip by. `tests/release/host-instance.test.ts` and the log rule of
 * `tests/release/host-webmessage.test.ts` read it that way.
 */
export const HOST_SOURCES = [
  'launcher/host/AiSessionManagerHost.cs',
  'launcher/host/AiSessionManagerHost-clipboard.cs',
  'launcher/host/AiSessionManagerHost-overlay.cs',
  'launcher/host/AiSessionManagerHost-overlay-window.cs',
] as const;
