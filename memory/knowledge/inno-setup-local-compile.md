---
type: knowledge
created: 2026-09-09
updated: 2026-09-09
tags: [installer, inno-setup, windows, ci, testing]
---
# Compile the Inno Setup script locally from WSL — no 6-minute CI loop

Measured 2026-09-09 (audit agent, ISCC 6.7.1): the `.iss` can be compiled
from WSL through `powershell.exe` interop with a **portable** Inno Setup,
no system-wide install, no elevation:

```
innosetup-6.7.1.exe /CURRENTUSER /PORTABLE=1 /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /NOICONS /DIR=<scratch>\iscc
```

Source: `https://github.com/jrsoftware/issrc/releases/download/is-6_7_1/innosetup-6.7.1.exe`.
`/CURRENTUSER` is REQUIRED — without it the installer asks for elevation
and, under `/VERYSILENT`, exits silently. Then copy `installer/` +
`launcher/` into a throwaway tree with dummy payload files
(`payload\ai-session-manager-linux-x64.tar.gz`, the four host files under
`payload\host\`) and run
`ISCC.exe /DAppVersion=<v> /DBundleTar=… /DHostDir=… ai-session-manager.iss`.
Exit 0 + "0 errors" is the gate; delete the scratch tree afterwards.

Why it matters: the first two CI dispatches of the installer died on
`[Code]` comment/literal traps the suite could not see
([[inno-setup-ispp-char-literals]]); each cycle cost ~6 minutes. The same
run also verified: `TStringList[I]` compiles, `LoadStringsFromFile` decodes
UTF-8 and strips a BOM/CRLF, `LoadStringsFromFileUTF8` does NOT exist in
6.7.1, `DisableWelcomePage` defaults to `yes`, plain `MsgBox` is never
suppressed by `/SUPPRESSMSGBOXES` (use `SuppressibleMsgBox`), Inno
simulates Next on every custom page in silent mode (so `NextButtonClick`
runs), and a `deleteafterinstall` file still exists at `ssPostInstall`.

Backlog: turn this into an opt-in `installer/check-iss.ps1` (+ a test that
runs it when `ISCC.exe` is reachable) so a pre-push check catches syntax
classes locally.
