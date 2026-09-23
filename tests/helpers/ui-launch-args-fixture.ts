/**
 * Shared by the launch vocabulary tests (`tests/ui/ui-launch-args*.test.ts`):
 * the copy rule's banned code-shaped strings (`assertPlainCopy`) and a
 * `LaunchForm` bag with the dialog's own initial values (`form`). Not a test.
 */
import assert from 'node:assert/strict';
import type { LaunchForm } from '../../web/src/ui/launch-args.ts';

/**
 * The code-shaped strings the copy rule bans from the UI. Only the camelCase
 * mode values are listed: `plan` and `default` are ordinary English words, so a
 * substring ban on those would be meaningless — the rule is about CLI syntax,
 * not vocabulary overlap.
 */
export const CODE_SHAPED = ['acceptEdits', 'bypassPermissions', '--', '$'];

export function assertPlainCopy(text: string, where: string): void {
  for (const bad of CODE_SHAPED) {
    assert.ok(!text.includes(bad), `${where} must not contain ${bad}: ${text}`);
  }
}

/** A form bag with the dialog's own initial values; each test overrides what it means. */
export function form(over: Partial<LaunchForm> = {}): LaunchForm {
  return {
    kind: 'claude',
    model: 'opus',
    perm: 'default',
    continueLast: false,
    effort: 'default',
    shell: 'wsl',
    customLine: '',
    ...over,
  };
}
