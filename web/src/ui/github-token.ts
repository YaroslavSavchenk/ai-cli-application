/**
 * The GitHub panel's second credential path: the "paste a token" card — the
 * field, `Remember this token`, the check with GitHub, and the warnings
 * around it (2026-07-25, user's decision; design gates II-1..II-3, V-3).
 *
 * Split from `ui/github.ts` (Quality part Q13, `.claude/plans/PLAN-QUALITY.md`),
 * code moved as it stood: it was a block of `createGithubPanel()`, which now
 * places the card and hands in the three things of the panel it touches
 * (`TokenCtx`). The credential's whole client-side lifetime is still ONE
 * function, `submitToken()`. Siblings: `github.ts` (the chip and the panel),
 * `github-newrepo.ts`, `github-state.ts`, `github-model.ts`.
 */
import type { GithubStatus } from '../../../shared/protocol.ts';
import * as api from '../api.ts';
import { el, button } from './util.ts';
import { rememberNote, rememberSample, tokenErrText } from './github-model.ts';
import { applyStatus, forgetCredentialLost } from './github-state.ts';

/** What the token card touches of the panel around it — nothing else. */
interface TokenCtx {
  /** The device-flow button: disabled while a token is being checked. */
  connectBtn: HTMLButtonElement;
  /** Is the panel's tab on screen? */
  isActive(): boolean;
  /** Hand the keyboard to the repo search (the token just connected). */
  focusSearch(): void;
}

interface TokenCard {
  card: HTMLElement;
  /** The card's title; its words follow the device-flow copy. */
  title: HTMLElement;
  input: HTMLInputElement;
  syncRemember(): void;
  /** Drop anything typed but not submitted, and its error. */
  forget(): void;
}

export function createTokenCard(ctx: TokenCtx): TokenCard {
  const { connectBtn } = ctx;

  // NOT a <form>, and the input carries NO name attribute (design gate II-1):
  // submitting from a click handler is how every other action in this codebase
  // works, and it means no browser save-password prompt fires — the Edge --app
  // fallback window is a full Edge profile with a password manager.
  const tokenCard = el('div', 'gh-token');
  tokenCard.setAttribute('role', 'group');
  tokenCard.setAttribute('aria-label', 'connect with a GitHub token');
  const tokenTitle = el('div', 'gh-title', '');
  tokenCard.append(tokenTitle);
  // THE most valuable sentence in this panel: a fine-grained token limited to
  // chosen repositories, with an expiry, is strictly safer than our own device
  // flow. "Contents" and "Metadata" are the permission names on GitHub's own
  // screens — instructions for GitHub's UI, like the device-flow URL, so they
  // are allowed under the no-code-in-the-UI rule.
  tokenCard.append(
    el(
      'div',
      'gh-body',
      'Recommended: create a fine-grained token on GitHub, limit it to the repositories you want this app to touch, and give it an expiry date. Grant it Contents (read and write); Metadata (read) comes with it.',
    ),
  );
  const tokenField = el('label', 'ap-field is-mono');
  tokenField.append(el('span', 'ap-lb', 'GitHub token'));
  const tokenInput = el('input', 'gh-tokeninput');
  tokenInput.type = 'password'; // II-1
  tokenInput.autocomplete = 'new-password'; // II-1: never offered as a saved login
  tokenInput.spellcheck = false; // II-1: no spell-check upload path
  tokenInput.placeholder = 'paste your token here';
  // II-2: the value is only ever read/written through the .value PROPERTY, which
  // does not reflect to the attribute — so the credential can never appear in
  // outerHTML, a DOM snapshot, or a copied element.
  tokenField.append(tokenInput);
  tokenCard.append(tokenField);

  // "remember this token" — the ONE control that removes the on-disk copy, so
  // what it does is spelled out underneath rather than implied by the label.
  let remember = true; // decided default: persisted (user's call, 2026-07-25)
  const rememberRow = button('ap-check', '', () => {
    if (adding) return;
    remember = !remember;
    syncRemember();
  });
  const rememberBox = el('span', 'ap-box');
  rememberBox.setAttribute('aria-hidden', 'true');
  const rememberSampleEl = el('span', 'ap-check-sub', '');
  rememberRow.append(
    rememberBox,
    el('span', 'ap-check-lb', 'Remember this token'),
    rememberSampleEl,
  );
  const rememberFine = el('div', 'gh-fine', '');
  tokenCard.append(rememberRow, rememberFine);

  const tokenRow = el('div', 'gh-tokenrow');
  const tokenBusy = el('div', 'ap-busy');
  tokenBusy.hidden = true;
  const tokenSpin = el('span', 'ap-spinner');
  tokenSpin.setAttribute('aria-hidden', 'true');
  tokenBusy.append(tokenSpin, el('span', '', 'Checking the token with GitHub'));
  // Neutral outline, not the accent: the tab shows exactly one accent primary,
  // and whenever this card is visible the accent belongs to Connect with GitHub
  // (the recommended path) — both cards show together while disconnected.
  const tokenBtn = button('btn-quiet', 'Add token', () => void submitToken());
  tokenRow.append(tokenBusy, tokenBtn);
  tokenCard.append(tokenRow);

  const tokenErr = el('div', 'gh-newerr');
  tokenErr.setAttribute('role', 'alert');
  tokenErr.hidden = true;
  tokenCard.append(tokenErr);

  // V-3: the social-engineering case the device flow does not have. Permanent,
  // in the same red the bypass-permission card uses for a warning that must
  // never fade out of view.
  tokenCard.append(
    el(
      'div',
      'gh-warn',
      'Never paste a token someone else gave you. A token you did not create yourself connects this app to their account.',
    ),
  );
  // The comparison that makes the recommendation above concrete, as a footnote:
  // it belongs BELOW the action, so the field and the button stay near the top
  // of the card instead of being pushed under four lines of fine print.
  tokenCard.append(
    el(
      'div',
      'gh-fine',
      'Narrower than signing in, which takes read and write on every repository of the account and usually does not expire. A token limited to selected repositories can list and clone them, but creating a brand-new repository from here needs a broader one.',
    ),
  );

  // ---- "paste a token" state + handler --------------------------------------
  let adding = false;

  function syncRemember(): void {
    rememberRow.setAttribute('aria-pressed', remember ? 'true' : 'false');
    rememberBox.textContent = remember ? '✓' : '';
    rememberSampleEl.textContent = rememberSample(remember);
    rememberFine.textContent = rememberNote(remember);
  }

  /** Honest indeterminate busy while the server checks the token with GitHub. */
  function setAdding(on: boolean): void {
    adding = on;
    tokenBusy.hidden = !on;
    tokenInput.disabled = on;
    tokenBtn.disabled = on;
    rememberRow.disabled = on;
    connectBtn.disabled = on;
  }

  /**
   * Hand the pasted token to the backend and forget it.
   *
   * THE CREDENTIAL'S ENTIRE CLIENT-SIDE LIFETIME IS THIS FUNCTION (design gate
   * II-3). It is read once out of the field, handed straight to the request,
   * and the field is cleared in the same frame; the local reference is dropped
   * the moment JSON.stringify has run. Nothing retains it: no module variable,
   * no closure kept alive by a timer, no error object (an ApiError carries the
   * SERVER's message), and deliberately NO retry buffer — a failed add means
   * the user pastes again, which is the honest cost of not keeping it around.
   */
  async function submitToken(): Promise<void> {
    if (adding) return;
    tokenErr.hidden = true;
    tokenInput.classList.remove('is-err');
    if (tokenInput.value.trim() === '') {
      tokenErr.textContent = 'paste a token first';
      tokenErr.hidden = false;
      tokenInput.classList.add('is-err');
      tokenInput.focus();
      return;
    }
    let token = tokenInput.value.trim(); // a pasted line often carries whitespace
    const rememberIt = remember;
    tokenInput.value = ''; // II-2/II-3: cleared before anything can await
    setAdding(true);
    let next: GithubStatus;
    try {
      const pending = api.githubToken({ token, remember: rememberIt });
      token = ''; // the request body owns it now; this frame does not
      next = await pending;
    } catch (e) {
      token = '';
      setAdding(false);
      tokenErr.textContent =
        e instanceof api.ApiError
          ? tokenErrText(e.status, e.message)
          : e instanceof Error
            ? e.message
            : String(e);
      tokenErr.hidden = false;
      tokenInput.focus();
      return;
    }
    setAdding(false);
    forgetCredentialLost();
    remember = true; // back to the decided default for the next paste
    syncRemember();
    applyStatus(next); // resolved @login is on screen as part of accepting it
    if (ctx.isActive() && next.state === 'connected') ctx.focusSearch();
  }

  tokenInput.addEventListener('input', () => {
    tokenInput.classList.remove('is-err');
    tokenErr.hidden = true;
  });
  // Enter submits from the keyboard. This adds no <form> and no form submission
  // — it is the same click-handler path the button takes.
  tokenInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submitToken();
    }
  });

  function forget(): void {
    tokenInput.value = '';
    tokenErr.hidden = true;
    tokenInput.classList.remove('is-err');
  }

  return { card: tokenCard, title: tokenTitle, input: tokenInput, syncRemember, forget };
}
