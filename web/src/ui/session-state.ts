/**
 * ONE readout of what a session is doing (Nocturne B11,
 * `.claude/plans/nocturne/PLAN-B11.md`). Every surface that names a session's
 * state reads it from here: the pane dot + pill (`ui/panes.ts`), the Sessions
 * drawer row (`ui/sessions.ts`), the tab dot (`state.ts` `viewStatus`, drawn by
 * `ui/tabs.ts`), `N waiting for you` (`ui/statusline.ts`) and the top bar's
 * Sessions badge (`main.ts`). Five places, one rule — so they cannot disagree.
 *
 * DOM-free, like the other `*-model.ts` modules, so `node --test` imports it.
 *
 * THE ORDER, strongest first:
 *   - `attn`    — a BEL (`attention`): Claude asked something. Amber, pulsing.
 *   - `exited`  — the PTY is gone. Grey. Beats `turn`, which the server drops at
 *                 exit anyway; a stale one is ignored here too.
 *   - `waiting` — the server says Claude ended its turn, or waits on the
 *                 user (a question, a plan approval, a permission prompt).
 *                 Amber, still.
 *   - `working` — the transcript says Claude is generating or running a
 *                 tool, or background work it launched still runs. Green,
 *                 pulsing.
 *   - `running` — alive, but nothing this app reads says which of the two:
 *                 every non-claude session, a claude session spawned without
 *                 the injected status line, a refused transcript. Green,
 *                 STILL — a pulse would claim knowledge the app does not have.
 *
 * THE SERVER'S RULE (`turn`, Nocturne C2, `.claude/plans/nocturne/PLAN-C2.md`):
 * a session that ended its turn while background subagents or workflows it
 * launched still run reads `working` — Claude is not done; it reads `waiting`
 * (Waiting for you) once that work is over and Claude ended its turn. It also
 * reads `waiting`, whatever still runs, when Claude waits on the user — a
 * question (`AskUserQuestion`), a plan to approve (`ExitPlanMode`) or a
 * permission prompt: the server reads that from Claude Code's terminal title
 * once it has been idle for 3 s while the transcript says the turn runs (the
 * C2 fix after the DEV check, 2026-09-27; this settles B11's old
 * permission-prompt limit). Background shells never count.
 *
 * `waiting` is a READOUT, never a nag: it raises no `attention`, no
 * notification, no taskbar flash, no `seen` bookkeeping. Those stay BEL-only
 * (they read `attention` itself, never this readout).
 */
import type { SessionInfo } from '../../../shared/protocol.ts';

export type SessionReadout = 'attn' | 'waiting' | 'working' | 'running' | 'exited';

/** attn (BEL) > exited > waiting > working (turn known) > running (no turn readout). */
export function sessionReadout(s: Pick<SessionInfo, 'status' | 'attention' | 'turn'>): SessionReadout {
  if (s.attention) return 'attn';
  if (s.status !== 'running') return 'exited';
  if (s.turn === 'waiting') return 'waiting';
  if (s.turn === 'working') return 'working';
  return 'running';
}

/** 'Needs your answer' · 'Waiting for you' · 'Working' · 'Working' · 'Finished'. */
export function readoutWord(r: SessionReadout): string {
  switch (r) {
    case 'attn':
      return 'Needs your answer';
    case 'waiting':
      return 'Waiting for you';
    case 'working':
    case 'running':
      return 'Working';
    case 'exited':
      return 'Finished';
  }
}

/**
 * The state class every surface puts on its dot / pill / meta line:
 * `is-attn` · `is-wait` · `is-work` · `is-run` · `is-exit` (app.css).
 */
export function readoutClass(r: SessionReadout): 'is-attn' | 'is-wait' | 'is-work' | 'is-run' | 'is-exit' {
  switch (r) {
    case 'attn':
      return 'is-attn';
    case 'waiting':
      return 'is-wait';
    case 'working':
      return 'is-work';
    case 'running':
      return 'is-run';
    case 'exited':
      return 'is-exit';
  }
}
