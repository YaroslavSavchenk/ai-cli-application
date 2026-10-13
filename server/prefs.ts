/**
 * Prefs store: prefs.json in the data dir — an OPAQUE preferences bag the
 * server never interprets. Any JSON object PUT by the client is stored
 * verbatim (validation of shape/size happens in api.ts before it reaches
 * this store), so a future settings panel can add keys without a
 * server-side schema change. Loaded on startup, saved atomically (mode
 * 0600) on every PUT. Missing/corrupt file -> empty object, never a crash
 * (same tolerance as ProjectStore for projects.json).
 */
import type { UiPrefs } from '../shared/protocol.ts';
import {
  atomicWriteFile,
  errorStackOnly,
  readSmallRegularFile,
  scoped,
  setAsideRefused,
  type Logger,
} from './config.ts';

/**
 * Read cap for prefs.json (Q8). The writer stores a PUT body of at most
 * PREFS_MAX_BYTES (64 KiB, server/api-app.ts) re-indented by two spaces per
 * level; real prefs are a few hundred bytes. 4 MiB is 64x the body cap — room
 * for that re-indent at any sane nesting. A bigger file is not ours.
 */
const PREFS_FILE_MAX_BYTES = 4 * 1024 * 1024;

export class PrefsStore {
  #prefs: UiPrefs = {};
  readonly #file: string;
  readonly #log: Logger;
  #flog: Logger = () => undefined;
  /** The load refused the file: set it aside before the first write (config.ts setAsideRefused). */
  #refusedAtLoad = false;

  constructor(file: string, log: Logger) {
    this.#file = file;
    this.#log = log;
    this.#flog = scoped(log, 'prefs');
    this.#load();
  }

  get(): UiPrefs {
    return { ...this.#prefs };
  }

  /** Caller must have validated `prefs` is a plain JSON object within the size cap. */
  replace(prefs: UiPrefs): void {
    this.#prefs = { ...prefs };
    this.#save();
  }

  #load(): void {
    // The judged open (memory/knowledge/fifo-open-blocks-main-thread.md): a
    // FIFO planted here would hang the boot, a link would be followed.
    const read = readSmallRegularFile(this.#file, PREFS_FILE_MAX_BYTES);
    if (read.kind === 'missing') {
      this.#flog('debug', `no ${this.#file} yet — starting with an empty prefs bag`);
      return; // No prefs.json yet — start empty.
    }
    if (read.kind === 'unreadable') {
      this.#refusedAtLoad = true;
      this.#log('warn', `${this.#file} refused: ${read.reason} — starting with an empty prefs bag, set aside at the first save`);
      return;
    }
    const raw = read.text;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('prefs.json is not an object');
      }
      this.#prefs = parsed as UiPrefs;
      // KEYS ONLY, never values: prefs is an opaque bag the server does not
      // interpret, so its contents are not ours to write into the log.
      this.#flog('debug', `loaded ${Object.keys(this.#prefs).length} pref keys from ${this.#file}`);
    } catch (err) {
      // errorStackOnly, NOT describeError: this file is written from a request
      // BODY, and Node's JSON.parse SyntaxError quotes ~10 characters of what it
      // parsed — which would put that body fragment in server.log.
      this.#log('error', `failed to parse ${this.#file}, starting empty: ${errorStackOnly(err)}`);
      this.#prefs = {};
    }
  }

  #save(): void {
    if (this.#refusedAtLoad) {
      this.#refusedAtLoad = false;
      setAsideRefused(this.#file, this.#log);
    }
    atomicWriteFile(this.#file, JSON.stringify(this.#prefs, null, 2) + '\n');
    this.#flog('debug', `saved ${Object.keys(this.#prefs).length} pref keys to ${this.#file}`);
  }
}
