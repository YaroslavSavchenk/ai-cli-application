' launch-silent.vbs - run launch.ps1 with NO console window, ever.
'
' wscript.exe is a GUI-subsystem host, so double-clicking this file (or the
' "AI Session Manager" shortcut created by make-shortcut.ps1) shows nothing.
' PowerShell is then started via Shell.Run with window style 0 (SW_HIDE), so
' its console never appears either - not even the brief flash you get from
' powershell -WindowStyle Hidden started any other way.
'
' launch.ps1 receives -Silent: on success nothing is shown until the Edge
' app window opens; on failure launch.ps1 raises a native error box itself
' (see Show-ErrorBox there), so a hidden launcher can never fail invisibly.
'
' Extra arguments are forwarded to launch.ps1 (e.g. -NoBrowser).
' The single argument /dryrun makes this script print the exact command it
' would run and exit without running it - used by the WSL-side verification
' (cscript //nologo launch-silent.vbs /dryrun) to parse-check this file.

Option Explicit

Dim fso, sh, scriptDir, ps1, cmd, i, arg, dryRun, extraArgs
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = fso.BuildPath(scriptDir, "launch.ps1")

If Not fso.FileExists(ps1) Then
  MsgBox "launch.ps1 not found next to this script:" & vbCrLf & ps1, _
    vbCritical + vbSystemModal, "AI Session Manager - launch failed"
  WScript.Quit 1
End If

dryRun = False
extraArgs = ""
For i = 0 To WScript.Arguments.Count - 1
  arg = WScript.Arguments(i)
  If LCase(arg) = "/dryrun" Then
    dryRun = True
  Else
    extraArgs = extraArgs & " """ & arg & """"
  End If
Next

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """ -Silent" & extraArgs

If dryRun Then
  WScript.Echo cmd
  WScript.Quit 0
End If

' 0 = hidden window, False = do not wait (the backend is detached inside
' WSL anyway; nothing here may hold a process relationship over it).
sh.Run cmd, 0, False
