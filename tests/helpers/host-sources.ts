/**
 * The Windows host's source files: `launcher/host/AiSessionManagerHost.cs` and
 * the parts Q6 (2026-10-13, `.claude/plans/quality/PLAN-Q6.md`) cut it into —
 * one `partial class HostApp`, in `launcher/build-host.ps1`'s compile order
 * (the fifth, `-relaunch.cs`, from Q17 P2).
 *
 * `readSources(...HOST_SOURCES)` (`helpers.ts`) is the whole host as ONE text,
 * for a source pin that must hold over every part: a copy in another part must
 * not slip by. `tests/release/host-instance.test.ts` and the log rule of
 * `tests/release/host-webmessage.test.ts` read it that way.
 *
 * `csharpCode` / `csharpMember` are the comment-blind readers the overlay pins
 * share (`tests/release/host-overlay-stray.test.ts`,
 * `tests/release/host-overlay-app-active.test.ts`); `rawMember`, `csConst`,
 * `psVar` and `logArguments` are the readers the host-instance, web-message
 * and relaunch pins share.
 */
export const HOST_SOURCES = [
  'launcher/host/AiSessionManagerHost.cs',
  'launcher/host/AiSessionManagerHost-clipboard.cs',
  'launcher/host/AiSessionManagerHost-overlay.cs',
  'launcher/host/AiSessionManagerHost-overlay-window.cs',
  'launcher/host/AiSessionManagerHost-relaunch.cs',
] as const;

/** C# source with comments out and whitespace collapsed: the code's shape, so a comment can never satisfy a pin. */
export function csharpCode(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The code (`csharpCode`) of the member that starts at `signature` in `cs`, up to the next `private` member. */
export function csharpMember(cs: string, signature: string, file: string): string {
  const start = cs.indexOf(signature);
  if (start === -1) throw new Error(`${signature} not found in ${file}`);
  const next = cs.indexOf('\n        private ', start + signature.length);
  return csharpCode(cs.slice(start, next === -1 ? cs.length : next));
}

/** The full raw text of the member (or PowerShell function) that starts at `signature` in `text`, by brace matching. */
export function rawMember(text: string, signature: string): string {
  const start = text.indexOf(signature);
  if (start === -1) throw new Error(`${signature} not found`);
  let i = text.indexOf('{', start);
  let depth = 0;
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) break;
  }
  return text.slice(start, i + 1);
}

/** The value of a `private const string Name = "…";` (or verbatim `@"…"`) in the C# `text`. */
export function csConst(text: string, name: string): string | undefined {
  return new RegExp(`private const string ${name} = @?"([^"]*)";`).exec(text)?.[1];
}

/** The value of a top-level `$Name = '…'` in the PowerShell `text`. */
export function psVar(text: string, name: string): string | undefined {
  return new RegExp(`^\\$${name}\\s*=\\s*'([^']*)'`, 'm').exec(text)?.[1];
}

/** Argument text of every `Log(` CALL in the C# `text` (the `void Log(` declaration is skipped). */
export function logArguments(text: string): string[] {
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
