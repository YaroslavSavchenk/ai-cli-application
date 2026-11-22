/**
 * The one bounded child-process runner, and `runCapture` on top of it.
 *
 * Split from server/config.ts (PLAN-QUALITY Q11), which re-exports
 * everything here; importers keep using config.ts. Before Q11 four modules
 * wrote the same skeleton by hand — server/config.ts `runCapture`,
 * server/git.ts `runGitCapture`, server/scaffold.ts `runGit`,
 * server/github-clone.ts `runGitClone` — and one of them read its timer in
 * the temporal dead zone when `spawn` threw synchronously.
 *
 * THE SEAM IS A HARD CONSTRAINT (.claude/PROJECT-SCOPE.md § Hard technical
 * constraints; CONTRIBUTING.md § The hard constraints): `runChild` never
 * builds argv, options or env — the caller's `start()` makes the one `spawn`
 * call, argv only, `shell: false`. What lives here is the lifetime: settle
 * once, SIGKILL on the timeout, an unref'd timer, the `error` and `close`
 * events, each mapped by the caller to its own error class.
 */
import { spawn, type ChildProcess } from 'node:child_process';

/** One bounded run: the caller's spawn and the caller's answer to each way it can end. */
interface ChildRun<T> {
  /** The caller's own `spawn(...)` call. May throw synchronously (EMFILE). */
  start(): ChildProcess;
  /** SIGKILL after this many ms; the timer is unref'd, so a run never holds the process. */
  timeoutMs: number;
  /** `start()` threw. */
  startThrew(): Error;
  /** The timeout fired; SIGKILL has been sent. */
  timedOut(): Error;
  /** The child's `error` event (ENOENT, EACCES …). */
  failed(err: Error): Error;
  /** The child's `close` event: the value to resolve, or an Error to reject. Ignored once settled. */
  closed(code: number | null): T | Error;
  /** Wire the child's streams; `fail` rejects early (a stdout cap). */
  watch?(child: ChildProcess, fail: (err: Error) => void): void;
}

/** SIGKILL that cannot throw: a child already gone needs nothing. */
export function killQuietly(child: ChildProcess): void {
  try {
    child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}

/**
 * Run one child to its end and settle ONCE: the first of a start failure, an
 * early `fail` from `watch`, the timeout, the `error` event or the `close`
 * event wins; every hook still runs for the later events (a hook may log or
 * trace them), and its answer is then ignored.
 */
export function runChild<T>(run: ChildRun<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    // DECLARED BEFORE finish(), and checked: when `start()` throws, finish()
    // runs before the `setTimeout` below exists — a bare `clearTimeout(timer)`
    // on a `const` declared later is a ReferenceError (the bug scaffold.ts had).
    let timer: NodeJS.Timeout | undefined;
    const finish = (outcome: T | Error): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    let child: ChildProcess;
    try {
      child = run.start();
    } catch {
      finish(run.startThrew());
      return;
    }
    run.watch?.(child, finish);
    timer = setTimeout(() => {
      killQuietly(child);
      finish(run.timedOut());
    }, run.timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.on('error', (err) => finish(run.failed(err)));
    child.on('close', (code) => finish(run.closed(code)));
  });
}

interface RunCaptureOptions {
  /** SIGKILL after this many ms (default 15 s); the promise then rejects `timed out`. */
  timeoutMs?: number;
  /** The child's environment; default this process's own. */
  env?: Record<string, string | undefined>;
  /** Stdout bytes kept; the rest is read and discarded (default RUN_CAPTURE_MAX_BYTES). */
  maxBytes?: number;
}

/** Default stdout cap of runCapture: these helpers answer one short line. */
const RUN_CAPTURE_MAX_BYTES = 4096;

/**
 * Run `command` with `args` and resolve its stdout (at most `maxBytes`,
 * UTF-8) when it exits 0. ARGV ONLY, `shell: false`: no value is ever parsed
 * by a shell. Stdin and stderr are ignored. Rejects with a short plain
 * `Error` whose message the caller may log — `timed out`, `could not be
 * started` or `exited with code <n>` — never the output.
 *
 * Moved from server/update-install.ts (Nocturne D6) so the Windows interop
 * probes and the `claude --version` probe (server/claude-version.ts) share
 * one bounded spawn.
 */
export function runCapture(
  command: string,
  args: string[],
  opts: RunCaptureOptions = {},
): Promise<string> {
  const maxBytes = opts.maxBytes ?? RUN_CAPTURE_MAX_BYTES;
  const chunks: Buffer[] = [];
  let kept = 0;
  return runChild({
    start: () =>
      spawn(command, args, {
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: false,
        ...(opts.env === undefined ? {} : { env: opts.env }),
      }),
    timeoutMs: opts.timeoutMs ?? 15_000,
    startThrew: () => new Error('could not be started'),
    timedOut: () => new Error('timed out'),
    failed: () => new Error('could not be started'),
    closed: (code) => (code === 0 ? Buffer.concat(chunks).toString('utf8') : new Error(`exited with code ${code}`)),
    watch: (child) => {
      child.stdout?.on('data', (chunk: Buffer) => {
        if (kept >= maxBytes) return;
        const part = chunk.subarray(0, maxBytes - kept);
        chunks.push(part);
        kept += part.byteLength;
      });
    },
  });
}
