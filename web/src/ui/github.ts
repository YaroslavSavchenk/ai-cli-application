/**
 * GitHub connection (Phase 2b) — the shared status controller, the top-bar
 * chip, and the New Project dialog's GitHub tab panel, all in one cohesive
 * module (the dialog and main.ts both consume it).
 *
 * TWO CREDENTIAL PATHS (2026-07-25, user's decision): the OAuth device flow and
 * a token the user pastes. One credential at a time; `status.source` says which
 * is live, and everything the user must do differently — above all WHERE to
 * revoke — branches on it.
 *
 * HONESTY (load-bearing):
 *   - Every state is driven by GET /api/github/status. `deviceFlowAvailable`
 *     reports whether the server has an OAuth client id (env
 *     AI_SM_GITHUB_CLIENT_ID — documented in the README, never NAMED in the UI
 *     per the 2026-07-25 copy rule). It hides the Connect BUTTON and nothing
 *     else: the paste affordance stays, because a pasted token needs no client
 *     id and that is precisely the situation it exists for.
 *   - The access token is 100% server-side. It is never displayed and never
 *     returned; the ONE inbound flow (POST /api/github/token) reads the pasted
 *     value straight out of the field into the request body, clears the field,
 *     and keeps NO copy anywhere — see submitToken().
 *   - Storage copy has a hard ceiling (design gate): stored on this machine in
 *     the app's data folder, readable by your own user account. Never
 *     "keychain", "encrypted", "secure" or "vault" — there is no keyring in
 *     this environment and 0600 does not hold against the Windows side of WSL.
 *   - Disconnect only drops the LOCAL credential; a device-flow grant and a
 *     personal access token are revoked on DIFFERENT GitHub screens
 *     (revokeNote), and telling the user the wrong one would leave a live
 *     credential they believe is dead.
 *   - Phase 2c wires the per-repo clone/open action + the "+ New repo" form:
 *     a real POST /api/github/clone and a create->clone chain over POST
 *     /api/github/repos. Clone is a SLOW synchronous call — an HONEST
 *     indeterminate "cloning…" spinner shows while awaiting (NEVER a fake
 *     percentage; the prototype's faked % bar is deliberately dropped). Errors
 *     (409 folder exists / 422 name taken / 502) render inline.
 *
 * Untrusted display: login, repo fullName/description/language, userCode,
 * verificationUri, and the created repo's name all render via textContent —
 * never innerHTML.
 *
 * Poll cadence: FAST (~2.5 s) ONLY while connecting OR while the dialog's
 * GitHub tab is open; otherwise PAUSED. A single status fetch on chip mount
 * (initGithub) and on tab open keeps the chip honest without hammering a
 * disconnected/closed app.
 *
 * This module owns the DOM, the timers, and the api/state calls ONLY. The pure
 * presentation decisions it renders — chip view, expiry/relative-time formats,
 * language colors, cadence intervals, clone-error copy — live in
 * ./github-model.ts, which is DOM-free and unit-tested.
 */
import type { GithubRepo, GithubStatus, Project } from '../../../shared/protocol.ts';
import * as api from '../api.ts';
import * as st from '../state.ts';
import { el, button, armButton } from './util.ts';
import {
  GH_SEARCH_DEBOUNCE_MS,
  chipView,
  clonedProject,
  cloneErrText,
  deviceCardCopy,
  expiryTickMs,
  fmtExpiry,
  fmtTokenExpiry,
  langColor,
  ownerDest,
  pollIntervalMs,
  relTime,
  rememberNote,
  rememberSample,
  revokeNote,
  scopesNote,
  sourceLabel,
  storageNote,
  tokenErrText,
} from './github-model.ts';

// ---------------------------------------------------------------------------
// Shared controller state
// ---------------------------------------------------------------------------

let status: GithubStatus | null = null; // null = not yet fetched
let repos: GithubRepo[] = [];
type RepoState = 'idle' | 'loading' | 'loaded' | 'error';
let repoState: RepoState = 'idle';
let repoErr = '';
let reposVersion = 0; // bumps whenever the repo list/state changes (list rebuild gate)

const listeners = new Set<() => void>();
let timer: number | null = null;
let tabOpen = false;
let inFlight = false;
let repoToken = 0;

/**
 * V-4: a connection that DROPS on its own — an expired or revoked token, or one
 * that lost access — used to flip the UI to "disconnected" with no explanation,
 * which with user-pasted tokens will be routine. These two flags separate that
 * from a disconnect the user asked for, so the panel can say what happened.
 * Both are per-run observations: after a reload the status is simply
 * disconnected and we do NOT invent a reason for it.
 */
let userDropped = false;
let credentialLost = false;

// Phase 2c: repos with a clone in flight, keyed by fullName. Lives OUTSIDE the
// row DOM (like util.ArmedSet) so a per-row "cloning…" state survives a list
// rebuild (search / repo-list reload) instead of being wiped by replaceChildren.
const cloning = new Set<string>();

function emit(): void {
  for (const cb of listeners) cb();
}

// ---------------------------------------------------------------------------
// Phase 2c helpers: home resolution + ApiError narrowing (the destination path,
// already-cloned detection, and the error copy itself live in github-model.ts).
// ---------------------------------------------------------------------------

/**
 * Real $HOME, resolved ONCE from GET /api/fs/list (the same source
 * newproject.ts uses — NEVER hardcoded `/home/...`) and cached. Retried on
 * every call until it succeeds; null until then (clone/create surface a
 * "couldn't resolve your home directory" error rather than guessing a path).
 */
let homeDir: string | null = null;

async function ensureHome(): Promise<string | null> {
  if (homeDir !== null) return homeDir;
  try {
    const res = await api.fsList(); // no path → backend's $HOME
    if (res.path !== '') homeDir = res.path;
  } catch {
    // Leave null — the caller reports it; a later call retries.
  }
  return homeDir;
}

/**
 * Honest clone-error copy: prefer the server's real `{error}` message; fall
 * back to friendly text only for a bare `HTTP <status>` (no body) — that
 * status→copy mapping lives in github-model.cloneErrText.
 */
function cloneErr(e: unknown): string {
  if (e instanceof api.ApiError) return cloneErrText(e.status, e.message);
  return e instanceof Error ? e.message : String(e);
}

function onGithubUpdate(cb: () => void): void {
  listeners.add(cb);
}

/** Fast poll while connecting or while the dialog's GitHub tab is open (paused otherwise). */
function syncTimer(): void {
  const ms = pollIntervalMs(tabOpen, status);
  if (ms !== null) {
    if (timer === null) timer = window.setInterval(() => void poll(), ms);
  } else if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/** Apply a fresh (or optimistic) status: fire transitions, notify, resync poll. */
function applyStatus(next: GithubStatus): void {
  const prev = status;
  status = next;
  if (next.state === 'connected' && prev?.state !== 'connected') {
    credentialLost = false;
    void loadRepos(''); // load the list once on reaching connected
  }
  if (next.state !== 'connected' && prev?.state === 'connected') {
    repos = [];
    repoState = 'idle';
    reposVersion++;
    // Only an UNASKED-FOR drop is news (V-4); a disconnect the user pressed is not.
    // Nor is the drop the "remember this token" toggle CREATES: a credential the
    // user chose not to store lives only in the backend process, so a plain
    // restart ends it exactly this way. Saying "expired, revoked, or lost access"
    // there would name three causes we know to be false — and could send the user
    // to revoke a healthy token. `prev.persisted === false` is the server's own
    // report of that choice.
    credentialLost = !userDropped && prev.persisted !== false;
    userDropped = false;
  }
  emit();
  syncTimer();
}

async function poll(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    applyStatus(await api.githubStatus());
  } catch {
    // Soft: keep last-known status (chip/panel stand); the health probe lives
    // in the main session poll, not here.
  } finally {
    inFlight = false;
  }
}

async function loadRepos(q: string): Promise<void> {
  const mine = ++repoToken;
  repoState = 'loading';
  reposVersion++;
  emit();
  try {
    const res = await api.githubRepos(q);
    if (mine !== repoToken) return; // superseded by a newer query
    repos = res.repos;
    repoState = 'loaded';
    reposVersion++;
    emit();
  } catch (e) {
    if (mine !== repoToken) return;
    repoErr = e instanceof Error ? e.message : String(e);
    repoState = 'error';
    reposVersion++;
    emit();
  }
}

/** Fetch status once at boot so the chip is honest from the first paint. */
export function initGithub(): void {
  void poll();
}

/** The dialog's GitHub tab opened/closed — drives the fast/paused cadence. */
function setTabOpen(open: boolean): void {
  tabOpen = open;
  syncTimer();
  if (open) void poll();
}

// ---------------------------------------------------------------------------
// Top-bar chip
// ---------------------------------------------------------------------------

/**
 * A .tb-btn with a status dot + mono label reflecting GithubStatus:
 *   status unknown → faint dot + "GitHub"
 *   disconnected   → gray dot + "Connect GitHub"
 *   connecting     → amber dot + "connecting…"
 *   connected      → green dot + "@login" + a `token` / `sign-in` tag
 * The tag is V-5: the two credentials are disconnected on different GitHub
 * screens, so the chip has to say which one is live, not only that one is.
 * Clicking always opens the New Project dialog on its GitHub tab.
 */
export function createGithubChip(openTab: () => void): HTMLButtonElement {
  const chip = button('tb-gh', '', openTab);
  chip.setAttribute('aria-haspopup', 'dialog');
  // The avatar is the account's own initial — decorative next to the name the
  // chip prints in full, so it is hidden from a screen reader.
  const avatar = el('span', 'tb-gh-av');
  avatar.setAttribute('aria-hidden', 'true');
  const lb = el('span', 'tb-gh-lb');
  chip.append(avatar, lb);

  function render(): void {
    const v = chipView(status);
    avatar.textContent = v.initial; // derived from the untrusted login → textContent
    lb.textContent = v.label; // untrusted login → textContent
    chip.setAttribute('aria-label', v.aria);
    chip.title = v.aria;
  }

  render();
  onGithubUpdate(render);
  return chip;
}

// ---------------------------------------------------------------------------
// New Project dialog — GitHub tab panel
// ---------------------------------------------------------------------------

export interface GithubPanel {
  /** The panel root (a .np-panel sibling of the blank/clone panels). */
  el: HTMLElement;
  /** The dialog switched to / away from the GitHub tab. */
  setActive(active: boolean): void;
}

export interface GithubPanelOptions {
  /**
   * A repo row's "open" action fired: the repo is already a local project.
   * The host (newproject.ts) closes the dialog and reveals it in the Projects
   * drawer. Absent → "open" is inert (still shown, just no navigation).
   */
  onOpenProject?: (project: Project) => void;
}

function ghAvatar(text: string): HTMLElement {
  const a = el('div', 'gh-avatar', text);
  a.setAttribute('aria-hidden', 'true');
  return a;
}

export function createGithubPanel(opts: GithubPanelOptions = {}): GithubPanel {
  const root = el('div', 'np-panel');
  root.hidden = true;
  let active = false;

  // --- checking (status not yet known) --------------------------------------
  const checkingCard = el('div', 'gh-card');
  const checkRow = el('div', 'gh-wait');
  const checkSpin = el('span', 'np-spinner');
  checkSpin.setAttribute('aria-hidden', 'true');
  checkRow.append(checkSpin, el('span', '', 'checking GitHub…'));
  checkingCard.append(checkRow);

  // --- the connection stopped working on its own (V-4) -----------------------
  // Shown above the disconnected state when a LIVE connection dropped without
  // the user asking — the routine outcome of an expiring pasted token. We say
  // the three things it can be and stop: the server tells us it is gone, not
  // why, and inventing a single cause would be a lie.
  const lostCard = el(
    'div',
    'gh-lost',
    'GitHub stopped accepting the stored credential. It may have expired, been revoked, or lost access to your repositories. Connect again below.',
  );
  lostCard.setAttribute('role', 'status');
  lostCard.hidden = true;

  // --- disconnected: path 1, sign in with GitHub ------------------------------
  const disconnectedCard = el('div', 'gh-card');
  // The mark belongs to the sign-in ACTION. With no sign-in button this card is
  // a heading plus an explanation, and 44px of decoration would push the one
  // control that does work below the fold — so it is hidden there.
  const connectAvatar = ghAvatar('GH');
  disconnectedCard.append(connectAvatar);
  disconnectedCard.append(el('div', 'gh-title', 'Connect your GitHub account'));
  const connectBody = el('div', 'gh-body', '');
  disconnectedCard.append(connectBody);
  const connectBtn = button('gh-connect', 'Connect with GitHub', () => void onConnect());
  disconnectedCard.append(connectBtn);
  const connectErr = el('div', 'gh-msg is-err');
  connectErr.setAttribute('role', 'alert');
  connectErr.hidden = true;
  disconnectedCard.append(connectErr);
  // COPY RULE (scope doc, 2026-07-25): no config-variable names in the UI — the
  // setting's actual name lives in the README, where acting on it belongs. This
  // note REPLACES the old dormant "not set up on this server" card, which used
  // to take over the whole panel and would now hide the one path that still
  // works on a server without an OAuth App.
  const noDeviceNote = el('div', 'gh-body', '');
  noDeviceNote.hidden = true;
  disconnectedCard.append(noDeviceNote);
  // Honest about the grant's reach WITHOUT naming the OAuth scope (copy rule):
  // "read and write every repository on the account" is what it means to a
  // person — and it is the comparison that makes the recommendation below land.
  const deviceFine = el('div', 'gh-fine', '');
  disconnectedCard.append(deviceFine);

  // --- disconnected: path 2, paste a token -----------------------------------
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
  const tokenField = el('label', 'launch-field gh-tokenfield');
  tokenField.append(el('span', 'launch-lb', 'GitHub token'));
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
  const rememberRow = button('status-row gh-remember', '', () => {
    if (adding) return;
    remember = !remember;
    syncRemember();
  });
  const rememberBox = el('span', 'status-box');
  rememberBox.setAttribute('aria-hidden', 'true');
  const rememberSampleEl = el('span', 'status-sample', '');
  rememberRow.append(rememberBox, el('span', 'status-lb', 'Remember this token'), rememberSampleEl);
  const rememberFine = el('div', 'gh-fine gh-remember-note', '');
  tokenCard.append(rememberRow, rememberFine);

  const tokenRow = el('div', 'gh-tokenrow');
  const tokenBusy = el('div', 'np-busy');
  tokenBusy.hidden = true;
  const tokenSpin = el('span', 'np-spinner');
  tokenSpin.setAttribute('aria-hidden', 'true');
  tokenBusy.append(tokenSpin, el('span', '', 'checking with GitHub…'));
  const tokenBtn = button('gh-connect gh-addtoken', 'Add token', () => void submitToken());
  tokenRow.append(tokenBusy, el('span', 'launch-gap'), tokenBtn);
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

  // --- connecting ------------------------------------------------------------
  const connectingCard = el('div', 'gh-card');
  const waitRow = el('div', 'gh-wait');
  const waitSpin = el('span', 'np-spinner');
  waitSpin.setAttribute('aria-hidden', 'true');
  waitRow.append(waitSpin, el('span', '', 'Waiting for authorization…'));
  connectingCard.append(waitRow);
  const instruct = el('div', 'gh-instruct');
  const uriSpan = el('span', 'gh-uri'); // verificationUri (untrusted → textContent)
  instruct.append(document.createTextNode('Open '), uriSpan, document.createTextNode(' and enter this code:'));
  connectingCard.append(instruct);
  const codeEl = el('div', 'gh-code'); // userCode (untrusted → textContent)
  connectingCard.append(codeEl);
  const expiryEl = el('div', 'gh-expiry');
  connectingCard.append(expiryEl);
  const cancelBtn = button('gh-mini', 'Cancel', () => void drop());
  connectingCard.append(cancelBtn);

  // --- connected -------------------------------------------------------------
  const connectedWrap = el('div', 'gh-connected');
  const meRow = el('div', 'gh-me');
  const meAvatar = ghAvatar('?');
  meAvatar.classList.add('is-me', 'is-sm');
  const meCol = el('div', 'gh-me-col');
  const meName = el('span', 'gh-me-name', '');
  const meSub = el('span', 'gh-me-sub', 'connected');
  meCol.append(meName, meSub);
  const disconnectBtn = button('gh-mini', 'disconnect');
  armButton(disconnectBtn, 'confirm disconnect', () => void drop());
  meRow.append(meAvatar, meCol, el('span', 'launch-gap'), disconnectBtn);
  connectedWrap.append(meRow);
  // V-2: a token can be for the WRONG account, and nothing else in the app would
  // say so — clones and newly created repositories would just quietly land
  // there. Shown for a pasted token only; with the device flow the user signed
  // in themselves and already knows whose account it is.
  const verifyNote = el(
    'div',
    'gh-verify',
    'Check this is the account you meant — clones and new repositories land in it.',
  );
  verifyNote.hidden = true;
  connectedWrap.append(verifyNote);
  // What this credential actually is: where it is kept, when it expires, and
  // (classic tokens only) what GitHub says it can do. Every line renders only
  // when the server actually reported it.
  const factsEl = el('div', 'gh-facts');
  connectedWrap.append(factsEl);
  // REQUIRED honest note — the backend can't self-revoke either credential, and
  // they are revoked on DIFFERENT GitHub screens (revokeNote, design gate IV-3).
  const revokeEl = el('div', 'gh-revoke-note', '');
  connectedWrap.append(revokeEl);
  // search + "+ New repo" (Phase 2c) share one row
  const actionsRow = el('div', 'gh-actions');
  const searchInput = el('input', 'gh-search');
  searchInput.placeholder = 'search repositories…';
  searchInput.spellcheck = false;
  searchInput.autocomplete = 'off';
  searchInput.setAttribute('aria-label', 'search repositories');
  const newRepoBtn = button('gh-newrepo', '+ New repo', () => toggleNewForm());
  newRepoBtn.setAttribute('aria-expanded', 'false');
  newRepoBtn.setAttribute('aria-controls', 'gh-newform');
  newRepoBtn.title = 'create a new repository on GitHub and clone it locally';
  actionsRow.append(searchInput, newRepoBtn);
  connectedWrap.append(actionsRow);

  // --- "+ New repo" inline form (create -> clone chain) ----------------------
  const newForm = el('div', 'gh-newform');
  newForm.id = 'gh-newform';
  newForm.hidden = true;
  newForm.setAttribute('role', 'group');
  newForm.setAttribute('aria-label', 'create a new GitHub repository');
  const newNameInput = el('input', 'gh-newinput');
  newNameInput.placeholder = 'new-repo-name';
  newNameInput.spellcheck = false;
  newNameInput.autocomplete = 'off';
  newNameInput.setAttribute('aria-label', 'new repository name');
  const newDescInput = el('input', 'gh-newinput');
  newDescInput.placeholder = 'description (optional)';
  newDescInput.spellcheck = false;
  newDescInput.autocomplete = 'off';
  newDescInput.setAttribute('aria-label', 'new repository description (optional)');
  const newRow = el('div', 'gh-newrow');
  const privBtn = button('gh-newbtn is-toggle', 'private', () => togglePrivate());
  const newNote = el('span', 'gh-newnote', 'creates it on GitHub and clones it locally');
  const newCancel = button('gh-newbtn is-cancel', 'Cancel', () => closeNewForm());
  const newCreate = button('gh-newbtn is-create', 'Create', () => void submitNewRepo());
  newRow.append(privBtn, newNote, el('span', 'launch-gap'), newCancel, newCreate);
  const newErr = el('div', 'gh-newerr');
  newErr.setAttribute('role', 'alert');
  newErr.hidden = true;
  const newBusy = el('div', 'np-busy');
  newBusy.hidden = true;
  const newBusySpin = el('span', 'np-spinner');
  newBusySpin.setAttribute('aria-hidden', 'true');
  const newBusyLabel = el('span', '', '');
  newBusy.append(newBusySpin, newBusyLabel);
  newForm.append(newNameInput, newDescInput, newRow, newErr, newBusy);
  newNameInput.addEventListener('input', () => {
    newNameInput.classList.remove('is-err');
    newErr.hidden = true;
  });
  connectedWrap.append(newForm);

  const reposEl = el('div', 'gh-repos');
  reposEl.setAttribute('aria-live', 'polite');
  connectedWrap.append(reposEl);

  root.append(checkingCard, lostCard, disconnectedCard, tokenCard, connectingCard, connectedWrap);

  // ---- "+ New repo" form state + handlers -----------------------------------
  let newOpen = false;
  let newPrivate = true;
  let creating = false;

  function syncPrivate(): void {
    privBtn.textContent = newPrivate ? 'private' : 'public';
    privBtn.setAttribute('aria-pressed', newPrivate ? 'true' : 'false');
    privBtn.setAttribute(
      'aria-label',
      `repository visibility: ${newPrivate ? 'private' : 'public'} — activate to make it ${
        newPrivate ? 'public' : 'private'
      }`,
    );
  }

  function togglePrivate(): void {
    if (creating) return;
    newPrivate = !newPrivate;
    syncPrivate();
  }

  function toggleNewForm(): void {
    if (newOpen) closeNewForm();
    else openNewForm();
  }

  function openNewForm(): void {
    newOpen = true;
    newForm.hidden = false;
    newRepoBtn.setAttribute('aria-expanded', 'true');
    newNameInput.value = '';
    newDescInput.value = '';
    newNameInput.classList.remove('is-err');
    newPrivate = true;
    syncPrivate();
    newErr.hidden = true;
    newNameInput.focus();
  }

  function closeNewForm(): void {
    if (creating) return; // never collapse mid create/clone
    newOpen = false;
    newForm.hidden = true;
    newRepoBtn.setAttribute('aria-expanded', 'false');
    newErr.hidden = true;
    newRepoBtn.focus();
  }

  /** Honest indeterminate busy across the create->clone chain (no fake %). */
  function setCreating(on: boolean, label = ''): void {
    creating = on;
    newBusy.hidden = !on;
    newBusyLabel.textContent = label;
    newNameInput.disabled = on;
    newDescInput.disabled = on;
    privBtn.disabled = on;
    newCancel.disabled = on;
    newCreate.disabled = on;
    newRepoBtn.disabled = on;
    searchInput.disabled = on;
  }

  async function submitNewRepo(): Promise<void> {
    if (creating) return;
    const name = newNameInput.value.trim();
    newErr.hidden = true;
    newNameInput.classList.remove('is-err');
    if (name === '') {
      newErr.textContent = 'a repository name is required';
      newErr.hidden = false;
      newNameInput.classList.add('is-err');
      newNameInput.focus();
      return;
    }
    const home = await ensureHome();
    if (home === null) {
      newErr.textContent = 'couldn’t resolve your home directory — try again';
      newErr.hidden = false;
      return;
    }
    const description = newDescInput.value.trim();
    setCreating(true, 'creating…');
    let created: GithubRepo;
    try {
      created = await api.githubCreateRepo({
        name,
        private: newPrivate,
        ...(description !== '' ? { description } : {}),
      });
    } catch (e) {
      setCreating(false);
      if (e instanceof api.ApiError && e.status === 422) {
        newErr.textContent = e.message; // "…the name may already be taken"
        newErr.hidden = false;
        newNameInput.classList.add('is-err');
        newNameInput.focus();
      } else {
        newErr.textContent = e instanceof Error ? e.message : String(e);
        newErr.hidden = false;
      }
      return;
    }
    // CHAIN: create succeeded → clone the fresh repo into
    // <home>/projects/<owner>/<repo>. Owner-qualified like every other clone
    // this panel starts (settled 2026-07-25): the owner is known for certain
    // here — it comes back in the create response — and the destination is
    // ours, not user-chosen, which is exactly the pair of conditions that keeps
    // the URL-clone tab out of this rule. `created.name` (not the typed `name`)
    // is authoritative: GitHub may normalize what it accepted, and the path has
    // to match what the repo list will compare against.
    newBusyLabel.textContent = 'cloning…';
    try {
      const project = await api.githubClone({
        cloneUrl: created.cloneUrl,
        dest: ownerDest(home, created.owner, created.name),
        name: created.name,
      });
      st.setProjects([...st.state.projects, project]);
      setCreating(false);
      closeNewForm();
    } catch (e) {
      // The repo WAS created on GitHub; only the local clone failed — say so.
      setCreating(false);
      newErr.textContent = `repo created on GitHub, but the clone failed: ${cloneErr(e)}`;
      newErr.hidden = false;
    }
    // Refresh the list either way so the new repo appears (open if cloned,
    // clone-able if the clone half failed).
    void loadRepos(searchInput.value.trim());
  }

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
    credentialLost = false;
    remember = true; // back to the decided default for the next paste
    syncRemember();
    applyStatus(next); // resolved @login is on screen as part of accepting it
    if (active && next.state === 'connected') searchInput.focus();
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

  // ---- handlers -------------------------------------------------------------
  async function onConnect(): Promise<void> {
    connectBtn.disabled = true;
    connectErr.hidden = true;
    try {
      const d = await api.githubDevice();
      // Optimistic: the server sets connecting synchronously, so show the code
      // immediately, then confirm via poll.
      applyStatus({
        deviceFlowAvailable: true,
        state: 'connecting',
        userCode: d.userCode,
        verificationUri: d.verificationUri,
        expiresAt: d.expiresAt,
      });
      void poll();
    } catch (e) {
      if (e instanceof api.ApiError && e.status === 409) {
        void poll(); // reveals deviceFlowAvailable:false → the button goes away
        connectErr.textContent =
          'Signing in with GitHub is not set up on this server — see the project README. You can still paste a token below.';
      } else {
        connectErr.textContent = e instanceof Error ? e.message : String(e);
      }
      connectErr.hidden = false;
    } finally {
      connectBtn.disabled = false;
    }
  }

  /** Cancel a pending flow / disconnect — both drop the LOCAL token, then re-poll. */
  async function drop(): Promise<void> {
    userDropped = true; // an asked-for disconnect is not a lost credential (V-4)
    credentialLost = false;
    try {
      await api.githubDisconnect();
    } catch {
      // Soft: the poll below reconciles the real state either way.
    }
    repos = [];
    repoState = 'idle';
    reposVersion++;
    void poll();
  }

  // ---- render ---------------------------------------------------------------
  let lastReposVersion = -1;

  function renderExpiry(): void {
    expiryEl.textContent = fmtExpiry(status?.expiresAt, Date.now());
  }

  /**
   * The connected credential's facts, one mono line each, and ONLY the ones the
   * server actually reported. Absent `scopes` says nothing at all about
   * permissions — for a fine-grained token GitHub does not report them, and
   * rendering that absence as "no permissions" would be the opposite of true
   * (design gate V-1).
   */
  function renderFacts(s: GithubStatus): void {
    const lines: HTMLElement[] = [];
    const storage = storageNote(s.persisted);
    if (storage !== '') lines.push(el('div', 'gh-fact', storage));
    const exp = fmtTokenExpiry(s.expiresAt, Date.now());
    if (exp !== null) lines.push(el('div', `gh-fact${exp.warn ? ' is-warn' : ''}`, exp.text));
    const scopes = scopesNote(s.scopes); // untrusted strings → textContent (el)
    if (scopes !== null) lines.push(el('div', 'gh-fact', scopes));
    factsEl.replaceChildren(...lines);
    factsEl.hidden = lines.length === 0;
  }

  function render(): void {
    const s = status;
    checkingCard.hidden = s !== null;
    const disconnected = s !== null && s.state === 'disconnected';
    lostCard.hidden = !(disconnected && credentialLost);
    disconnectedCard.hidden = !disconnected;
    tokenCard.hidden = !disconnected; // the paste path is offered whenever it applies
    connectingCard.hidden = !(s !== null && s.state === 'connecting');
    connectedWrap.hidden = !(s !== null && s.state === 'connected');

    if (disconnected) {
      // deviceFlowAvailable hides the BUTTON, never the card and never the
      // paste path — a server with no OAuth App is exactly who needs the latter.
      const copy = deviceCardCopy(s.deviceFlowAvailable);
      connectBody.textContent = copy.body;
      connectAvatar.hidden = !s.deviceFlowAvailable;
      connectBtn.hidden = !s.deviceFlowAvailable;
      deviceFine.textContent = copy.fine;
      deviceFine.hidden = copy.fine === '';
      noDeviceNote.textContent = copy.note;
      noDeviceNote.hidden = copy.note === '';
      tokenTitle.textContent = copy.tokenTitle;
      syncRemember();
    }
    if (s !== null && s.state === 'connecting') {
      uriSpan.textContent = s.verificationUri ?? 'github.com/login/device';
      codeEl.textContent = s.userCode ?? '—';
      renderExpiry();
    }
    if (s !== null && s.state === 'connected') {
      meName.textContent = `@${s.login ?? ''}`;
      meAvatar.textContent = (s.login ?? '?').slice(0, 1).toUpperCase() || '?';
      const how = sourceLabel(s.source);
      meSub.textContent = how === '' ? 'Connected' : `Connected, ${how}`;
      verifyNote.hidden = s.source !== 'pat';
      renderFacts(s);
      revokeEl.textContent = revokeNote(s.source);
      // Rebuild the list ONLY when it actually changed — keeps the search box's
      // focus and the disconnect button's armed state across status polls.
      if (reposVersion !== lastReposVersion) {
        lastReposVersion = reposVersion;
        renderRepos();
      }
    }
    syncExpiryTimer();
    // The first status landed while the tab was open with nothing to focus yet.
    if (awaitingFocus && active && s !== null) focusFirst();
  }

  function renderRepos(): void {
    if (repoState === 'loading' && repos.length === 0) {
      reposEl.replaceChildren(el('div', 'gh-msg', 'loading repositories…'));
      return;
    }
    if (repoState === 'error') {
      reposEl.replaceChildren(el('div', 'gh-msg is-err', `couldn’t load repositories: ${repoErr}`));
      return;
    }
    if (repos.length === 0) {
      reposEl.replaceChildren(el('div', 'gh-msg', 'no repositories match'));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const r of repos) frag.append(repoCard(r));
    reposEl.replaceChildren(frag);
  }

  function repoCard(r: GithubRepo): HTMLElement {
    const card = el('div', 'gh-repo');
    const top = el('div', 'gh-repo-top');
    top.append(el('span', 'gh-repo-name', r.fullName)); // untrusted → textContent
    top.append(
      el('span', `gh-badge ${r.private ? 'is-private' : 'is-public'}`, r.private ? 'private' : 'public'),
    );
    // Phase 2c: per-repo clone/open action, pinned right. `actionSlot` holds the
    // clone|open button; `statusSlot` holds the "cloning…" indicator or an error.
    const actionSlot = el('span', 'gh-repo-actslot');
    top.append(actionSlot);
    card.append(top);

    if (r.description !== undefined && r.description !== '') {
      card.append(el('div', 'gh-repo-desc', r.description)); // untrusted → textContent
    }

    const meta = el('div', 'gh-repo-meta');
    let hasLang = false;
    if (r.language !== undefined && r.language !== '') {
      const color = langColor(r.language);
      if (color !== undefined) {
        const d = el('span', 'gh-lang-dot');
        d.style.background = color; // Linguist DATA color, not a palette token
        d.setAttribute('aria-hidden', 'true');
        meta.append(d);
      }
      meta.append(el('span', 'gh-meta-t', r.language)); // untrusted → textContent
      hasLang = true;
    }
    const pushed = relTime(r.pushedAt, Date.now());
    if (pushed !== '') {
      // A comma, attached to the text it follows — never a separator element
      // in its own flex slot (A2 copy rules).
      meta.append(el('span', 'gh-meta-t', `${hasLang ? ', ' : ''}pushed ${pushed}`));
    }
    if (meta.childElementCount > 0) card.append(meta);

    const statusSlot = el('div', 'gh-repo-status');
    statusSlot.hidden = true;
    card.append(statusSlot);

    let rowErr = '';

    /** Repaint the action + status area from current state (cloning set + projects). */
    function paint(): void {
      const inFlightClone = cloning.has(r.fullName);
      const project = clonedProject(r, homeDir, st.state.projects);
      actionSlot.replaceChildren();
      statusSlot.replaceChildren();
      statusSlot.hidden = true;

      if (inFlightClone) {
        const b = button('gh-repo-act is-clone', 'clone');
        b.disabled = true;
        actionSlot.append(b);
        const busy = el('div', 'np-busy');
        const spin = el('span', 'np-spinner');
        spin.setAttribute('aria-hidden', 'true');
        busy.append(spin, el('span', '', 'cloning…'));
        statusSlot.append(busy);
        statusSlot.hidden = false;
        return;
      }

      if (project !== null) {
        const b = button('gh-repo-act is-open', 'open', () => opts.onOpenProject?.(project));
        b.setAttribute('aria-label', `open ${r.name} — reveal it in the Projects drawer`);
        b.title = 'already cloned — open in the Projects drawer';
        actionSlot.append(b);
      } else {
        const b = button('gh-repo-act is-clone', 'clone', () => void startClone());
        b.setAttribute('aria-label', `clone ${r.fullName} into your projects folder`);
        b.title = 'clone into your projects folder, grouped by owner, and register it as a project';
        actionSlot.append(b);
      }

      if (rowErr !== '') {
        statusSlot.append(el('div', 'gh-repo-err', rowErr));
        statusSlot.hidden = false;
      }
    }

    async function startClone(): Promise<void> {
      if (cloning.has(r.fullName)) return;
      rowErr = '';
      const home = await ensureHome();
      if (home === null) {
        rowErr = 'couldn’t resolve your home directory — try again';
        paint();
        return;
      }
      cloning.add(r.fullName);
      paint();
      try {
        const project = await api.githubClone({
          cloneUrl: r.cloneUrl,
          // OWNER-QUALIFIED (settled 2026-07-25): <home>/projects/<owner>/<repo>,
          // so two same-basename repos from different owners can both be cloned.
          dest: ownerDest(home, r.owner, r.name),
          name: r.name,
        });
        st.setProjects([...st.state.projects, project]); // drawer + open-state update
        cloning.delete(r.fullName);
        paint(); // flips this row to "open"
        actionSlot.querySelector('button')?.focus(); // keep focus reachable
      } catch (e) {
        cloning.delete(r.fullName);
        rowErr = cloneErr(e);
        paint();
      }
    }

    paint();
    return card;
  }

  // ---- expiry ticker (1 s while active + connecting) ------------------------
  let expTimer: number | null = null;
  function syncExpiryTimer(): void {
    const ms = expiryTickMs(active, status);
    if (ms !== null) {
      if (expTimer === null) expTimer = window.setInterval(renderExpiry, ms);
    } else if (expTimer !== null) {
      clearInterval(expTimer);
      expTimer = null;
    }
  }

  // ---- debounced repo search ------------------------------------------------
  let searchTimer: number | null = null;
  searchInput.addEventListener('input', () => {
    if (searchTimer !== null) clearTimeout(searchTimer);
    searchTimer = window.setTimeout(
      () => void loadRepos(searchInput.value.trim()),
      GH_SEARCH_DEBOUNCE_MS,
    );
  });

  /**
   * True while the tab is open but the first status has not landed, so the
   * panel still shows "checking GitHub…" and has nothing focusable. Without
   * this, a cold open left focus on <body> — behind the scrim — until the user
   * pressed Tab; render() now claims it the moment there IS a control.
   */
  let awaitingFocus = false;

  function focusFirst(): void {
    const s = status;
    if (s === null) {
      awaitingFocus = true; // still checking: take focus as soon as we can
      return;
    }
    awaitingFocus = false;
    if (s.state === 'disconnected') {
      // Whichever path this server can actually offer first.
      if (s.deviceFlowAvailable) connectBtn.focus();
      else tokenInput.focus();
    } else if (s.state === 'connecting') cancelBtn.focus();
    else if (s.state === 'connected') searchInput.focus();
  }

  function setActive(a: boolean): void {
    active = a;
    setTabOpen(a);
    if (a) {
      if (status?.state === 'connected') {
        if (repoState === 'idle') void loadRepos('');
        // Resolve $HOME so path-based already-cloned detection + the clone
        // destination are ready; rebuild the list once it lands (name-based
        // detection already works without it).
        if (homeDir === null) {
          void ensureHome().then(() => {
            if (active && status?.state === 'connected' && homeDir !== null) {
              reposVersion++;
              emit();
            }
          });
        }
      }
      render();
      focusFirst();
    } else {
      // Leaving the tab drops anything typed but not submitted: a pasted
      // credential never sits in a hidden field waiting for the next open
      // (II-3 — the field is the only place it ever lives client-side).
      tokenInput.value = '';
      tokenErr.hidden = true;
      tokenInput.classList.remove('is-err');
      awaitingFocus = false;
      syncExpiryTimer();
    }
  }

  syncRemember();
  onGithubUpdate(render);
  return { el: root, setActive };
}
