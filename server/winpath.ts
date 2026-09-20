/**
 * WSL -> Windows path mapping for the ONE place the app needs it: opening a
 * Command Prompt in the project folder (Nocturne B5, `.claude/PLAN-B5.md`).
 *
 * `cmd.exe` launched through WSL interop refuses a UNC working directory —
 * measured 2026-09-18: "UNC paths are not supported. Defaulting to Windows
 * directory" — so the session is spawned as `cmd.exe /k pushd <windows path>`:
 * `pushd` maps a temporary drive letter for a UNC path and the prompt really
 * opens in the folder (measured: `Z:\home\…`).
 *
 * PURE functions: no fs, no env, no spawn. The caller passes the cwd and the
 * distro name it read from the PTY environment.
 *
 * SECURITY — why the allow-list shapes exist. Everything else this app spawns
 * is an argv array, and `cmd.exe` gets one too; but cmd PARSES ITS OWN COMMAND
 * LINE, and in that line `& | ^ % " < >` and whitespace are metacharacters. The
 * cwd reaching here is a client-chosen project path, so the tail is composed
 * ONLY when the path is made of `[A-Za-z0-9._-]` segments (no `.`/`..`
 * segment) and the distro name is made of the same characters. Anything else
 * spawns a plain `cmd.exe` in the Windows default directory — a worse prompt,
 * never a reshaped command line.
 */

/** Segment charset of a path we are willing to hand to cmd.exe. */
export const WSL_PATH_SHAPE = /^\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
/** Distro names as `WSL_DISTRO_NAME` reports them (`Ubuntu-24.04`, `Debian`). */
export const DISTRO_NAME_SHAPE = /^[A-Za-z0-9._-]+$/;

/**
 * True for an absolute path this module will map. `.` and `..` segments pass
 * WSL_PATH_SHAPE (both are made of dots) and are refused HERE: a mapped path
 * must name the folder the user picked, not a traversal of it.
 */
export function isSafeWslPath(cwd: string): boolean {
  if (!WSL_PATH_SHAPE.test(cwd)) return false;
  return cwd
    .split('/')
    .slice(1)
    .every((segment) => segment !== '.' && segment !== '..');
}

/**
 * True for a usable `WSL_DISTRO_NAME` (absent/empty/odd -> false). `.` and `..`
 * pass DISTRO_NAME_SHAPE (both are made of dots) and are refused HERE, the same
 * dot-segment rule as `isSafeWslPath`: they are path segments of
 * `\\wsl.localhost\<distro>\…`, and a distro named `..` would walk the UNC path
 * one level up instead of naming a distro.
 */
export function isDistroName(value: string | undefined): value is string {
  if (typeof value !== 'string' || !DISTRO_NAME_SHAPE.test(value)) return false;
  return value !== '.' && value !== '..';
}

/**
 * The Windows path of a WSL working directory, or undefined when either shape
 * is refused (see the security note above).
 *
 *   /mnt/c              -> C:\
 *   /mnt/c/Users/x      -> C:\Users\x
 *   /home/you/projects  -> \\wsl.localhost\<distro>\home\you\projects
 *
 * Only a SINGLE-LETTER second segment under /mnt is a drive (`/mnt/wsl/...` is
 * a real WSL path, not drive `wsl:`). The drive letter is upper-cased.
 */
export function windowsPathFor(cwd: string, distro: string | undefined): string | undefined {
  if (!isSafeWslPath(cwd)) return undefined;
  if (!isDistroName(distro)) return undefined;
  const segments = cwd.split('/').slice(1);
  const drive = segments[1];
  if (segments[0] === 'mnt' && drive !== undefined && /^[A-Za-z]$/.test(drive)) {
    const rest = segments.slice(2);
    return `${drive.toUpperCase()}:\\${rest.join('\\')}`;
  }
  return `\\\\wsl.localhost\\${distro}${cwd.replace(/\//g, '\\')}`;
}

/** Why a cmd.exe launch got no working-directory tail. Both are log sentences. */
export type CmdStartRefusal = 'path shape' | 'no distro';

export type CmdStartPlan =
  | { ok: true; args: string[]; winPath: string }
  | { ok: false; reason: CmdStartRefusal };

/**
 * The PTY argv tail for a `cmd.exe` session with NO client arguments:
 * `['/k', 'pushd', <windows path>]`. Never reaches SessionInfo.args, exactly
 * like the claude `--settings` / `--session-id` injections — so history stores
 * the client's `[]` and a resume composes the tail again from the cwd of the
 * run it resumes.
 */
export function planCmdStart(cwd: string, distro: string | undefined): CmdStartPlan {
  if (!isSafeWslPath(cwd)) return { ok: false, reason: 'path shape' };
  if (!isDistroName(distro)) return { ok: false, reason: 'no distro' };
  const winPath = windowsPathFor(cwd, distro);
  if (winPath === undefined) return { ok: false, reason: 'path shape' };
  return { ok: true, args: ['/k', 'pushd', winPath], winPath };
}

// ---------------------------------------------------------------------------
// The CLIPBOARD form of a path (Nocturne B10, .claude/PLAN-B10.md §2)
//
// A SECOND, WIDER vocabulary, and the reason is the one written at the top of
// this file: WSL_PATH_SHAPE is narrow because cmd.exe PARSES ITS OWN COMMAND
// LINE, so a space or an `&` in a cwd would reshape that line. NOTHING parses a
// clipboard path — the native host puts the string on Clipboard.SetFileDropList
// as one item — so spaces, Unicode, parentheses and `&` are allowed here and
// only what Windows itself cannot name in a path segment is refused.
// ---------------------------------------------------------------------------

/** Why a path cannot be a Windows one. Never a sentence, never logged with a path. */
const WINDOWS_RESERVED_CHARS = /[\\/:*?"<>|]/;

/**
 * One segment Windows can name: not empty, not `.`/`..`, no reserved character,
 * no control character (< 0x20 or 0x7F), and no trailing dot or space (Windows
 * silently trims those, so a name ending in one would land under a DIFFERENT
 * name than the one the user copied).
 */
function isClipboardSegment(segment: string): boolean {
  if (segment === '' || segment === '.' || segment === '..') return false;
  if (WINDOWS_RESERVED_CHARS.test(segment)) return false;
  for (let i = 0; i < segment.length; i += 1) {
    const code = segment.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  const last = segment[segment.length - 1];
  return last !== '.' && last !== ' ';
}

/**
 * The Windows form of an absolute WSL path for the CLIPBOARD, or undefined when
 * a segment cannot be named on Windows.
 *
 *   /mnt/c                 -> C:\
 *   /mnt/c/Users/My Docs   -> C:\Users\My Docs
 *   /home/you/my notes     -> \\wsl.localhost\<distro>\home\you\my notes
 *
 * Same two branches as windowsPathFor: a SINGLE-LETTER second segment under
 * /mnt is a drive (upper-cased), everything else is a UNC path into the distro.
 * The distro is only needed by the UNC branch, so a `/mnt/c` path still maps
 * when WSL_DISTRO_NAME is missing — unlike windowsPathFor, whose single gate
 * exists so a cmd.exe launch has exactly one path through it.
 */
export function windowsPathForClipboard(
  path: string,
  distro: string | undefined,
): string | undefined {
  if (typeof path !== 'string' || !path.startsWith('/')) return undefined;
  const segments = path.split('/').slice(1);
  if (segments.length === 0) return undefined;
  if (!segments.every(isClipboardSegment)) return undefined;
  const drive = segments[1];
  if (segments[0] === 'mnt' && drive !== undefined && /^[A-Za-z]$/.test(drive)) {
    return `${drive.toUpperCase()}:\\${segments.slice(2).join('\\')}`;
  }
  if (!isDistroName(distro)) return undefined;
  return `\\\\wsl.localhost\\${distro}\\${segments.join('\\')}`;
}

/**
 * GET /api/fs/winpath's refusal. A CONSTANT sentence, like every other refusal
 * this app writes: server/api.ts records it in `responseReason` for the access
 * log, and that channel never carries anything derived from a request.
 */
export const FS_PATH_NOT_MAPPABLE = 'That file cannot be reached from Windows.';
