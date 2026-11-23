/**
 * Which of the shell's chrome renderers a change notification reaches
 * (Quality Q12). `main-shell.ts` used to run all six on every `notify`, of
 * any kind — the 5 s latency pong redrew the tab strip, both drawers and the
 * Files panel. Each renderer is listed here with the kinds of change that
 * carry the state it reads; anything else cannot change what it draws.
 *
 * - `chrome`   (main-shell `updateChrome`): the Sessions badge's attention
 *   count, the drawer and Files toggles, the connection dot.
 * - `tabs`     (`ui/tabs.ts`): the views and their panes, session titles and
 *   tool marks, project names for folder tabs. The `Confirm before ending`
 *   preference it also reads arrives through settings' `repaintTabs`.
 * - `status`   (`ui/statusline.ts`): live sessions, the active tab's panes,
 *   attention, latency and uptime.
 * - `sessionsDrawer` (`ui/sessions.ts`): its visibility, the sessions and the
 *   history (both `sessions`), project names.
 * - `projectsDrawer` (`ui/projects.ts`): its visibility, the projects, the
 *   running count per project.
 * - `filesPanel` (`ui/files.ts`): its visibility (`drawer`, `panel`), its
 *   root (the focused pane, the session behind it, its project), the open
 *   commit (`screen`), the files open as tabs (`ui`).
 *
 * The ORDER is the order they run in, and it is the order they always ran in.
 * `tests/ui/ui-chrome-dispatch.test.ts` proves each list against the real
 * setters and renderers.
 */
import type { ChangeKind } from '../state.ts';

export type ChromeRenderer =
  | 'chrome'
  | 'tabs'
  | 'status'
  | 'sessionsDrawer'
  | 'projectsDrawer'
  | 'filesPanel';

export const RENDERS_ON: readonly (readonly [ChromeRenderer, readonly ChangeKind[]])[] = [
  ['chrome', ['sessions', 'drawer', 'panel', 'conn']],
  ['tabs', ['ui', 'sessions', 'projects']],
  ['status', ['ui', 'sessions', 'conn']],
  ['sessionsDrawer', ['drawer', 'sessions', 'projects']],
  ['projectsDrawer', ['drawer', 'projects', 'sessions']],
  ['filesPanel', ['ui', 'sessions', 'projects', 'drawer', 'panel', 'screen']],
];

/** The renderers one kind of change reaches, in run order. */
export function renderersFor(kind: ChangeKind): ChromeRenderer[] {
  return RENDERS_ON.filter(([, kinds]) => kinds.includes(kind)).map(([r]) => r);
}
