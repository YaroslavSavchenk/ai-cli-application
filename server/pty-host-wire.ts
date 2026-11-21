/**
 * The pty-host's wire — everything BOTH sides of the socket must agree on:
 * the frame layout, the message shapes and their validation, the protocol
 * number, where the socket and the state file live, and when a data dir is
 * refused.
 *
 * Nocturne D9 P2 (.claude/plans/nocturne/PLAN-D9.md § Defaults, § Phases).
 * One of four flat pieces (CONTRIBUTING: `server/` stays flat): the
 * pty-host process is server/pty-host-main.ts + server/pty-host-server.ts,
 * the backend's side server/pty-host-client.ts; this module is what both
 * import. It does no socket I/O; its file-system calls are the lstat checks
 * and the state-file read.
 *
 * Trust in the data dir (`dataDirRefusal`, `ownedRefusal`): the LAST path
 * component must be a real directory of this uid with mode exactly 0700, and
 * the socket and `pty-host.json` in it must be ours (socket; regular file,
 * 0600). The parents are not checked — they are the user's home (or the
 * `AI_SM_DATA_DIR` the user chose); a parent another user can write could
 * swap the whole directory, which no check made here can rule out. The host
 * checks at start and again right before the bind; the client checks before
 * it reads the state file or connects.
 *
 * The data dir's pty-host files: `pty-host.sock` (the socket),
 * `pty-host.json` (state + token, 0600), `pty-host.lockname` (128 random
 * bits naming the instance lock, 0600, created once and kept),
 * `pty-host.log` (lifecycle and counts).
 *
 * Socket path cap: 107 bytes — Linux's `sun_path` is 108 bytes and holds the
 * terminating NUL (the spec's "> 108" counted the NUL).
 *
 * Frame: `u32 length | u8 kind | payload`, big-endian, `length` = payload
 * bytes (the kind byte not counted). A length over MAX_FRAME_PAYLOAD is a
 * protocol error: the reader throws and the receiver closes the connection.
 * Kinds:
 *   - control  (1): UTF-8 JSON, one message object (`t` names it);
 *   - output   (2): 16-byte session uuid | u64 absolute offset | UTF-8 text;
 *   - input    (3): 16-byte session uuid | UTF-8 text;
 *   - snapshot (4): u32 request id | u8 found | u64 end offset | ring bytes —
 *     binary because a full 1 MiB ring does not fit under the cap inside a
 *     JSON envelope (P1 review).
 * Offsets count the UTF-8 bytes of the DECODED text, exactly as
 * server/pty-table.ts's ring does, and text is always cut at a character
 * boundary (`utf8Pieces`), so each frame decodes on its own.
 *
 * Session ids are the backend's `randomUUID()` ids; the wire carries them as
 * 16 raw bytes, so the socket host refuses any other id shape.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, linkSync, lstatSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSmallRegularFile } from './config.ts';
import {
  SCROLLBACK_MAX_BYTES,
  type PtyEntrySummary,
  type PtyExitRecord,
  type PtySnapshot,
  type PtySpawnRequest,
} from './pty-table.ts';

/** v1. A hello must name exactly this number (no ranges, no negotiation). */
export const PTY_HOST_PROTOCOL = 1;

/** `u32 length | u8 kind`. */
const HEADER_BYTES = 5;

/** The biggest payload: a full ring plus the snapshot's 13-byte prefix, with room to spare. */
export const MAX_FRAME_PAYLOAD = SCROLLBACK_MAX_BYTES + 64;

/** How much text one output or input frame carries at most (cut at a character boundary). */
const TEXT_PIECE_BYTES = 256 * 1024;

const KIND_CONTROL = 1;
const KIND_OUTPUT = 2;
const KIND_INPUT = 3;
const KIND_SNAPSHOT = 4;

const UUID_BYTES = 16;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Longest socket path a bind accepts: `sockaddr_un.sun_path` is 108 bytes
 * on Linux and holds the terminating NUL, so 107 bytes of path.
 */
export const MAX_SOCKET_PATH_BYTES = 107;

/** How the pty-host process ends when it does not run (the starter reads it). */
export const PTY_HOST_EXIT = {
  /** The data dir, its mode or the socket path was refused. */
  refused: 2,
  /** Another pty-host already answers on this data dir's socket. */
  otherInstance: 3,
} as const;

/** A build id as both sides accept it (a bundle version or a commit). */
const BUILD_SHAPE = /^[\w.+-]{1,64}$/;

/**
 * `build` as the starter passes it (AI_SM_PTY_HOST_BUILD) or as a host's
 * `welcome` reports it, or 'unknown' for anything of another shape — one rule
 * for the host and for the backend that logs it and serves it in
 * GET /api/runtime (D9 P3).
 */
export function buildOrUnknown(raw: unknown): string {
  return typeof raw === 'string' && BUILD_SHAPE.test(raw) ? raw : 'unknown';
}

/** The files of one data dir's pty-host. */
interface PtyHostPaths {
  socket: string;
  /** `pty-host.json`: pid, startedAt, proto, build, appDir, token (0600). */
  stateFile: string;
  /** `pty-host.lockname`: the secret the instance lock is named after (0600, created once). */
  lockName: string;
  log: string;
}

export function ptyHostPaths(dataDir: string): PtyHostPaths {
  return {
    socket: join(dataDir, 'pty-host.sock'),
    stateFile: join(dataDir, 'pty-host.json'),
    lockName: join(dataDir, 'pty-host.lockname'),
    log: join(dataDir, 'pty-host.log'),
  };
}

/**
 * Why this data dir may not hold a pty-host, as one sentence, or undefined
 * when it may. The socket's 0600 is only worth something inside a directory
 * nobody else can enter or swap: a real directory (not a link), owned by this
 * uid, mode exactly 0700. Also refused: a socket path the kernel cannot bind.
 */
export function dataDirRefusal(dataDir: string): string | undefined {
  const socketBytes = Buffer.byteLength(ptyHostPaths(dataDir).socket);
  if (socketBytes > MAX_SOCKET_PATH_BYTES) {
    return `The pty-host socket path is ${socketBytes} bytes, over the ${MAX_SOCKET_PATH_BYTES}-byte limit of a Unix socket.`;
  }
  let st;
  try {
    st = lstatSync(dataDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
    return `The data directory cannot be read (${code}).`;
  }
  if (!st.isDirectory()) return 'The data directory is not a plain directory.';
  if (st.uid !== process.getuid?.()) return 'The data directory belongs to another user.';
  const mode = st.mode & 0o777;
  if (mode !== 0o700) {
    return `The data directory has mode ${mode.toString(8)}, not 700.`;
  }
  return undefined;
}

/** What a stat of a pty-host file must answer; `fs.Stats` fits, a test passes a literal. */
interface StatLike {
  uid: number;
  mode: number;
  isFile(): boolean;
  isSocket(): boolean;
}

/**
 * Why this socket or state file is not to be trusted, or undefined when it
 * is: the socket must be a socket of `uid`; the state file (it holds the
 * token) and the lock name file (its secret names the instance lock) a
 * regular file of `uid`, mode 0600 — never a link (lstat).
 */
export function ownedRefusal(kind: OwnedKind, st: StatLike, uid: number): string | undefined {
  if (kind === 'socket' ? !st.isSocket() : !st.isFile()) return `The pty-host ${kind} is not a ${kind === 'socket' ? 'socket' : 'regular file'}.`;
  if (st.uid !== uid) return `The pty-host ${kind} belongs to another user.`;
  if (kind !== 'socket' && (st.mode & 0o777) !== 0o600) {
    return `The pty-host ${kind} has mode ${(st.mode & 0o777).toString(8)}, not 600.`;
  }
  return undefined;
}

/** The files `ownedRefusal` judges: the socket, and the two private files (0600). */
type OwnedKind = 'socket' | 'state file' | 'lock name file';

/** lstat + `ownedRefusal`; `missing` when there is nothing at the path. */
function fileRefusal(path: string, kind: OwnedKind): string | 'missing' | undefined {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    return `The pty-host ${kind} cannot be read (${(err as NodeJS.ErrnoException).code ?? 'unknown'}).`;
  }
  return ownedRefusal(kind, st, process.getuid?.() ?? -1);
}

/**
 * Why a client must not connect to this data dir's pty-host, or undefined:
 * the directory, the socket and the state file are all checked first. A
 * missing socket or state file is a refusal too (nothing to connect to).
 */
export function connectRefusal(dataDir: string): string | undefined {
  const dir = dataDirRefusal(dataDir);
  if (dir !== undefined) return dir;
  const paths = ptyHostPaths(dataDir);
  for (const [path, kind] of [
    [paths.stateFile, 'state file'],
    [paths.socket, 'socket'],
  ] as const) {
    const refusal = fileRefusal(path, kind);
    if (refusal === 'missing') return `No pty-host ${kind} in the data directory.`;
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}

const LOCK_SECRET_SHAPE = /^[0-9a-f]{32}$/;

/**
 * The secret this data dir's instance lock is named after
 * (server/pty-host-server.ts `holdInstanceLock`): 128 random bits, hex, in
 * `pty-host.lockname`. Created ONCE — written to a temp file 0600 and
 * `link()`ed to the final name, so of two first starts exactly one secret
 * wins (EEXIST ⇒ the winner's is read) — then reused by every later start.
 * Read only as a regular file of ours, mode 0600 (`ownedRefusal`); anything
 * else, or content of the wrong shape, throws with the reason.
 *
 * WHY a secret and not a path digest (D9 P2 security re-review): abstract
 * socket names live in the network namespace, which every WSL2 distro shares
 * — two distros with the same user and home would collide on a digest of the
 * path, and anyone in the namespace could squat it. Only someone who can read
 * our 0700 data dir can learn this name.
 */
export function lockSecret(dataDir: string): string {
  const path = ptyHostPaths(dataDir).lockName;
  const read = (): string | undefined => {
    const refusal = fileRefusal(path, 'lock name file');
    if (refusal === 'missing') return undefined;
    if (refusal !== undefined) throw new Error(refusal);
    const got = readSmallRegularFile(path, 1024);
    if (got.kind !== 'text') throw new Error('The pty-host lock name file cannot be read.');
    const secret = got.text.trim();
    if (!LOCK_SECRET_SHAPE.test(secret)) throw new Error('The pty-host lock name file is malformed.');
    return secret;
  };
  const existing = read();
  if (existing !== undefined) return existing;
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, `${randomBytes(16).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  try {
    chmodSync(tmp, 0o600); // the umask may have narrowed it; the reader wants exactly 600
    linkSync(tmp, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // Another first start linked its secret first: that one is the secret.
  } finally {
    rmSync(tmp, { force: true });
  }
  const secret = read();
  if (secret === undefined) throw new Error('The pty-host lock name file vanished.');
  return secret;
}

/** What `<dataDir>/pty-host.json` says about the running pty-host. */
export interface PtyHostFile {
  pid: number;
  startedAt: string;
  proto: number;
  build: string;
  appDir: string;
  token: string;
}

/** pty-host.json is a few hundred bytes; anything far bigger is not ours. */
const STATE_FILE_MAX_BYTES = 64 * 1024;

/**
 * `<dataDir>/pty-host.json`, or undefined when it is absent, not ours
 * (`ownedRefusal`) or not well-formed. The ONE reader: the host checks it
 * names itself before removing it, the client takes the token from it.
 */
export function readPtyHostFile(dataDir: string): PtyHostFile | undefined {
  const path = ptyHostPaths(dataDir).stateFile;
  if (fileRefusal(path, 'state file') !== undefined) return undefined;
  const read = readSmallRegularFile(path, STATE_FILE_MAX_BYTES);
  if (read.kind !== 'text') return undefined;
  let v: unknown;
  try {
    v = JSON.parse(read.text);
  } catch {
    return undefined;
  }
  const m = record(v);
  if (m === undefined) return undefined;
  const { pid, startedAt, proto, build, appDir, token } = m;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1 || typeof proto !== 'number') return undefined;
  if (typeof startedAt !== 'string' || typeof build !== 'string' || typeof appDir !== 'string') return undefined;
  if (typeof token !== 'string' || token === '') return undefined;
  return { pid, startedAt, proto, build, appDir, token };
}

/** A frame the reader could not accept: the receiver closes the connection. */
export class WireError extends Error {
  /**
   * The frames of the same chunk decoded BEFORE the bad one. They are as good
   * as if they had come in an earlier read, so a receiver handles them first,
   * then closes (D9 P2 test gate: dropping them lost a peer's last words —
   * an exit, a bye — for no reason).
   */
  readonly frames: Frame[];

  constructor(message: string, frames: Frame[] = []) {
    super(message);
    this.frames = frames;
  }
}

export function isSessionUuid(id: unknown): id is string {
  return typeof id === 'string' && UUID_SHAPE.test(id);
}

function uuidBytes(id: string): Buffer {
  if (!UUID_SHAPE.test(id)) throw new RangeError('a pty-host session id must be a lowercase uuid');
  return Buffer.from(id.replaceAll('-', ''), 'hex');
}

function uuidText(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function frame(kind: number, parts: Buffer[]): Buffer {
  const length = parts.reduce((n, p) => n + p.byteLength, 0);
  if (length > MAX_FRAME_PAYLOAD) {
    throw new RangeError(`a pty-host frame of ${length} bytes is over the ${MAX_FRAME_PAYLOAD}-byte cap`);
  }
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header.writeUInt32BE(length, 0);
  header.writeUInt8(kind, 4);
  return Buffer.concat([header, ...parts], HEADER_BYTES + length);
}

/** One control message. Throws a RangeError when it does not fit a frame. */
export function encodeControl(message: ClientMessage | HostMessage): Buffer {
  return frame(KIND_CONTROL, [Buffer.from(JSON.stringify(message), 'utf8')]);
}

function u64(n: number): Buffer {
  const b = Buffer.allocUnsafe(8);
  b.writeBigUInt64BE(BigInt(n), 0);
  return b;
}

/**
 * Text as UTF-8 pieces of at most `max` bytes, each cut before a character's
 * first byte so every piece decodes on its own (no U+FFFD at a seam).
 */
export function utf8Pieces(text: string, max: number = TEXT_PIECE_BYTES): Buffer[] {
  const all = Buffer.from(text, 'utf8');
  const pieces: Buffer[] = [];
  let start = 0;
  while (all.byteLength - start > max) {
    let end = start + max;
    // 0b10xxxxxx is a continuation byte: back off to the character's start.
    while (end > start && ((all[end] as number) & 0xc0) === 0x80) end -= 1;
    pieces.push(all.subarray(start, end));
    start = end;
  }
  pieces.push(all.subarray(start));
  return pieces;
}

/** One output chunk as frames; `offset` is the absolute offset of its first byte. */
export function encodeOutput(id: string, offset: number, text: string): Buffer[] {
  const head = uuidBytes(id);
  let at = offset;
  return utf8Pieces(text).map((piece) => {
    const f = frame(KIND_OUTPUT, [head, u64(at), piece]);
    at += piece.byteLength;
    return f;
  });
}

/** Input text for one session as frames. */
export function encodeInput(id: string, text: string): Buffer[] {
  const head = uuidBytes(id);
  return utf8Pieces(text).map((piece) => frame(KIND_INPUT, [head, piece]));
}

/** The answer to `snapshot` request `req`; `undefined` = no such session. */
export function encodeSnapshot(req: number, snapshot: PtySnapshot | undefined): Buffer {
  const head = Buffer.allocUnsafe(5);
  head.writeUInt32BE(req, 0);
  head.writeUInt8(snapshot === undefined ? 0 : 1, 4);
  if (snapshot === undefined) return frame(KIND_SNAPSHOT, [head, u64(0)]);
  return frame(KIND_SNAPSHOT, [head, u64(snapshot.endOffset), snapshot.ring]);
}

export type Frame =
  | { kind: 'control'; message: unknown }
  | { kind: 'output'; id: string; offset: number; text: string }
  | { kind: 'input'; id: string; text: string }
  | { kind: 'snapshot'; req: number; snapshot: PtySnapshot | undefined };

function decode(kind: number, payload: Buffer): Frame {
  switch (kind) {
    case KIND_CONTROL:
      try {
        return { kind: 'control', message: JSON.parse(payload.toString('utf8')) as unknown };
      } catch {
        throw new WireError('a control frame is not JSON');
      }
    case KIND_OUTPUT:
    case KIND_INPUT: {
      const fixed = kind === KIND_OUTPUT ? UUID_BYTES + 8 : UUID_BYTES;
      if (payload.byteLength < fixed) throw new WireError('a data frame is shorter than its header');
      const id = uuidText(payload.subarray(0, UUID_BYTES));
      const text = payload.subarray(fixed).toString('utf8');
      if (kind === KIND_INPUT) return { kind: 'input', id, text };
      const offset = Number(payload.readBigUInt64BE(UUID_BYTES));
      return { kind: 'output', id, offset, text };
    }
    case KIND_SNAPSHOT: {
      if (payload.byteLength < 13) throw new WireError('a snapshot frame is shorter than its header');
      const req = payload.readUInt32BE(0);
      if (payload.readUInt8(4) === 0) return { kind: 'snapshot', req, snapshot: undefined };
      const endOffset = Number(payload.readBigUInt64BE(5));
      // A copy: the payload is a view into the reader's buffers.
      return { kind: 'snapshot', req, snapshot: { endOffset, ring: Buffer.from(payload.subarray(13)) } };
    }
    default:
      throw new WireError(`unknown frame kind ${kind}`);
  }
}

/**
 * Cuts a byte stream into frames. Throws a WireError for a frame over the
 * cap (checked on the header, before a byte of the payload is buffered), an
 * unknown kind or a malformed payload, carrying the good frames decoded
 * before it (`WireError.frames`); the caller handles those, then closes the
 * connection — the reader is not usable after an error.
 */
export class FrameReader {
  #chunks: Buffer[] = [];
  #bytes = 0;

  push(chunk: Buffer): Frame[] {
    this.#chunks.push(chunk);
    this.#bytes += chunk.byteLength;
    const frames: Frame[] = [];
    for (;;) {
      if (this.#bytes < HEADER_BYTES) return frames;
      const header = this.#peek(HEADER_BYTES);
      const length = header.readUInt32BE(0);
      if (length > MAX_FRAME_PAYLOAD) {
        throw new WireError(`a frame of ${length} bytes is over the ${MAX_FRAME_PAYLOAD}-byte cap`, frames);
      }
      if (this.#bytes < HEADER_BYTES + length) return frames;
      const whole = this.#take(HEADER_BYTES + length);
      try {
        frames.push(decode(header.readUInt8(4), whole.subarray(HEADER_BYTES)));
      } catch (err) {
        throw err instanceof WireError ? new WireError(err.message, frames) : err;
      }
    }
  }

  /** The first `n` buffered bytes (joined only when they span chunks). */
  #peek(n: number): Buffer {
    const first = this.#chunks[0] as Buffer;
    if (first.byteLength >= n) return first;
    const joined = Buffer.concat(this.#chunks, this.#bytes);
    this.#chunks = [joined];
    return joined;
  }

  #take(n: number): Buffer {
    const head = this.#peek(n);
    const rest = head.subarray(n);
    this.#chunks[0] = rest;
    if (rest.byteLength === 0) this.#chunks.shift();
    this.#bytes -= n;
    return head.subarray(0, n);
  }
}

// ---------------------------------------------------------------------------
// Control messages. Every one is validated where it is received: a field of
// the wrong type makes the whole message unknown (undefined), never a guess.

export type PtyHostRole = 'owner' | 'probe';

/** Why a host answered `refuse`: a wrong token or protocol, or the owner seat is taken. */
export type RefuseReason = 'token' | 'proto' | 'owner-busy' | 'bad-hello';

/** Why the host said goodbye to its owner right before closing (`bye`). */
export type ByeReason = 'taken-over' | 'idle' | 'orphan' | 'shutdown';

export type ClientMessage =
  | { t: 'hello'; proto: number; token: string; role: PtyHostRole; takeover: boolean }
  | ({ t: 'spawn' } & PtySpawnRequest)
  | { t: 'snapshot'; req: number; id: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'kill'; id: string; mode: 'ladder' | 'now' }
  | { t: 'set-meta'; id: string; meta: string }
  | { t: 'forget'; id: string }
  | { t: 'list'; req: number }
  | { t: 'shutdown-all' }
  | { t: 'detach' }
  | { t: 'list-count'; req: number }
  | { t: 'shutdown-if-empty'; req: number };

export interface Welcome {
  proto: number;
  build: string;
  pid: number;
  startedAt: string;
}

export type HostMessage =
  | ({ t: 'welcome' } & Welcome)
  | { t: 'refuse'; reason: RefuseReason; proto: number }
  | { t: 'spawned'; id: string; pid: number }
  | { t: 'spawn-error'; id: string; cls: string }
  | ({ t: 'exit'; id: string } & PtyExitRecord)
  | { t: 'list-part'; req: number; entries: PtyEntrySummary[]; done: boolean }
  | { t: 'count'; req: number; total: number; running: number }
  | { t: 'emptied'; req: number; done: boolean }
  | { t: 'bye'; reason: ByeReason };

/** A PTY dimension the kernel's `struct winsize` can carry (u16, at least 1). */
const MAX_PTY_DIM = 0xffff;

type Fields = Record<string, unknown>;

function record(v: unknown): Fields | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Fields) : undefined;
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function isReq(v: unknown): v is number {
  return isCount(v) && v <= 0xffffffff;
}

function isDim(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_PTY_DIM;
}

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function stringMap(v: unknown): Record<string, string> | undefined {
  const r = record(v);
  if (r === undefined) return undefined;
  for (const value of Object.values(r)) if (typeof value !== 'string') return undefined;
  return r as Record<string, string>;
}

function parseSpawn(m: Fields): ClientMessage | undefined {
  const env = stringMap(m['env']);
  const { id, file, argv, cwd, cols, rows, meta } = m;
  if (!isSessionUuid(id) || typeof file !== 'string' || !isStringList(argv)) return undefined;
  if (typeof cwd !== 'string' || env === undefined || !isDim(cols) || !isDim(rows)) return undefined;
  if (meta !== undefined && typeof meta !== 'string') return undefined;
  const spawn: ClientMessage = { t: 'spawn', id, file, argv, cwd, env, cols, rows };
  if (meta !== undefined) spawn.meta = meta;
  return spawn;
}

/** What a client sent, or undefined for anything unknown or malformed. */
export function parseClientMessage(v: unknown): ClientMessage | undefined {
  const m = record(v);
  if (m === undefined) return undefined;
  const { t, id, req } = m;
  switch (t) {
    case 'hello': {
      const { proto, token, role, takeover } = m;
      if (typeof proto !== 'number' || typeof token !== 'string' || typeof takeover !== 'boolean') return undefined;
      if (role !== 'owner' && role !== 'probe') return undefined;
      return { t, proto, token, role, takeover };
    }
    case 'spawn':
      return parseSpawn(m);
    case 'snapshot':
      return isReq(req) && isSessionUuid(id) ? { t, req, id } : undefined;
    case 'resize': {
      const { cols, rows } = m;
      return isSessionUuid(id) && isDim(cols) && isDim(rows) ? { t, id, cols, rows } : undefined;
    }
    case 'kill': {
      const { mode } = m;
      if (!isSessionUuid(id) || (mode !== 'ladder' && mode !== 'now')) return undefined;
      return { t, id, mode };
    }
    case 'set-meta': {
      const { meta } = m;
      return isSessionUuid(id) && typeof meta === 'string' ? { t, id, meta } : undefined;
    }
    case 'forget':
      return isSessionUuid(id) ? { t, id } : undefined;
    case 'list':
    case 'list-count':
    case 'shutdown-if-empty':
      return isReq(req) ? { t, req } : undefined;
    case 'shutdown-all':
    case 'detach':
      return { t };
    default:
      return undefined;
  }
}

function parseExitRecord(m: Fields): PtyExitRecord | undefined {
  const { code, signal, at } = m;
  if (typeof code !== 'number' || !Number.isInteger(code)) return undefined;
  if (signal !== null && (typeof signal !== 'number' || !Number.isInteger(signal))) return undefined;
  if (!isCount(at)) return undefined;
  return { code, signal, at };
}

function parseSummary(v: unknown): PtyEntrySummary | undefined {
  const m = record(v);
  if (m === undefined) return undefined;
  const { id, pid, cols, rows, endOffset, meta } = m;
  if (!isSessionUuid(id) || !isCount(pid) || !isDim(cols) || !isDim(rows) || !isCount(endOffset)) {
    return undefined;
  }
  if (meta !== null && typeof meta !== 'string') return undefined;
  let exit: PtyExitRecord | null = null;
  if (m['exit'] !== null) {
    const r = record(m['exit']);
    const parsed = r === undefined ? undefined : parseExitRecord(r);
    if (parsed === undefined) return undefined;
    exit = parsed;
  }
  return { id, pid, cols, rows, endOffset, exit, meta };
}

const REFUSE_REASONS: readonly string[] = ['token', 'proto', 'owner-busy', 'bad-hello'];
const BYE_REASONS: readonly string[] = ['taken-over', 'idle', 'orphan', 'shutdown'];

/** What the host sent, or undefined for anything unknown or malformed. */
export function parseHostMessage(v: unknown): HostMessage | undefined {
  const m = record(v);
  if (m === undefined) return undefined;
  const { t, id, req } = m;
  switch (t) {
    case 'welcome': {
      const { proto, build, pid, startedAt } = m;
      if (typeof proto !== 'number' || typeof build !== 'string' || !isCount(pid)) return undefined;
      return typeof startedAt === 'string' ? { t, proto, build, pid, startedAt } : undefined;
    }
    case 'refuse': {
      const { reason, proto } = m;
      if (typeof reason !== 'string' || !REFUSE_REASONS.includes(reason) || typeof proto !== 'number') {
        return undefined;
      }
      return { t, reason: reason as RefuseReason, proto };
    }
    case 'spawned': {
      const { pid } = m;
      return isSessionUuid(id) && isCount(pid) ? { t, id, pid } : undefined;
    }
    case 'spawn-error': {
      const { cls } = m;
      return isSessionUuid(id) && typeof cls === 'string' ? { t, id, cls } : undefined;
    }
    case 'exit': {
      const exit = parseExitRecord(m);
      return isSessionUuid(id) && exit !== undefined ? { t, id, ...exit } : undefined;
    }
    case 'list-part': {
      const { entries, done } = m;
      if (!isReq(req) || !Array.isArray(entries) || typeof done !== 'boolean') return undefined;
      const parsed = entries.map(parseSummary);
      if (parsed.some((e) => e === undefined)) return undefined;
      return { t, req, entries: parsed as PtyEntrySummary[], done };
    }
    case 'count': {
      const { total, running } = m;
      return isReq(req) && isCount(total) && isCount(running) ? { t, req, total, running } : undefined;
    }
    case 'emptied': {
      const { done } = m;
      return isReq(req) && typeof done === 'boolean' ? { t, req, done } : undefined;
    }
    case 'bye': {
      const { reason } = m;
      if (typeof reason !== 'string' || !BYE_REASONS.includes(reason)) return undefined;
      return { t, reason: reason as ByeReason };
    }
    default:
      return undefined;
  }
}
