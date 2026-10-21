/**
 * server/fsmedia.ts MediaTickets — the media viewer's ticket store (Nocturne
 * D7, `.claude/plans/nocturne/PLAN-D7.md`): bound to one path, 10 minutes,
 * at most 64 alive, one per path and file version, renewed on every ask.
 *
 * How: the class in process with its clock SEAM (`now`), so ten minutes pass
 * without a wait. The HTTP side — a ticket used on another path, an unknown
 * one — is in fs-media-boundary.test.ts.
 *
 * Why it matters: the ticket is the ONLY credential of GET /api/fs/media; a
 * ticket that outlives its window, or a cap that drops the newest instead of
 * the oldest, is a hole or a video that stops mid-play.
 *
 * NOT claimed: that a restart forgets the tickets (it is process memory; no
 * file is written — read the class).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEDIA_TICKET_MAX, MEDIA_TICKET_TTL_MS, MediaTickets } from '../../server/fsmedia.ts';

function clocked(): { tickets: MediaTickets; step: (ms: number) => void } {
  let now = 1_000_000;
  return { tickets: new MediaTickets({ now: () => now }), step: (ms) => (now += ms) };
}

test('a ticket is 32 random bytes in hex and names the path it was issued for', () => {
  const { tickets } = clocked();
  const t = tickets.issue('/home/you/a.png', 'v1');
  assert.match(t, /^[0-9a-f]{64}$/);
  assert.equal(tickets.pathOf(t), '/home/you/a.png');
  assert.notEqual(tickets.issue('/home/you/b.png', 'v1'), t, 'another path, another ticket');
});

test('an unknown, malformed or absent ticket names no path', () => {
  const { tickets } = clocked();
  tickets.issue('/home/you/a.png', 'v1');
  assert.equal(tickets.pathOf('0'.repeat(64)), null, 'unknown');
  assert.equal(tickets.pathOf('nope'), null, 'malformed');
  assert.equal(tickets.pathOf('A'.repeat(64)), null, 'upper-case hex is not a ticket');
  assert.equal(tickets.pathOf(null), null, 'absent');
});

test('a ticket expires 10 minutes after it was last handed out', () => {
  const { tickets, step } = clocked();
  const t = tickets.issue('/home/you/a.png', 'v1');
  step(MEDIA_TICKET_TTL_MS - 1);
  assert.equal(tickets.pathOf(t), '/home/you/a.png', 'one ms before the end');
  step(1);
  assert.equal(tickets.pathOf(t), null, 'at 10 minutes');
});

test('asking again for a path with a live ticket returns it and restarts its 10 minutes', () => {
  const { tickets, step } = clocked();
  const t = tickets.issue('/home/you/a.mp4', 'v1');
  step(MEDIA_TICKET_TTL_MS - 1000);
  assert.equal(tickets.issue('/home/you/a.mp4', 'v1'), t, 'the same ticket: a playing video keeps its src');
  step(MEDIA_TICKET_TTL_MS - 1000);
  assert.equal(tickets.pathOf(t), '/home/you/a.mp4', 'renewed, so still alive');
  step(1000);
  assert.equal(tickets.pathOf(t), null, 'and it ends 10 minutes after the renewal');
  assert.notEqual(tickets.issue('/home/you/a.mp4', 'v1'), t, 'an expired ticket is never handed out again');
});

test('the 65th ticket drops the oldest, and only the oldest', () => {
  const { tickets } = clocked();
  const issued = Array.from({ length: MEDIA_TICKET_MAX }, (_, i) => tickets.issue(`/home/you/${i}.png`, 'v1'));
  assert.equal(MEDIA_TICKET_MAX, 64);
  const newest = tickets.issue('/home/you/64.png', 'v1');
  assert.equal(tickets.pathOf(issued[0]!), null, 'the first ticket is gone');
  for (let i = 1; i < MEDIA_TICKET_MAX; i++) {
    assert.equal(tickets.pathOf(issued[i]!), `/home/you/${i}.png`, `ticket ${i} survives`);
  }
  assert.equal(tickets.pathOf(newest), '/home/you/64.png');
  assert.notEqual(tickets.issue('/home/you/0.png', 'v1'), issued[0], 'the dropped path gets a new ticket');
});

test('a renewal counts as new: the renewed ticket is not the one the cap drops', () => {
  const { tickets } = clocked();
  const first = tickets.issue('/home/you/0.png', 'v1');
  const second = tickets.issue('/home/you/1.png', 'v1');
  for (let i = 2; i < MEDIA_TICKET_MAX; i++) tickets.issue(`/home/you/${i}.png`, 'v1');
  tickets.issue('/home/you/0.png', 'v1'); // the 5 s poll of a visible tab
  tickets.issue('/home/you/64.png', 'v1');
  assert.equal(tickets.pathOf(first), '/home/you/0.png', 'the polled ticket survives');
  assert.equal(tickets.pathOf(second), null, 'the oldest unrenewed one was dropped instead');
});

test('a changed file version mints a NEW ticket; the old one stays valid until it expires', () => {
  const { tickets, step } = clocked();
  const before = tickets.issue('/home/you/a.png', '10:1000:7');
  const after = tickets.issue('/home/you/a.png', '12:2000:7');
  assert.notEqual(after, before, 'a new URL, so no cache hands back the old picture');
  assert.equal(tickets.issue('/home/you/a.png', '12:2000:7'), after, 'and the new one is renewed from then on');
  assert.equal(tickets.pathOf(before), '/home/you/a.png', 'an in-flight load of the old URL still works');
  step(MEDIA_TICKET_TTL_MS);
  assert.equal(tickets.pathOf(before), null);
});

test('a renewal below the cap moves the ticket to the back of the line', () => {
  // The cap test above renews at a FULL store, where the drop-and-re-add hides
  // the order; here the store has room, so only the re-insert moves it.
  const { tickets } = clocked();
  const first = tickets.issue('/home/you/0.png', 'v1');
  const second = tickets.issue('/home/you/1.png', 'v1');
  assert.equal(tickets.issue('/home/you/0.png', 'v1'), first, 'renewed, not replaced');
  for (let i = 2; i <= MEDIA_TICKET_MAX; i++) tickets.issue(`/home/you/${i}.png`, 'v1');
  assert.equal(tickets.pathOf(second), null, 'the oldest unrenewed ticket was the one dropped');
  assert.equal(tickets.pathOf(first), '/home/you/0.png', 'the renewed one survives');
});
