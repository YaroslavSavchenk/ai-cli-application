/**
 * The GitHub panel's "+ New repo" inline form (Phase 2c): the New repository
 * button that opens it, the name / description / visibility fields, and the
 * create -> clone chain behind Create, with its honest indeterminate busy
 * line (no fake percentage) and its errors inline.
 *
 * Split from `ui/github.ts` (Quality part Q13, `.claude/plans/PLAN-QUALITY.md`),
 * code moved as it stood: it was a block of `createGithubPanel()`, which now
 * places the button and the form and hands in the one control of the panel
 * they touch, the repo search. Siblings: `github.ts` (the chip and the
 * panel), `github-token.ts`, `github-state.ts`, `github-model.ts`.
 */
import type { GithubRepo } from '../../../shared/protocol.ts';
import * as api from '../api.ts';
import * as st from '../state.ts';
import { el, button } from './util.ts';
import { ownerDest } from './github-model.ts';
import { cloneErr, loadRepos } from './github-state.ts';
import { ensureHome } from './home-store.ts';

interface NewRepoForm {
  /** `New repository` — opens and closes the form. */
  button: HTMLButtonElement;
  form: HTMLElement;
}

/**
 * `searchInput` is the panel's repo search: disabled with everything else
 * while the chain runs, and its query reloads the list after it.
 */
export function createNewRepoForm(searchInput: HTMLInputElement): NewRepoForm {
  const newRepoBtn = button('gh-newrepo', 'New repository', () => toggleNewForm());
  newRepoBtn.setAttribute('aria-expanded', 'false');
  newRepoBtn.setAttribute('aria-controls', 'gh-newform');
  newRepoBtn.title = 'create a new repository on GitHub and clone it locally';

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
  const privBtn = button('gh-newbtn', 'Private', () => togglePrivate());
  const newNote = el('span', 'gh-newnote', 'Created on GitHub, then cloned to this computer');
  const newCancel = button('gh-newbtn', 'Cancel', () => closeNewForm());
  const newCreate = button('gh-newbtn is-create', 'Create', () => void submitNewRepo());
  newRow.append(privBtn, newNote, newCancel, newCreate);
  const newErr = el('div', 'gh-newerr');
  newErr.setAttribute('role', 'alert');
  newErr.hidden = true;
  const newBusy = el('div', 'ap-busy');
  newBusy.hidden = true;
  const newBusySpin = el('span', 'ap-spinner');
  newBusySpin.setAttribute('aria-hidden', 'true');
  const newBusyLabel = el('span', '', '');
  newBusy.append(newBusySpin, newBusyLabel);
  newForm.append(newNameInput, newDescInput, newRow, newErr, newBusy);
  newNameInput.addEventListener('input', () => {
    newNameInput.classList.remove('is-err');
    newErr.hidden = true;
  });

  // ---- "+ New repo" form state + handlers -----------------------------------
  let newOpen = false;
  let newPrivate = true;
  let creating = false;

  function syncPrivate(): void {
    privBtn.textContent = newPrivate ? 'Private' : 'Public';
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
    const home = await ensureHome(api.fsList);
    if (home === null) {
      newErr.textContent = 'couldn’t resolve your home directory — try again';
      newErr.hidden = false;
      return;
    }
    const description = newDescInput.value.trim();
    setCreating(true, 'Creating the repository');
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
    newBusyLabel.textContent = 'Cloning';
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

  return { button: newRepoBtn, form: newForm };
}
