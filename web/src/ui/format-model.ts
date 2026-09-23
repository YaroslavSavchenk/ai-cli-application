/**
 * The UI's pure formatters: argv tags (`modelFromArgs`, `permFromArgs`),
 * times (`fmtUptime`, `relativeTime`, `MONTHS`) and badge counts
 * (`fmtCount`). No DOM, no app state, no I/O — so a `*-model.ts` may import
 * them and `node --test` calls them directly.
 *
 * Split from `ui/util.ts` in the Q1–Q4 fix round
 * (`.claude/plans/PLAN-QUALITY.md`): two models (`commit-model.ts`,
 * `pane-status-model.ts`) imported util.ts, a DOM module, for these. util.ts
 * keeps the DOM helpers, `ModalSlot`, `errorText` and `promiseOf`.
 */
import { PERM_SHORT, isPerm } from './launch-args.ts';

/**
 * Model tag from a session's argv (`--model x` / `--model=x`, and since B5 the
 * short `-m x` the other three agents take) — tags derive client-side from
 * SessionInfo.args; the protocol carries no tag fields.
 *
 * Only the SPACE form of the short flag is read: Codex, Gemini CLI and Grok are
 * all spawned by this app as `-m <id>`, and guessing at `-m<id>` / `-m=<id>`
 * would start reading a custom command's unrelated `-m` as a model.
 */
export function modelFromArgs(args: string[]): string | null {
  const i = args.indexOf('--model');
  const next = args[i + 1];
  if (i !== -1 && typeof next === 'string' && next !== '') return next;
  const eq = args.find((a) => a.startsWith('--model='));
  const v = eq?.slice('--model='.length);
  if (v !== undefined && v !== '') return v;
  const j = args.indexOf('-m');
  const short = j !== -1 ? args[j + 1] : undefined;
  return typeof short === 'string' && short !== '' ? short : null;
}

/**
 * Permission tag from argv, in the UI's plain words (`PERM_SHORT`, the pane
 * status bar's Mode value): both bypass forms read "No prompts", `acceptEdits`
 * reads "Auto edits", `plan` reads "Read only". Danger (red tag) for both bypass
 * forms; null for default/absent (no tag shown at all — unchanged). A mode
 * outside the known four (only reachable from a custom command the user typed)
 * is shown verbatim: inventing a translation for it would be dishonest.
 */
export function permFromArgs(args: string[]): { label: string; danger: boolean } | null {
  if (args.includes('--dangerously-skip-permissions')) {
    return { label: PERM_SHORT.bypassPermissions, danger: true };
  }
  const i = args.indexOf('--permission-mode');
  const next = i !== -1 ? args[i + 1] : undefined;
  const v =
    typeof next === 'string' && next !== ''
      ? next
      : args.find((a) => a.startsWith('--permission-mode='))?.slice('--permission-mode='.length);
  if (typeof v !== 'string' || v === '' || v === 'default') return null;
  return { label: isPerm(v) ? PERM_SHORT[v] : v, danger: v === 'bypassPermissions' };
}

/**
 * Uptime since an ISO timestamp in the v3 handoff's form — `31m`, `2h 15m`
 * (the statusline prints it as `Up …`; the Legacy form was `HH:MM:SS`, and a
 * second-by-second uptime is a readout nobody reads). Hours are shown only
 * once there is at least one, and never wrap; seconds are never shown. An
 * unparsable timestamp renders as an em dash.
 *
 * `now` is injectable (same pattern as `relativeTime`) so the pane status bar's
 * model can be tested without a clock stub; the statusline passes nothing.
 */
export function fmtUptime(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** English month abbreviations (locale-independent): `commit-model.ts`'s commit date. */
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** Calendar months and years vary; a relative line is an ORDER of magnitude. */
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

function ago(n: number, unit: string): string {
  return `${n} ${n === 1 ? unit : `${unit}s`} ago`;
}

/**
 * How long ago, in words — `just now`, `5 minutes ago`, `3 hours ago`,
 * `2 days ago`, `1 week ago`, `4 months ago`, `2 years ago`. The ONE relative
 * time of the app (user's decision 2026-09-23, `.claude/plans/PLAN-QUALITY.md`
 * decision 1): the commits list, the commit view, the sessions drawer's
 * earlier rows, the resume picker and the GitHub repo list all say it this way.
 *
 * `now` is handed in so a test never depends on a clock and so a list that has
 * been open for an hour says so on its next repaint.
 *
 * A timestamp in the future (a clock that runs ahead) reads `just now` rather
 * than a negative age: the app cannot know which of the two clocks is wrong,
 * and "in 3 hours" is the one thing that is certainly false. A timestamp it
 * cannot parse comes back EMPTY, never as a made-up age — every caller then
 * leaves the slot out rather than print an empty one.
 */
export function relativeTime(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const d = now - at;
  if (d < MINUTE) return 'just now';
  if (d < HOUR) return ago(Math.floor(d / MINUTE), 'minute');
  if (d < DAY) return ago(Math.floor(d / HOUR), 'hour');
  if (d < WEEK) return ago(Math.floor(d / DAY), 'day');
  if (d < MONTH) return ago(Math.floor(d / WEEK), 'week');
  if (d < YEAR) return ago(Math.floor(d / MONTH), 'month');
  return ago(Math.floor(d / YEAR), 'year');
}

/**
 * A count for a badge or header — capped at `9+` past nine (user's request
 * 2026-09-08: a full number there is "far too unwieldy"). Every history count
 * the UI shows goes through this so they never disagree.
 */
export function fmtCount(n: number): string {
  return n > 9 ? '9+' : String(n);
}
