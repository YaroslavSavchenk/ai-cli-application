/**
 * The New session dialog's project preferences — pure rules, no DOM (part D1,
 * `.claude/plans/nocturne/PLAN-D1.md`). `launch.ts` only wires them.
 *
 * What D1 fixed: the preferences resolved ONCE per open, so the model shown was
 * the first project's, not the one picked next, and a `No prompts` preference
 * armed bypass for whatever tool was on screen. The rule now:
 *
 *   - on open and on every project change, the project's model, permission
 *     mode and effort are layered onto Claude Code's controls — except a field
 *     the user changed by hand during THIS open ("a per-launch choice always
 *     wins", PROJECT-SCOPE);
 *   - the preferences are Claude Code's only: its model ids and its effort
 *     levels, and its permission mode. Another tool starts on Always ask.
 */
import type { Project } from '../../../shared/protocol.ts';
import { resolveEffort, resolveModel, resolvePerm } from './launch-args.ts';
import type { AgentKind, Effort, Perm } from './launch-args.ts';

/** What Claude Code's controls hold. */
export interface ClaudeChoice {
  model: string;
  perm: Perm;
  effort: Effort;
}

/** One of the three preferences a hand change can claim for this open. */
export type PrefField = keyof ClaudeChoice;

/** The stored preferences a project carries. */
type ProjectPrefs = Pick<Project, 'defaultModel' | 'defaultPerm' | 'defaultMode' | 'defaultEffort'>;

/** A project's preferences as Claude Code values; none = the fallbacks (Opus 5.5, Always ask, Default). */
export function projectChoice(p: ProjectPrefs | undefined): ClaudeChoice {
  return {
    model: resolveModel(p?.defaultModel),
    perm: resolvePerm(p?.defaultPerm, p?.defaultMode),
    effort: resolveEffort(p?.defaultEffort),
  };
}

/**
 * Lay the project's choice over what the dialog holds, for the tool on screen:
 * a field changed by hand this open stays. The model and effort are Claude
 * Code's own controls; the permission cards are ONE set shared by every agent,
 * so a mode picked by hand stays whichever tool it was picked on, and without
 * one Claude Code takes the project's mode while every other tool starts on
 * Always ask — a `No prompts` preference never arms Codex's or Gemini's bypass.
 * `held.perm` is the hand pick itself, kept apart from what the cards show: a
 * tool that cannot take it shows Always ask without losing it, and a tool that
 * can shows it again.
 */
export function layerChoice(
  agent: AgentKind,
  held: ClaudeChoice,
  wanted: ClaudeChoice,
  byHand: ReadonlySet<PrefField>,
): ClaudeChoice {
  const projectPerm = agent === 'claude' ? wanted.perm : 'default';
  return {
    model: byHand.has('model') ? held.model : wanted.model,
    perm: byHand.has('perm') ? held.perm : projectPerm,
    effort: byHand.has('effort') ? held.effort : wanted.effort,
  };
}
