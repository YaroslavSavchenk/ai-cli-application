/**
 * Shared builders for `tests/ui/ui-drop-model*.test.ts`: a dropped file (1 KiB
 * unless told otherwise) and a dropped folder (no size of its own), as
 * `web/src/ui/drop-model.ts`'s `DropItem`. Not a test.
 */
import type { DropItem } from '../../web/src/ui/drop-model.ts';

export const file = (name: string, bytes = 1024): DropItem => ({ name, dir: false, bytes });
export const folder = (name: string): DropItem => ({ name, dir: true, bytes: null });
