/**
 * The copy itself (Nocturne part B10 phase 2, `.claude/PLAN-B10.md` §3) — the
 * runner that turns one walked drop and one conflict answer into real writes,
 * and into the rows the dialog paints while they happen.
 *
 * It is the ONLY place in the app that uploads a file, and it decides nothing
 * about WHAT to write: `ui/drop-model.ts` planned that (`planTargets`,
 * `uploadMode`) and the dialog is showing that very plan. This module walks
 * the plan in the dropped order and reports what became of each row.
 *
 * The four promises it makes, all of them load-bearing:
 *
 * - SEQUENTIAL, in the dropped order, one file at a time. The rows then settle
 *   in the order the list draws them and `N of M` is honest; a pool of three
 *   would buy round-trip time on a keep-alive loopback socket and cost the
 *   list its meaning.
 * - WHAT COPIED STAYS. Nothing is rolled back, ever — a half-copied tree
 *   cannot be undone honestly, and deleting files the user can see would be a
 *   far worse surprise than a folder that says `3 of 12 files failed` (D4).
 * - A ROW IS A DROPPED THING. A folder stays ONE row whatever happens inside
 *   it; twelve rows for one dragged name would bury what was dropped.
 * - AN ITEM PLANNED `failed` IS NEVER SENT. A file over the per-file limit
 *   fails client-side (D3's refinement), so the app never spends 50 MiB
 *   learning what the server already told it.
 *
 * NO DOM, NO `fetch`. The transport is injected (`UploadGateway`), so the
 * whole runner is driven under `node --test` against a fake that records what
 * it was asked to write.
 */
import type { FsUploadMode } from '../../../shared/protocol.ts';
import { formatError, log } from '../log.ts';
import type { Destination } from './fs-model.ts';
import {
  failNote,
  partialNote,
  planResults,
  planTargets,
  uploadMode,
  type Choice,
  type DropItem,
  type ItemResult,
} from './drop-model.ts';
import type { WalkResult } from './drop-walk.ts';

/**
 * The two writes a drop needs. `put` is `PUT /api/fs/upload` (one raw body per
 * file); `folder` is the A9c create route, which is how a folder holding
 * nothing at all comes into existence.
 *
 * Both REJECT on refusal, with the server's status on `.status` when there was
 * one (`ApiError`) — that status is the whole vocabulary of `failNote`.
 */
export interface UploadGateway {
  put(dir: string, rel: string, mode: FsUploadMode, body: Blob): Promise<void>;
  /** One folder inside `dir`. A name already taken (409) is a success here. */
  folder(dir: string, name: string): Promise<void>;
}

/** What the dialog drives: the plan it draws, and the copy it then watches. */
export interface DropRun {
  /** The rows for this answer, pending — the same plan `start` executes. */
  plan(choice: Choice): ItemResult[];
  start(
    choice: Choice,
    on: {
      /** One row is done. The index is its place in `plan()`'s list. */
      settled(index: number, result: ItemResult): void;
      /**
       * `done` of `total` WRITES are over — files, plus the folders that hold
       * none, plus one unit for a row that is written at all. Counted in
       * files and not in rows on purpose: one dragged folder of 2000 files is
       * one row, and `0 of 1` standing still for two minutes says nothing
       * about a copy that is moving.
       */
      progress(done: number, total: number): void;
    },
  ): Promise<ItemResult[]>;
  /**
   * How many WRITES failed in the run that just finished — files, not rows, so
   * the one summary line the app logs per drop counts in the same unit its
   * other two numbers do.
   */
  failed(): number;
}

/** The status a rejection carries, or 0 when it was not an answer at all. */
function statusOf(err: unknown): number {
  const n = (err as { status?: unknown } | null)?.status;
  return typeof n === 'number' ? n : 0;
}

/** `/home/you` + `web` → `/home/you/web`. The one place a path is built. */
function join(dir: string, seg: string): string {
  return dir.endsWith('/') ? `${dir}${seg}` : `${dir}/${seg}`;
}

/**
 * One drop, ready to run. `dest` carries the PATH the writes go to; the dialog
 * never sees this object, which is how a path stays out of every label.
 */
export function createDropRun(args: {
  dest: Destination;
  items: DropItem[];
  listing: readonly string[];
  walk: WalkResult;
  gateway: UploadGateway;
}): DropRun {
  const { dest, items, listing, walk, gateway } = args;
  /** Failed WRITES of the last run — what the per-drop summary line counts. */
  let failedWrites = 0;

  /**
   * A hook is the CALLER's code (the dialog paints a row, scrolls it into
   * view): if it throws, that is the caller's bug and not a reason to abandon
   * a copy halfway with files already on disk. One line, and the copy goes on.
   */
  function safely(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      log.warn(`drop: the ${what} hook threw: ${formatError(err)}`);
    }
  }

  return {
    plan(choice: Choice): ItemResult[] {
      return planResults(items, listing, choice);
    },

    failed(): number {
      return failedWrites;
    },

    async start(choice, on): Promise<ItemResult[]> {
      const planned = planTargets(items, listing, choice);
      const results = planResults(items, listing, choice);
      failedWrites = 0;

      /** What one item costs in WRITES: its files and its empty folders. */
      const unitsOf = (index: number, plan: string): number => {
        if (plan !== 'upload') return 1; // a skipped row is still a step of the drop
        const n =
          walk.files.filter((f) => f.top === index).length +
          walk.folders.filter((f) => f.top === index).length;
        return n === 0 ? 1 : n;
      };
      const total = planned.reduce((sum, p, i) => sum + unitsOf(i, p.plan), 0);
      let done = 0;
      const step = (): void => {
        done += 1;
        safely('progress', () => on.progress(done, total));
      };

      for (let i = 0; i < planned.length; i += 1) {
        const p = planned[i] as (typeof planned)[number];
        const row = results[i] as ItemResult;

        // Skipped, and failed-before-anything (over the per-file limit): both
        // are already what the row says. Nothing is sent for either.
        if (p.plan !== 'upload') {
          safely('settled', () => on.settled(i, row));
          step();
          continue;
        }

        const mode: FsUploadMode = uploadMode(choice, p.conflict);
        const mine = walk.files.filter((f) => f.top === i);
        const empties = walk.folders.filter((f) => f.top === i);
        const units = mine.length + empties.length;
        let failed = 0;
        let last = 0;

        for (const f of mine) {
          const rel = f.rel === '' ? p.target : `${p.target}/${f.rel}`;
          try {
            await gateway.put(dest.path, rel, mode, f.file);
          } catch (err) {
            // Nothing is rolled back and nothing is abandoned: the next file of
            // this folder is still attempted, and the row counts what failed.
            failed += 1;
            last = statusOf(err);
          }
          step();
        }

        for (const f of empties) {
          const segs = f.rel === '' ? [p.target] : [p.target, ...f.rel.split('/')];
          let dir = dest.path;
          for (const seg of segs) {
            try {
              await gateway.folder(dir, seg);
            } catch (err) {
              const status = statusOf(err);
              // A name already taken is exactly what a folder that is already
              // there answers, and that is the outcome asked for.
              if (status !== 409) {
                failed += 1;
                last = status;
                break;
              }
            }
            dir = join(dir, seg);
          }
          step();
        }

        // Nothing to write at all: a file whose bytes the browser would not
        // hand over, or a folder whose contents could not be read. It did not
        // copy, so it may not say it did.
        if (units === 0) {
          failed = 1;
          last = 0;
          step(); // the unit `unitsOf` counted for a row that writes nothing
        }
        failedWrites += failed;

        const settled: ItemResult = { ...row };
        if (failed === 0) {
          settled.state = 'copied';
        } else {
          settled.state = 'failed';
          settled.note = units <= 1 ? failNote(last) : partialNote(failed, units);
        }
        results[i] = settled;
        safely('settled', () => on.settled(i, settled));
      }

      return results;
    },
  };
}
