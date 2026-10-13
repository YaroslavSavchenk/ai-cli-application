/**
 * Project store: projects.json in the data dir, loaded on startup and saved
 * atomically (mode 0600) on every mutation. A project's path must be an
 * absolute path to an existing directory.
 *
 * `update` (Nocturne D1, `.claude/plans/nocturne/PLAN-D1.md`) edits a project's
 * name and launch preferences in place; the path is never editable.
 */
import { statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type {
  ClaudePermissionMode,
  PermissionMode,
  Project,
  ProjectEffort,
  UpdateProjectRequest,
} from '../shared/protocol.ts';
import {
  atomicWriteFile,
  errorStackOnly,
  readSmallRegularFile,
  scoped,
  setAsideRefused,
  type Logger,
} from './config.ts';

/**
 * Read cap for projects.json (Q8). A project the writer stores is a few
 * hundred bytes (name, path, three preferences); the list has no count limit,
 * only each POST body's 1 MiB (MAX_BODY_BYTES, server/api-http.ts). 16 MiB is
 * ~50 000 ordinary projects. A bigger file is not ours.
 */
const PROJECTS_FILE_MAX_BYTES = 16 * 1024 * 1024;

/** True when `p` is an absolute path to an existing directory. */
export function isExistingDirectory(p: string): boolean {
  if (!isAbsolute(p)) return false;
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export interface CreateProjectInput {
  name: string;
  path: string;
  defaultModel?: string;
  defaultMode?: PermissionMode;
  defaultPerm?: ClaudePermissionMode;
  defaultEffort?: ProjectEffort;
}

type PrefKey = 'defaultModel' | 'defaultPerm' | 'defaultEffort';

/** Set (a value) or delete (null) one preference; false when the patch leaves it out. */
function applyPref<K extends PrefKey>(project: Project, key: K, value: Project[K] | null | undefined): boolean {
  if (value === undefined) return false;
  if (value === null) delete project[key];
  else project[key] = value;
  return true;
}

export class ProjectStore {
  #projects: Project[] = [];
  readonly #file: string;
  readonly #log: Logger;
  #plog: Logger = () => undefined;
  /** The load refused the file: set it aside before the first write (config.ts setAsideRefused). */
  #refusedAtLoad = false;

  constructor(file: string, log: Logger) {
    this.#file = file;
    this.#log = log;
    this.#plog = scoped(log, 'projects');
    this.#load();
  }

  list(): Project[] {
    return this.#projects.map((p) => ({ ...p }));
  }

  get(id: string): Project | undefined {
    const p = this.#projects.find((x) => x.id === id);
    return p === undefined ? undefined : { ...p };
  }

  /** Caller must have validated that input.path is an existing directory. */
  create(input: CreateProjectInput): Project {
    const project: Project = {
      id: randomUUID(),
      name: input.name,
      path: input.path,
      ...(input.defaultModel !== undefined ? { defaultModel: input.defaultModel } : {}),
      ...(input.defaultMode !== undefined ? { defaultMode: input.defaultMode } : {}),
      ...(input.defaultPerm !== undefined ? { defaultPerm: input.defaultPerm } : {}),
      ...(input.defaultEffort !== undefined ? { defaultEffort: input.defaultEffort } : {}),
      createdAt: new Date().toISOString(),
    };
    this.#projects.push(project);
    this.#plog('info', `created project ${project.id} at ${project.path}`);
    this.#save();
    return { ...project };
  }

  /**
   * Apply a validated patch: an absent field stays, `null` deletes that key.
   * Writing or clearing `defaultPerm` also deletes the legacy `defaultMode` —
   * otherwise a cleared preference would fall back to the old two-value mode.
   * Logs the changed field NAMES only: a name is user text. Undefined = no such
   * project. A patch that changes nothing is not written.
   */
  update(id: string, patch: UpdateProjectRequest): Project | undefined {
    const index = this.#projects.findIndex((p) => p.id === id);
    const current = this.#projects[index];
    if (current === undefined) {
      this.#plog('debug', `update ${id}: no such project`);
      return undefined;
    }
    const next: Project = { ...current };
    const changed: string[] = [];
    if (patch.name !== undefined) {
      next.name = patch.name;
      changed.push('name');
    }
    if (applyPref(next, 'defaultModel', patch.defaultModel)) changed.push('defaultModel');
    if (applyPref(next, 'defaultPerm', patch.defaultPerm)) {
      changed.push('defaultPerm');
      if (next.defaultMode !== undefined) {
        delete next.defaultMode;
        changed.push('defaultMode');
      }
    }
    if (applyPref(next, 'defaultEffort', patch.defaultEffort)) changed.push('defaultEffort');
    if (changed.length === 0) return { ...current };
    this.#projects[index] = next;
    this.#plog('info', `updated project ${id}: ${changed.join(', ')}`);
    this.#save();
    return { ...next };
  }

  remove(id: string): boolean {
    const before = this.#projects.length;
    this.#projects = this.#projects.filter((p) => p.id !== id);
    if (this.#projects.length === before) {
      this.#plog('debug', `remove ${id}: no such project`);
      return false;
    }
    this.#plog('info', `removed project ${id}; ${this.#projects.length} remain`);
    this.#save();
    return true;
  }

  #load(): void {
    // The judged open (memory/knowledge/fifo-open-blocks-main-thread.md): a
    // FIFO planted here would hang the boot, a link would be followed.
    const read = readSmallRegularFile(this.#file, PROJECTS_FILE_MAX_BYTES);
    if (read.kind === 'missing') {
      this.#plog('debug', `no ${this.#file} yet — starting with 0 projects`);
      return; // No projects.json yet — start empty.
    }
    if (read.kind === 'unreadable') {
      this.#refusedAtLoad = true;
      this.#log('warn', `${this.#file} refused: ${read.reason} — starting with 0 projects, set aside at the first save`);
      return;
    }
    const raw = read.text;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('projects.json is not an array');
      this.#projects = parsed as Project[];
      this.#plog('debug', `loaded ${this.#projects.length} projects from ${this.#file}`);
    } catch (err) {
      // errorStackOnly, NOT describeError: this file is written from a request
      // BODY, and Node's JSON.parse SyntaxError quotes ~10 characters of what it
      // parsed — which would put that body fragment in server.log.
      this.#log('error', `failed to parse ${this.#file}, starting empty: ${errorStackOnly(err)}`);
      this.#projects = [];
    }
  }

  #save(): void {
    if (this.#refusedAtLoad) {
      this.#refusedAtLoad = false;
      setAsideRefused(this.#file, this.#log);
    }
    atomicWriteFile(this.#file, JSON.stringify(this.#projects, null, 2) + '\n');
    this.#plog('debug', `saved ${this.#projects.length} projects to ${this.#file}`);
  }
}
