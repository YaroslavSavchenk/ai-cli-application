/**
 * The Settings panel's API keys block (Nocturne B5, on the Preferences page):
 * one row per tool the app knows, a password-shaped field for each tool that
 * reads a key from its environment, and the live half — save, remove, show,
 * and what the page learns from GET /api/keys (saved / not saved, never the
 * key itself). A typed key is never kept past the request that sends it, and
 * never past the dialog closing (`clearKeyFields`).
 *
 * Split from `ui/settings.ts` (O8, 2026-09-23), code moved as it stood.
 * Siblings: `settings.ts` (the modal, its nav and the other four pages),
 * `settings-apikeys.ts`, `settings-service.ts`.
 */
import type { KeyedTool, KeyStatus } from '../../../shared/protocol.ts';
import * as api from '../api.ts';
import { log } from '../log.ts';
import { el, button } from './util.ts';
import { TOOL_CARDS, type ToolIconId } from './launch-args.ts';
import { toolIcon } from './icons-tools.ts';
// theme-model.ts only: the clamp that reads a prefs bag's `theme`. ui/theme.ts
// itself arrives as a dep (see SettingsDeps.theme).

/**
 * The Preferences page's key rows, LIVE since part B5. They are listed for
 * every tool the app knows, hidden card or not (B6): a key is about the tool,
 * not about whether its card shows up in the New session dialog.
 * `tool` names the keyed tool whose field the row carries — absent = no field,
 * because there is no key this app can store for it.
 */
interface ProviderRow {
  icon: ToolIconId;
  label: string;
  keyText: string;
  /** The keyed tool this row saves for; absent = the row is words only. */
  tool?: KeyedTool;
  /** The known agent's tile carries the accent family (v3). */
  agent?: boolean;
}

/**
 * What each row says about its key, by the New session dialog's own card id.
 * Codex gets NO field on purpose (user decision 2026-09-18): a key alone does
 * not authenticate it, so the honest line is that it signs in where it runs.
 * A card with no entry here (the custom-command `Other`) gets no provider row.
 */
const ROW_KEYS: Record<string, { keyText: string; tool?: KeyedTool; agent?: boolean }> = {
  claude: { keyText: 'Uses your Claude login. A saved key is used instead.', tool: 'claude', agent: true },
  codex: { keyText: 'Signs in inside the terminal' },
  gemini: { keyText: 'Needs an API key, or a sign-in inside the terminal.', tool: 'gemini' },
  grok: { keyText: 'Needs an API key, or a sign-in inside the terminal.', tool: 'grok' },
  terminal: { keyText: 'No key needed' },
};

/** What the row says about the key it has: stored here, or only in the environment. */
const KEY_SAVED = 'Saved';
const KEY_ENV_ONLY = 'Set outside the app';

/**
 * The marks and names are the New session dialog's own table (launch-args.ts
 * `TOOL_CARDS`, whose `claude` entry carries `AGENT_LABEL`) in its own order, so
 * the two surfaces cannot drift apart and the product name lives in one place.
 */
const PROVIDER_ROWS: ProviderRow[] = TOOL_CARDS.flatMap((c) => {
  const k = ROW_KEYS[c.id];
  return k === undefined ? [] : [{ icon: c.icon, label: c.label, ...k }];
});

/** What `initSettings()` reaches in the key rows. */
export interface KeyRowsPart {
  keyRows: Map<KeyedTool, { input: HTMLInputElement }>;
  syncKeyRows(): void;
  refreshKeys(): void;
  clearKeyFields(): void;
}

/**
 * Build the block onto the Preferences page, where `initSettings()` used to
 * build it inline, and hand back what the rest of the panel calls.
 */
export function createKeyRows(prefsPage: HTMLElement): KeyRowsPart {
  /** One live key row's controls, kept so the page can reflect what it learns. */
  interface KeyRowCtl {
    label: string;
    input: HTMLInputElement;
    show: HTMLButtonElement;
    save: HTMLButtonElement;
    remove: HTMLButtonElement;
    state: HTMLElement;
    err: HTMLElement;
  }
  const keyRows = new Map<KeyedTool, KeyRowCtl>();
  /** Last answer from GET /api/keys; null until one arrives. */
  let keyStatus: KeyStatus | null = null;

  const provWrap = el('div', 'sg-rows');
  for (const p of PROVIDER_ROWS) {
    const row = el('div', 'sg-prow');
    const mark = el('span', p.agent === true ? 'sg-mark is-agent' : 'sg-mark');
    mark.append(toolIcon(p.icon, 14));
    mark.setAttribute('aria-hidden', 'true');
    const txt = el('div', 'sg-prowtxt');
    txt.append(el('span', 'sg-rowlb', p.label), el('span', 'sg-prowkey', p.keyText));
    row.append(mark, txt);
    const tool = p.tool;
    if (tool !== undefined) {
      const inp = el('input', 'sg-keyin');
      // Same shape as the app's one real credential field (ui/github.ts): a key
      // is never plain text on screen unless the user asks, never offered as a
      // saved login, and with no `name` for an autofill to match.
      inp.type = 'password';
      inp.autocomplete = 'new-password';
      inp.spellcheck = false;
      inp.placeholder = 'Paste API key';
      inp.setAttribute('aria-label', `${p.label} key`);
      inp.id = `sg-key-${tool}`;
      const show = button('sg-smallbtn', 'Show', () => toggleShow(tool));
      show.setAttribute('aria-pressed', 'false');
      const save = button('sg-smallbtn', 'Save', () => void saveKey(tool));
      const remove = button('sg-smallbtn', 'Remove', () => void removeKey(tool));
      const state = el('span', 'sg-keystate', '');
      const line = el('div', 'sg-keyline');
      line.append(inp, show, save, remove);
      const err = el('div', 'sg-keyerr');
      err.setAttribute('role', 'alert');
      err.hidden = true;
      txt.append(line, err);
      row.append(state);
      // Save stays off until there is something to save — a key-shaped field
      // with nothing in it has no verb.
      inp.addEventListener('input', () => syncKeyRow(tool));
      keyRows.set(tool, { label: p.label, input: inp, show, save, remove, state, err });
    }
    provWrap.append(row);
  }
  prefsPage.append(el('h3', 'sg-sub', 'API keys'), provWrap);

  // ---- the key rows, live --------------------------------------------------

  /**
   * Reflect what the page knows onto ONE row: the state word beside the name
   * (`Saved`, or `Set outside the app` when only the environment carries one),
   * and which verbs can be used. The page only ever learns saved / not saved —
   * a key never comes back from the server, so the field always starts empty.
   */
  function syncKeyRow(tool: KeyedTool): void {
    const r = keyRows.get(tool);
    if (r === undefined) return;
    const saved = keyStatus?.saved[tool] === true;
    const env = keyStatus?.env[tool] === true;
    r.state.textContent = saved ? KEY_SAVED : env ? KEY_ENV_ONLY : '';
    r.save.disabled = r.input.value.trim() === '';
    r.remove.disabled = !saved;
  }

  function syncKeyRows(): void {
    for (const tool of keyRows.keys()) syncKeyRow(tool);
  }

  /** Show the key that is being typed, for as long as the user asks. */
  function toggleShow(tool: KeyedTool): void {
    const r = keyRows.get(tool);
    if (r === undefined) return;
    const showing = r.input.type === 'text';
    r.input.type = showing ? 'password' : 'text';
    r.show.textContent = showing ? 'Show' : 'Hide';
    r.show.setAttribute('aria-pressed', showing ? 'false' : 'true');
  }

  function keyErr(tool: KeyedTool, msg: string | null): void {
    const r = keyRows.get(tool);
    if (r === undefined) return;
    r.err.textContent = msg ?? '';
    r.err.hidden = msg === null;
  }

  /**
   * What to SAY about a failed key call. The server's own sentences are written
   * for the user and are rendered verbatim; a failure with no sentence (a
   * network drop, or a status whose body the client could not read) falls back
   * to plain words — `HTTP 413` is a status code, not something to read.
   */
  function keyFailure(e: unknown, fallback: string): string {
    const msg = e instanceof Error ? e.message : '';
    return msg !== '' && !/^HTTP \d+$/.test(msg) ? msg : fallback;
  }

  /**
   * Hand ONE key to the backend and forget it. The field is cleared in the same
   * turn the request is made, the local reference dies with this function, and
   * nothing about the value is logged — only which tool was written.
   */
  async function saveKey(tool: KeyedTool): Promise<void> {
    const r = keyRows.get(tool);
    if (r === undefined) return;
    const key = r.input.value.trim();
    if (key === '') return;
    keyErr(tool, null);
    r.save.disabled = true;
    try {
      await api.saveKey(tool, key);
      r.input.value = '';
      if (r.input.type === 'text') toggleShow(tool);
      keyStatus = withSaved(keyStatus, tool, true);
      log.info(`key saved for ${tool}`);
    } catch (e) {
      // The server's sentence is written for the user; it never echoes the value.
      keyErr(tool, keyFailure(e, 'That key was not saved.'));
    } finally {
      syncKeyRow(tool);
    }
  }

  /** Forget the stored key. An environment variable set outside the app stays. */
  async function removeKey(tool: KeyedTool): Promise<void> {
    const r = keyRows.get(tool);
    if (r === undefined) return;
    keyErr(tool, null);
    r.remove.disabled = true;
    try {
      await api.deleteKey(tool);
      keyStatus = withSaved(keyStatus, tool, false);
      log.info(`key cleared for ${tool}`);
    } catch (e) {
      keyErr(tool, keyFailure(e, 'That key was not removed.'));
    } finally {
      syncKeyRow(tool);
    }
  }

  /** The status bag with ONE tool's saved bit replaced (never mutated in place). */
  function withSaved(cur: KeyStatus | null, tool: KeyedTool, saved: boolean): KeyStatus {
    const base: KeyStatus = cur ?? {
      saved: { claude: false, gemini: false, grok: false },
      env: { claude: false, gemini: false, grok: false },
    };
    return { saved: { ...base.saved, [tool]: saved }, env: { ...base.env } };
  }

  /** Re-read which keys exist. Never throws: a failed read leaves the rows blank. */
  function refreshKeys(): void {
    void api
      .getKeys()
      .then((s) => {
        keyStatus = s;
        syncKeyRows();
      })
      .catch(() => {
        // Nothing to say: the rows simply claim no key.
      });
  }

  /**
   * Empty every key field, drop its error and put it back to hidden. Run on
   * BOTH open and close: a key typed and never saved must not sit in an input's
   * `.value` for the rest of the page's life — a credential the user abandoned
   * is one the app stops holding, in the same gesture that abandons it.
   */
  function clearKeyFields(): void {
    for (const tool of keyRows.keys()) {
      const r = keyRows.get(tool);
      if (r === undefined) continue;
      r.input.value = '';
      if (r.input.type === 'text') toggleShow(tool);
      keyErr(tool, null);
    }
  }

  return { keyRows, syncKeyRows, refreshKeys, clearKeyFields };
}
