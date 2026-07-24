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
// C# 5 only (compiled by the in-box Framework csc.exe, pre-Roslyn): no string
// interpolation, no expression-bodied members, no null-conditional operators.

using System;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

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

        // Design tokens, written exactly as in web/src/styles/tokens.css so the
        // two stay diffable: --bg-app, --text-hd, --edge. ToColorRef converts.
        private const int TokenBgApp = 0x171D25;
        private const int TokenTextHd = 0xAAB7C4;
        private const int TokenEdge = 0x262F3B;

        private static string _dataDir;
        private static string _readySentinel;
        private static string _logFile;
        private static bool _sentinelWritten;
        private static int _exitCode;
        // Exact launch origin (scheme + host + port), captured from args[0] at
        // startup. The navigation lock and the new-window handler compare against
        // this, not just the host, so a different scheme/port cannot escape.
        private static Uri _launchOrigin;

        [STAThread]
        private static int Main(string[] args)
        {
            // FIRST statement, before any window is created: bind this process
            // to the app's explicit AppUserModelID so the taskbar button groups
            // under the matching shortcut and shows app.ico.
            SetCurrentProcessExplicitAppUserModelID(AppUserModelId);

            string localAppData = Environment.GetFolderPath(
                Environment.SpecialFolder.LocalApplicationData);
            _dataDir = Path.Combine(localAppData, "ai-session-manager");
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

            form.Controls.Add(webView);

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
            // 3) Windows-local app.ico copy placed by make-shortcut.ps1.
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
                // uncontrolled popup that escapes the origin lock.
                WebView2 wv = sender as WebView2;
                if (wv != null && wv.CoreWebView2 != null)
                {
                    wv.CoreWebView2.Settings.AreDevToolsEnabled = false;
                    wv.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = false;
                    wv.CoreWebView2.NewWindowRequested += WebView_NewWindowRequested;
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

        private static void WebView_NewWindowRequested(
            object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            // Never let WebView2 open its own popup window: that popup is not
            // covered by the navigation lock and would escape the origin.
            e.Handled = true;
            Uri target;
            if (Uri.TryCreate(e.Uri, UriKind.Absolute, out target)
                && IsLaunchOrigin(target))
            {
                // Same-origin request: keep it in the existing window instead of
                // a popup.
                CoreWebView2 core = sender as CoreWebView2;
                if (core != null)
                {
                    core.Navigate(e.Uri);
                }
            }
            // Anything off-origin is dropped: no popup, no navigation.
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
}
