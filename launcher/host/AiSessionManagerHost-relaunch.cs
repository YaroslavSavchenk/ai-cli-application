// AiSessionManagerHost-relaunch.cs - part of the native WebView2 host: one
// partial class HostApp in five files (Q6, .claude/plans/quality/PLAN-Q6.md,
// this fifth one added by Q17 P2, .claude/plans/quality/PLAN-Q17.md). The
// header, the C# 5 rule (no $"", no => members, no ?.) and the assembly
// attribute are in AiSessionManagerHost.cs; the other parts are
// AiSessionManagerHost-clipboard.cs, AiSessionManagerHost-overlay.cs and
// AiSessionManagerHost-overlay-window.cs.
//
// Holds the "Page -> host: start the app again" region (Q17 P2). When WSL
// stops under the app (2026-11-24: an out-of-memory power-off) this window
// stays open on a dead backend. The page then posts the ONE word `relaunch`
// and the host runs the SAME launcher that opened this window, in its normal
// attach-or-start mode: wsl.exe boots the VM, Start-Backend + Wait-ForHealthy
// bring the backend up, Open-NativeHost opens a NEW window. When the launcher
// reports success this window closes; on a failure the page gets
// `relaunch-failed` and the window stays.

using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using Microsoft.Web.WebView2.WinForms;

namespace AiSessionManager
{
    internal static partial class HostApp
    {
        // --- Page -> host: start the app again ------------------------------
        //
        // ONE string in, ONE string out, through the same origin-locked
        // channel as copy-files (WebView_WebMessageReceived checks the origin
        // and the length before it hands the text here):
        //
        //     page -> host   relaunch           (the whole message, ordinal)
        //     host -> page   relaunch-failed    (only on a failure)
        //
        // Success has no reply: the page's window is replaced.
        //
        // SECURITY POSTURE, in one place:
        //
        //  * The page chooses NOTHING. The message carries no argument; the
        //    launcher and the backend data dir come from the RELAUNCH RECORD
        //    that launch.ps1 wrote into this instance's folder just before it
        //    started this host, read ONCE at startup (LoadRelaunchRecord) and
        //    shape-checked: the launcher must be a well-formed Windows path
        //    (IsAcceptableWindowsPath, the copy-files shape check; \\wsl$\ is
        //    read as \\wsl.localhost\) whose file
        //    name is launch.ps1, the data dir must pass launch.ps1's own
        //    allow-list. A record written later - by another launch - never
        //    changes what this window relaunches.
        //  * A dev instance (--dev-instance) relaunches the dev instance: its
        //    data dir is set on the launcher's environment from the record,
        //    and a dev record whose data dir has a `.` or `..` segment, or
        //    whose last segment is `.ai-session-manager` (the installed app's
        //    folder name, under ~ or any absolute spelling), is refused
        //    outright (the D9 P5 -Stop incident: an environment variable that
        //    did not cross over pointed a dev command at the user's app). A
        //    symlink or another name for that folder is not something a
        //    string check can see; launch.ps1 never writes one.
        //  * powershell.exe is the in-box one, by its full System32 path; the
        //    command line is fixed text plus the one quoted launcher (a path
        //    that passed the shape check holds no `"`).
        //  * Single flight: a second `relaunch` while one runs is ignored.
        //    A launcher that has not finished after 120 s is killed (only
        //    that process, by its handle - not a host it may already have
        //    started) and the page gets relaunch-failed. The flight stays
        //    HELD until that launcher has really exited and a short tail has
        //    passed: if a window it started comes up after all, this window
        //    closes, so the end state is still one window.
        //  * host.log gets one line when a relaunch starts and one with its
        //    outcome: counts, codes and exception CLASSES only - no URL, no
        //    token, no path.
        private const string RelaunchKind = "relaunch";
        private const string RelaunchFailed = "relaunch-failed";

        // Written by launch.ps1 (Open-NativeHost, $AiSmRelaunchRecordName in
        // config-common.ps1): line 1 the launcher, line 2 the data dir.
        private const string RelaunchRecordName = "relaunch.txt";
        private const string LauncherFileName = "launch.ps1";
        private const int MaxRelaunchRecordLength = 8192;
        private const string WslSharePrefix = @"\\wsl.localhost\";
        private const string LegacyWslSharePrefix = @"\\wsl$\";

        // launch.ps1's default backend data dir ($AiSmDefaultDataDir) and its
        // data-dir allow-list ($AiSmDataDirPattern), byte for byte
        // (tests/release/host-relaunch.test.ts holds the two sides equal).
        private const string DefaultBackendDataDir = "~/.ai-session-manager";
        private static readonly Regex BackendDataDirPattern = new Regex(
            @"^(~)?(/[A-Za-z0-9._-]+)+\z", RegexOptions.CultureInvariant);

        // The spec's limit: a cold WSL boot plus launch.ps1's own 90 s
        // health wait plus its 8 s window probe fit inside it.
        private const int RelaunchTimeoutMs = 120000;

        private const string BackendDataDirVariable = "AI_SM_DATA_DIR";

        // From the record, set once at startup; null = relaunch unavailable.
        private static string _relaunchLauncher;
        private static string _relaunchDataDir;
        // After a timeout kill: how long (1 s ticks) to watch host-ready for
        // a window the killed launcher started - launch.ps1 itself gives a
        // new host 8 s to signal ready.
        private const int RelaunchTailTicks = 10;
        private const int RelaunchTailTickMs = 1000;
        // The installed app's data folder name (the last segment of
        // DefaultBackendDataDir), refused for a dev instance however spelled.
        private const string InstalledDataFolderName = ".ai-session-manager";

        // The single flight: true from StartRelaunch until the relaunch is
        // completely over (after a timeout: until the killed launcher exited
        // and the tail watch ended).
        private static bool _relaunchBusy;
        // The running launcher (null once it exited), its timer (the 120 s
        // timeout, then the tail watch), whether the timeout fired, the tail
        // ticks left, and host-ready's pid when the relaunch started (so an
        // older window's pid is never taken for the new one).
        private static Process _relaunchProcess;
        private static System.Windows.Forms.Timer _relaunchTimer;
        private static bool _relaunchTimedOut;
        private static int _relaunchTailLeft;
        private static int _relaunchSentinelBefore;

        // The whole message, ordinally: `relaunch` with anything before,
        // after or inside it is not this kind.
        private static bool IsRelaunchMessage(string text)
        {
            return string.Equals(text, RelaunchKind, StringComparison.Ordinal);
        }

        // Main calls this once, after the instance folder is settled. Every
        // failure leaves relaunch unavailable (a later `relaunch` answers
        // relaunch-failed); none of them stops the window.
        private static void LoadRelaunchRecord(bool devInstance)
        {
            string text;
            try
            {
                FileInfo record = new FileInfo(Path.Combine(_dataDir, RelaunchRecordName));
                if (!record.Exists)
                {
                    Log("relaunch unavailable: the launcher left no relaunch record.");
                    return;
                }
                if (record.Length > MaxRelaunchRecordLength)
                {
                    Log("relaunch unavailable: the relaunch record is over the size cap.");
                    return;
                }
                text = File.ReadAllText(record.FullName);
            }
            catch (Exception ex)
            {
                Log("relaunch unavailable: the relaunch record could not be read ("
                    + ex.GetType().Name + ").");
                return;
            }

            string launcher;
            string dataDir;
            if (!TryParseRelaunchRecord(text, devInstance, out launcher, out dataDir))
            {
                Log("relaunch unavailable: the relaunch record is malformed.");
                return;
            }
            bool exists;
            try
            {
                exists = File.Exists(launcher);
            }
            catch (Exception)
            {
                exists = false;
            }
            if (!exists)
            {
                Log("relaunch unavailable: the launcher named in the relaunch record does not exist.");
                return;
            }
            _relaunchLauncher = launcher;
            _relaunchDataDir = dataDir;
        }

        // Pure: the record's two lines, each checked; a trailing line break is
        // allowed, a third line is not. `devInstance` refuses the installed
        // app's data dir (IsInstalledAppDataDir).
        private static bool TryParseRelaunchRecord(
            string text, bool devInstance, out string launcher, out string dataDir)
        {
            launcher = null;
            dataDir = null;
            if (text == null || text.Length > MaxRelaunchRecordLength)
            {
                return false;
            }
            string[] lines = text.Replace("\r\n", "\n").Split('\n');
            int count = lines.Length;
            if (count == 3 && lines[2].Length == 0)
            {
                count = 2;
            }
            if (count != 2)
            {
                return false;
            }
            string first = lines[0];
            string second = lines[1];
            // \\wsl$\ is the older name of the same share (launch.ps1 derives
            // its config from either); the shape check knows the new name.
            string shape = first.StartsWith(LegacyWslSharePrefix, StringComparison.OrdinalIgnoreCase)
                ? WslSharePrefix + first.Substring(LegacyWslSharePrefix.Length)
                : first;
            if (!IsAcceptableWindowsPath(shape)
                || !string.Equals(Path.GetFileName(first), LauncherFileName,
                       StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }
            if (!BackendDataDirPattern.IsMatch(second))
            {
                return false;
            }
            if (devInstance && IsInstalledAppDataDir(second))
            {
                return false;
            }
            launcher = first;
            dataDir = second;
            return true;
        }

        // Pure, for a data dir that already passed BackendDataDirPattern: true
        // for the default spelling, for any `.` or `..` segment (which could
        // walk back into it) and for any path whose last segment is the
        // installed app's folder name (/home/<you>/.ai-session-manager).
        private static bool IsInstalledAppDataDir(string dataDir)
        {
            if (string.Equals(dataDir, DefaultBackendDataDir, StringComparison.Ordinal))
            {
                return true;
            }
            string[] segments = dataDir.Split('/');
            for (int i = 1; i < segments.Length; i++)
            {
                if (segments[i] == "." || segments[i] == "..")
                {
                    return true;
                }
            }
            return string.Equals(segments[segments.Length - 1], InstalledDataFolderName,
                StringComparison.Ordinal);
        }

        // Called by WebView_WebMessageReceived for a `relaunch` from the
        // launch origin, on the UI thread - as is every other relaunch
        // handler (Process.SynchronizingObject, a WinForms Timer), so the
        // state above needs no lock.
        private static void StartRelaunch(WebView2 wv)
        {
            if (_relaunchBusy)
            {
                Log("relaunch ignored: one is already running.");
                return;
            }
            if (_relaunchLauncher == null || _relaunchDataDir == null)
            {
                Log("relaunch failed: this window has no usable relaunch record.");
                PostRelaunchFailed(wv);
                return;
            }

            Process launcher = new Process();
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(
                    InBoxPowerShell(),
                    "-NoProfile -ExecutionPolicy Bypass -File \"" + _relaunchLauncher + "\"");
                // No -Silent: a failure must END the launcher with exit 1, not
                // wait on a message box nobody asked for. No window either.
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.EnvironmentVariables[BackendDataDirVariable] = _relaunchDataDir;
                launcher.StartInfo = psi;
                launcher.EnableRaisingEvents = true;
                launcher.SynchronizingObject = _form;
                launcher.Exited += RelaunchLauncher_Exited;
                launcher.Start();
            }
            catch (Exception ex)
            {
                launcher.Dispose();
                Log("relaunch failed: the launcher could not be started ("
                    + ex.GetType().Name + ").");
                PostRelaunchFailed(wv);
                return;
            }
            _relaunchBusy = true;
            _relaunchProcess = launcher;
            _relaunchTimedOut = false;
            _relaunchSentinelBefore = ReadSentinelPid();
            _relaunchTimer = new System.Windows.Forms.Timer();
            _relaunchTimer.Interval = RelaunchTimeoutMs;
            _relaunchTimer.Tick += RelaunchTimer_Tick;
            _relaunchTimer.Start();
            Log("relaunch started: launcher pid "
                + launcher.Id.ToString(CultureInfo.InvariantCulture) + ".");
        }

        private static string InBoxPowerShell()
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.System),
                "WindowsPowerShell", "v1.0", "powershell.exe");
        }

        private static void RelaunchLauncher_Exited(object sender, EventArgs e)
        {
            Process launcher = sender as Process;
            if (launcher == null)
            {
                return;
            }
            if (!ReferenceEquals(launcher, _relaunchProcess))
            {
                launcher.Dispose();
                return;
            }
            int code;
            try
            {
                code = launcher.ExitCode;
            }
            catch (Exception)
            {
                code = -1;
            }
            _relaunchProcess = null;
            launcher.Dispose();

            if (_relaunchTimedOut)
            {
                // The page already has relaunch-failed. The killed launcher may
                // have started a host before it died: watch host-ready for a
                // short tail, the flight still held.
                if (CloseIfNewHostWindowIsUp())
                {
                    return;
                }
                StopRelaunchTimer();
                _relaunchTailLeft = RelaunchTailTicks;
                _relaunchTimer = new System.Windows.Forms.Timer();
                _relaunchTimer.Interval = RelaunchTailTickMs;
                _relaunchTimer.Tick += RelaunchTail_Tick;
                _relaunchTimer.Start();
                return;
            }

            EndRelaunch();
            if (code != 0)
            {
                Log("relaunch failed: the launcher exited with code "
                    + code.ToString(CultureInfo.InvariantCulture) + ".");
                PostRelaunchFailed(_webView);
                return;
            }
            // launch.ps1 exits 0 only with a UI open: its Open-NativeHost has
            // seen the NEW host's pid in host-ready, or it fell back to Edge.
            Log(NewHostWindowIsUp()
                ? "relaunch ok: the new window is up; this one closes."
                : "relaunch ok: the launcher opened the app outside this host; this one closes.");
            CloseThisWindow();
        }

        private static void RelaunchTimer_Tick(object sender, EventArgs e)
        {
            StopRelaunchTimer();
            Process launcher = _relaunchProcess;
            if (launcher == null)
            {
                return;
            }
            // The flight stays held: RelaunchLauncher_Exited of THIS launcher
            // ends it (after the tail watch), so no second launcher can start
            // while this one is still dying.
            _relaunchTimedOut = true;
            try
            {
                // Only the launcher this window started, by its own handle. A
                // host it already started lives on - the tail watch closes
                // this window if that one comes up.
                if (!launcher.HasExited)
                {
                    launcher.Kill();
                }
            }
            catch (Exception ex)
            {
                Log("relaunch: the overdue launcher could not be stopped ("
                    + ex.GetType().Name + "); non-fatal.");
            }
            Log("relaunch failed: the launcher did not finish within 120 s.");
            PostRelaunchFailed(_webView);
        }

        // After a timeout: one host-ready look per tick, RelaunchTailTicks
        // ticks, then the flight is over and the window stays.
        private static void RelaunchTail_Tick(object sender, EventArgs e)
        {
            if (CloseIfNewHostWindowIsUp())
            {
                return;
            }
            _relaunchTailLeft--;
            if (_relaunchTailLeft <= 0)
            {
                EndRelaunch();
                Log("relaunch: the overdue launcher ended without a new window; this one stays.");
            }
        }

        private static bool CloseIfNewHostWindowIsUp()
        {
            if (!NewHostWindowIsUp())
            {
                return false;
            }
            EndRelaunch();
            Log("relaunch: the overdue launcher's window came up after all; this one closes.");
            CloseThisWindow();
            return true;
        }

        private static void StopRelaunchTimer()
        {
            System.Windows.Forms.Timer timer = _relaunchTimer;
            _relaunchTimer = null;
            if (timer != null)
            {
                timer.Stop();
                timer.Dispose();
            }
        }

        // The whole relaunch is over: the flight is free again.
        private static void EndRelaunch()
        {
            StopRelaunchTimer();
            _relaunchProcess = null;
            _relaunchTimedOut = false;
            _relaunchBusy = false;
        }

        // host-ready's pid, or 0 when it is absent or not a pid.
        private static int ReadSentinelPid()
        {
            try
            {
                int pid;
                if (int.TryParse(File.ReadAllText(_readySentinel).Trim(), NumberStyles.None,
                        CultureInfo.InvariantCulture, out pid) && pid > 0)
                {
                    return pid;
                }
            }
            catch (Exception)
            {
                // Absent or unreadable: no pid.
            }
            return 0;
        }

        // host-ready names a live process that is neither this one nor the
        // one it named when the relaunch started: the window the relaunch
        // opened (launch.ps1 deletes the sentinel before it starts the host).
        private static bool NewHostWindowIsUp()
        {
            int pid = ReadSentinelPid();
            if (pid == 0 || pid == _relaunchSentinelBefore
                || pid == Process.GetCurrentProcess().Id)
            {
                return false;
            }
            try
            {
                using (Process other = Process.GetProcessById(pid))
                {
                    return !other.HasExited;
                }
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static void CloseThisWindow()
        {
            try
            {
                Form form = _form;
                if (form != null && !form.IsDisposed)
                {
                    form.Close();
                }
            }
            catch (Exception ex)
            {
                Log("relaunch: this window could not close itself ("
                    + ex.GetType().Name + "); non-fatal.");
            }
        }

        private static void PostRelaunchFailed(WebView2 wv)
        {
            try
            {
                if (wv != null && !wv.IsDisposed && wv.CoreWebView2 != null)
                {
                    wv.CoreWebView2.PostWebMessageAsString(RelaunchFailed);
                }
            }
            catch (Exception ex)
            {
                Log("relaunch: the failure could not be posted to the page ("
                    + ex.GetType().Name + "); non-fatal.");
            }
        }
    }
}
