/**
 * Data directory resolution and file logging.
 *
 * Data dir: ~/.ai-session-manager/ (created 0700), overridable via the
 * AI_SM_DATA_DIR env var (must be an absolute path). Holds runtime.json,
 * projects.json and server.log.
 *
 * The process runs detached — nothing may depend on stdout. All logging
 * appends to server.log in the data dir.
 */
import { mkdirSync, appendFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface DataPaths {
  dataDir: string;
  runtimeFile: string;
  projectsFile: string;
  logFile: string;
}

/** Resolve (and create, mode 0700) the data dir. Throws on a relative AI_SM_DATA_DIR. */
export function resolveDataPaths(): DataPaths {
  const override = process.env['AI_SM_DATA_DIR'];
  let dataDir: string;
  if (override !== undefined && override !== '') {
    if (!isAbsolute(override)) {
      throw new Error(`AI_SM_DATA_DIR must be an absolute path, got: ${override}`);
    }
    dataDir = override;
  } else {
    dataDir = join(homedir(), '.ai-session-manager');
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return {
    dataDir,
    runtimeFile: join(dataDir, 'runtime.json'),
    projectsFile: join(dataDir, 'projects.json'),
    logFile: join(dataDir, 'server.log'),
  };
}

export type Logger = (level: 'info' | 'warn' | 'error', message: string) => void;

/** Cap on server.log before rotation to server.log.1 (total on disk <= 2x this). */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;

/**
 * Appends timestamped lines to server.log. Never throws (a detached process has
 * nowhere to report). When the file exceeds MAX_LOG_BYTES it is rotated to
 * server.log.1 (replacing any previous one), bounding total log disk usage.
 */
export function createLogger(logFile: string): Logger {
  let bytes: number;
  try {
    bytes = statSync(logFile).size;
  } catch {
    bytes = 0;
  }
  return (level, message) => {
    try {
      const line = `${new Date().toISOString()} [${level}] ${message}\n`;
      if (bytes + Buffer.byteLength(line) > MAX_LOG_BYTES) {
        renameSync(logFile, `${logFile}.1`);
        bytes = 0;
      }
      appendFileSync(logFile, line, { mode: 0o600 });
      bytes += Buffer.byteLength(line);
    } catch {
      // Nothing sane to do — stdout must not be relied on.
    }
  };
}

/**
 * Atomically write a file with mode 0600: write to a unique temp file in the
 * same directory, then rename over the destination.
 */
export function atomicWriteFile(filePath: string, contents: string): void {
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmpPath, contents, { mode: 0o600 });
  renameSync(tmpPath, filePath);
}
