/**
 * Prefs store: prefs.json in the data dir — an OPAQUE preferences bag the
 * server never interprets. Any JSON object PUT by the client is stored
 * verbatim (validation of shape/size happens in api.ts before it reaches
 * this store), so a future settings panel can add keys without a
 * server-side schema change. Loaded on startup, saved atomically (mode
 * 0600) on every PUT. Missing/corrupt file -> empty object, never a crash
 * (same tolerance as ProjectStore for projects.json).
 */
import { readFileSync } from 'node:fs';
import type { UiPrefs } from '../shared/protocol.ts';
import { atomicWriteFile, errorStackOnly, scoped, type Logger } from './config.ts';

export class PrefsStore {
  #prefs: UiPrefs = {};
  readonly #file: string;
  readonly #log: Logger;
  #flog: Logger = () => undefined;

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
    let raw: string;
    try {
      raw = readFileSync(this.#file, 'utf8');
    } catch {
      this.#flog('debug', `no ${this.#file} yet — starting with an empty prefs bag`);
      return; // No prefs.json yet — start empty.
    }
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
    atomicWriteFile(this.#file, JSON.stringify(this.#prefs, null, 2) + '\n');
    this.#flog('debug', `saved ${Object.keys(this.#prefs).length} pref keys to ${this.#file}`);
  }
}
