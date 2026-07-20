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
import { atomicWriteFile, type Logger } from './config.ts';

export class PrefsStore {
  #prefs: UiPrefs = {};
  readonly #file: string;
  readonly #log: Logger;

  constructor(file: string, log: Logger) {
    this.#file = file;
    this.#log = log;
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
      return; // No prefs.json yet — start empty.
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('prefs.json is not an object');
      }
      this.#prefs = parsed as UiPrefs;
    } catch (err) {
      this.#log('error', `failed to parse ${this.#file}, starting empty: ${String(err)}`);
      this.#prefs = {};
    }
  }

  #save(): void {
    atomicWriteFile(this.#file, JSON.stringify(this.#prefs, null, 2) + '\n');
  }
}
