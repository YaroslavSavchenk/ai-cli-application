# GitHub connection

Where the credential file sits among the app's other files: [app-data.md](app-data.md).

The app can list your GitHub repositories, clone one into a new project, and
create a new repository. There are **two ways to connect, and exactly one
credential is active at a time** — connecting one way replaces the other.
**Sign in with GitHub (B) is the easy one**: no token to make, and it sees
your private and organisation repositories. A pasted fine-grained token sees
only what it was granted — often just your public repositories.

## A. Paste a token (no server setup)

Works out of the box, with nothing configured. In the app: **Add a project →
From GitHub → paste a token** (the GitHub chip in the top bar opens it too). The server checks it against GitHub (`GET /user`,
then `GET /user/repos?per_page=1`) and shows you which account it resolved to
before it counts as connected.

Recommended token: a **fine-grained personal access token limited to the
repositories you want, with an expiry**. That is strictly less powerful — and
therefore safer — than the device flow below, which asks for read/write on
every repository of the account and usually does not expire (a device-flow
token expires in 8 hours only if the OAuth App enables expiring user tokens,
which this app cannot refresh).

"Remember this token" (on by default) writes it to `github.json`. Turn it off
and the credential lives **only in the running backend process**, which exits
about 30 seconds after the last window closes; you paste again next time.

## B. Sign in with GitHub (recommended)

Works out of the box since v0.4.9: the app carries the client id of its own
OAuth App ("AI Session Manager"). A client id is public by design — the
device flow of a public app uses no client secret, which is how GitHub CLI
and VS Code ship theirs.

1. Open **Add a project → From GitHub → Connect with GitHub**.
2. Enter the shown code at `github.com/login/device` and approve.
3. Done. The requested scope is `repo`: every repository you can reach,
   private and organisation ones included (an organisation that restricts
   OAuth Apps has to approve "AI Session Manager" first). The app then shows
   up under GitHub → Settings → Applications → Authorized OAuth Apps, where
   you can revoke it.

The token does not expire on its own; Disconnect drops it from this machine,
revoking it on GitHub ends it everywhere.

**Your own OAuth App instead** (forks, self-builds): register one (Settings →
Developer settings → OAuth Apps → New OAuth App), **enable Device Flow**,
leave "Expire user access tokens" off, and start the backend with its id:

    AI_SM_GITHUB_CLIENT_ID=Ov23your_client_id npm start

`AI_SM_GITHUB_CLIENT_ID` set to an empty string turns sign-in off; pasting a
token still works.

## What "Disconnect" does, and what it does not

Disconnect deletes the local copy (`github.json`) and clears the in-memory
credential. **It revokes nothing on GitHub.** To actually kill the credential:
a pasted token under GitHub Settings → Developer settings → Personal access
tokens; a device-flow grant under GitHub Settings → Applications.

## How the credential is stored (stated plainly)

Server-side only: `github.json`, mode 0600, never returned to the browser,
never written to `server.log`, and never put in `prefs.json`. It is **not
encrypted and not in a keychain** — there is no OS keyring in this environment,
and an encryption key stored on the same disk protects against nobody who can
read the file. On Windows + WSL2, note that file permissions do not stop a
process running as your Windows user: the WSL filesystem is reachable through
`\\wsl.localhost\...` as root inside the distro, so every file in the data dir
is readable that way regardless of its mode. The honest promise is "stored on
this machine, readable by your own user account" — which is also why a
short-lived, repository-scoped token is the better credential to hand it.

Never paste a token somebody else gave you.

Clones started from the GitHub repo list land in
`<home>/projects/<owner>/<repo>`, so two repositories with the same name from
different owners can both exist locally. The URL-clone tab keeps its
user-chosen destination.

## Test-only seam

`AI_SM_GITHUB_API_BASE` exists **only for offline tests** — it re-points the
REST base and is refused unless it is a loopback origin (the server exits 1
rather than start), so it can never be a production or GitHub-Enterprise
setting.
