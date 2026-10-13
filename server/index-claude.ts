/**
 * The Claude Code version wiring (Nocturne D6, `.claude/plans/nocturne/PLAN-D6.md`):
 * the dev-only AI_SM_CLAUDE_VERSION_OVERRIDE (refused in the installed app),
 * the ClaudeVersionWatch that GET /api/runtime reads, and the GET /api/tools
 * probe whose every real run tells the watch to check the binary again.
 *
 * Called by server/index.ts at module load, BEFORE createStores (the
 * SessionManager reads the version for its early-exit log line). It spawns
 * nothing: index.ts calls `claude.start()` from the `listening` handler, so
 * the probe never delays boot. Siblings: server/index-banner.ts,
 * server/index-stores.ts, server/index-update.ts, server/index-restart.ts.
 */
import type { ToolAvailability } from '../shared/protocol.ts';
import { scoped, type Logger } from './config.ts';
import { ptyEnv } from './sessions-env.ts';
import { cachedProbe } from './tools.ts';
import { ClaudeVersionWatch, resolveClaudeVersionOverride } from './claude-version.ts';

interface ClaudeWiringInput {
  log: Logger;
  /** True for an installed bundle: the override is then refused. */
  installed: boolean;
}

interface ClaudeWiring {
  claude: ClaudeVersionWatch;
  /** GET /api/tools (ApiDeps.tools). */
  tools: () => Promise<ToolAvailability>;
}

export function createClaudeWiring({ log, installed }: ClaudeWiringInput): ClaudeWiring {
  const claudeLog = scoped(log, 'claude');
  const override = resolveClaudeVersionOverride(
    process.env['AI_SM_CLAUDE_VERSION_OVERRIDE'],
    installed,
    claudeLog,
  );
  const claude = new ClaudeVersionWatch({ env: ptyEnv, log: claudeLog, override });
  const tools = cachedProbe({ env: ptyEnv, onProbe: () => void claude.binaryChanged() });
  return { claude, tools };
}
