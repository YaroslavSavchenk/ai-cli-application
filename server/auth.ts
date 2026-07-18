/**
 * Auth: token generation, timing-safe comparison, and Host/Origin validation.
 *
 * The server binds 127.0.0.1 only; Host/Origin checks defend against DNS
 * rebinding and cross-origin requests from other pages on localhost.
 */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/** Hex token with >= 32 bytes of entropy. */
export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Constant-time string comparison. Both inputs are hashed first so the
 * comparison leaks neither content nor length.
 */
export function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(provided).digest();
  return timingSafeEqual(a, b);
}

/** Host header must be localhost:<port> or 127.0.0.1:<port>. */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  return host === `localhost:${port}` || host === `127.0.0.1:${port}`;
}

/**
 * If an Origin header is present it must be http://localhost:<port> or
 * http://127.0.0.1:<port>. Absent Origin (curl, same-origin GET) is allowed.
 */
export function originAllowed(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true;
  return origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`;
}
