/**
 * The fake `EditorGateway` the part-B4 frontend tests drive the editor with:
 * one in-memory disk, the server's own refusal sentences, and full control
 * over what is still in flight.
 *
 * WHY A FIXTURE AND NOT A MOCK MODULE. `ui/file-pane.ts` takes its backend
 * INJECTED (PLAN-B4 §1, the seam `ui/commit-store.ts` already uses), so every
 * test is the real body against a plain object: no module stubbing, no HTTP,
 * no clock. `ui/files-mock.ts` — the placeholder map A10 read files from —
 * died with this part, and this is what replaced it: a DOUBLE of the backend,
 * never a source of invented file content the app could render.
 *
 * WHAT A TEST CONTROLS. `setFile` puts bytes on the fake disk (and bumps their
 * stamp, which is what the 5 s disk follow and the 409 are about), `reads` and
 * `writes` record every request in order (the `if=` and the `expect` are IN
 * those records, because carrying them is the whole of D3 and D4), `failRead` /
 * `failWrite` arm one refusal with the server's own status and sentence, and
 * `holdRead` / `holdWrite` keep answers in flight until `release…` — which is
 * how `Saving…`, the "a body with a request out is not polled" rule and a
 * keystroke landing while an answer is out are all observable. A HELD READ IS
 * A READ ALREADY ON ITS WAY: it answers with the bytes and the stamp of the
 * moment it left, so a write that lands while it is out cannot change what it
 * says.
 *
 * TIME. There is none: `settle()` (tests/helpers/fs-fixture.ts) turns the microtask
 * queue, and fake-dom's timers are RECORDED, so the follow is driven by
 * calling `dom.win.intervals[0].fn()`.
 */
import type {
  FsEol,
  FsReadResponse,
  FsWriteRequest,
  FsWriteResponse,
} from '../../shared/protocol.ts';

/** The server's own sentences for the refusals this part can answer (PLAN-B4 §6). */
export const CHANGED_TEXT = 'This file changed on disk since you opened it.';
export const GONE_TEXT = 'This file is no longer there.';
export const TOO_LARGE_TEXT = 'This file is too large to open here.';
export const NOT_TEXT_TEXT = 'This file is not text, so the editor cannot show it.';
export const NO_READ_TEXT = 'You do not have permission to read this file.';
export const NO_WRITE_TEXT = 'You do not have permission to change this file.';

/** What `web/src/api.ts` rejects with: a status and the server's sentence. */
export class FakeApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Blob {
  text: string;
  stamp: string;
  eol: FsEol;
  bom: boolean;
}

export interface EditorFixture {
  gateway: { read(path: string, ifStamp?: string): Promise<FsReadResponse>; write(body: FsWriteRequest): Promise<FsWriteResponse> };
  /** Every read, as `path` or `path if=<stamp>`, in order. */
  reads: string[];
  /** Every write body, verbatim — `expect` included, or absent. */
  writes: FsWriteRequest[];
  /** Put bytes on the fake disk under a NEW stamp (what a disk change is). */
  setFile(path: string, text: string, opts?: { eol?: FsEol; bom?: boolean }): void;
  /** What is on the fake disk now, or null for a path that is not there. */
  fileText(path: string): string | null;
  /** The stamp those bytes carry (opaque to the app, readable to a test). */
  stampOf(path: string): string | null;
  /** The next read of this path is refused with that status and sentence. */
  failRead(path: string, status: number, message: string): void;
  /** The next write is refused with that status and sentence. */
  failWrite(status: number, message: string): void;
  /** Keep every read in flight until `releaseReads()`. */
  holdRead(): void;
  releaseReads(): void;
  /** Keep every write in flight until `releaseWrites()`. */
  holdWrite(): void;
  releaseWrites(): void;
}

export function makeEditor(): EditorFixture {
  const disk = new Map<string, Blob>();
  const reads: string[] = [];
  const writes: FsWriteRequest[] = [];
  const readFail = new Map<string, FakeApiError>();
  let writeFail: FakeApiError | null = null;
  let heldReads: (() => void)[] | null = null;
  let heldWrites: (() => void)[] | null = null;
  let stampSeq = 0;

  const nextStamp = (): string => {
    stampSeq += 1;
    return `s${stampSeq}`;
  };

  /** Run now, or park until the test releases. */
  function when(held: (() => void)[] | null, run: () => void): void {
    if (held === null) run();
    else held.push(run);
  }

  const fx: EditorFixture = {
    reads,
    writes,
    gateway: {
      read(path: string, ifStamp?: string): Promise<FsReadResponse> {
        reads.push(ifStamp === undefined ? path : `${path} if=${ifStamp}`);
        // THE ANSWER IS READ WHEN THE QUESTION IS ASKED; only its DELIVERY is
        // held. A held read is a read that is ON ITS WAY, so it carries the
        // bytes and the stamp of the moment it left — which is the whole of
        // the out-of-order case (a write that lands while a follow read is
        // out, and an answer that arrives afterwards holding the PRE-write
        // version).
        const armed = readFail.get(path);
        if (armed !== undefined) readFail.delete(path);
        const blob = disk.get(path);
        return new Promise<FsReadResponse>((resolve, reject) => {
          when(heldReads, () => {
            if (armed !== undefined) {
              reject(armed);
              return;
            }
            if (blob === undefined) {
              reject(new FakeApiError(404, GONE_TEXT));
              return;
            }
            if (ifStamp === blob.stamp) {
              resolve({ changed: false, stamp: blob.stamp });
              return;
            }
            resolve({
              changed: true,
              stamp: blob.stamp,
              text: blob.text,
              eol: blob.eol,
              bom: blob.bom,
            });
          });
        });
      },
      write(body: FsWriteRequest): Promise<FsWriteResponse> {
        writes.push({ ...body });
        return new Promise<FsWriteResponse>((resolve, reject) => {
          when(heldWrites, () => {
            if (writeFail !== null) {
              const err = writeFail;
              writeFail = null;
              reject(err);
              return;
            }
            const blob = disk.get(body.path);
            if (body.expect !== undefined) {
              if (blob === undefined) {
                reject(new FakeApiError(404, GONE_TEXT));
                return;
              }
              if (blob.stamp !== body.expect) {
                reject(new FakeApiError(409, CHANGED_TEXT));
                return;
              }
            }
            const stamp = nextStamp();
            // `expect` absent recreates a file that is gone — the Overwrite
            // button's whole job.
            disk.set(body.path, { text: body.text, stamp, eol: body.eol, bom: body.bom });
            resolve({ stamp, bytes: Buffer.byteLength(body.text, 'utf8') });
          });
        });
      },
    },
    setFile(path: string, text: string, opts?: { eol?: FsEol; bom?: boolean }): void {
      disk.set(path, {
        text,
        stamp: nextStamp(),
        eol: opts?.eol ?? 'lf',
        bom: opts?.bom ?? false,
      });
    },
    fileText(path: string): string | null {
      return disk.get(path)?.text ?? null;
    },
    stampOf(path: string): string | null {
      return disk.get(path)?.stamp ?? null;
    },
    failRead(path: string, status: number, message: string): void {
      readFail.set(path, new FakeApiError(status, message));
    },
    failWrite(status: number, message: string): void {
      writeFail = new FakeApiError(status, message);
    },
    holdRead(): void {
      heldReads = [];
    },
    releaseReads(): void {
      const held = heldReads ?? [];
      heldReads = null;
      for (const run of held) run();
    },
    holdWrite(): void {
      heldWrites = [];
    },
    releaseWrites(): void {
      const held = heldWrites ?? [];
      heldWrites = null;
      for (const run of held) run();
    },
  };
  return fx;
}
