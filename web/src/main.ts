/**
 * Minimal placeholder UI entry point. The real frontend (xterm.js panes,
 * tabs/layouts, project management) lands in a later phase.
 */
import type { SessionInfo } from '../../shared/protocol.ts';

declare global {
  interface Window {
    /** Auth token injected at serve time in place of the __AUTH_TOKEN__ placeholder. */
    __AUTH__: string;
  }
}

const app = document.querySelector<HTMLDivElement>('#app');
if (app !== null) {
  app.textContent = 'AI Session Manager — UI placeholder';
}

// Referenced so the shared contract is part of the web typecheck surface.
export type { SessionInfo };
