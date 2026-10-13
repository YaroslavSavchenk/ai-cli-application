/**
 * The stores and watchers the boot constructs — projects, prefs, history,
 * session settings, keys, the subagents watcher, the SessionManager, the
 * status-line telemetry watcher, the GitHub connection — and the wipe of what
 * no run may inherit (resetSessionArtifacts, resetUpdateArtifacts).
 *
 * Split from server/index.ts (Quality Q5, 2026-10-13): a pure move, the
 * construction order, the log lines and the AI_SM_GITHUB_API_BASE refusal
 * unchanged. index.ts calls createStores() at the exact point the statements
 * stood, at module load, so a refusal still throws out of module evaluation
 * (stderr + exit 1). It keeps the boot order, the standby flag and every
 * caller of the two resets. Siblings: server/index-banner.ts,
 * server/index-update.ts, server/index-restart.ts.
 */
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveGithubApiBase,
  DEFAULT_GITHUB_API_BASE,
  type DataPaths,
  type Logger,
} from './config.ts';
import { ProjectStore } from './projects.ts';
import { PrefsStore } from './prefs.ts';
import { SessionManager } from './sessions.ts';
import { SessionSettingsStore } from './session-settings.ts';
import { KeyStore } from './keys.ts';
import { TelemetryWatcher } from './telemetry.ts';
import { AgentsWatcher } from './agents.ts';
import { SessionHistory } from './history.ts';
import { GithubConnection } from './github.ts';
import { cleanupUpdatesDir } from './update-install.ts';

/** What the construction reads from the boot in server/index.ts. */
interface StoresWiring {
  log: Logger;
  paths: DataPaths;
  serverDir: string;
  /** A standby waiting for `go` must not touch the data dir (see index.ts). */
  standbyWaiting: boolean;
}

interface Stores {
  projects: ProjectStore;
  prefs: PrefsStore;
  history: SessionHistory;
  keys: KeyStore;
  agents: AgentsWatcher;
  sessions: SessionManager;
  telemetry: TelemetryWatcher;
  github: GithubConnection;
  /** Run at module load in a normal boot, at `go` in a standby. */
  resetSessionArtifacts: () => void;
  /** Run at module load in a normal boot, at `go` in a standby. */
  resetUpdateArtifacts: () => void;
}

export function createStores({ log, paths, serverDir, standbyWaiting }: StoresWiring): Stores {
  const projects = new ProjectStore(paths.projectsFile, log);
  const prefs = new PrefsStore(paths.prefsFile, log);
  const history = new SessionHistory(paths.historyFile, log);
  // A standby reads the file WITHOUT stamping or rewriting it: those entries
  // belong to the parent that is still running them. The full load runs at `go`.
  history.load({ readOnly: standbyWaiting });
  // Per-session `--settings` files giving claude sessions our status line. The
  // script is run by a FOREIGN process (claude), so it is named by absolute path
  // and run with this very node binary — never by a name resolved through the
  // child's PATH. Any file left by a previous run is wiped: sessions do not
  // survive a restart.
  const sessionSettings = new SessionSettingsStore(
    {
      dir: paths.sessionSettingsDir,
      snapshotDir: paths.statuslineSnapshotDir,
      scriptPath: join(serverDir, 'statusline.mjs'),
      prefsFile: paths.prefsFile,
      nodePath: process.execPath,
    },
    log,
  );
  /**
   * Wipe what no session may inherit across a run. Deferred to `go` in a standby:
   * `session-settings/` holds the `--settings` files of the PARENT's live claude
   * sessions, and the statusline cache is written by those very sessions.
   */
  function resetSessionArtifacts(): void {
    sessionSettings.resetDir();
    // Same reasoning for the status line's git-branch cache (written by the
    // script, keyed by claude session id): those sessions are gone, so every
    // entry is stale — and a leftover written by anything else must not outlive
    // a restart.
    try {
      unlinkSync(paths.statuslineCacheFile);
    } catch {
      // Absent (the normal case) or unremovable — the script tolerates either.
    }
  }
  /**
   * IN-APP UPDATE (phase E): drop `<dataDir>/updates` — a `.part` from a killed
   * download, or a Setup.exe from a release nobody ran, must never be reused.
   * The only file this app ever executes is one it verified in the CURRENT run.
   * Deferred to `go` in a standby, like every other data-dir mutation.
   */
  function resetUpdateArtifacts(): void {
    cleanupUpdatesDir(paths.updatesDir, log);
  }
  if (!standbyWaiting) {
    resetSessionArtifacts();
    resetUpdateArtifacts();
  }
  /**
   * Stored API keys (Nocturne B5). Constructed beside prefs/github and handed to
   * BOTH consumers: the SessionManager, which sets a saved key as that tool's
   * variable in the child environment at spawn, and the API, which only ever
   * reports saved/not-saved. The value never appears in server.log or a response.
   */
  const keys = new KeyStore(paths.keysFile, log);
  /**
   * The subagents Claude Code ran for a session (Nocturne B7), polled out of its
   * own transcripts under paths.claudeProjectsDir — which is also the boundary
   * every transcript path from a snapshot is checked against (server/agents.ts).
   *
   * Constructed BEFORE the SessionManager because the manager holds it: a
   * session that exits or is deleted must stop being polled, and the manager is
   * the only place that knows when that happened. C2: it reads each session's
   * title stamp (titleIdleSince) at poll time only, once `sessions` exists.
   */
  const titleIdleSince = (id: string): number | undefined => sessions.titleIdleSince(id);
  const agents = new AgentsWatcher(log, { projectsRoot: paths.claudeProjectsDir, titleIdleSince });
  const sessions = new SessionManager(log, history, sessionSettings, keys, agents);
  /**
   * The status-line snapshots the script writes for each claude session, back
   * into SessionInfo.telemetry (and from there to every attached client as the
   * existing `info` message) — the pane status bar's data source, B1.
   *
   * Started in index.ts's beginListening(), NOT here: in a standby child the
   * wipe of the directory is deferred to `go`, and watching a directory that is
   * about to be removed and recreated would watch the wrong inode.
   */
  const telemetry = new TelemetryWatcher(paths.statuslineSnapshotDir, log);
  // GitHub connection. The OAuth client_id comes from env; absent/empty disables
  // only the DEVICE FLOW (status.deviceFlowAvailable=false, POST /api/github/device
  // answers a clean not-available signal). The PASTED-TOKEN path and every
  // connected operation keep working without it — that is the whole point of the
  // second credential path (2026-07-25).
  // AI_SM_GITHUB_API_BASE re-points the REST API for offline tests — loopback
  // only; a non-loopback value throws here and the server refuses to start
  // (before listen, so no runtime.json is ever written).
  let githubApiBase: string;
  try {
    githubApiBase = resolveGithubApiBase();
  } catch (err) {
    // The reason must reach server.log: in production this process is started as
    // `setsid --fork nohup node server/index.ts </dev/null >/dev/null 2>&1`
    // (launcher/start-backend.sh), so stderr goes to /dev/null and the user would
    // otherwise see only the launcher's "did not become healthy" timeout. The
    // message never carries a credential (the embedded-credential branch of
    // assertLoopbackApiBase refuses without echoing the value).
    log('error', `refusing to start: ${err instanceof Error ? err.message : String(err)}`);
    throw err; // unchanged otherwise: uncaught at module eval -> stderr + exit 1.
  }
  if (githubApiBase !== DEFAULT_GITHUB_API_BASE) {
    log('warn', `github REST api base overridden via AI_SM_GITHUB_API_BASE: ${githubApiBase}`);
  }
  const github = new GithubConnection({
    file: paths.githubFile,
    log,
    clientId: process.env['AI_SM_GITHUB_CLIENT_ID'],
    apiBase: githubApiBase,
  });
  return {
    projects,
    prefs,
    history,
    keys,
    agents,
    sessions,
    telemetry,
    github,
    resetSessionArtifacts,
    resetUpdateArtifacts,
  };
}
