/**
 * `commandLabel` in `web/src/ui/launch-args.ts` — how the UI names a session's
 * command. It is the enforcement point of the copy rule's ONE display
 * exemption (PROJECT-SCOPE, 2026-07-25): the known agent reads as its product
 * name, a shell the launch dialog itself composed reads as that shell's name
 * (2026-09-08), and ANY other command is echoed exactly as the user typed it —
 * inventing a name for an arbitrary command would be a lie about what is
 * running.
 *
 * It used to live in `ui/sessions.ts`, whose import graph reaches
 * `ui/panes.ts` -> `ui/terminal.ts` -> `@xterm/xterm` (a browser bundle with no
 * matching named exports under Node) and `ui/dnd.ts` (a module-scope
 * `document.addEventListener`), so this file had to install a `registerHooks`
 * module stub and a bag of DOM globals before it could import the function at
 * all. The function is pure vocabulary and now sits beside the two tables it
 * reads (`AGENT_LABEL`, `SHELLS`/`shellLabel`) in `ui/launch-args.ts`, which is
 * DOM-free by construction — so the shim is gone and this is a plain import.
 * Its three callers (the sessions drawer, the settings relaunch notice, the
 * restart confirmation) import it from there.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_LABEL, SHELLS, commandLabel, isClaudeCommand } from '../web/src/ui/launch-args.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SESSIONS = join(REPO_ROOT, 'web', 'src', 'ui', 'sessions.ts');

// ---------------------------------------------------------------------------

test('commandLabel: imported straight from the DOM-free module (non-vacuity)', () => {
  assert.equal(typeof commandLabel, 'function');
  assert.equal(commandLabel.length, 1);
});

test('commandLabel: the known agent reads as its product name, never as the command `claude`', () => {
  assert.equal(commandLabel('claude'), AGENT_LABEL);
  assert.equal(commandLabel('claude'), 'Claude Code');
  assert.notEqual(commandLabel('claude'), 'claude');
});

test('commandLabel: each shell the dialog composes reads as that shell’s name — no path, no .exe on screen', () => {
  for (const s of SHELLS) {
    assert.equal(commandLabel(s.command), s.label, s.command);
    assert.notEqual(commandLabel(s.command), s.command, s.command);
    assert.equal(commandLabel(s.command).includes('/'), false, s.label);
    assert.equal(commandLabel(s.command).includes('.exe'), false, s.label);
  }
  // Byte-exact, so a table edit that renames a spawn is visible here too.
  assert.equal(commandLabel('/bin/bash'), 'WSL shell');
  assert.equal(commandLabel('powershell.exe'), 'PowerShell');
});

test('commandLabel: every other command is echoed VERBATIM — the custom-command exemption', () => {
  for (const raw of [
    'htop',
    'bash',
    '/usr/bin/bash',
    'pwsh',
    'python3',
    'node',
    '/home/you/bin/my agent',
    'CLAUDE',
    'claude-code',
    './claude',
    '',
  ]) {
    assert.equal(commandLabel(raw), raw, JSON.stringify(raw));
  }
});

test('commandLabel: resemblance is never enough — only an exact match is relabelled', () => {
  // The three relabelled commands, mutated one character at a time, must all
  // fall through to the verbatim echo.
  for (const near of ['claud', 'claudee', ' claude', 'claude ', '/bin/bash -l', 'bin/bash', 'powershell', 'Powershell.exe']) {
    assert.equal(commandLabel(near), near, near);
  }
});

// ---------------------------------------------------------------------------
// The HISTORY row's label rule (2026-09-08)
// ---------------------------------------------------------------------------
//
// A history row used to render title + age + model only. A shell entry carries
// no model, so a bash or PowerShell run looked exactly like a Claude one. The
// fix reuses this same vocabulary as an extra meta part, for NON-claude entries
// only (a claude row already says what it is through its model tag).
//
// `historyRow` itself is a closure inside `initSessionsDrawer` and needs a DOM,
// so what runs here is the DECISION — `isClaudeCommand` gating `commandLabel` —
// plus a source check that the drawer really composes it that way. Rendering
// stays manual (`.claude/skills/verify-terminal/SKILL.md`).

/** The rule as the drawer applies it: null = add nothing to the meta line. */
const historyMetaLabel = (command: string): string | null =>
  isClaudeCommand(command) ? null : commandLabel(command);

test('history meta: a claude entry adds NOTHING — its model tag already names it', () => {
  for (const c of ['claude', '/home/you/.local/bin/claude', './claude']) {
    assert.equal(historyMetaLabel(c), null, c);
  }
});

test('history meta: both built-in shells get their product name, so a shell row is not mistaken for a Claude row', () => {
  assert.equal(historyMetaLabel('/bin/bash'), 'WSL shell');
  assert.equal(historyMetaLabel('powershell.exe'), 'PowerShell');
  for (const s of SHELLS) assert.equal(historyMetaLabel(s.command), s.label, s.command);
});

test('history meta: a custom command is echoed verbatim — the same one exemption, no second vocabulary', () => {
  assert.equal(historyMetaLabel('htop'), 'htop');
  assert.equal(historyMetaLabel('python3'), 'python3');
  assert.equal(historyMetaLabel('claude-code'), 'claude-code');
});

test('the sessions drawer really composes its history meta from this rule (source check, non-vacuous)', () => {
  const src = readFileSync(SESSIONS, 'utf8');
  const start = src.indexOf('function historyRow(');
  assert.notEqual(start, -1, 'sessions.ts must still define historyRow');
  const body = src.slice(start, start + 2000);
  // Non-vacuity: the slice really is the row builder.
  assert.ok(body.includes("el('div', 'sess-meta')"), 'historyRow must still build a sess-meta line');
  assert.ok(body.includes('fmtAgo(entry.lastUsedAt)'), 'historyRow must still show the age');
  assert.ok(
    body.includes('if (!isClaudeCommand(entry.command)) parts.push(commandLabel(entry.command));'),
    'historyRow must push commandLabel for non-claude entries only',
  );
  // And it must be the SHARED helper, not a second table copied into the drawer.
  assert.ok(
    src.includes("import { commandLabel, isClaudeCommand } from './launch-args.ts';"),
    'the drawer must import the shared vocabulary, never redefine it',
  );
  assert.equal(src.includes('export function commandLabel'), false, 'commandLabel must not live here anymore');
});
