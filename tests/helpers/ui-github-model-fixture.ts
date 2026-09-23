/**
 * Shared fixtures for `tests/ui/ui-github-model*.test.ts`: a FIXED `now`
 * (every clock-dependent format in `web/src/ui/github-model.ts` takes the
 * instant as a parameter), the time units, ISO stamps before/after it, and a
 * repo and a project builder. Not a test. NO TOKEN appears here: GithubStatus
 * carries none by protocol design.
 */
import type { GithubRepo, Project } from '../../shared/protocol.ts';

export const NOW = Date.parse('2026-07-24T12:00:00.000Z');
export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** ISO timestamp `ms` milliseconds BEFORE NOW (i.e. in the past). */
export function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

/** ISO timestamp `ms` milliseconds AFTER NOW (i.e. in the future). */
export function ahead(ms: number): string {
  return new Date(NOW + ms).toISOString();
}

export function repo(over: Partial<GithubRepo> = {}): GithubRepo {
  return {
    fullName: 'sava/ai-cli-application',
    name: 'ai-cli-application',
    owner: 'sava',
    private: true,
    cloneUrl: 'https://github.com/sava/ai-cli-application.git',
    ...over,
  };
}

export function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'ai-cli-application',
    path: '/home/you/projects/ai-cli-application',
    createdAt: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}
