# v0.4.9 — Sign in with GitHub

- **Sign in with GitHub, no token needed.** Add a project → From GitHub →
  Connect with GitHub, enter the code at github.com/login/device, done. The
  app has its own GitHub OAuth App now, so you see all your repositories —
  private ones too, which a pasted fine-grained token often hides. You stay
  signed in until you press Disconnect or revoke "AI Session Manager" on
  GitHub.
- **The sign-in actually completes.** The app asked GitHub for the token a
  moment too early, got "slow down" back every time and never finished, even
  after you approved. It now waits as long as GitHub asks.
- Pasting a token still works, as before.
- An organisation that restricts OAuth Apps has to approve "AI Session
  Manager" before its repositories show up.

Verified with Claude Code 2.1.325.
