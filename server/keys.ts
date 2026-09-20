/**
 * Stored API keys for the tools that read one from their environment
 * (Nocturne B5, decision 2026-09-18 in `.claude/PLAN-B5.md`): Claude Code ->
 * ANTHROPIC_API_KEY, Gemini CLI -> GEMINI_API_KEY, Grok -> XAI_API_KEY. Codex
 * has no key: a key alone does not sign it in, it signs in inside the terminal.
 *
 * WHERE THE VALUE MAY GO, and nowhere else:
 *   - `<dataDir>/keys.json`, written atomically with mode 0600 (atomicWriteFile,
 *     the same store shape as prefs.ts and the GitHub token);
 *   - the child ENVIRONMENT of a session spawned for exactly that tool
 *     (server/sessions.ts, by `basename(command)`), never its argv.
 *
 * WHERE IT NEVER GOES: server.log (not the value, not a fragment, not a masked
 * form, not a length), any HTTP response (GET /api/keys answers saved/not saved
 * only), any error message. The log lines this file writes are the three
 * constant sentences `key saved for <tool>` / `key cleared for <tool>` /
 * `key rejected for <tool>` — a tool name out of a closed three-element set.
 *
 * STORAGE CEILING, stated honestly: 0600 is file-permission hygiene, not
 * encryption. Anything running as this user can read keys.json, and from
 * Windows the file is reachable through \\wsl.localhost. The control that
 * matters is "the value is never written anywhere else".
 *
 * LOAD IS GATED. A keys.json that is not a plain object — or whose entries are
 * not `<keyed tool>: <key-shaped string>` — yields an EMPTY store (or drops the
 * offending entries) plus one warn line naming the reason CLASS. Nothing
 * derived from the file's bytes is ever logged: a JSON.parse error quotes ~10
 * characters of its input, which here would be a key.
 */
import { readFileSync } from 'node:fs';
import {
  isKeyedTool,
  KEYED_TOOLS,
  KEY_ENV,
  type KeyedTool,
  type KeyStatus,
} from '../shared/protocol.ts';
import { atomicWriteFile, scoped, type Logger } from './config.ts';

/** Upper bound on a stored key. No real key of these vendors comes near it. */
export const KEY_MAX_CHARS = 4096;

/** The two constant refusal sentences of PUT/DELETE /api/keys/:tool. */
export const KEY_NOT_SHAPED = 'That does not look like an API key.';
export const KEY_UNKNOWN_TOOL = 'Unknown tool.';

/**
 * Printable ASCII, no spaces, no control characters. Every key these three
 * CLIs issue is of that shape, and the value becomes an ENVIRONMENT VARIABLE:
 * a newline or a NUL in one is never a legitimate key and is exactly what a
 * pasted-from-anywhere value would carry.
 */
const KEY_SHAPE = /^[\x21-\x7e]+$/;

/**
 * The key `value` would be stored as (surrounding whitespace removed), or
 * undefined when it is not key-shaped. The trim is deliberate: a trailing
 * newline from a copy-paste is the single most common way a good key arrives
 * looking bad.
 */
export function normalizeKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Bound the work before trimming: a body cap already applies at the route,
  // and no legitimate key is anywhere near this long.
  if (value.length > KEY_MAX_CHARS * 2) return undefined;
  const key = value.trim();
  if (key.length < 1 || key.length > KEY_MAX_CHARS) return undefined;
  return KEY_SHAPE.test(key) ? key : undefined;
}

/** True when `value` is an acceptable API key (see normalizeKey). */
export function isKeyShaped(value: unknown): value is string {
  return normalizeKey(value) !== undefined;
}

/** Why a loaded keys.json was (partly) discarded. The CLASS, never the content. */
type LoadRefusal = 'not valid JSON' | 'not an object';

export class KeyStore {
  #keys = new Map<KeyedTool, string>();
  readonly #file: string;
  readonly #log: Logger;
  readonly #klog: Logger;

  constructor(file: string, log: Logger) {
    this.#file = file;
    this.#log = log;
    this.#klog = scoped(log, 'keys');
    this.#load();
  }

  /**
   * What the browser is allowed to know: which tools have a stored key, and
   * which ones the backend's own environment already carries a variable for
   * (set outside the app — a saved key wins over it at spawn time).
   */
  status(env: Record<string, string | undefined>): KeyStatus {
    const saved = {} as Record<KeyedTool, boolean>;
    const inEnv = {} as Record<KeyedTool, boolean>;
    for (const tool of KEYED_TOOLS) {
      saved[tool] = this.#keys.has(tool);
      const value = env[KEY_ENV[tool]];
      inEnv[tool] = typeof value === 'string' && value !== '';
    }
    return { saved, env: inEnv };
  }

  /** The stored key for `tool`, or undefined. Only server/sessions.ts calls this. */
  get(tool: KeyedTool): string | undefined {
    return this.#keys.get(tool);
  }

  /**
   * Store a key. Returns false when the value is not key-shaped — the caller
   * answers KEY_NOT_SHAPED; nothing is written and nothing but the tool name
   * is logged.
   */
  save(tool: KeyedTool, value: unknown): boolean {
    const key = normalizeKey(value);
    if (key === undefined) {
      this.#log('warn', `key rejected for ${tool}`);
      return false;
    }
    this.#keys.set(tool, key);
    this.#save();
    this.#log('info', `key saved for ${tool}`);
    return true;
  }

  /** Forget the key for `tool` (no-op when there is none). */
  clear(tool: KeyedTool): void {
    this.#keys.delete(tool);
    this.#save();
    this.#log('info', `key cleared for ${tool}`);
  }

  #load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.#file, 'utf8');
    } catch {
      this.#klog('debug', `no ${this.#file} yet — no API keys stored`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      // The error object is NEVER touched: Node's SyntaxError quotes a fragment
      // of what it parsed, and what it parsed is a file full of API keys.
      this.#refuse('not valid JSON');
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.#refuse('not an object');
      return;
    }
    let dropped = 0;
    for (const [tool, value] of Object.entries(parsed as Record<string, unknown>)) {
      const key = normalizeKey(value);
      if (!isKeyedTool(tool) || key === undefined) {
        dropped += 1;
        continue;
      }
      this.#keys.set(tool, key);
    }
    if (dropped > 0) {
      this.#log(
        'warn',
        `${this.#file}: dropped ${dropped} entr${dropped === 1 ? 'y' : 'ies'} ` +
          'that is not a known tool with a key-shaped value',
      );
    }
    // COUNT and TOOL NAMES only — a name is one of three constants.
    this.#klog(
      'debug',
      `loaded ${this.#keys.size} stored key(s) from ${this.#file}` +
        (this.#keys.size > 0 ? ` (${[...this.#keys.keys()].join(', ')})` : ''),
    );
  }

  #refuse(reason: LoadRefusal): void {
    this.#keys.clear();
    this.#log('warn', `${this.#file} is ${reason} — starting with no stored keys`);
  }

  #save(): void {
    const out: Record<string, string> = {};
    for (const tool of KEYED_TOOLS) {
      const key = this.#keys.get(tool);
      if (key !== undefined) out[tool] = key;
    }
    // Mode 0600, temp file + rename: a reader never sees a half-written file,
    // and the value never exists at a world-readable mode even for an instant.
    atomicWriteFile(this.#file, JSON.stringify(out, null, 2) + '\n');
    this.#klog('debug', `saved ${Object.keys(out).length} key(s) to ${this.#file}`);
  }
}
