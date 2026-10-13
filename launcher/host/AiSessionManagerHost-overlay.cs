// AiSessionManagerHost-overlay.cs - part of the native WebView2 host: one
// partial class HostApp in four files, cut from one by Q6
// (.claude/plans/quality/PLAN-Q6.md). The header, the C# 5 rule (no $"",
// no => members, no ?.) and the assembly attribute are in
// AiSessionManagerHost.cs; the other parts are AiSessionManagerHost-clipboard.cs
// and AiSessionManagerHost-overlay-window.cs.
//
// Holds the first half of the "Peek-mascot overlay (Nocturne C1)" region:
// its design note, consts, fields, P/Invokes, creation, composition,
// the stray-window fix, navigation lock and reload. The rest is in
// -overlay-window.cs.

using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace AiSessionManager
{
    internal static partial class HostApp
    {
        // --- Peek-mascot overlay (Nocturne C1) --------------------------------
        //
        // A second borderless form in THIS process (MascotOverlayForm, in
        // AiSessionManagerHost-overlay-window.cs):
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
        // ONE STRAY WINDOW (WebView2Feedback #5668, no fix upstream): under
        // visual hosting the browser process still makes a top-level
        // Chrome_WidgetWin_1 of its own at the overlay's exact bounds - layered
        // with alpha 0, NOACTIVATE, no owner, not topmost - WITHOUT
        // WS_EX_TRANSPARENT, so it still hit-tests: an invisible 220 x 340
        // dead zone over everything below it in z-order (the desktop at
        // least), where a click lands nowhere. The host ORs WS_EX_TRANSPARENT
        // into exactly that window (MakeStrayInputWindowClickThrough), after
        // the controller exists and again on every count message, in case
        // Chromium makes it anew. Hit-testing is all that changes: the page's
        // input comes through SendMouseInput anyway, and the window is never
        // hidden or moved (Chromium may take a hidden one as occluded and stop
        // rendering).
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
        // One line each per overlay life: the stray window fixed, or refused.
        private static bool _strayWindowFixLogged;
        private static bool _strayWindowFailLogged;

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
                _strayWindowFixLogged = false;
                _strayWindowFailLogged = false;

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
                MakeStrayInputWindowClickThrough();
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

        // The stray window (region note, ONE STRAY WINDOW). Found among the
        // top-level windows of its class and changed only when EVERY test in
        // IsStrayInputWindow holds: the MAIN window's WebView2 shares the
        // browser process, and its windows must stay exactly as they are.
        // SetWindowLongPtr on another process's window of the same integrity
        // level is allowed for GWL_EXSTYLE. 64-bit entry points: the host is
        // built /platform:x64 only.
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter,
            string className, string windowName);
        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder className,
            int maxCount);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
        private static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
        private static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int index, IntPtr newLong);
        [DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr hWnd, out NativeRect rect);

        [StructLayout(LayoutKind.Sequential)]
        private struct NativeRect
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        private const string StrayInputWindowClass = "Chrome_WidgetWin_1";
        private const int GwlExStyle = -20;
        private const long WsExTransparent = 0x00000020;
        private const long WsExLayered = 0x00080000;
        private const long WsExNoActivate = 0x08000000;
        // A bound on the walk, far above any real count of Chromium windows:
        // a list that changes under the walk can never make it spin.
        private const int MaxStrayWindowScan = 512;

        // Never throws, never changes anything but that one bit: a failure
        // logs one line per overlay life and leaves every window as it was.
        private static void MakeStrayInputWindowClickThrough()
        {
            MascotOverlayForm overlay = _overlay;
            CoreWebView2CompositionController cc = _overlayController;
            if (overlay == null || overlay.IsDisposed || cc == null)
            {
                return;
            }
            try
            {
                uint browserProcessId = cc.CoreWebView2.BrowserProcessId;
                Rectangle bounds = overlay.Bounds;
                bool changed = false;
                bool refused = false;
                IntPtr hwnd = IntPtr.Zero;
                for (int i = 0; i < MaxStrayWindowScan; i++)
                {
                    hwnd = FindWindowEx(IntPtr.Zero, hwnd, StrayInputWindowClass, null);
                    if (hwnd == IntPtr.Zero)
                    {
                        break;
                    }
                    if (!IsStrayInputWindow(hwnd, browserProcessId, bounds))
                    {
                        continue;
                    }
                    long exStyle = GetWindowLongPtr(hwnd, GwlExStyle).ToInt64();
                    if ((exStyle & WsExTransparent) != 0)
                    {
                        continue;
                    }
                    // The old style is never 0 here (LAYERED is in it), so a 0
                    // answer can only mean the call was refused.
                    if (SetWindowLongPtr(hwnd, GwlExStyle, new IntPtr(exStyle | WsExTransparent))
                        == IntPtr.Zero)
                    {
                        refused = true;
                    }
                    else
                    {
                        changed = true;
                    }
                }
                if (changed && !_strayWindowFixLogged)
                {
                    _strayWindowFixLogged = true;
                    Log("mascot overlay: WebView2's Chrome_WidgetWin_1 window made click-through.");
                }
                if (refused && !_strayWindowFailLogged)
                {
                    _strayWindowFailLogged = true;
                    Log("mascot overlay: WebView2's Chrome_WidgetWin_1 window refused click-through; non-fatal.");
                }
            }
            catch (Exception ex)
            {
                if (!_strayWindowFailLogged)
                {
                    _strayWindowFailLogged = true;
                    Log("mascot overlay: WebView2's Chrome_WidgetWin_1 window could not be checked ("
                        + ex.GetType().Name + "); non-fatal.");
                }
            }
        }

        // ALL of: the overlay's browser process, the class exactly (FindWindowEx
        // compares it case-blind), LAYERED and NOACTIVATE, and the overlay's
        // bounds to the pixel.
        private static bool IsStrayInputWindow(IntPtr hwnd, uint browserProcessId, Rectangle bounds)
        {
            uint processId;
            GetWindowThreadProcessId(hwnd, out processId);
            if (processId == 0 || processId != browserProcessId)
            {
                return false;
            }
            System.Text.StringBuilder className = new System.Text.StringBuilder(64);
            if (GetClassName(hwnd, className, className.Capacity) == 0
                || !string.Equals(className.ToString(), StrayInputWindowClass, StringComparison.Ordinal))
            {
                return false;
            }
            long exStyle = GetWindowLongPtr(hwnd, GwlExStyle).ToInt64();
            if ((exStyle & WsExLayered) == 0 || (exStyle & WsExNoActivate) == 0)
            {
                return false;
            }
            NativeRect r;
            if (!GetWindowRect(hwnd, out r))
            {
                return false;
            }
            return r.Left == bounds.Left && r.Top == bounds.Top
                && r.Right == bounds.Right && r.Bottom == bounds.Bottom;
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
    }
}
