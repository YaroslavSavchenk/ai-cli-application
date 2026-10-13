/**
 * The boot banner: the first lines of every run, answering "which code is
 * this?" — node and pid, data dir, log level, every AI_SM_* override in
 * effect (redacted where it could carry a secret), the install or clone
 * identity, a restart handoff's origin, and the frontend bundle.
 *
 * Split from server/index.ts (Quality Q5, 2026-10-13): a pure move, every
 * line's text and order unchanged. index.ts calls logBootBanner() at the
 * exact point the statements stood and logWebBuild() where it did (at module
 * load, or at a standby's `go`). Siblings: server/index-stores.ts,
 * server/index-update.ts, server/index-restart.ts.
 */
import { join } from 'node:path';
import { oneLine, MAX_LOG_BYTES, type Logger, type ResolvedLogLevel } from './config.ts';
import { mtimeOf, type WebBuildInfo } from './buildinfo.ts';
import type { BundleInfo } from './bundle.ts';

// ---------------------------------------------------------------------------
// Motivated by a real incident (2026-09-06): a freshly built UI talking to a
// backend started before the feature existed showed an empty HISTORY section,
// and the log gave the user nothing to go on. NO SECRET goes in here:
// token-shaped env values are redacted by name and the auth token is never
// printed at all.
// ---------------------------------------------------------------------------
/** Env names whose VALUE is never logged, whatever else they are. */
const SECRETISH_ENV = /TOKEN|SECRET|PASSWORD|PASSWD|KEY|CRED|AUTH/i;
/**
 * A URL with USERINFO (`scheme://user:password@host`). Measured, not
 * hypothetical: AI_SM_GITHUB_API_BASE is a URL and the server's own refusal
 * path deliberately declines to echo it for exactly this reason
 * (assertLoopbackApiBase). The banner must not undo that.
 */
const URL_WITH_USERINFO = /\/\/[^/\s@]*:[^/\s@]*@/;

/** The value as it may be logged: redacted whenever it could carry a secret. */
function envValueForLog(name: string, raw: string): string {
  if (SECRETISH_ENV.test(name)) return '<redacted by name>';
  if (URL_WITH_USERINFO.test(raw)) return '<redacted: embeds credentials>';
  return JSON.stringify(oneLine(raw));
}

/** What the banner reads from the boot in server/index.ts. */
interface BannerFacts {
  dataDir: string;
  logLevel: ResolvedLogLevel;
  bundle: BundleInfo | null;
  /** Collected by readBundleInfo before the logger was scoped for the banner. */
  bundleWarnings: readonly string[];
  serverCommit: string | null;
  repoRoot: string;
  serverDir: string;
  /** AI_SM_RESTARTED_FROM as read by index.ts (which also names the standby's parent). */
  restartedFrom: string | undefined;
}

/** Every banner line up to (not including) the frontend identity line. */
export function logBootBanner(boot: Logger, facts: BannerFacts): void {
  const { logLevel, bundle, restartedFrom } = facts;
  boot('info', `ai-cli-application backend starting (node ${process.version}, pid ${process.pid})`);
  boot('info', `data dir ${facts.dataDir}`);
  boot(
    'info',
    `log level ${logLevel.level} (AI_SM_LOG_LEVEL ${
      logLevel.raw === undefined ? 'unset, default' : `= ${JSON.stringify(oneLine(logLevel.raw))}`
    }${logLevel.valid ? '' : ' — unrecognized, using the default'}), rotation at ${MAX_LOG_BYTES} bytes, 2 kept generations`,
  );
  // SET means non-empty: every consumer in this codebase (resolveDataPaths,
  // resolveGithubApiBase, envMs) treats '' as unset, so an empty value is not an
  // override and must not be reported as one.
  for (const name of Object.keys(process.env).filter((n) => n.startsWith('AI_SM_')).sort()) {
    const raw = process.env[name] ?? '';
    if (raw === '') continue;
    boot('info', `env ${name}=${envValueForLog(name, raw)}`);
  }
  // Which code is this? An install answers with its bundle marker (there is no
  // .git in a packaged tree, so the commit line would always read "unknown"), a
  // clone with the checked-out commit. Every field of the marker is charset-gated
  // in server/bundle.ts — this line prints untrusted disk content otherwise.
  if (bundle !== null) {
    boot(
      'info',
      `installed build ${bundle.version} (commit ${bundle.commit ?? 'unknown'}, ` +
        `node ${bundle.nodeVersion}, built ${oneLine(bundle.builtAt)}, app dir ${oneLine(facts.repoRoot)})`,
    );
  } else {
    // An unreadable (not absent) bundle.json makes the line below a possible
    // LIE: this may be an INSTALL running as a clone for the rest of its life.
    for (const line of facts.bundleWarnings) boot('warn', line);
    boot(
      'info',
      `server code ${facts.serverCommit ?? 'commit unknown'} (server/index.ts mtime ${
        mtimeOf(join(facts.serverDir, 'index.ts')) ?? 'unknown'
      })`,
    );
  }
  // A restart handoff (POST /api/restart) says so in one line, so the log reads
  // as one continuous story across the two processes.
  // The value is our OWN env, but a log line is a text record: an unvalidated
  // string could carry anything a future caller puts there, so only a plain pid
  // is printed and everything else is named as invalid.
  if (restartedFrom !== undefined && restartedFrom !== '') {
    boot(
      'info',
      /^\d{1,10}$/.test(restartedFrom)
        ? `restarted from pid ${restartedFrom}`
        : `restarted from pid <invalid> (${JSON.stringify(oneLine(restartedFrom))})`,
    );
  }
}

/**
 * The frontend identity line. In a standby child it is printed at `go`, not
 * at module load: the parent's preflight swaps a freshly built web/dist into
 * place while that process waits, so anything read at module load names the
 * OLD bundle.
 */
export function logWebBuild(boot: Logger, webBuild: WebBuildInfo): void {
  boot(
    'info',
    webBuild.indexMtime === null
      ? 'web build: web/dist missing — the UI will not be served'
      : `web build ${webBuild.asset ?? 'no assets/index-*.js'} (build id ${
          webBuild.buildId ?? 'unknown'
        }, web/dist/index.html mtime ${webBuild.indexMtime})`,
  );
}
