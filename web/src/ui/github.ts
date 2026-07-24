/**
 * GitHub connection (Phase 2b) — the shared status controller, the top-bar
 * chip, and the New Project dialog's GitHub tab panel, all in one cohesive
 * module (the dialog and main.ts both consume it).
 *
 * HONESTY (load-bearing):
 *   - Every state is driven by GET /api/github/status. The feature is DORMANT
 *     until the server has an OAuth client id (AI_SM_GITHUB_CLIENT_ID):
 *     status.configured === false renders an honest one-time-setup panel, never
 *     a dead Connect button that would 409 confusingly.
 *   - The access token is 100% server-side. It is NEVER requested, displayed,
 *     or expected here — no shape below carries it.
 *   - Disconnect only drops the LOCAL token; the public device-flow grant can
 *     only be fully revoked from GitHub settings (surfaced in copy).
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
 */
import type { GithubRepo, GithubStatus, Project } from '../../../shared/protocol.ts';
import * as api from '../api.ts';
import * as st from '../state.ts';
import { el, button, armButton } from './util.ts';
import { joinPath } from './newproject-model.ts';

const GH_POLL_MS = 2500;

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

// Phase 2c: repos with a clone in flight, keyed by fullName. Lives OUTSIDE the
// row DOM (like util.ArmedSet) so a per-row "cloning…" state survives a list
// rebuild (search / repo-list reload) instead of being wiped by replaceChildren.
const cloning = new Set<string>();

function emit(): void {
  for (const cb of listeners) cb();
}

// ---------------------------------------------------------------------------
// Phase 2c helpers: home resolution, already-cloned detection, error mapping.
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

/** Default clone destination for a repo: `<home>/projects/<repo.name>`. */
function defaultDest(home: string, name: string): string {
  return joinPath(joinPath(home, 'projects'), name);
}

/**
 * The local Project a repo already maps to, or null. Matches by NAME or by the
 * default clone path (`<home>/projects/<repo.name>`) — path-match needs `home`,
 * name-match works without it (so detection is live before home resolves).
 */
function clonedProject(r: GithubRepo, home: string | null): Project | null {
  const dest = home !== null ? defaultDest(home, r.name) : null;
  for (const p of st.state.projects) {
    if (p.name === r.name) return p;
    if (dest !== null && p.path === dest) return p;
  }
  return null;
}

/**
 * Honest clone-error copy: prefer the server's real `{error}` message; fall
 * back to friendly text only for a bare `HTTP <status>` (no body). 409 =
 * a non-empty destination already exists; 502 = the git clone itself failed.
 */
function cloneErr(e: unknown): string {
  if (e instanceof api.ApiError) {
    if (e.message !== `HTTP ${e.status}`) return e.message;
    if (e.status === 409) return 'a folder already exists there';
    if (e.status === 502) return 'clone failed';
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

function onGithubUpdate(cb: () => void): void {
  listeners.add(cb);
}

/** Fast poll while connecting or while the dialog's GitHub tab is open. */
function fast(): boolean {
  return tabOpen || status?.state === 'connecting';
}

function syncTimer(): void {
  if (fast()) {
    if (timer === null) timer = window.setInterval(() => void poll(), GH_POLL_MS);
  } else if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/** Apply a fresh (or optimistic) status: fire transitions, notify, resync poll. */
function applyStatus(next: GithubStatus): void {
  const prev = status;
  status = next;
  if (next.configured && next.state === 'connected' && prev?.state !== 'connected') {
    void loadRepos(''); // load the list once on reaching connected
  }
  if (next.state !== 'connected' && prev?.state === 'connected') {
    repos = [];
    repoState = 'idle';
    reposVersion++;
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
// GitHub Linguist language colors — EXTERNAL DATA (a language's canonical
// color), deliberately NOT app-palette tokens and NOT in tokens.css. Set inline
// on the language dot so it carries real information; an unknown language shows
// NO dot (never an arbitrary hue).
// ---------------------------------------------------------------------------
const LANG_COLOR: Record<string, string> = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Python: '#3572A5',
  Go: '#00ADD8',
  Rust: '#dea584',
  Java: '#b07219',
  'C++': '#f34b7d',
  C: '#555555',
  'C#': '#178600',
  Ruby: '#701516',
  PHP: '#4F5D95',
  Shell: '#89e051',
  HTML: '#e34c26',
  CSS: '#563d7c',
  Vue: '#41b883',
  Swift: '#F05138',
  Kotlin: '#A97BFF',
  Dart: '#00B4AB',
  Scala: '#c22d40',
  Elixir: '#6e4a7e',
  Lua: '#000080',
  'Objective-C': '#438eff',
  Haskell: '#5e5086',
  Clojure: '#db5855',
  R: '#198CE7',
  Perl: '#0298c3',
  Zig: '#ec915c',
  Nix: '#7e7eff',
};

/** Compact relative time for the repo "pushed …" line; '' for absent/bad input. */
function relTime(iso?: string): string {
  if (iso === undefined || iso === '') return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const sec = Math.floor((Date.now() - t) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

// ---------------------------------------------------------------------------
// Top-bar chip
// ---------------------------------------------------------------------------

/**
 * A .tb-btn with a status dot + mono label reflecting GithubStatus:
 *   disconnected → gray dot + "Connect GitHub"
 *   connecting   → amber dot + "connecting…"
 *   connected    → green dot + "@login"
 *   not-configured (dormant) → faint dot + muted "GitHub"
 * Clicking always opens the New Project dialog on its GitHub tab (which shows
 * the honest setup panel when dormant — no dead 409 path).
 */
export function createGithubChip(openTab: () => void): HTMLButtonElement {
  const chip = button('tb-btn tb-gh', '', openTab);
  chip.setAttribute('aria-haspopup', 'dialog');
  const dot = el('span', 'tb-gh-dot');
  dot.setAttribute('aria-hidden', 'true');
  const lb = el('span', 'tb-gh-lb');
  chip.append(dot, lb);

  function render(): void {
    const s = status;
    let cls = 'is-off';
    let label = 'GitHub';
    let aria = 'GitHub';
    if (s !== null && s.configured) {
      if (s.state === 'connected') {
        cls = 'is-connected';
        label = `@${s.login ?? ''}`;
        aria = `GitHub — connected as ${s.login ?? ''}`;
      } else if (s.state === 'connecting') {
        cls = 'is-connecting';
        label = 'connecting…';
        aria = 'GitHub — connecting';
      } else {
        cls = 'is-disconnected';
        label = 'Connect GitHub';
        aria = 'GitHub — connect your account';
      }
    } else if (s !== null && !s.configured) {
      aria = 'GitHub — not set up on this server';
    }
    dot.className = `tb-gh-dot ${cls}`;
    lb.textContent = label; // untrusted login → textContent
    chip.setAttribute('aria-label', aria);
    chip.title = aria;
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

  // --- not configured (dormant) ---------------------------------------------
  const setupCard = el('div', 'gh-card');
  setupCard.append(ghAvatar('GH'));
  setupCard.append(el('div', 'gh-title', 'GitHub connection isn’t set up'));
  const setupBody = el('div', 'gh-body');
  setupBody.append(
    document.createTextNode('Connecting needs the app’s OAuth client id. Whoever runs the manager sets '),
    el('span', 'gh-mono-acc', 'AI_SM_GITHUB_CLIENT_ID'),
    document.createTextNode(' once on the server, then this tab can connect.'),
  );
  setupCard.append(setupBody);
  setupCard.append(el('div', 'gh-fine', 'one-time server setup · nothing to do in the browser'));

  // --- disconnected ----------------------------------------------------------
  const disconnectedCard = el('div', 'gh-card');
  disconnectedCard.append(ghAvatar('GH'));
  disconnectedCard.append(el('div', 'gh-title', 'Connect your GitHub account'));
  disconnectedCard.append(
    el(
      'div',
      'gh-body',
      'List your repositories from inside the manager. Connecting authorizes this app once via GitHub’s device flow.',
    ),
  );
  const connectBtn = button('gh-connect', 'Connect with GitHub', () => void onConnect());
  disconnectedCard.append(connectBtn);
  const connectErr = el('div', 'gh-msg is-err');
  connectErr.setAttribute('role', 'alert');
  connectErr.hidden = true;
  disconnectedCard.append(connectErr);
  // CORRECTED copy: `repo` scope (NOT "read-only") · server-side token (NOT
  // "OS keychain").
  const fine = el('div', 'gh-fine');
  fine.append(
    document.createTextNode('secure device-flow OAuth · token stored server-side, never in the browser · '),
    el('span', 'gh-mono-acc', 'repo'),
    document.createTextNode(' scope'),
  );
  disconnectedCard.append(fine);

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
  meCol.append(meName, el('span', 'gh-me-sub', 'connected · repo scope'));
  const disconnectBtn = button('gh-mini', 'disconnect');
  armButton(disconnectBtn, 'confirm disconnect', () => void drop());
  meRow.append(meAvatar, meCol, el('span', 'launch-gap'), disconnectBtn);
  connectedWrap.append(meRow);
  // REQUIRED honest note — the backend can't self-revoke a public device grant.
  connectedWrap.append(
    el(
      'div',
      'gh-revoke-note',
      'Disconnect removes the local token. To fully revoke access, remove the app in your GitHub settings → Applications.',
    ),
  );
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

  root.append(checkingCard, setupCard, disconnectedCard, connectingCard, connectedWrap);

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
    // CHAIN: create succeeded → clone the fresh repo into <home>/projects/<name>.
    newBusyLabel.textContent = 'cloning…';
    try {
      const project = await api.githubClone({
        cloneUrl: created.cloneUrl,
        dest: defaultDest(home, name),
        name,
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

  // ---- handlers -------------------------------------------------------------
  async function onConnect(): Promise<void> {
    connectBtn.disabled = true;
    connectErr.hidden = true;
    try {
      const d = await api.githubDevice();
      // Optimistic: the server sets connecting synchronously, so show the code
      // immediately, then confirm via poll.
      applyStatus({
        configured: true,
        state: 'connecting',
        userCode: d.userCode,
        verificationUri: d.verificationUri,
        expiresAt: d.expiresAt,
      });
      void poll();
    } catch (e) {
      if (e instanceof api.ApiError && e.status === 409) {
        void poll(); // reveals configured:false → the setup panel
        connectErr.textContent = 'GitHub isn’t set up on this server (AI_SM_GITHUB_CLIENT_ID is unset).';
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
    const iso = status?.expiresAt;
    if (iso === undefined) {
      expiryEl.textContent = '';
      return;
    }
    const ms = new Date(iso).getTime() - Date.now();
    if (Number.isNaN(ms) || ms <= 0) {
      expiryEl.textContent = 'code expired — cancel and retry';
      return;
    }
    const s = Math.floor(ms / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    expiryEl.textContent = `expires in ${mm}:${ss}`;
  }

  function render(): void {
    const s = status;
    checkingCard.hidden = s !== null;
    setupCard.hidden = !(s !== null && !s.configured);
    const conf = s !== null && s.configured ? s : null;
    disconnectedCard.hidden = !(conf !== null && conf.state === 'disconnected');
    connectingCard.hidden = !(conf !== null && conf.state === 'connecting');
    connectedWrap.hidden = !(conf !== null && conf.state === 'connected');

    if (conf !== null && conf.state === 'connecting') {
      uriSpan.textContent = conf.verificationUri ?? 'github.com/login/device';
      codeEl.textContent = conf.userCode ?? '—';
      renderExpiry();
    }
    if (conf !== null && conf.state === 'connected') {
      meName.textContent = `@${conf.login ?? ''}`;
      meAvatar.textContent = (conf.login ?? '?').slice(0, 1).toUpperCase() || '?';
      // Rebuild the list ONLY when it actually changed — keeps the search box's
      // focus and the disconnect button's armed state across status polls.
      if (reposVersion !== lastReposVersion) {
        lastReposVersion = reposVersion;
        renderRepos();
      }
    }
    syncExpiryTimer();
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
      const color = LANG_COLOR[r.language];
      if (color !== undefined) {
        const d = el('span', 'gh-lang-dot');
        d.style.background = color; // Linguist DATA color, not a palette token
        d.setAttribute('aria-hidden', 'true');
        meta.append(d);
      }
      meta.append(el('span', 'gh-meta-t', r.language)); // untrusted → textContent
      hasLang = true;
    }
    const pushed = relTime(r.pushedAt);
    if (pushed !== '') {
      if (hasLang) meta.append(el('span', 'gh-meta-sep', '·'));
      meta.append(el('span', 'gh-meta-t', `pushed ${pushed}`));
    }
    if (meta.childElementCount > 0) card.append(meta);

    const statusSlot = el('div', 'gh-repo-status');
    statusSlot.hidden = true;
    card.append(statusSlot);

    let rowErr = '';

    /** Repaint the action + status area from current state (cloning set + projects). */
    function paint(): void {
      const inFlightClone = cloning.has(r.fullName);
      const project = clonedProject(r, homeDir);
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
        b.title = 'clone into <home>/projects and register as a project';
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
          dest: defaultDest(home, r.name),
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
    const want = active && status?.configured === true && status.state === 'connecting';
    if (want) {
      if (expTimer === null) expTimer = window.setInterval(renderExpiry, 1000);
    } else if (expTimer !== null) {
      clearInterval(expTimer);
      expTimer = null;
    }
  }

  // ---- debounced repo search ------------------------------------------------
  let searchTimer: number | null = null;
  searchInput.addEventListener('input', () => {
    if (searchTimer !== null) clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void loadRepos(searchInput.value.trim()), 300);
  });

  function focusFirst(): void {
    const s = status;
    if (s !== null && s.configured) {
      if (s.state === 'disconnected') connectBtn.focus();
      else if (s.state === 'connecting') cancelBtn.focus();
      else if (s.state === 'connected') searchInput.focus();
    }
    // not-configured / checking: nothing actionable — focus stays on the tab.
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
      syncExpiryTimer();
    }
  }

  onGithubUpdate(render);
  return { el: root, setActive };
}
