// AiSessionManagerHost.cs - native WebView2 host window for the AI CLI Session
// Manager. Its whole reason to exist is Windows taskbar identity: one process
// owns BOTH its window's AppUserModelID and (via make-shortcut.ps1) the
// launching shortcut's AppUserModelID, so the two match byte-for-byte and
// Windows draws app.ico for the taskbar group instead of the Edge logo. The
// Edge --app window can never do this (Chromium stamps its own per-URL AUMID);
// this host is Tier 1, with the Edge --app window kept as the fallback in
// launch.ps1.
//
// The host resolves NOTHING: launch.ps1 reads runtime.json, resolves the
// auto-picked port, builds http://127.0.0.1:<port>/ and passes it as args[0].
// There is no default or hardcoded port here. The host is a dumb window: it
// does not monitor or kill the backend. Backend lifetime stays bound to UI
// presence (the page's presence WebSocket), exactly as the browser window did.
//
// Its Windows-side files (host-ready, host.log, the WebView2 profile, the
// optional local app.ico) live in %LOCALAPPDATA%\ai-session-manager\ - or, when
// launch.ps1 passes the ONE fixed switch --dev-instance as args[1] (a clone
// launch on a non-default backend data dir: the dev flow beside the installed
// app; the installed launcher never passes it), in
// %LOCALAPPDATA%\ai-session-manager-dev\, so the two never share a WebView2
// browser process, profile, sentinel or log. The switch selects one of two
// fixed folder names; no path is ever taken from the command line or the
// environment.
//
// Four things the host does for the page beyond showing it: it hands the
// keyboard back to the web content whenever the window is activated (WebView2
// runs the page in its own HWND tree, so an Alt-Tab away and back could leave
// the window active with nothing able to receive typing or pasting), it hands
// off-origin http/https window.open targets to the user's default browser
// instead of dropping them, it grants clipboard-read to the app's own origin
// so the page can offer a paste command, and it puts FILES on the Windows
// clipboard for the page through one origin-locked string message channel
// (see the "Page -> host" region below). Everything else stays denied and
// top-level navigation stays locked to the launch origin.
//
// A second, borderless window in the same process shows the peek mascot
// (Nocturne C1, .claude/plans/nocturne/PLAN-C1.md § The window): a topmost,
// never-activated, click-through overlay at the right edge of the app
// window's monitor. See the "Peek-mascot overlay" region below.
//
// C# 5 only (compiled by the in-box Framework csc.exe, pre-Roslyn): no string
// interpolation, no expression-bodied members, no null-conditional operators.

using System;
using System.Collections.Specialized;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

// csc.exe stamps no TargetFrameworkAttribute of its own, and WITHOUT one the
// CLR runs this exe under the pre-4.6.2 quirks - including
// Switch.System.IO.UseLegacyPathHandling = true, where any path of 260+
// characters throws in Path.GetFullPath. Clipboard.SetFileDropList calls
// exactly that on every entry, so an everyday deep project path would turn a
// copy into "copy-files failed" although the host accepts 4096 characters.
// Declaring the target framework here (not in an .exe.config: the launcher
// ships four files and that stays true) opts into the 4.6.2+ defaults.
[assembly: System.Runtime.Versioning.TargetFramework(
    ".NETFramework,Version=v4.7.2", FrameworkDisplayName = ".NET Framework 4.7.2")]

namespace AiSessionManager
{
    internal static class HostApp
    {
        // Must be byte-identical to the System.AppUserModel.ID stamped on the
        // shortcut by make-shortcut.ps1. That match is the entire mechanism.
        private const string AppUserModelId = "AiSessionManager";

        // Returns an HRESULT; a valid string always yields S_OK. Declared with
        // an int return (not PreserveSig=false) so the call can never throw and
        // is safe as the very first statement in Main, before any window.
        [DllImport("shell32.dll")]
        private static extern int SetCurrentProcessExplicitAppUserModelID(
            [MarshalAs(UnmanagedType.LPWStr)] string AppID);

        // ExtractIconEx accepts UNC paths (the \\wsl.localhost install case),
        // where Icon.ExtractAssociatedIcon does not; both pull the exe's own
        // embedded RT_ICON.
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        private static extern int ExtractIconEx(
            string lpszFile, int nIconIndex,
            IntPtr[] phiconLarge, IntPtr[] phiconSmall, int nIcons);

        [DllImport("user32.dll")]
        private static extern bool DestroyIcon(IntPtr hIcon);

        // Both the BOOL (immersive dark mode) and the COLORREF attributes are
        // 4-byte values, so one `ref int` overload covers every call below.
        // Declared with an int return (not PreserveSig=false) so an unsupported
        // attribute on an older Windows returns a failing HRESULT instead of
        // throwing: dark chrome is cosmetic and must never break the window.
        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(
            IntPtr hwnd, int dwAttribute, ref int pvAttribute, int cbAttribute);

        // DWMWINDOWATTRIBUTE members. 20 is Windows 10 2004+ (build 19041);
        // on the 18985-19041 insider range the same flag lived at 19, which is
        // why both are tried. 34/35/36 are Windows 11 22000+ only — on Windows
        // 10 they fail harmlessly and the caption just stays light-with-dark-
        // mode, which is the documented ceiling there, not a bug to work around.
        private const int DwmwaUseImmersiveDarkMode = 20;
        private const int DwmwaUseImmersiveDarkModeLegacy = 19;
        private const int DwmwaBorderColor = 34;
        private const int DwmwaCaptionColor = 35;
        private const int DwmwaTextColor = 36;

        // Nocturne design tokens, written exactly as in web/src/styles/tokens.css
        // so the two stay diffable: --color-bg (caption), --color-neutral-200
        // (heading ink), --color-neutral-800 (the --shadow-sm edge).
        // ToColorRef converts.
        private const int TokenBgApp = 0x161826;
        private const int TokenTextHd = 0xE4E7F5;
        private const int TokenEdge = 0x3F424D;

        // The Windows-side folder under %LOCALAPPDATA% (see the file header):
        // the installed app's, or the second instance's when launch.ps1 passes
        // DevInstanceSwitch. All three must stay byte-equal to
        // $AiSmWindowsDataName / $AiSmWindowsDevDataName / $AiSmHostDevSwitch
        // in launcher/config-common.ps1: launch.ps1 waits for host-ready in the
        // folder IT computed (tests/release/host-instance.test.ts).
        private const string DataFolderName = "ai-session-manager";
        private const string DevDataFolderName = "ai-session-manager-dev";
        private const string DevInstanceSwitch = "--dev-instance";

        private static string _dataDir;
        private static string _readySentinel;
        private static string _logFile;
        private static bool _sentinelWritten;
        private static int _exitCode;
        // Exact launch origin (scheme + host + port), captured from args[0] at
        // startup. The navigation lock and the new-window handler compare against
        // this, not just the host, so a different scheme/port cannot escape.
        private static Uri _launchOrigin;
        // The window and its WebView2, captured in BuildForm so the activation
        // and navigation handlers can hand keyboard focus back to the page.
        private static Form _form;
        private static WebView2 _webView;

        [STAThread]
        private static int Main(string[] args)
        {
            // FIRST statement, before any window is created: bind this process
            // to the app's explicit AppUserModelID so the taskbar button groups
            // under the matching shortcut and shows app.ico.
            SetCurrentProcessExplicitAppUserModelID(AppUserModelId);

            // The folder is settled before anything is logged, so a refused
            // command line from a dev launch is logged in the dev folder too.
            bool devInstance = IsDevInstance(args);
            string localAppData = Environment.GetFolderPath(
                Environment.SpecialFolder.LocalApplicationData);
            _dataDir = Path.Combine(localAppData,
                devInstance ? DevDataFolderName : DataFolderName);
            _readySentinel = Path.Combine(_dataDir, "host-ready");
            _logFile = Path.Combine(_dataDir, "host.log");

            try
            {
                if (!Directory.Exists(_dataDir))
                {
                    Directory.CreateDirectory(_dataDir);
                }

                // args[0] is the fully-resolved URL from launch.ps1. Validate it
                // is http(s)://127.0.0.1|localhost:<port>/ ; anything else is a
                // caller bug, not something to guess around.
                if (args == null || args.Length < 1 || string.IsNullOrEmpty(args[0]))
                {
                    Log("no URL argument supplied (args[0] is required)");
                    return 2;
                }
                // After the URL, the one switch or nothing: an unknown word
                // there is a caller bug, and running anyway would put this
                // window in the installed app's folder and browser process.
                if (args.Length > 2 || (args.Length == 2 && !devInstance))
                {
                    Log("unexpected argument after the URL (only " + DevInstanceSwitch
                        + " is accepted)");
                    return 2;
                }

                Uri uri;
                if (!Uri.TryCreate(args[0], UriKind.Absolute, out uri))
                {
                    Log("URL argument is not an absolute URI: " + args[0]);
                    return 2;
                }
                if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
                {
                    Log("URL scheme not http/https: " + args[0]);
                    return 2;
                }
                if (!IsAllowedHost(uri.Host))
                {
                    Log("URL host not allowed (must be 127.0.0.1 or localhost): " + args[0]);
                    return 2;
                }

                // Capture the exact origin (scheme+host+port) the whole session
                // is locked to.
                _launchOrigin = uri;

                // Explicit, never the exe dir: keep the WebView2 profile out of
                // the (read-only WSL share) install location.
                string userDataFolder = Path.Combine(_dataDir, "webview2");
                if (!Directory.Exists(userDataFolder))
                {
                    Directory.CreateDirectory(userDataFolder);
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                using (Form form = BuildForm(userDataFolder, uri))
                {
                    Application.Run(form);
                }
                return _exitCode;
            }
            catch (Exception ex)
            {
                // Nothing escapes unlogged: WebView2 DLL load failures or any
                // other fatal init throw lands here.
                Log("fatal: " + ex);
                return 3;
            }
        }

        // args[1] is exactly the fixed switch: compared ordinally, never a
        // prefix, never case-folded, never carrying a value.
        private static bool IsDevInstance(string[] args)
        {
            return args != null && args.Length >= 2
                && string.Equals(args[1], DevInstanceSwitch, StringComparison.Ordinal);
        }

        private static bool IsAllowedHost(string host)
        {
            return string.Equals(host, "127.0.0.1", StringComparison.OrdinalIgnoreCase)
                || string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase);
        }

        private static Form BuildForm(string userDataFolder, Uri uri)
        {
            Form form = new Form();
            // Subscribed before anything can create the handle (adding the
            // WebView2 child can force it), so the event is never missed; it
            // fires again if WinForms ever recreates the handle.
            form.HandleCreated += Form_HandleCreated;
            form.Activated += Form_Activated;
            // The mascot overlay follows the app window's monitor, and goes
            // away with it (C1).
            form.LocationChanged += MainForm_MovedOrResized;
            form.SizeChanged += MainForm_MovedOrResized;
            form.FormClosed += MainForm_FormClosed;
            form.Text = "AI Session Manager";
            form.Width = 1280;
            form.Height = 860;
            form.MinimumSize = new Size(640, 480);
            form.StartPosition = FormStartPosition.CenterScreen;

            // Window icon == the exe's OWN embedded icon == the verified app.ico
            // (csc /win32icon). One source of truth for the identity.
            Icon appIcon = LoadAppIcon();
            if (appIcon != null)
            {
                form.Icon = appIcon;
            }

            WebView2 webView = new WebView2();
            webView.Dock = DockStyle.Fill;

            CoreWebView2CreationProperties props = new CoreWebView2CreationProperties();
            props.UserDataFolder = userDataFolder;
            webView.CreationProperties = props;

            webView.CoreWebView2InitializationCompleted += WebView_InitCompleted;
            webView.NavigationStarting += WebView_NavigationStarting;
            webView.NavigationCompleted += WebView_NavigationCompleted;

            form.Controls.Add(webView);
            _form = form;
            _webView = webView;

            // Setting Source implicitly begins CoreWebView2 initialization using
            // the CreationProperties above (once the control has a window
            // handle), then navigates to the target URL.
            webView.Source = uri;
            return form;
        }

        private static void Form_HandleCreated(object sender, EventArgs e)
        {
            Form form = sender as Form;
            if (form != null)
            {
                ApplyDarkChrome(form.Handle);
            }
        }

        // The window's non-client area (caption bar + border) is drawn by DWM,
        // not by us and not by the page, so a maximized window showed the
        // default light Windows caption above the dark UI. These attributes
        // recolor it to the app's own tokens. Entirely cosmetic: every failure
        // path leaves a working, correctly-sized window.
        private static void ApplyDarkChrome(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero)
            {
                return;
            }
            try
            {
                // Dark mode first: it also darkens the system context menu and
                // is what Windows 10 can honour at all. Attribute 20 is the
                // current index; fall back to the legacy 19 only if 20 fails.
                int on = 1;
                int hr = DwmSetWindowAttribute(
                    hwnd, DwmwaUseImmersiveDarkMode, ref on, sizeof(int));
                if (hr != 0)
                {
                    DwmSetWindowAttribute(
                        hwnd, DwmwaUseImmersiveDarkModeLegacy, ref on, sizeof(int));
                }

                int caption = ToColorRef(TokenBgApp);
                DwmSetWindowAttribute(
                    hwnd, DwmwaCaptionColor, ref caption, sizeof(int));

                int text = ToColorRef(TokenTextHd);
                DwmSetWindowAttribute(
                    hwnd, DwmwaTextColor, ref text, sizeof(int));

                int border = ToColorRef(TokenEdge);
                DwmSetWindowAttribute(
                    hwnd, DwmwaBorderColor, ref border, sizeof(int));
            }
            catch (Exception ex)
            {
                // DllNotFound/EntryPointNotFound on an ancient Windows, or any
                // other surprise: log once and keep the light caption.
                Log("dark window chrome could not be applied (" + ex.Message + "); non-fatal.");
            }
        }

        // 0xRRGGBB (how the CSS token is written) -> Win32 COLORREF 0x00BBGGRR.
        private static int ToColorRef(int rgb)
        {
            int r = (rgb >> 16) & 0xFF;
            int g = (rgb >> 8) & 0xFF;
            int b = rgb & 0xFF;
            return (b << 16) | (g << 8) | r;
        }

        private static Icon LoadAppIcon()
        {
            string exePath = Application.ExecutablePath;
            // 1) Documented primary: works for a local-drive install; throws on
            //    a UNC path (\\wsl.localhost), which is the normal install here.
            try
            {
                return Icon.ExtractAssociatedIcon(exePath);
            }
            catch (Exception ex)
            {
                Log("ExtractAssociatedIcon failed (" + ex.Message + "); trying ExtractIconEx.");
            }
            // 2) ExtractIconEx handles UNC paths: same embedded RT_ICON, from
            //    the exe running off the WSL share.
            try
            {
                IntPtr[] large = new IntPtr[1];
                IntPtr[] small = new IntPtr[1];
                int n = ExtractIconEx(exePath, 0, large, small, 1);
                IntPtr handle = large[0] != IntPtr.Zero ? large[0] : small[0];
                if (handle != IntPtr.Zero)
                {
                    Icon icon = (Icon)Icon.FromHandle(handle).Clone();
                    if (large[0] != IntPtr.Zero) { DestroyIcon(large[0]); }
                    if (small[0] != IntPtr.Zero) { DestroyIcon(small[0]); }
                    return icon;
                }
            }
            catch (Exception ex)
            {
                Log("ExtractIconEx failed (" + ex.Message + "); trying the local app.ico copy.");
            }
            // 3) Windows-local app.ico copy placed by make-shortcut.ps1 - in the
            //    installed instance's folder only; a dev instance never reads
            //    that folder and has 1) and 2), off its local staged copy.
            try
            {
                string ico = Path.Combine(_dataDir, "app.ico");
                if (File.Exists(ico))
                {
                    return new Icon(ico);
                }
            }
            catch (Exception ex)
            {
                Log("local app.ico load failed (" + ex.Message + ").");
            }
            Log("window icon could not be loaded from any source (non-fatal).");
            return null;
        }

        private static void WebView_InitCompleted(
            object sender, CoreWebView2InitializationCompletedEventArgs e)
        {
            if (e.IsSuccess)
            {
                // Lock the host down: disable devtools (F12 / Ctrl+Shift+I) and
                // browser accelerator keys (reload, etc.); wire NewWindowRequested
                // so window.open/target=_blank/ctrl-click cannot spawn an
                // uncontrolled popup that escapes the origin lock, and
                // PermissionRequested so every permission the page asks for is
                // answered by this host instead of by a WebView2 prompt. The
                // page -> host message channel is opened here too, with its
                // setting written explicitly WHERE IT IS READ: WebView2
                // defaults IsWebMessageEnabled to true, and a channel this
                // host answers must not depend on a default staying true.
                WebView2 wv = sender as WebView2;
                if (wv != null && wv.CoreWebView2 != null)
                {
                    wv.CoreWebView2.Settings.AreDevToolsEnabled = false;
                    wv.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = false;
                    wv.CoreWebView2.Settings.IsWebMessageEnabled = true;
                    // Hygiene: this host adds no host object to the page, so
                    // the bridge that would expose one stays off explicitly.
                    wv.CoreWebView2.Settings.AreHostObjectsAllowed = false;
                    wv.CoreWebView2.NewWindowRequested += WebView_NewWindowRequested;
                    wv.CoreWebView2.PermissionRequested += WebView_PermissionRequested;
                    wv.CoreWebView2.WebMessageReceived += WebView_WebMessageReceived;
                    ScheduleMascotOverlay();
                }
                return;
            }
            string detail = e.InitializationException == null
                ? "(no exception detail)"
                : e.InitializationException.ToString();
            Log("WebView2 initialization failed: " + detail);
            // Non-zero exit so launch.ps1's Tier-1 probe detects the failure and
            // falls through to the Edge --app fallback. No ready-sentinel is
            // written on this path.
            _exitCode = 3;
            Application.Exit();
        }

        private static void WebView_NavigationStarting(
            object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            Uri navUri;
            if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out navUri)
                || !IsLaunchOrigin(navUri))
            {
                // Navigation lock: never leave the exact launch origin.
                e.Cancel = true;
                return;
            }
            // First navigation to the allowed origin == init succeeded and the
            // window is coming up: signal readiness to launch.ps1 exactly once.
            if (!_sentinelWritten)
            {
                WriteReadySentinel();
            }
        }

        // Keyboard focus on activation. WebView2 renders the page in its own
        // child HWND tree, so the window can become active again — after an
        // Alt-Tab, or after the user clicked a link that opened the system
        // browser and then came back by clicking only the title bar, never
        // inside the page — with nothing in the web content holding the
        // keyboard. Typing and pasting then go nowhere, which is exactly what
        // an OAuth "paste code here" prompt runs into.
        private static void Form_Activated(object sender, EventArgs e)
        {
            Form form = sender as Form;
            if (form == null || form.IsDisposed)
            {
                return;
            }
            try
            {
                // Deferred: while Activated runs, WinForms is still restoring
                // its own active control, and it would undo the focus change.
                form.BeginInvoke(new MethodInvoker(FocusWebView));
            }
            catch (Exception ex)
            {
                Log("could not schedule a focus restore (" + ex.Message + "); non-fatal.");
            }
        }

        // A finished navigation means the page is there: give it the keyboard
        // without making the user click into it first.
        private static void WebView_NavigationCompleted(
            object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (e != null && !e.IsSuccess)
            {
                return;
            }
            FocusWebView();
        }

        private static void FocusWebView()
        {
            try
            {
                Form form = _form;
                WebView2 wv = _webView;
                if (form == null || wv == null || form.IsDisposed || wv.IsDisposed)
                {
                    return;
                }
                if (!form.Visible || form.WindowState == FormWindowState.Minimized)
                {
                    return;
                }
                if (!wv.CanFocus)
                {
                    return;
                }
                // Clear the form's idea of its active control first. While it
                // still points at the WebView2 control, WinForms can treat the
                // Focus() below as a no-op, and the control's OnGotFocus - the
                // only hook that calls the WebView2 controller's
                // MoveFocus(CoreWebView2MoveFocusReason.Programmatic), which is
                // what actually puts the keyboard back into the page - never
                // runs. There is no public controller on the WinForms wrapper,
                // so this is the supported way to reach that call.
                form.ActiveControl = null;
                wv.Focus();
            }
            catch (Exception ex)
            {
                Log("could not return keyboard focus to the page (" + ex.Message + "); non-fatal.");
            }
        }

        // Permissions. The page asks for clipboard read when the user pastes
        // with a keyboard command the browser does not handle itself
        // (navigator.clipboard.readText). Granted for the app's own origin -
        // the only origin that can ever be loaded here - and denied for
        // everything else, every other permission kind included. Handled is
        // always set, so WebView2 never shows a prompt of its own.
        private static void WebView_PermissionRequested(
            object sender, CoreWebView2PermissionRequestedEventArgs e)
        {
            if (e == null)
            {
                return;
            }
            Uri origin;
            bool isOurs = Uri.TryCreate(e.Uri, UriKind.Absolute, out origin)
                && IsLaunchOrigin(origin);
            if (isOurs && e.PermissionKind == CoreWebView2PermissionKind.ClipboardRead)
            {
                e.State = CoreWebView2PermissionState.Allow;
            }
            else
            {
                e.State = CoreWebView2PermissionState.Deny;
            }
            e.Handled = true;
        }

        // True only for the exact launch origin: same scheme AND host AND port.
        // Host-only matching would let a different scheme/port on 127.0.0.1
        // through; this does not.
        private static bool IsLaunchOrigin(Uri candidate)
        {
            if (candidate == null || _launchOrigin == null)
            {
                return false;
            }
            return string.Equals(candidate.Scheme, _launchOrigin.Scheme,
                       StringComparison.OrdinalIgnoreCase)
                && string.Equals(candidate.Host, _launchOrigin.Host,
                       StringComparison.OrdinalIgnoreCase)
                && candidate.Port == _launchOrigin.Port;
        }

        // --- Page -> host: files onto the Windows clipboard -----------------
        //
        // ONE string in, ONE string out, and the channel is origin-locked. The
        // page (web/src/ui/host-bridge.ts) posts, through
        // chrome.webview.postMessage:
        //
        //     copy-files\n<windowsPath1>\n<windowsPath2>...
        //
        // and gets back "copy-files ok <n>" (n = paths placed) or
        // "copy-files failed". Strings, not JSON, in both directions: the
        // in-box Framework csc.exe this host is built with has no
        // System.Text.Json, and a newline-separated kind plus a list of strings
        // needs no parser at all.
        //
        // SECURITY POSTURE, in one place:
        //
        //  * The path BOUNDARY lives in the BACKEND. Every path in this message
        //    was produced by GET /api/fs/winpath, which maps only what
        //    resolveUnderAllowed accepts (the user's home and the registered
        //    projects). The host does not know those roots and cannot re-check
        //    them - it re-checks SHAPE only, and says so out loud here rather
        //    than pretending the check is an authorization.
        //  * A message is refused WHOLE on the FIRST bad path: half a copy the
        //    user did not ask for is worse than a refusal they can see.
        //  * Nothing here is executed, resolved, opened or read. The accepted
        //    strings go to Clipboard.SetFileDropList and nowhere else.
        //  * NO PATH IS EVER LOGGED. host.log is a plain file and a path is the
        //    user's data; every line below carries a COUNT and one outcome word.
        //  * One way in, one way out: the host sends the page nothing but the
        //    two reply strings, and reads nothing from the page but this one
        //    message kind.
        private const string CopyFilesKind = "copy-files";
        private const string CopyFilesOkPrefix = "copy-files ok ";
        private const string CopyFilesFailed = "copy-files failed";

        // Caps, all three enforced before any work is done. 65536 characters is
        // the whole message; 100 is the number of paths (the page enforces the
        // same cap, which is exactly why the host does not trust it); 4096 is
        // past Windows' own extended-length limit for a single path.
        private const int MaxWebMessageLength = 65536;
        private const int MaxCopyFilesPaths = 100;
        private const int MaxWindowsPathLength = 4096;

        // The only two prefixes a clipboard path may carry, written exactly as
        // the backend writes them: the WSL share and a drive letter. The
        // charset is isDistroName's [A-Za-z0-9._-], but the CHARSET ALONE is
        // not that function: `.` and `..` are made of dots and pass it, so
        // isDistroName refuses those two by name and IsAcceptableWindowsPath
        // does the same below - a distro slot of `..` would walk the UNC path
        // one level up instead of naming a distro.
        private static readonly Regex UncPathPrefix = new Regex(
            @"^\\\\wsl\.localhost\\(?<distro>[A-Za-z0-9._-]+)\\", RegexOptions.CultureInvariant);
        private static readonly Regex DrivePathPrefix = new Regex(
            @"^[A-Za-z]:\\", RegexOptions.CultureInvariant);

        // Characters no Windows path SEGMENT may contain. `:` is in the list on
        // top of the reserved set: after the drive/UNC prefix a colon can only
        // be an alternate-data-stream suffix (`notes.txt:hidden`), which names
        // something other than the file the user copied. The backend refuses
        // all of these before it ever writes a path, so nothing legitimate is
        // lost here.
        private static readonly char[] ReservedPathChars =
            new char[] { '*', '?', '"', '<', '>', '|', ':' };

        private static void WebView_WebMessageReceived(
            object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            WebView2 wv = _webView;
            if (e == null || wv == null || wv.CoreWebView2 == null)
            {
                return;
            }

            // (a) ORIGIN FIRST, before the message is even read: the exact
            // scheme+host+port test the navigation and permission handlers use.
            // Anything else is dropped with one line that describes only that.
            Uri source;
            if (!Uri.TryCreate(e.Source, UriKind.Absolute, out source)
                || !IsLaunchOrigin(source))
            {
                Log("web message ignored: not from the launch origin.");
                return;
            }

            // (b) The message itself. TryGetWebMessageAsString throws when the
            // page posted a non-string (postMessage of an object); that is a
            // page bug with no protocol to answer in, so it is only logged.
            string webMessageText;
            try
            {
                webMessageText = e.TryGetWebMessageAsString();
            }
            catch (Exception)
            {
                Log("web message ignored: not a string.");
                return;
            }
            if (webMessageText == null || webMessageText.Length > MaxWebMessageLength)
            {
                Log("web message ignored: empty, or over the length cap.");
                return;
            }
            string[] messageLines = webMessageText.Split('\n');
            if (!string.Equals(messageLines[0], CopyFilesKind, StringComparison.Ordinal))
            {
                // No reply: an unknown kind has no protocol to reply in, and a
                // reply would tell a page that is not ours that someone is here.
                Log("web message ignored: unknown kind.");
                return;
            }
            int count = messageLines.Length - 1;
            if (count < 1 || count > MaxCopyFilesPaths)
            {
                Log("copy-files refused: " + count.ToString(CultureInfo.InvariantCulture)
                    + " items, outside the allowed 1..100.");
                PostCopyFilesReply(wv, CopyFilesFailed);
                return;
            }

            // (c) SHAPE of every path, all of them checked before ANY of them
            // is copied.
            StringCollection filePaths = new StringCollection();
            for (int i = 1; i < messageLines.Length; i++)
            {
                string pathLine = messageLines[i];
                if (!IsAcceptableWindowsPath(pathLine))
                {
                    // The index and the total are counts, not content.
                    Log("copy-files refused: item "
                        + i.ToString(CultureInfo.InvariantCulture) + " of "
                        + count.ToString(CultureInfo.InvariantCulture)
                        + " is not a well-formed Windows location.");
                    PostCopyFilesReply(wv, CopyFilesFailed);
                    return;
                }
                filePaths.Add(pathLine);
            }

            // (d) The clipboard, then (e) the reply - on EVERY outcome, because
            // the page's 3 s timeout is a belt, not the protocol.
            if (!TrySetClipboardFiles(filePaths))
            {
                PostCopyFilesReply(wv, CopyFilesFailed);
                return;
            }
            Log("copy-files ok: " + count.ToString(CultureInfo.InvariantCulture)
                + " item(s) placed on the clipboard.");
            PostCopyFilesReply(wv,
                CopyFilesOkPrefix + count.ToString(CultureInfo.InvariantCulture));
        }

        // SHAPE ONLY - never an authorization (the boundary is the backend's,
        // see the region note). The string must look like a path the backend
        // could have produced, and must not be able to mean something else once
        // Windows resolves it.
        private static bool IsAcceptableWindowsPath(string candidate)
        {
            if (string.IsNullOrEmpty(candidate) || candidate.Length > MaxWindowsPathLength)
            {
                return false;
            }
            // Control characters anywhere (< 0x20 or 0x7F), and `/` anywhere:
            // the backend writes `\` only, while Windows accepts `/` as a
            // separator too - so a `/` would smuggle a segment past the
            // backslash-based segment scan below.
            for (int i = 0; i < candidate.Length; i++)
            {
                char c = candidate[i];
                if (c < 0x20 || c == 0x7F || c == '/')
                {
                    return false;
                }
            }
            Match prefix = UncPathPrefix.Match(candidate);
            if (prefix.Success)
            {
                // The distro slot is a path segment like any other: `.` and
                // `..` match the charset and must be refused by name (the
                // backend's isDistroName refuses exactly these two too).
                string distro = prefix.Groups["distro"].Value;
                if (distro == "." || distro == "..")
                {
                    return false;
                }
            }
            else
            {
                prefix = DrivePathPrefix.Match(candidate);
            }
            if (!prefix.Success)
            {
                return false;
            }
            // Everything after `\\wsl.localhost\<distro>\` or `C:\` is segments.
            // A BARE root is refused too: there is no file there to copy, and
            // the backend never produces one for a file the user picked.
            string rest = candidate.Substring(prefix.Length);
            if (rest.Length == 0)
            {
                return false;
            }
            string[] segments = rest.Split('\\');
            for (int i = 0; i < segments.Length; i++)
            {
                if (!IsAcceptableSegment(segments[i]))
                {
                    return false;
                }
            }
            return true;
        }

        // One segment Windows can name - the same rule the backend's
        // isClipboardSegment applies before it writes a path: not empty (a
        // doubled `\` after the prefix), not `.` or `..` (a traversal, not a
        // name), no reserved character, and no trailing dot or space, which
        // Windows silently trims - so such a name would resolve to a DIFFERENT
        // file than the one the user copied.
        private static bool IsAcceptableSegment(string segment)
        {
            if (segment.Length == 0 || segment == "." || segment == "..")
            {
                return false;
            }
            if (segment.IndexOfAny(ReservedPathChars) >= 0)
            {
                return false;
            }
            char last = segment[segment.Length - 1];
            return last != '.' && last != ' ';
        }

        // WebMessageReceived is raised on the UI thread of this [STAThread]
        // process, so this IS the STA thread the clipboard requires: no
        // Invoke, no marshalling. Clipboard contention - another process
        // holding the clipboard open for a moment - is the classic failure, so
        // one retry after 100 ms, and then the page is told the truth.
        private static bool TrySetClipboardFiles(StringCollection filePaths)
        {
            try
            {
                Clipboard.SetFileDropList(filePaths);
                return true;
            }
            catch (Exception)
            {
                // Not logged: the retry below decides the outcome.
            }
            try
            {
                Thread.Sleep(100);
                Clipboard.SetFileDropList(filePaths);
                return true;
            }
            catch (Exception ex)
            {
                // The EXCEPTION CLASS ONLY, never ex.Message - the backend's
                // errorClass rule, and here it is load-bearing:
                // Clipboard.SetFileDropList validates every entry with
                // Path.GetFullPath and rethrows an ArgumentException whose
                // message INTERPOLATES THE PATH. Logging ex.Message would put
                // a user's file path in host.log on that very path.
                Log("copy-files failed: the clipboard refused the file list ("
                    + ex.GetType().Name + ").");
                return false;
            }
        }

        private static void PostCopyFilesReply(WebView2 wv, string reply)
        {
            try
            {
                wv.CoreWebView2.PostWebMessageAsString(reply);
            }
            catch (Exception ex)
            {
                // Class only, same rule as above: nothing from this region
                // ever puts an exception MESSAGE in host.log.
                Log("copy-files: the reply could not be posted ("
                    + ex.GetType().Name + "); non-fatal.");
            }
        }

        private static void WebView_NewWindowRequested(
            object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            // Never let WebView2 open its own popup window: that popup is not
            // covered by the navigation lock and would escape the origin.
            e.Handled = true;
            // Defence in depth: only a real user gesture may leave this window.
            // WebView2 sets IsUserInitiated for a click / keyboard activation;
            // a scripted window.open on a timer, or one a compromised page runs
            // by itself, reports false and is dropped here before any scheme or
            // origin test runs. The page is our own, so this changes nothing a
            // user does - it removes the case where the page acts alone.
            if (!e.IsUserInitiated)
            {
                return;
            }
            Uri target;
            if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out target))
            {
                return;
            }
            // The one sanctioned exit from the origin lock, and a deliberately
            // narrow one. Only a user-initiated window.open / target=_blank /
            // ctrl-click from the app's own page can reach this line at all:
            // the navigation lock in WebView_NavigationStarting means no other
            // page ever runs in this window. Such a link leaves through the
            // user's default browser, in a separate process, instead of opening
            // a WebView2 popup that the lock does not cover. Top-level
            // navigation in this window stays locked to the launch origin -
            // nothing here changes that. Only the exact schemes http and https
            // are handed over, so a link can never shell-execute a file:,
            // ms-something: or any other custom-protocol target.
            //
            // A SAME-ORIGIN new-window request is dropped too, on purpose: this
            // handler used to Navigate() the existing window to it, which meant
            // a link printed by a CLI inside a terminal pane could replace the
            // running app with, say, an unauthenticated 401 page and leave the
            // user no way back (no address bar, no back button in this window).
            // Nothing in the app opens a same-origin new window, so there is
            // nothing to keep working.
            if (target.Scheme == Uri.UriSchemeHttp || target.Scheme == Uri.UriSchemeHttps)
            {
                if (IsLaunchOrigin(target))
                {
                    return;
                }
                OpenInDefaultBrowser(target);
                return;
            }
            // Anything else is dropped: no popup, no navigation, no shell.
        }

        private static void OpenInDefaultBrowser(Uri target)
        {
            // Logged without the URL itself: an external link can carry an OAuth
            // state or code in its query, and host.log is a plain file.
            Log("external link handed to the default browser: "
                + target.Scheme + "://" + target.Host);
            try
            {
                // The absolute, parsed URI (never the raw string from the page)
                // and UseShellExecute, which is what routes it to the user's
                // default browser rather than starting a process directly.
                ProcessStartInfo psi = new ProcessStartInfo(target.AbsoluteUri);
                psi.UseShellExecute = true;
                Process.Start(psi);
            }
            catch (Exception ex)
            {
                Log("could not open the external link (" + ex.Message + "); non-fatal.");
            }
        }

        // --- Peek-mascot overlay (Nocturne C1) --------------------------------
        //
        // A second borderless form in THIS process (MascotOverlayForm, below):
        // topmost, WS_EX_TOOLWINDOW (no taskbar button, not in Alt-Tab),
        // WS_EX_NOACTIVATE + MA_NOACTIVATE (a click never takes the focus from
        // what the user is doing), with its own WebView2 controller on the
        // MAIN WebView2's environment (same browser process, same profile) and
        // a transparent background, on <launch origin>/mascot.html - never with
        // a query string (the page's ?demo strip stays unreachable here).
        //
        // VISUAL HOSTING (PLAN-C1 § Fix after release): the page draws through
        // a CoreWebView2CompositionController into a DirectComposition visual
        // tree on the form, and the form has no GDI surface at all
        // (WS_EX_NOREDIRECTIONBITMAP) - per-pixel alpha, no colour key. The
        // first build keyed a colour out (TransparencyKey) around a windowed
        // WebView2 control, and that transparent area turned opaque for good
        // after ONE resize of the form - which the host does on every display
        // change: a black box around the mascot until the app restarted. The
        // page has no window of its own this way, so the form hands it the
        // mouse input it needs and applies its cursor
        // (MascotOverlayForm.WndProc).
        //
        // The page tells the host what to show; the host decides nothing else.
        // Two strings, both JSON, both matched WHOLE against the exact shape
        // JSON.stringify gives them on the page (web/src/mascot/feed.ts), key
        // order included - anything else is logged and dropped:
        //
        //     {"type":"mascot-count","count":N,"rects":[[x,y,w,h],...]}
        //     {"type":"mascot-open","session":"<uuid>"}
        //
        // WHERE the mascots are: the rects, in CSS px of the 220 x 340 page. The
        // window's region (SetWindowRgn) is their union, scaled by the
        // overlay's DPI, so the transparent rest of the window takes no clicks
        // and draws nothing - a click next to a mascot reaches the window below.
        //
        // "Hidden" (count 0, or no usable rect) is an EMPTY region, not
        // Form.Hide(): the window then draws nothing and takes no click, which
        // is everything hiding buys - but its WebView2 stays visible to
        // Chromium. A hidden WebView2 (controller IsVisible = false) makes the
        // page hidden, and a page hidden for 5 minutes gets Chromium's
        // intensive timer throttling (chained timers woken once a MINUTE): the
        // page's 2 s poll would then show a finished session's mascot up to a
        // minute late, in exactly the common case of "nothing for a while".
        //
        // ON TOP: while a mascot shows, the window re-asserts HWND_TOPMOST -
        // never activating, never moving - on every count message with rects
        // and whenever the foreground window changes (a WinEvent hook), then
        // once more OverlayLateRaiseMs after the last change. A fullscreen
        // window that is topmost itself (DXGI/SDL fullscreen, some video
        // players) otherwise covers the mascot as soon as it comes to the
        // front, and such a window raises itself WHILE it activates - after
        // the foreground event has already fired.
        //
        // Known limit (decision 15, accepted by the user): a game in true
        // EXCLUSIVE fullscreen owns the display and no window can draw over it,
        // this one included. Borderless / optimised fullscreen and video work.
        //
        // Failure here is never the app's failure: every path that goes wrong
        // logs one line and drops the overlay, the main window carries on.
        private const int MascotStageWidth = 220;
        private const int MascotStageHeight = 340;
        private const int MaxMascotMessageLength = 1024;
        private const string MascotPagePath = "/mascot.html";

        // Written the way JSON.stringify writes a finite number (the page sends
        // whole numbers today; a fraction or an exponent is still a number).
        // Every regex below ends in \z, not $: $ also matches before a
        // trailing newline.
        private const string JsonNumber =
            @"-?(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,20})?(?:[eE][+-]?[0-9]{1,3})?";
        private const string JsonRect =
            @"\[" + JsonNumber + "," + JsonNumber + "," + JsonNumber + "," + JsonNumber + @"\]";

        // count: one digit 0..3 (an integer by construction); rects: zero to
        // three [x,y,w,h] of four numbers each.
        private static readonly Regex MascotCountMessage = new Regex(
            @"^\{""type"":""mascot-count"",""count"":(?<count>[0-3]),""rects"":\[(?<rects>"
                + JsonRect + "(?:," + JsonRect + @"){0,2})?\]\}\z",
            RegexOptions.CultureInvariant);
        private static readonly Regex MascotRectItem = new Regex(
            @"\[(?<x>" + JsonNumber + "),(?<y>" + JsonNumber + "),(?<w>" + JsonNumber
                + "),(?<h>" + JsonNumber + @")\]",
            RegexOptions.CultureInvariant);
        // The session id's only shape (the server's randomUUID(), the same
        // regex the main page applies in web/src/ui/host-bridge.ts), either
        // case. A character class, not RegexOptions.IgnoreCase: that option
        // would loosen the literal "type" and "mascot-open" too.
        private static readonly Regex MascotOpenMessage = new Regex(
            @"^\{""type"":""mascot-open"",""session"":""(?<session>[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})""\}\z",
            RegexOptions.CultureInvariant);

        private static MascotOverlayForm _overlay;
        // The page's controller, once it exists; null before that and after
        // the overlay is dropped.
        private static CoreWebView2CompositionController _overlayController;
        // The DirectComposition tree the page draws into: the device, the
        // form's target, and the root visual the controller hangs its own
        // visuals under (its RootVisualTarget). Released in
        // DisposeMascotOverlay.
        private static IDCompositionDevice _overlayDevice;
        private static IDCompositionTarget _overlayTarget;
        private static IDCompositionVisual _overlayRootVisual;
        // The last rects the page reported (validated, clamped, CSS px), or
        // null while nothing is shown. Kept so a DPI or monitor change can
        // re-scale the region without waiting for the page.
        private static double[][] _overlayRects;
        private static string _overlayScreenName;

        [DllImport("user32.dll")]
        private static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool bRedraw);
        [DllImport("gdi32.dll")]
        private static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
        [DllImport("gdi32.dll")]
        private static extern int CombineRgn(IntPtr dest, IntPtr src1, IntPtr src2, int mode);
        [DllImport("gdi32.dll")]
        private static extern bool DeleteObject(IntPtr hObject);
        [DllImport("user32.dll")]
        private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
            int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr hWnd);
        // A device with no rendering device of its own: the controller brings
        // the content. PreserveSig = false turns a failing HRESULT into an
        // exception, which the creating step catches and logs as one line.
        [DllImport("dcomp.dll", PreserveSig = false)]
        private static extern void DCompositionCreateDevice2(IntPtr renderingDevice,
            [In] ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object device);

        private const int RgnOr = 2;
        private static readonly IntPtr HwndTopmost = new IntPtr(-1);
        private const uint SwpNoSize = 0x0001;
        private const uint SwpNoMove = 0x0002;
        private const uint SwpNoActivate = 0x0010;
        private const int SwRestore = 9;

        // Called once the MAIN WebView2 is up: the overlay needs its
        // environment, and must never get in the way of the main window
        // starting. Deferred so it runs after the main init handler returns.
        private static void ScheduleMascotOverlay()
        {
            try
            {
                Form main = _form;
                if (main != null && !main.IsDisposed && main.IsHandleCreated)
                {
                    main.BeginInvoke(new MethodInvoker(CreateMascotOverlay));
                }
            }
            catch (Exception ex)
            {
                Log("mascot overlay could not be scheduled (" + ex.GetType().Name
                    + "); the app window is unaffected.");
            }
        }

        private static void CreateMascotOverlay()
        {
            if (_overlay != null)
            {
                return;
            }
            try
            {
                Form main = _form;
                WebView2 mainView = _webView;
                if (main == null || main.IsDisposed || mainView == null
                    || mainView.CoreWebView2 == null)
                {
                    return;
                }
                CoreWebView2Environment env = mainView.CoreWebView2.Environment;

                MascotOverlayForm overlay = new MascotOverlayForm();
                overlay.Text = "AI Session Manager mascot";
                overlay.FormBorderStyle = FormBorderStyle.None;
                overlay.ShowInTaskbar = false;
                overlay.StartPosition = FormStartPosition.Manual;
                overlay.AutoScaleMode = AutoScaleMode.None;
                // NOT the TopMost property: WinForms focuses a TopMost form
                // when it is shown, ShowWithoutActivation or not, and the
                // overlay would take the activation from the app window at
                // start. WS_EX_TOPMOST comes from MascotOverlayForm.CreateParams
                // and RaiseOverlay re-asserts it.
                overlay.DpiChanged += Overlay_DpiChanged;

                _overlay = overlay;
                _overlayRects = null;

                // The handle first, then an EMPTY region, then the place - all
                // before the first show, so the window never flashes a frame.
                IntPtr handle = overlay.Handle;
                ApplyOverlayRegion();
                PlaceOverlay();
                // The visual tree before the show too: where DirectComposition
                // is refused, the overlay is dropped without ever appearing.
                CreateOverlayComposition(handle);
                // ShowWithoutActivation (MascotOverlayForm) makes this
                // SW_SHOWNOACTIVATE: the window the user is in keeps the focus.
                overlay.Show();
                SubscribeDisplayEvents();
                WatchForeground();

                // The MAIN window's environment: same browser process, same
                // profile. The continuation runs on this UI thread (the
                // WinForms synchronization context), where the controller
                // must be used.
                Task<CoreWebView2CompositionController> pending =
                    env.CreateCoreWebView2CompositionControllerAsync(handle);
                pending.ContinueWith(
                    delegate(Task<CoreWebView2CompositionController> done)
                    {
                        OverlayController_Created(overlay, done);
                    },
                    TaskScheduler.FromCurrentSynchronizationContext());
            }
            catch (Exception ex)
            {
                Log("mascot overlay could not be created (" + ex.GetType().Name
                    + "); the app window is unaffected.");
                DisposeMascotOverlay();
            }
        }

        // The tree the page draws into: a device, a target on the form
        // (topmost: over anything GDI could draw - on this window, nothing),
        // and a root visual that becomes the controller's RootVisualTarget.
        // Each lands in its static the moment it exists, so
        // DisposeMascotOverlay releases whatever a failure part-way left.
        private static void CreateOverlayComposition(IntPtr handle)
        {
            Guid iid = typeof(IDCompositionDevice).GUID;
            object device;
            DCompositionCreateDevice2(IntPtr.Zero, ref iid, out device);
            _overlayDevice = (IDCompositionDevice)device;
            _overlayTarget = _overlayDevice.CreateTargetForHwnd(handle, true);
            _overlayRootVisual = _overlayDevice.CreateVisual();
            _overlayTarget.SetRoot(_overlayRootVisual);
            _overlayDevice.Commit();
        }

        // The controller exists, or could not be made. An overlay dropped in
        // the meantime (the app closing) has no use for it: it is closed.
        private static void OverlayController_Created(
            MascotOverlayForm overlay, Task<CoreWebView2CompositionController> done)
        {
            CoreWebView2CompositionController cc =
                done.Status == TaskStatus.RanToCompletion ? done.Result : null;
            if (overlay != _overlay || overlay.IsDisposed)
            {
                CloseOverlayController(cc);
                return;
            }
            if (cc == null)
            {
                string detail = done.Exception == null
                    ? "no detail" : done.Exception.GetBaseException().GetType().Name;
                Log("mascot overlay: WebView2 initialization failed (" + detail
                    + "); the app window is unaffected.");
                DeferDisposeMascotOverlay();
                return;
            }
            _overlayController = cc;
            try
            {
                // The page's scale is the host's to set, never the monitor's
                // (SyncOverlayController says why).
                cc.ShouldDetectMonitorScaleChanges = false;
                // Before the page loads: the controller paints no background
                // of its own, so what the page leaves transparent stays so.
                cc.DefaultBackgroundColor = Color.Transparent;
                cc.RootVisualTarget = _overlayRootVisual;
                // Always visible to Chromium: "hidden" is the empty region.
                cc.IsVisible = true;
                SyncOverlayController();
                overlay.AttachController(cc, OverlayInput_Failed);

                CoreWebView2 core = cc.CoreWebView2;
                CoreWebView2Settings s = core.Settings;
                s.AreDevToolsEnabled = false;
                s.AreBrowserAcceleratorKeysEnabled = false;
                s.AreHostObjectsAllowed = false;
                s.IsWebMessageEnabled = true;
                // A page with no text and no menu: no context menu, no zoom (a
                // zoomed page would no longer match the rects it reports), no
                // status bubble, no swipe or pinch.
                s.AreDefaultContextMenusEnabled = false;
                s.IsZoomControlEnabled = false;
                s.IsStatusBarEnabled = false;
                try
                {
                    s.IsPinchZoomEnabled = false;
                    s.IsSwipeNavigationEnabled = false;
                }
                catch (Exception)
                {
                    // Older runtime without these two: cosmetic, carry on.
                }
                // The navigation lock before the first navigation.
                core.NavigationStarting += OverlayWebView_NavigationStarting;
                core.NewWindowRequested += OverlayWebView_NewWindowRequested;
                core.PermissionRequested += OverlayWebView_PermissionRequested;
                core.WebMessageReceived += OverlayWebView_WebMessageReceived;
                core.ProcessFailed += OverlayWebView_ProcessFailed;
                core.Navigate(new Uri(_launchOrigin, MascotPagePath).AbsoluteUri);
            }
            catch (Exception ex)
            {
                Log("mascot overlay could not load its page (" + ex.GetType().Name
                    + "); the app window is unaffected.");
                DeferDisposeMascotOverlay();
            }
        }

        // The page's box follows the form: Bounds = the client rect, and the
        // page's scale = the region's scale (OverlayScale), so CSS px x that
        // scale = window px - the 220 x 340 stage fills the window exactly and
        // the rects the page reports land where the region puts them. Left to
        // itself (ShouldDetectMonitorScaleChanges, switched off at creation)
        // the controller would take the monitor's scale AND the user's text
        // size setting, and with either above 100 % the stage would overflow
        // the window and the region miss the mascots. OverlayScale is 1.0 while
        // this process is not DPI aware (PLAN-C1, "No DPI awareness in v1":
        // Windows scales the whole window itself).
        private static void SyncOverlayController()
        {
            MascotOverlayForm overlay = _overlay;
            CoreWebView2CompositionController cc = _overlayController;
            if (overlay == null || overlay.IsDisposed || cc == null)
            {
                return;
            }
            cc.RasterizationScale = OverlayScale();
            cc.Bounds = new Rectangle(Point.Empty, overlay.ClientSize);
            // The page's idea of where it sits on the screen follows a move.
            cc.NotifyParentWindowPositionChanged();
            IDCompositionDevice device = _overlayDevice;
            if (device != null)
            {
                device.Commit();
            }
        }

        // MascotOverlayForm hands the page its mouse input; the first input
        // the controller refuses ends the overlay: a mascot that still takes
        // the clicks on it but can no longer answer them is worse than none.
        private static void OverlayInput_Failed(Exception ex)
        {
            Log("mascot overlay: mouse input could not reach the page ("
                + ex.GetType().Name + "); the app window is unaffected.");
            // Deferred: this runs inside the overlay's own window procedure.
            DeferDisposeMascotOverlay();
        }

        private static void CloseOverlayController(CoreWebView2CompositionController cc)
        {
            if (cc == null)
            {
                return;
            }
            try
            {
                cc.Close();
            }
            catch (Exception ex)
            {
                Log("mascot overlay: its WebView2 could not be closed (" + ex.GetType().Name
                    + "); non-fatal.");
            }
        }

        private static void ReleaseOverlayComposition()
        {
            IDCompositionVisual visual = _overlayRootVisual;
            IDCompositionTarget target = _overlayTarget;
            IDCompositionDevice device = _overlayDevice;
            _overlayRootVisual = null;
            _overlayTarget = null;
            _overlayDevice = null;
            try
            {
                if (visual != null)
                {
                    Marshal.FinalReleaseComObject(visual);
                }
                if (target != null)
                {
                    Marshal.FinalReleaseComObject(target);
                }
                if (device != null)
                {
                    Marshal.FinalReleaseComObject(device);
                }
            }
            catch (Exception ex)
            {
                Log("mascot overlay: its composition objects could not be released ("
                    + ex.GetType().Name + "); non-fatal.");
            }
        }

        // The overlay's page: the exact launch origin AND /mascot.html AND no
        // query - the same origin test as the main window, narrowed to the one
        // page this window exists for.
        private static bool IsMascotPage(Uri candidate)
        {
            return IsLaunchOrigin(candidate)
                && string.Equals(candidate.AbsolutePath, MascotPagePath, StringComparison.Ordinal)
                && string.IsNullOrEmpty(candidate.Query);
        }

        private static void OverlayWebView_NavigationStarting(
            object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            Uri navUri;
            if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out navUri) || !IsMascotPage(navUri))
            {
                e.Cancel = true;
            }
            // No ready sentinel here: that is the main window's signal alone.
        }

        // Nothing leaves the overlay: no popup, no default browser, no shell.
        private static void OverlayWebView_NewWindowRequested(
            object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            e.Handled = true;
        }

        // The overlay needs no permission at all, clipboard included.
        private static void OverlayWebView_PermissionRequested(
            object sender, CoreWebView2PermissionRequestedEventArgs e)
        {
            if (e == null)
            {
                return;
            }
            e.State = CoreWebView2PermissionState.Deny;
            e.Handled = true;
        }

        // A crashed page cannot report "no mascots" any more: drop the region
        // so a dead frame never sits over other programs taking clicks. A dead
        // or hung RENDERER is reloaded (the navigation lock allows the same
        // page), at most MaxOverlayReloads times per OverlayReloadWindow; past
        // that the overlay stays empty and says so once. A dead BROWSER process
        // is terminal: the app window lost it too.
        private const int MaxOverlayReloads = 3;
        private static readonly TimeSpan OverlayReloadWindow = TimeSpan.FromMinutes(10);
        private static readonly System.Collections.Generic.List<DateTime> _overlayReloads =
            new System.Collections.Generic.List<DateTime>();
        private static bool _overlayReloadCapLogged;

        private static void OverlayWebView_ProcessFailed(
            object sender, CoreWebView2ProcessFailedEventArgs e)
        {
            string kind = e == null ? "no detail" : e.ProcessFailedKind.ToString();
            Log("mascot overlay: WebView2 process failed (" + kind + "); mascots hidden.");
            try
            {
                _overlayRects = null;
                ApplyOverlayRegion();
            }
            catch (Exception)
            {
                // Best effort; the reload below still applies.
            }
            if (e == null
                || (e.ProcessFailedKind != CoreWebView2ProcessFailedKind.RenderProcessExited
                    && e.ProcessFailedKind != CoreWebView2ProcessFailedKind.RenderProcessUnresponsive))
            {
                return;
            }
            DateTime now = DateTime.UtcNow;
            _overlayReloads.RemoveAll(delegate(DateTime t) { return now - t > OverlayReloadWindow; });
            if (_overlayReloads.Count >= MaxOverlayReloads)
            {
                if (!_overlayReloadCapLogged)
                {
                    _overlayReloadCapLogged = true;
                    Log("mascot overlay: reload cap reached (3 per 10 min); mascots stay hidden.");
                }
                return;
            }
            _overlayReloads.Add(now);
            _overlayReloadCapLogged = false;
            try
            {
                // Deferred: not from inside the WebView2's own event.
                Form main = _form;
                if (main != null && !main.IsDisposed && main.IsHandleCreated)
                {
                    main.BeginInvoke(new MethodInvoker(ReloadMascotOverlay));
                }
            }
            catch (Exception ex)
            {
                Log("mascot overlay: reload could not be scheduled (" + ex.GetType().Name
                    + "); non-fatal.");
            }
        }

        private static void ReloadMascotOverlay()
        {
            CoreWebView2CompositionController cc = _overlayController;
            if (_overlay == null || cc == null)
            {
                return;
            }
            try
            {
                cc.CoreWebView2.Reload();
            }
            catch (Exception ex)
            {
                Log("mascot overlay: reload failed (" + ex.GetType().Name + "); non-fatal.");
            }
        }

        // Monitors added / removed / re-arranged / re-scaled, or the taskbar
        // moved or resized (the working area: UserPreferenceCategory.Desktop,
        // which is where SPI_SETWORKAREA lands): re-place the window and
        // re-scale the region. SystemEvents are STATIC - unsubscribed in
        // DisposeMascotOverlay, and every handler re-checks the overlay,
        // because a raise can already be queued when the overlay goes away.
        private static bool _displayEventsSubscribed;

        private static void SubscribeDisplayEvents()
        {
            if (_displayEventsSubscribed)
            {
                return;
            }
            Microsoft.Win32.SystemEvents.DisplaySettingsChanged += SystemEvents_DisplaySettingsChanged;
            Microsoft.Win32.SystemEvents.UserPreferenceChanged += SystemEvents_UserPreferenceChanged;
            _displayEventsSubscribed = true;
        }

        private static void UnsubscribeDisplayEvents()
        {
            if (!_displayEventsSubscribed)
            {
                return;
            }
            _displayEventsSubscribed = false;
            try
            {
                Microsoft.Win32.SystemEvents.DisplaySettingsChanged -= SystemEvents_DisplaySettingsChanged;
                Microsoft.Win32.SystemEvents.UserPreferenceChanged -= SystemEvents_UserPreferenceChanged;
            }
            catch (Exception)
            {
                // Going away anyway.
            }
        }

        private static void SystemEvents_DisplaySettingsChanged(object sender, EventArgs e)
        {
            QueueOverlayReplace();
        }

        private static void SystemEvents_UserPreferenceChanged(
            object sender, Microsoft.Win32.UserPreferenceChangedEventArgs e)
        {
            if (e != null && e.Category == Microsoft.Win32.UserPreferenceCategory.Desktop)
            {
                QueueOverlayReplace();
            }
        }

        // SystemEvents may raise on their own thread: always hop to the UI
        // thread through the overlay's own handle.
        private static void QueueOverlayReplace()
        {
            try
            {
                MascotOverlayForm overlay = _overlay;
                if (overlay != null && !overlay.IsDisposed && overlay.IsHandleCreated)
                {
                    overlay.BeginInvoke(new MethodInvoker(ReplaceOverlay));
                }
            }
            catch (Exception)
            {
                // The overlay went away between the check and the call.
            }
        }

        private static void ReplaceOverlay()
        {
            MascotOverlayForm overlay = _overlay;
            if (overlay == null || overlay.IsDisposed)
            {
                return;
            }
            try
            {
                PlaceOverlay();
                ApplyOverlayRegion();
            }
            catch (Exception ex)
            {
                Log("mascot overlay could not follow a display change (" + ex.GetType().Name
                    + "); non-fatal.");
            }
        }

        private static void OverlayWebView_WebMessageReceived(
            object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (e == null || _overlay == null)
            {
                return;
            }
            // (a) ORIGIN FIRST, before the message is read.
            Uri source;
            if (!Uri.TryCreate(e.Source, UriKind.Absolute, out source) || !IsMascotPage(source))
            {
                Log("mascot message ignored: not from the mascot page on the launch origin.");
                return;
            }
            // (b) Strings only.
            string text;
            try
            {
                text = e.TryGetWebMessageAsString();
            }
            catch (Exception)
            {
                Log("mascot message ignored: not a string.");
                return;
            }
            if (text == null || text.Length > MaxMascotMessageLength)
            {
                Log("mascot message ignored: empty, or over the length cap.");
                return;
            }
            // (c) One of the two exact shapes, or nothing. Nothing from the
            // message is ever logged.
            Match m = MascotCountMessage.Match(text);
            if (m.Success)
            {
                HandleMascotCount(m);
                return;
            }
            m = MascotOpenMessage.Match(text);
            if (m.Success)
            {
                HandleMascotOpen(m.Groups["session"].Value);
                return;
            }
            Log("mascot message ignored: not a well-formed mascot-count or mascot-open.");
        }

        private static void HandleMascotCount(Match m)
        {
            int count = m.Groups["count"].Value[0] - '0';
            if (count == 0)
            {
                ShowMascotRects(null);
                return;
            }
            System.Collections.Generic.List<double[]> rects =
                new System.Collections.Generic.List<double[]>();
            foreach (Match r in MascotRectItem.Matches(m.Groups["rects"].Value))
            {
                double x, y, w, h;
                if (!TryParseFinite(r.Groups["x"].Value, out x)
                    || !TryParseFinite(r.Groups["y"].Value, out y)
                    || !TryParseFinite(r.Groups["w"].Value, out w)
                    || !TryParseFinite(r.Groups["h"].Value, out h))
                {
                    Log("mascot message ignored: a rect value is not a finite number.");
                    return;
                }
                // Clamped to the stage: a rect can never reach past the window.
                double x0 = Clamp(x, 0, MascotStageWidth);
                double y0 = Clamp(y, 0, MascotStageHeight);
                double x1 = Clamp(x + w, 0, MascotStageWidth);
                double y1 = Clamp(y + h, 0, MascotStageHeight);
                if (x1 > x0 && y1 > y0)
                {
                    rects.Add(new double[] { x0, y0, x1 - x0, y1 - y0 });
                }
            }
            // A count without a usable rect has nothing to show or click.
            ShowMascotRects(rects.Count == 0 ? null : rects.ToArray());
        }

        private static bool TryParseFinite(string text, out double value)
        {
            if (!double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out value))
            {
                return false;
            }
            return !double.IsNaN(value) && !double.IsInfinity(value);
        }

        private static double Clamp(double v, double min, double max)
        {
            return v < min ? min : (v > max ? max : v);
        }

        // null = nothing to show (an empty region); otherwise the union of the
        // rects. Going from nothing to something re-places the window (the
        // working area may have changed since); EVERY count with rects puts it
        // back on top of the other topmost windows, without activating it.
        private static void ShowMascotRects(double[][] rects)
        {
            MascotOverlayForm overlay = _overlay;
            if (overlay == null || overlay.IsDisposed)
            {
                return;
            }
            try
            {
                bool wasEmpty = _overlayRects == null;
                _overlayRects = rects;
                if (rects != null)
                {
                    if (wasEmpty)
                    {
                        PlaceOverlay();
                    }
                    RaiseOverlay();
                }
                ApplyOverlayRegion();
            }
            catch (Exception ex)
            {
                Log("mascot overlay could not be updated (" + ex.GetType().Name + "); non-fatal.");
            }
        }

        // HWND_TOPMOST again - the top of the topmost band - while a mascot
        // shows. Never activates, never moves or sizes: this runs on every
        // foreground change, and the window the user is in keeps the focus.
        private static void RaiseOverlay()
        {
            MascotOverlayForm overlay = _overlay;
            if (overlay == null || overlay.IsDisposed || !overlay.IsHandleCreated
                || _overlayRects == null)
            {
                return;
            }
            SetWindowPos(overlay.Handle, HwndTopmost, 0, 0, 0, 0,
                SwpNoMove | SwpNoSize | SwpNoActivate);
        }

        // The foreground watch (ON TOP, region note). Out of context: the
        // callback runs on THIS UI thread, from its message loop - no
        // marshalling. The delegate is a static readonly field for the whole
        // process: user32 holds it as a native pointer the GC cannot see, and
        // an event already queued may still arrive after UnhookWinEvent.
        private delegate void WinEventProc(IntPtr hook, uint eventType, IntPtr hwnd,
            int idObject, int idChild, uint eventThread, uint eventTime);

        [DllImport("user32.dll")]
        private static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax,
            IntPtr hmodWinEventProc, WinEventProc callback, uint idProcess, uint idThread,
            uint flags);
        [DllImport("user32.dll")]
        private static extern bool UnhookWinEvent(IntPtr hook);

        private const uint EventSystemForeground = 0x0003;
        private const uint WinEventOutOfContext = 0x0000;
        // The late raise: a window that makes itself topmost does it while
        // it activates (a DXGI swap chain entering fullscreen, an SDL window),
        // after the foreground event this host was told about. One raise half
        // a second after the LAST change catches that, for one SetWindowPos.
        private const int OverlayLateRaiseMs = 500;

        private static readonly WinEventProc ForegroundHookProc = Foreground_Changed;
        private static IntPtr _foregroundHook;
        private static System.Windows.Forms.Timer _lateRaiseTimer;

        private static void WatchForeground()
        {
            if (_foregroundHook != IntPtr.Zero)
            {
                return;
            }
            _foregroundHook = SetWinEventHook(EventSystemForeground, EventSystemForeground,
                IntPtr.Zero, ForegroundHookProc, 0, 0, WinEventOutOfContext);
            if (_foregroundHook == IntPtr.Zero)
            {
                // The count messages still raise the window.
                Log("mascot overlay: foreground changes cannot be watched; non-fatal.");
            }
            System.Windows.Forms.Timer late = new System.Windows.Forms.Timer();
            late.Interval = OverlayLateRaiseMs;
            late.Tick += LateRaiseTimer_Tick;
            _lateRaiseTimer = late;
        }

        private static void UnwatchForeground()
        {
            IntPtr hook = _foregroundHook;
            System.Windows.Forms.Timer late = _lateRaiseTimer;
            _foregroundHook = IntPtr.Zero;
            _lateRaiseTimer = null;
            try
            {
                if (hook != IntPtr.Zero)
                {
                    UnhookWinEvent(hook);
                }
                if (late != null)
                {
                    late.Stop();
                    late.Dispose();
                }
            }
            catch (Exception)
            {
                // Going away anyway.
            }
        }

        private static void Foreground_Changed(IntPtr hook, uint eventType, IntPtr hwnd,
            int idObject, int idChild, uint eventThread, uint eventTime)
        {
            // Nothing may unwind into user32's callback.
            try
            {
                if (_overlay == null || _overlayRects == null)
                {
                    return;
                }
                RaiseOverlay();
                System.Windows.Forms.Timer late = _lateRaiseTimer;
                if (late != null)
                {
                    late.Stop();
                    late.Start();
                }
            }
            catch (Exception ex)
            {
                Log("mascot overlay could not be raised (" + ex.GetType().Name + "); non-fatal.");
            }
        }

        private static void LateRaiseTimer_Tick(object sender, EventArgs e)
        {
            try
            {
                System.Windows.Forms.Timer late = sender as System.Windows.Forms.Timer;
                if (late != null)
                {
                    late.Stop();
                }
                RaiseOverlay();
            }
            catch (Exception ex)
            {
                Log("mascot overlay could not be raised (" + ex.GetType().Name + "); non-fatal.");
            }
        }

        // The overlay's DPI scale: CSS px -> window px. 1.0 while this process
        // is not per-monitor DPI aware (Windows then scales the whole window
        // itself); the monitor's scale if it ever is.
        private static double OverlayScale()
        {
            MascotOverlayForm overlay = _overlay;
            int dpi = overlay == null ? 96 : overlay.DeviceDpi;
            return dpi > 0 ? dpi / 96.0 : 1.0;
        }

        // SetWindowRgn = the union of _overlayRects scaled to window px,
        // rounded OUTWARD so a mascot is never clipped by a rounding pixel; an
        // empty region when there is nothing to show.
        private static void ApplyOverlayRegion()
        {
            MascotOverlayForm overlay = _overlay;
            if (overlay == null || overlay.IsDisposed || !overlay.IsHandleCreated)
            {
                return;
            }
            double scale = OverlayScale();
            IntPtr region = CreateRectRgn(0, 0, 0, 0);
            if (region == IntPtr.Zero)
            {
                Log("mascot overlay: no region could be created; non-fatal.");
                return;
            }
            double[][] rects = _overlayRects;
            if (rects != null)
            {
                for (int i = 0; i < rects.Length; i++)
                {
                    double[] r = rects[i];
                    IntPtr one = CreateRectRgn(
                        (int)Math.Floor(r[0] * scale),
                        (int)Math.Floor(r[1] * scale),
                        (int)Math.Ceiling((r[0] + r[2]) * scale),
                        (int)Math.Ceiling((r[1] + r[3]) * scale));
                    if (one != IntPtr.Zero)
                    {
                        CombineRgn(region, region, one, RgnOr);
                        DeleteObject(one);
                    }
                }
            }
            // On success the system owns the region; only a failure leaves it
            // to us.
            if (SetWindowRgn(overlay.Handle, region, true) == 0)
            {
                DeleteObject(region);
                Log("mascot overlay: the window region was refused; non-fatal.");
            }
        }

        // 220 x 340 (DPI-scaled) at the right edge of the WORKING AREA of the
        // app window's monitor, vertically centred. Screen.FromHandle on a
        // minimised window answers the monitor it was on before (the
        // MonitorFromWindow rule), which is decision 12.
        private static void PlaceOverlay()
        {
            Form main = _form;
            MascotOverlayForm overlay = _overlay;
            if (main == null || main.IsDisposed || overlay == null || overlay.IsDisposed)
            {
                return;
            }
            Screen screen = Screen.FromHandle(main.Handle);
            Rectangle area = screen.WorkingArea;
            double scale = OverlayScale();
            int w = (int)Math.Round(MascotStageWidth * scale);
            int h = (int)Math.Round(MascotStageHeight * scale);
            overlay.Bounds = new Rectangle(area.Right - w, area.Top + (area.Height - h) / 2, w, h);
            _overlayScreenName = screen.DeviceName;
            // The page has no window to follow the form's on its own.
            SyncOverlayController();
        }

        private static void MainForm_MovedOrResized(object sender, EventArgs e)
        {
            MascotOverlayForm overlay = _overlay;
            Form main = _form;
            if (overlay == null || overlay.IsDisposed || main == null || main.IsDisposed)
            {
                return;
            }
            try
            {
                string name = Screen.FromHandle(main.Handle).DeviceName;
                if (!string.Equals(name, _overlayScreenName, StringComparison.Ordinal))
                {
                    PlaceOverlay();
                    ApplyOverlayRegion();
                }
            }
            catch (Exception ex)
            {
                Log("mascot overlay could not follow the app window (" + ex.GetType().Name
                    + "); non-fatal.");
            }
        }

        // Only raised if the process is per-monitor DPI aware: the size and
        // the region follow the new scale.
        private static void Overlay_DpiChanged(object sender, DpiChangedEventArgs e)
        {
            try
            {
                PlaceOverlay();
                ApplyOverlayRegion();
            }
            catch (Exception ex)
            {
                Log("mascot overlay could not follow a DPI change (" + ex.GetType().Name
                    + "); non-fatal.");
            }
        }

        // A click on a mascot, after its reaction played: the app comes to the
        // front on that session. SetForegroundWindow is allowed here - this
        // process just received the user's click. The message to the main page
        // is built from the VALIDATED id only, never from the page's text.
        private static void HandleMascotOpen(string sessionId)
        {
            Form main = _form;
            if (main == null || main.IsDisposed)
            {
                return;
            }
            try
            {
                IntPtr hwnd = main.Handle;
                if (IsIconic(hwnd))
                {
                    // SW_RESTORE brings back the state before minimising,
                    // maximised included.
                    ShowWindow(hwnd, SwRestore);
                }
                main.Activate();
                if (!SetForegroundWindow(hwnd))
                {
                    Log("mascot-open: Windows kept another window in front (the app flashes in the taskbar instead).");
                }
            }
            catch (Exception ex)
            {
                Log("mascot-open: the app window could not be brought forward ("
                    + ex.GetType().Name + "); non-fatal.");
            }
            WebView2 mainView = _webView;
            if (mainView == null || mainView.CoreWebView2 == null)
            {
                return;
            }
            try
            {
                mainView.CoreWebView2.PostWebMessageAsString(
                    "{\"type\":\"focus-session\",\"session\":\"" + sessionId + "\"}");
            }
            catch (Exception ex)
            {
                Log("mascot-open: focus-session could not be posted ("
                    + ex.GetType().Name + "); non-fatal.");
            }
        }

        private static void MainForm_FormClosed(object sender, FormClosedEventArgs e)
        {
            DisposeMascotOverlay();
        }

        // Called from inside the overlay's own callbacks - the WebView2
        // continuation that creates and loads its controller, and its window
        // procedure (OverlayInput_Failed) - so the controller and the form must
        // not be closed and disposed under their feet: the main window's
        // message loop does it next.
        private static void DeferDisposeMascotOverlay()
        {
            try
            {
                Form main = _form;
                if (main != null && !main.IsDisposed && main.IsHandleCreated)
                {
                    main.BeginInvoke(new MethodInvoker(DisposeMascotOverlay));
                    return;
                }
            }
            catch (Exception)
            {
                // Fall through to the direct path.
            }
            DisposeMascotOverlay();
        }

        // In this order: no more events or input, the controller closed (its
        // visuals leave the tree), the composition objects released, then the
        // window. Each step on its own, so one failure never skips the rest.
        private static void DisposeMascotOverlay()
        {
            UnsubscribeDisplayEvents();
            UnwatchForeground();
            MascotOverlayForm overlay = _overlay;
            CoreWebView2CompositionController cc = _overlayController;
            _overlay = null;
            _overlayController = null;
            _overlayRects = null;
            if (overlay != null)
            {
                try
                {
                    overlay.DetachController();
                }
                catch (Exception ex)
                {
                    Log("mascot overlay: its input could not be detached (" + ex.GetType().Name
                        + "); non-fatal.");
                }
            }
            CloseOverlayController(cc);
            ReleaseOverlayComposition();
            if (overlay == null)
            {
                return;
            }
            try
            {
                overlay.Close();
                overlay.Dispose();
            }
            catch (Exception ex)
            {
                Log("mascot overlay: its window could not be closed (" + ex.GetType().Name
                    + "); non-fatal.");
            }
        }

        private static void WriteReadySentinel()
        {
            try
            {
                int pid = Process.GetCurrentProcess().Id;
                File.WriteAllText(_readySentinel,
                    pid.ToString(CultureInfo.InvariantCulture));
                _sentinelWritten = true;
            }
            catch (Exception ex)
            {
                Log("could not write ready sentinel: " + ex.Message);
            }
        }

        private static void Log(string message)
        {
            try
            {
                if (_dataDir != null && !Directory.Exists(_dataDir))
                {
                    Directory.CreateDirectory(_dataDir);
                }
                // Cap the log so error-path logging can never grow unbounded:
                // if it is already over ~1 MB, truncate before appending.
                if (File.Exists(_logFile)
                    && new FileInfo(_logFile).Length > 1000000)
                {
                    File.WriteAllText(_logFile, string.Empty);
                }
                string stamp = DateTime.UtcNow.ToString(
                    "yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);
                File.AppendAllText(_logFile, stamp + "  " + message + Environment.NewLine);
            }
            catch
            {
                // Logging must never throw further.
            }
        }
    }

    // The peek-mascot window (C1). Everything that must be true BEFORE the
    // handle exists lives here (extended styles are fixed at creation), and
    // so does the page's mouse input: with visual hosting the page has no
    // window of its own, so every mouse message lands HERE and the ones the
    // page needs are handed on to its controller.
    internal sealed class MascotOverlayForm : Form
    {
        private const int WsExTopmost = 0x00000008;
        private const int WsExToolWindow = 0x00000080;
        private const int WsExNoRedirectionBitmap = 0x00200000;
        private const int WsExNoActivate = 0x08000000;
        private const int WmSetCursor = 0x0020;
        private const int WmMouseActivate = 0x0021;
        private const int WmMouseMove = 0x0200;
        private const int WmLButtonDown = 0x0201;
        private const int WmLButtonUp = 0x0202;
        private const int WmLButtonDblClk = 0x0203;
        private const int WmMouseLeave = 0x02A3;
        private const int MaNoActivate = 3;
        private const int HtClient = 1;
        private const uint TmeLeave = 0x00000002;
        // MK_LBUTTON .. MK_XBUTTON2, the key flags in a mouse message's
        // wParam - CoreWebView2MouseEventVirtualKeys copies them bit for bit.
        private const int MouseKeyFlags = 0x007F;

        [StructLayout(LayoutKind.Sequential)]
        private struct TrackMouseEventInfo
        {
            public int Size;
            public uint Flags;
            public IntPtr Window;
            public uint HoverTime;
        }

        [DllImport("user32.dll")]
        private static extern bool TrackMouseEvent(ref TrackMouseEventInfo track);
        [DllImport("user32.dll")]
        private static extern IntPtr SetCursor(IntPtr cursor);

        // Set once the page's controller exists; null before and after.
        private CoreWebView2CompositionController _controller;
        // Told ONCE, about the first input the controller refused.
        private Action<Exception> _inputFailed;
        // TrackMouseEvent(TME_LEAVE) is armed: the pointer is over the window,
        // and WM_MOUSELEAVE comes when it goes.
        private bool _leaveArmed;

        // Show() becomes SW_SHOWNOACTIVATE: showing never takes the focus.
        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }

        // TOOLWINDOW: no taskbar button, not in Alt-Tab. NOACTIVATE: a click
        // does not make this the active window (a game or an editor keeps the
        // keyboard; the click still reaches the page). TOPMOST: over other
        // programs. NOREDIRECTIONBITMAP: no GDI surface at all - what shows is
        // the DirectComposition tree the page draws into, with per-pixel
        // alpha, so the window is neither layered nor colour-keyed.
        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= WsExTopmost | WsExToolWindow | WsExNoRedirectionBitmap
                    | WsExNoActivate;
                return cp;
            }
        }

        // Nothing to paint: there is no GDI surface to paint on.
        protected override void OnPaintBackground(PaintEventArgs e)
        {
        }

        // From now on the page gets this window's mouse input and sets its
        // cursor. inputFailed hears of the first input the controller refuses;
        // forwarding stops right there.
        internal void AttachController(CoreWebView2CompositionController controller,
            Action<Exception> inputFailed)
        {
            _controller = controller;
            _inputFailed = inputFailed;
            controller.CursorChanged += Controller_CursorChanged;
        }

        // Forwarding stops first, so a failing unsubscribe cannot leave it on.
        internal void DetachController()
        {
            CoreWebView2CompositionController controller = _controller;
            _controller = null;
            _inputFailed = null;
            if (controller != null)
            {
                controller.CursorChanged -= Controller_CursorChanged;
            }
        }

        protected override void WndProc(ref Message m)
        {
            switch (m.Msg)
            {
                case WmMouseActivate:
                    // "Do not activate": the click still reaches the page, the
                    // window the user is in keeps the focus.
                    m.Result = new IntPtr(MaNoActivate);
                    return;
                case WmSetCursor:
                    if (LowWord(m.LParam) == HtClient && ApplyPageCursor())
                    {
                        m.Result = new IntPtr(1);
                        return;
                    }
                    break;
                case WmMouseMove:
                    if (Forward(CoreWebView2MouseEventKind.Move, ref m))
                    {
                        return;
                    }
                    break;
                case WmLButtonDown:
                    if (Forward(CoreWebView2MouseEventKind.LeftButtonDown, ref m))
                    {
                        return;
                    }
                    break;
                case WmLButtonUp:
                    if (Forward(CoreWebView2MouseEventKind.LeftButtonUp, ref m))
                    {
                        return;
                    }
                    break;
                case WmLButtonDblClk:
                    if (Forward(CoreWebView2MouseEventKind.LeftButtonDoubleClick, ref m))
                    {
                        return;
                    }
                    break;
                case WmMouseLeave:
                    if (Forward(CoreWebView2MouseEventKind.Leave, ref m))
                    {
                        return;
                    }
                    break;
            }
            base.WndProc(ref m);
        }

        // One mouse message to the page: the key flags from the wParam's low
        // word, the point in client px from the lParam (signed - a captured
        // move off the window is negative), which is the page's CSS px at the
        // scale the host sets. False = no controller: WinForms handles the
        // message as it always would.
        private bool Forward(CoreWebView2MouseEventKind kind, ref Message m)
        {
            CoreWebView2CompositionController controller = _controller;
            if (controller == null)
            {
                return false;
            }
            try
            {
                if (kind == CoreWebView2MouseEventKind.Move && !_leaveArmed)
                {
                    // The page must hear when the pointer leaves (its hover
                    // state), and Windows only says so when asked, once.
                    _leaveArmed = ArmLeave();
                }
                else if (kind == CoreWebView2MouseEventKind.Leave)
                {
                    _leaveArmed = false;
                }
                if (kind == CoreWebView2MouseEventKind.LeftButtonDown
                    || kind == CoreWebView2MouseEventKind.LeftButtonDoubleClick)
                {
                    // The release must reach the page too, even off the mascot.
                    Capture = true;
                }
                CoreWebView2MouseEventVirtualKeys keys = CoreWebView2MouseEventVirtualKeys.None;
                Point point = Point.Empty;
                if (kind != CoreWebView2MouseEventKind.Leave)
                {
                    keys = (CoreWebView2MouseEventVirtualKeys)(LowWord(m.WParam) & MouseKeyFlags);
                    point = new Point(SignedLowWord(m.LParam), SignedHighWord(m.LParam));
                }
                controller.SendMouseInput(kind, keys, 0, point);
                if (kind == CoreWebView2MouseEventKind.LeftButtonUp && Capture)
                {
                    Capture = false;
                }
            }
            catch (Exception ex)
            {
                Action<Exception> failed = _inputFailed;
                _controller = null;
                _inputFailed = null;
                if (failed != null)
                {
                    failed(ex);
                }
            }
            return true;
        }

        private bool ArmLeave()
        {
            TrackMouseEventInfo track = new TrackMouseEventInfo();
            track.Size = Marshal.SizeOf(typeof(TrackMouseEventInfo));
            track.Flags = TmeLeave;
            track.Window = Handle;
            return TrackMouseEvent(ref track);
        }

        // The page changed its cursor (the hand over a mascot). Windows asks
        // for a cursor only when the mouse moves (WM_SETCURSOR), so with the
        // pointer over this window the new one is applied now.
        private void Controller_CursorChanged(object sender, object e)
        {
            if (_leaveArmed || Capture)
            {
                ApplyPageCursor();
            }
        }

        // The page's cursor, set at once and never kept (the HCURSOR is the
        // controller's). False = no controller or no cursor: WinForms then
        // sets the arrow. A controller that fails here is left to the next
        // forwarded input to report.
        private bool ApplyPageCursor()
        {
            CoreWebView2CompositionController controller = _controller;
            if (controller == null)
            {
                return false;
            }
            try
            {
                IntPtr cursor = controller.Cursor;
                if (cursor == IntPtr.Zero)
                {
                    return false;
                }
                SetCursor(cursor);
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static int LowWord(IntPtr value)
        {
            return (int)(value.ToInt64() & 0xFFFF);
        }

        private static int SignedLowWord(IntPtr value)
        {
            return unchecked((short)(value.ToInt64() & 0xFFFF));
        }

        private static int SignedHighWord(IntPtr value)
        {
            return unchecked((short)((value.ToInt64() >> 16) & 0xFFFF));
        }
    }

    // DirectComposition, declared by hand (the in-box csc has no Windows SDK
    // projection): only the slots the overlay calls, in dcomp.h vtable order
    // - WaitForCommitCompletion and GetFrameStatistics are declared only to
    // keep the two after them in place. Not PreserveSig: a failing HRESULT
    // throws, and the overlay's step that made the call logs it as one line.
    [ComImport]
    [Guid("C37EA93A-E7AA-450D-B16F-9746CB0407F3")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IDCompositionDevice
    {
        void Commit();
        void WaitForCommitCompletion();
        void GetFrameStatistics(IntPtr statistics);
        IDCompositionTarget CreateTargetForHwnd(IntPtr hwnd,
            [MarshalAs(UnmanagedType.Bool)] bool topmost);
        IDCompositionVisual CreateVisual();
    }

    [ComImport]
    [Guid("EACDD04C-117E-4E17-88F4-D1B12B0E3D89")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IDCompositionTarget
    {
        void SetRoot(IDCompositionVisual visual);
    }

    // No method is called on the root visual: it only travels - to the
    // target's SetRoot and to the controller's RootVisualTarget.
    [ComImport]
    [Guid("4D93059D-097B-4651-9A60-F0F25116E2F3")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IDCompositionVisual
    {
    }
}
