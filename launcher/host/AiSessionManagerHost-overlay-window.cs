// AiSessionManagerHost-overlay-window.cs - part of the native WebView2 host: one
// partial class HostApp in four files, cut from one by Q6
// (.claude/plans/quality/PLAN-Q6.md). The header, the C# 5 rule (no $"",
// no => members, no ?.) and the assembly attribute are in
// AiSessionManagerHost.cs; the other parts are AiSessionManagerHost-clipboard.cs
// and AiSessionManagerHost-overlay.cs.
//
// Holds the second half of the "Peek-mascot overlay (Nocturne C1)" region
// (its design note opens -overlay.cs): display events, the overlay's
// web messages, the foreground hook, region / placement / DPI, open and
// dispose; then MascotOverlayForm and the DirectComposition interfaces.

using System;
using System.Drawing;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace AiSessionManager
{
    internal static partial class HostApp
    {
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
            // Every count, 0 included: the stray window blocks clicks whether
            // a mascot shows or not.
            MakeStrayInputWindowClickThrough();
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
