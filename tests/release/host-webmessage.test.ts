/**
 * The page -> host message channel that puts FILES on the Windows clipboard
 * (Nocturne B10 phase 3, plan `.claude/plans/nocturne/PLAN-B10.md` §4).
 *
 * WHAT THIS TEST IS. A source-shape test over the TEXT of
 * `launcher/host/AiSessionManagerHost.cs`, the idiom
 * `tests/release/launcher-config.test.ts` and `tests/release/installer-script.test.ts` already
 * use on the launcher's `.ps1`/`.cs` sources. Nothing here runs the host:
 * there is no Windows, no `csc.exe` and no clipboard on the machine `npm test`
 * runs on, and the host's whole behaviour is WebView2 + `Clipboard`.
 *
 * WHAT IT CAN PROVE: that the guarantees the plan names are PRESENT and in the
 * required ORDER in the source — the origin check before the message is read,
 * the three caps, the shape vocabulary, the clipboard call with its one retry,
 * a reply on every outcome, and that no log line can carry a path. The two
 * path PREFIX regexes are extracted from the C# verbatim string literals and
 * executed here against real samples (their source is identical in the .NET
 * and the JavaScript dialect for these two patterns), so those two are proven
 * by behaviour, not by text.
 *
 * WHAT IT CANNOT PROVE: that the compiled host behaves this way. The segment
 * scan, the clipboard call and the replies are C# statements this test only
 * READS — a check could be present and unreachable, and no text test would
 * see it. The behaviour itself is the user's Windows check (build with
 * `launcher/build-host.ps1`, copy a file from the Files panel, paste in
 * Explorer), exactly as §5 of the plan says.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot, readSource } from '../helpers/helpers.ts';

const HOST_CS = join(projectRoot, 'launcher', 'host', 'AiSessionManagerHost.cs');
const cs = readFileSync(HOST_CS, 'utf8');

/** The body of a `private static … Name(` member, up to the next member. */
function member(name: string): string {
  const start = cs.indexOf(`private static void ${name}(`);
  const startAny = start === -1 ? cs.indexOf(`private static bool ${name}(`) : start;
  assert.notEqual(startAny, -1, `${name} not found in AiSessionManagerHost.cs`);
  const next = cs.indexOf('\n        private static', startAny + 10);
  return cs.slice(startAny, next === -1 ? cs.length : next);
}

const handler = member('WebView_WebMessageReceived');

/**
 * The phase-3 region only: from its banner comment to the end of the reply
 * helper. Some assertions below are region-scoped on purpose — the rest of
 * this host predates B10 and lives by its own (older) rules.
 */
const region = (() => {
  const start = cs.indexOf('// --- Page -> host: files onto the Windows clipboard');
  assert.notEqual(start, -1, 'the copy-files region banner is gone');
  const endMarker = 'private static void PostCopyFilesReply(';
  const end = cs.indexOf(endMarker);
  assert.ok(end > start, 'PostCopyFilesReply is not in the region');
  const close = cs.indexOf('\n        }\n', end);
  return cs.slice(start, close + 11);
})();

// --- the channel is opened where it is read --------------------------------

test('host: IsWebMessageEnabled is set explicitly, beside the other Settings lines', () => {
  const init = member('WebView_InitCompleted');
  assert.match(init, /wv\.CoreWebView2\.Settings\.IsWebMessageEnabled = true;/);
  // Beside the two lockdown settings, i.e. in the same block that is only
  // reached when initialization succeeded.
  assert.match(init, /Settings\.AreDevToolsEnabled = false;/);
  assert.match(init, /Settings\.AreBrowserAcceleratorKeysEnabled = false;/);
  assert.match(init, /wv\.CoreWebView2\.WebMessageReceived \+= WebView_WebMessageReceived;/);
  // No host object exists, so the bridge that would expose one stays off.
  assert.match(init, /wv\.CoreWebView2\.Settings\.AreHostObjectsAllowed = false;/);
});

test('host: the exe declares its target framework, so path handling is not the legacy one', () => {
  // Without this attribute the CLR runs the exe under the pre-4.6.2 quirks,
  // where Switch.System.IO.UseLegacyPathHandling makes Path.GetFullPath -
  // which Clipboard.SetFileDropList calls on every entry - throw for any path
  // of 260+ characters, while this host accepts 4096.
  assert.match(
    cs,
    /\[assembly: System\.Runtime\.Versioning\.TargetFramework\(\s*"\.NETFramework,Version=v4\.7\.2", FrameworkDisplayName = "\.NET Framework 4\.7\.2"\)\]/,
  );
  // In the source, not in an .exe.config: the launcher ships four files, so
  // the build script must not produce or copy a config file.
  const build = readSource('launcher', 'build-host.ps1');
  assert.doesNotMatch(build, /exe\.config/);
});

// --- origin first ----------------------------------------------------------

test('host: the handler checks the launch origin BEFORE it reads the message', () => {
  const origin = handler.indexOf('IsLaunchOrigin(');
  const read = handler.indexOf('TryGetWebMessageAsString()');
  assert.notEqual(origin, -1, 'no IsLaunchOrigin call in the web-message handler');
  assert.notEqual(read, -1, 'no TryGetWebMessageAsString call in the web-message handler');
  assert.ok(
    origin < read,
    'the origin test must run before the message is read, not after',
  );
  // The SAME test the navigation and permission handlers use: scheme+host+port.
  assert.match(handler, /Uri\.TryCreate\(e\.Source, UriKind\.Absolute, out source\)/);
});

// --- the message shape and its caps ----------------------------------------

test('host: the kind line and the three caps are literals in the source', () => {
  assert.match(cs, /private const string CopyFilesKind = "copy-files";/);
  assert.match(cs, /private const int MaxWebMessageLength = 65536;/);
  assert.match(cs, /private const int MaxCopyFilesPaths = 100;/);
  assert.match(cs, /private const int MaxWindowsPathLength = 4096;/);

  // Split on '\n', line 0 compared ordinally against the kind, 1..100 paths.
  assert.match(handler, /webMessageText\.Split\('\\n'\)/);
  assert.match(
    handler,
    /string\.Equals\(messageLines\[0\], CopyFilesKind, StringComparison\.Ordinal\)/,
  );
  assert.match(handler, /webMessageText\.Length > MaxWebMessageLength/);
  assert.match(handler, /count < 1 \|\| count > MaxCopyFilesPaths/);
});

// --- the shape check -------------------------------------------------------

/** The source text of a C# verbatim regex literal, usable as a JS pattern. */
function regexLiteral(field: string): RegExp {
  const m = new RegExp(
    `private static readonly Regex ${field} = new Regex\\(\\s*@"([^"]*)"`,
  ).exec(cs);
  assert.ok(m, `${field} is not a verbatim-string Regex literal`);
  return new RegExp(m[1]!);
}

test('host: the two path prefixes accept only the shapes the backend produces', () => {
  const unc = regexLiteral('UncPathPrefix');
  const drive = regexLiteral('DrivePathPrefix');

  assert.equal(unc.source, '^\\\\\\\\wsl\\.localhost\\\\(?<distro>[A-Za-z0-9._-]+)\\\\');
  assert.equal(drive.source, '^[A-Za-z]:\\\\');

  // Accepted (both branches of server/winpath.ts's windowsPathForClipboard).
  assert.ok(unc.test('\\\\wsl.localhost\\Ubuntu-24.04\\home\\you\\notes.txt'));
  assert.ok(unc.test('\\\\wsl.localhost\\Debian\\home\\you\\my notes\\a (1).md'));
  assert.ok(drive.test('C:\\Users\\you\\Documents\\notes.txt'));
  assert.ok(drive.test('z:\\x'));

  // Refused: a look-alike host, a different share, a relative or rooted path,
  // a distro name outside [A-Za-z0-9._-], and a bare `\\server\share`.
  assert.ok(!unc.test('\\\\wsl.localhost.evil\\Ubuntu\\home\\you\\x'));
  assert.ok(!unc.test('\\\\wsl.localhostx\\Ubuntu\\home\\you\\x'));
  assert.ok(!unc.test('\\\\attacker\\share\\x'));
  assert.ok(!unc.test('\\\\wsl.localhost\\Ub untu\\home\\you\\x'));
  assert.ok(!unc.test('\\wsl.localhost\\Ubuntu\\home\\you\\x'));
  assert.ok(!drive.test('\\Users\\you\\x'));
  assert.ok(!drive.test('CC:\\x'));
  assert.ok(!drive.test('1:\\x'));
  // Neither prefix matches a UNIX path or a URL, so neither can reach the
  // clipboard through this channel.
  assert.ok(!unc.test('/home/you/notes.txt') && !drive.test('/home/you/notes.txt'));
  assert.ok(!unc.test('file:///C:/x') && !drive.test('file:///C:/x'));
});

test('host: the distro slot may not be `.` or `..`', () => {
  const check = member('IsAcceptableWindowsPath');
  // The charset alone admits both (they are made of dots), so the source
  // refuses them BY NAME after the match - the same two names the backend's
  // isDistroName refuses. These two lines are what the mirror below runs.
  assert.match(check, /string distro = prefix\.Groups\["distro"\]\.Value;/);
  assert.match(check, /if \(distro == "\." \|\| distro == "\.\."\)\s*\{\s*return false;/);

  const unc = regexLiteral('UncPathPrefix');
  const accepted = (path: string): boolean => {
    const m = unc.exec(path);
    if (!m) return false;
    const distro = m.groups?.distro;
    return distro !== '.' && distro !== '..';
  };
  assert.equal(accepted('\\\\wsl.localhost\\Ubuntu-24.04\\x'), true);
  assert.equal(accepted('\\\\wsl.localhost\\..\\x'), false);
  assert.equal(accepted('\\\\wsl.localhost\\.\\x'), false);
});

test('host: the per-path checks refuse control characters, `/`, traversal, reserved characters and trailing dot/space', () => {
  const check = member('IsAcceptableWindowsPath');
  const segment = member('IsAcceptableSegment');

  // Length cap and the whole-string character scan.
  assert.match(check, /candidate\.Length > MaxWindowsPathLength/);
  assert.match(check, /c < 0x20 \|\| c == 0x7F \|\| c == '\/'/);
  // A bare root has nothing to copy.
  assert.match(check, /rest\.Length == 0/);
  // Segments are split on the backslash, every one of them checked.
  assert.match(check, /rest\.Split\('\\\\'\)/);
  assert.match(check, /!IsAcceptableSegment\(segments\[i\]\)/);

  // `.` and `..` are names Windows would resolve elsewhere; an empty segment
  // is a doubled backslash.
  assert.match(segment, /segment\.Length == 0 \|\| segment == "\." \|\| segment == "\.\."/);
  // The reserved set, exactly: * ? " < > | and the ADS colon.
  const reserved =
    /private static readonly char\[\] ReservedPathChars =\s*new char\[\] \{([^}]*)\};/.exec(cs);
  assert.ok(reserved, 'ReservedPathChars is not a char[] literal');
  const chars = [...reserved[1]!.matchAll(/'(\\?.)'/g)].map((m) =>
    m[1] === "\\'" ? "'" : m[1]!.replace('\\', ''),
  );
  assert.deepEqual(chars, ['*', '?', '"', '<', '>', '|', ':']);
  assert.match(segment, /segment\.IndexOfAny\(ReservedPathChars\) >= 0/);
  // Windows trims a trailing dot or space, so such a name is a different file.
  assert.match(segment, /last != '\.' && last != ' '/);

  // The WHOLE message is refused on the FIRST bad path: the refusal branch
  // returns, and it does so BEFORE anything reaches the clipboard, so no
  // partial collection can be copied.
  const refusal = /if \(!IsAcceptableWindowsPath\(pathLine\)\)\s*\{[\s\S]*?return;\s*\}/.exec(
    handler,
  );
  assert.ok(refusal, 'the shape refusal branch does not return');
  assert.ok(
    handler.indexOf(refusal[0]) < handler.indexOf('TrySetClipboardFiles(filePaths)'),
    'the refusal must come before the clipboard call',
  );
});

// --- clipboard + replies ---------------------------------------------------

test('host: the clipboard is set on the UI thread with exactly one retry', () => {
  const put = member('TrySetClipboardFiles');
  const calls = put.match(/Clipboard\.SetFileDropList\(filePaths\);/g) ?? [];
  assert.equal(calls.length, 2, 'expected the call and exactly one retry');
  assert.match(put, /Thread\.Sleep\(100\);/);
  // No Invoke/BeginInvoke: WebMessageReceived already runs on the STA UI thread.
  assert.doesNotMatch(put, /BeginInvoke|\.Invoke\(/);
  assert.match(cs, /new StringCollection\(\)/);
});

test('host: every outcome answers the page with one of the two reply strings', () => {
  assert.match(cs, /private const string CopyFilesOkPrefix = "copy-files ok ";/);
  assert.match(cs, /private const string CopyFilesFailed = "copy-files failed";/);
  assert.match(cs, /PostWebMessageAsString\(reply\)/);

  // At least one failure reply, and exactly ONE success reply (the count
  // refusal, the shape refusal and the clipboard failure all reply failed;
  // how many branches there are is the handler's business, not this test's).
  const failed = handler.match(/PostCopyFilesReply\(wv, CopyFilesFailed\);/g) ?? [];
  assert.ok(failed.length >= 1, 'no failed reply anywhere in the handler');
  const ok = handler.match(/PostCopyFilesReply\(wv,\s*CopyFilesOkPrefix/g) ?? [];
  assert.equal(ok.length, 1, 'expected exactly one success reply');
  assert.match(
    handler,
    /PostCopyFilesReply\(wv,\s*CopyFilesOkPrefix \+ count\.ToString\(CultureInfo\.InvariantCulture\)\)/,
  );

  // A message from another origin, a non-string, an over-cap message and an
  // unknown kind get NO reply: those are not this protocol.
  const beforeKind = handler.slice(0, handler.indexOf('int count ='));
  assert.doesNotMatch(beforeKind, /PostCopyFilesReply/);
});

// --- no path is ever logged ------------------------------------------------

/** Argument text of every `Log(` CALL in `text` (the declaration is skipped). */
function logArguments(text: string): string[] {
  const out: string[] = [];
  const re = /(^|[^\w.])Log\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const open = m.index + m[0].length - 1;
    if (/void\s+$/.test(text.slice(Math.max(0, m.index - 6), open - 3))) continue;
    let depth = 1;
    let i = open + 1;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
    }
    out.push(text.slice(open + 1, i - 1));
  }
  return out;
}

test('host: no copy-files log line carries an exception MESSAGE', () => {
  // Region-scoped: the older handlers in this file log ex.Message and are not
  // this phase's. Here it would be a leak - Clipboard.SetFileDropList
  // validates each entry with Path.GetFullPath and rethrows an
  // ArgumentException whose message interpolates THE PATH.
  const args = logArguments(region);
  assert.ok(args.length >= 3, `expected the region's Log calls, found ${args.length}`);
  for (const arg of args) {
    assert.doesNotMatch(arg, /\.Message\b/, `a copy-files Log call uses ex.Message: ${arg.trim()}`);
  }
  // The exception CLASS is what is logged instead (the backend's errorClass rule).
  assert.match(region, /ex\.GetType\(\)\.Name/);
});

test('host: no log line can carry a path', () => {
  const args = logArguments(cs);
  assert.ok(args.length >= 10, `expected the host's Log calls, found ${args.length}`);
  // Every variable that holds a path or the raw message, by name. They are
  // named so this test can be a grep: if a later edit logs one of them, the
  // name appears inside a Log(...) argument and this fails.
  const pathCarrying = ['webMessageText', 'messageLines', 'filePaths', 'pathLine', 'candidate', 'segment', 'rest'];
  for (const arg of args) {
    // String literals are the message text and are allowed to contain the
    // WORD "path"; only the interpolated EXPRESSIONS are inspected.
    const code = arg.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    for (const name of pathCarrying) {
      assert.ok(
        !new RegExp(`\\b${name}\\b`).test(code),
        `a Log call names ${name}: ${arg.trim()}`,
      );
    }
    assert.doesNotMatch(
      code,
      /path/i,
      `a Log call names something path-shaped: ${arg.trim()}`,
    );
  }
});

test('host: the handler logs counts', () => {
  // Every refusal log and the success log carry counts only (what they may
  // NOT carry is the two tests above).
  assert.match(handler, /count\.ToString\(CultureInfo\.InvariantCulture\)/);
});
