// AiSessionManagerHost-clipboard.cs - part of the native WebView2 host: one
// partial class HostApp in four files, cut from one by Q6
// (.claude/plans/quality/PLAN-Q6.md). The header, the C# 5 rule (no $"",
// no => members, no ?.) and the assembly attribute are in
// AiSessionManagerHost.cs; the other parts are AiSessionManagerHost-overlay.cs
// and AiSessionManagerHost-overlay-window.cs.
//
// Holds the "Page -> host: files onto the Windows clipboard" region: the
// origin-locked copy-files web message, its path checks, the clipboard
// write and the reply.

using System;
using System.Collections.Specialized;
using System.Globalization;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace AiSessionManager
{
    internal static partial class HostApp
    {
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
    }
}
