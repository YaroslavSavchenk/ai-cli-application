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
 *   - 2b is VIEW-ONLY: repos are listed, with NO per-repo clone/open button —
 *     clone-by-picking is Phase 2c, and its seam is left clean.
 *
 * Untrusted display: login, repo fullName/description/language, userCode and
 * verificationUri all render via textContent — never innerHTML.
 *
 * Poll cadence: FAST (~2.5 s) ONLY while connecting OR while the dialog's
 * GitHub tab is open; otherwise PAUSED. A single status fetch on chip mount
 * (initGithub) and on tab open keeps the chip honest without hammering a
 * disconnected/closed app.
 */
import type { GithubRepo, GithubStatus } from '../../../shared/protocol.ts';
import * as api from '../api.ts';
import { el, button, armButton } from './util.ts';

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

function emit(): void {
  for (const cb of listeners) cb();
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

function ghAvatar(text: string): HTMLElement {
  const a = el('div', 'gh-avatar', text);
  a.setAttribute('aria-hidden', 'true');
  return a;
}

export function createGithubPanel(): GithubPanel {
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
  const searchInput = el('input', 'gh-search');
  searchInput.placeholder = 'search repositories…';
  searchInput.spellcheck = false;
  searchInput.autocomplete = 'off';
  searchInput.setAttribute('aria-label', 'search repositories');
  connectedWrap.append(searchInput);
  const reposEl = el('div', 'gh-repos');
  reposEl.setAttribute('aria-live', 'polite');
  connectedWrap.append(reposEl);

  root.append(checkingCard, setupCard, disconnectedCard, connectingCard, connectedWrap);

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
    // 2c SEAM: no per-repo clone/open button here — clone-by-picking is Phase 2c.
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
      if (status?.state === 'connected' && repoState === 'idle') void loadRepos('');
      render();
      focusFirst();
    } else {
      syncExpiryTimer();
    }
  }

  onGithubUpdate(render);
  return { el: root, setActive };
}
