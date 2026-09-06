/**
 * Project store: projects.json in the data dir, loaded on startup and saved
 * atomically (mode 0600) on every mutation. A project's path must be an
 * absolute path to an existing directory.
 */
import { readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { Project, PermissionMode } from '../shared/protocol.ts';
import { atomicWriteFile, errorStackOnly, scoped, type Logger } from './config.ts';

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
}

export class ProjectStore {
  #projects: Project[] = [];
  readonly #file: string;
  readonly #log: Logger;
  #plog: Logger = () => undefined;

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
      createdAt: new Date().toISOString(),
    };
    this.#projects.push(project);
    this.#plog('info', `created project ${project.id} at ${project.path}`);
    this.#save();
    return { ...project };
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
    let raw: string;
    try {
      raw = readFileSync(this.#file, 'utf8');
    } catch {
      this.#plog('debug', `no ${this.#file} yet — starting with 0 projects`);
      return; // No projects.json yet — start empty.
    }
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
    atomicWriteFile(this.#file, JSON.stringify(this.#projects, null, 2) + '\n');
    this.#plog('debug', `saved ${this.#projects.length} projects to ${this.#file}`);
  }
}
