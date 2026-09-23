/**
 * Shared helpers for the logging tests (`tests/server/logging.test.ts`,
 * `tests/server/logging-client-log.test.ts`, `tests/server/logging-hardening.test.ts`):
 * a temp dir for an in-process logger, and a raw POST to /api/client-log on a
 * real server child with a chosen token and Origin.
 */
import { rawRequest, makeTempDirSync, type TestServer } from './helpers.ts';

export function tempDir(): string {
  return makeTempDirSync('ai-sm-log-');
}

export async function postClientLog(
  server: TestServer,
  body: unknown,
  opts: { token?: string; origin?: string } = {},
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token !== '') headers['x-auth-token'] = opts.token ?? server.token;
  if (opts.origin !== undefined) headers['origin'] = opts.origin;
  const res = await rawRequest(server.port, {
    method: 'POST',
    path: '/api/client-log',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: res.body };
}
