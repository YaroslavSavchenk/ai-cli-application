/**
 * What a SESSION pane shows about its session, split from `panes.ts` (O8,
 * 2026-09-23): the header readout (state dot, tool mark, name, project NAME,
 * state pill, connection chip), the status bar and the background-agents table
 * under the terminal, the exited/lost banner with its `Start it again` and
 * `End session`, and `killSession`. `panes.ts` owns the grid, the slots and
 * the terminals, and calls in here on every render; this module reads back
 * only the rendered view's id and pane count and `requestTerminalFocus`
 * (function-time reads through the live bindings — nothing here runs at
 * import, so the `panes.ts` <-> `panes-status.ts` cycle cannot bite).
 * Sibling: `panes.ts`.
 */
import type { CreateSessionRequest } from '../../../shared/protocol.ts';
import * as api from '../api.ts';
import * as st from '../state.ts';
import { log } from '../log.ts';
import { el, button, armButton } from './util.ts';
import { scheduleHistoryRefresh } from './history.ts';
import { flash } from './statusline.ts';
import { getBehaviour } from './prefs-model.ts';
import { paneStatusItems } from './pane-status-model.ts';
import { getStatusLine } from './statusline-model.ts';
import { renderAgents } from './pane-agents.ts';
import { agentTable } from './pane-agents-model.ts';
import { readoutClass, readoutWord, sessionReadout, type SessionReadout } from './session-state.ts';
import { toolIconFor } from './launch-args.ts';
import { toolIcon } from './icons-tools.ts';
import {
  renderedCount,
  renderedViewId,
  requestTerminalFocus,
  type SessionPayload,
  type Slot,
} from './panes.ts';

/** DELETE a session; its view slot closes everywhere (drawer + tab close reuse this). */
export async function killSession(id: string): Promise<void> {
  log.info(`kill session ${id}`);
  try {
    await api.deleteSession(id);
    st.removeSessionEverywhere(id);
  } catch (err) {
    if (err instanceof api.ApiError && err.status === 404) {
      log.info(`kill session ${id}: already gone server-side`);
      st.removeSessionEverywhere(id);
      return;
    }
    log.warn(`kill failed: session=${id} ${err instanceof Error ? err.message : String(err)}`);
    flash(`Could not end it: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function updateHeader(s: Slot, pay: SessionPayload): void {
  const info = st.state.sessions.get(pay.id);
  // Projects are named, never pathed (PROJECT-SCOPE); a session without one
  // shows nothing at all rather than a folder.
  const pname = st.projectName(info?.projectId);
  pay.proj.textContent = pname ?? '';
  pay.title.textContent = info?.title ?? pay.id.slice(0, 8);
  // Dot and pill are one readout (ui/session-state.ts, B11): pulsing green
  // Working while the transcript says Claude works, still amber Waiting for
  // you once it ended its turn, still green Working where nothing says which
  // (a shell, a session without a transcript), pulsing amber Needs your
  // answer on a BEL, neutral Finished. A slot whose session is not in the list
  // yet reads as alive. The exit code rides in the pill's title (and on the
  // banner) — a code is not a state word.
  const readout: SessionReadout = info === undefined ? 'running' : sessionReadout(info);
  const cls = readoutClass(readout);
  pay.dot.className = `dot pane-dot ${cls}`;
  const stateText = readoutWord(readout);
  pay.state.textContent = stateText;
  // The tool's mark (B12), from the command the session carries — drawn once
  // it is known, redrawn only if it changes, never guessed: a session that
  // drops out of the list loses its mark rather than keep a stale one.
  const toolId = info === undefined ? null : toolIconFor(info.command);
  if (toolId === null) {
    if (pay.tool.dataset.tool !== undefined) {
      delete pay.tool.dataset.tool;
      pay.tool.replaceChildren();
    }
  } else if (pay.tool.dataset.tool !== toolId) {
    pay.tool.dataset.tool = toolId;
    pay.tool.replaceChildren(toolIcon(toolId, 14));
  }
  pay.state.className = `pane-state ${cls}`;
  const code = info?.exitCode ?? pay.exitCode;
  pay.state.title =
    info !== undefined && info.status !== 'running' && code !== null && code !== undefined ? `Finished, code ${code}` : stateText;
  if (pay.conn === null || pay.conn === 'live') {
    pay.connChip.hidden = true;
  } else {
    pay.connChip.hidden = false;
    pay.connChip.textContent = pay.conn === 'dead' ? 'Lost' : 'Reconnecting';
    pay.connChip.className = `pane-conn ${pay.conn === 'dead' ? 'is-danger' : 'is-warn'}`;
  }
  // Alone in its view, a session already IS its own tab.
  pay.extractBtn.hidden = renderedCount <= 1;
}

/**
 * The status bar under the terminal, plus the background agents table (B7).
 * Both are absent — not blank — when there is nothing honest to put in them:
 * `paneStatusItems` and `agentTable` both come back empty for anything but the
 * known agent, and `agentTable` also for a session that has spawned none or
 * while its switch is off, so a plain shell's pane is terminal edge to
 * terminal edge.
 */
function updateStatus(pay: SessionPayload): void {
  const info = st.state.sessions.get(pay.id);
  const items = paneStatusItems(info, getStatusLine(), Date.now());
  // The 15 s tick calls this for every slot; most ticks change nothing (Time
  // moves once a minute at most). Rebuilding then would throw away live DOM
  // — a text selection inside the bar, the row the pointer is over — for no
  // pixel change, so the rendered content is compared first.
  const statusSig = items.map((i) => `${i.k}=${i.v}:${i.tone}`).join('\n');
  if (statusSig !== pay.statusSig) {
    pay.statusSig = statusSig;
    pay.statusBar.hidden = items.length === 0;
    pay.statusBar.replaceChildren(
      ...items.map((it) => {
        const cell = el('span', 'pane-status-item');
        cell.append(
          el('span', 'pane-status-k', it.k),
          el('span', `pane-status-v${it.tone === 'neutral' ? '' : ` is-${it.tone}`}`, it.v),
        );
        return cell;
      }),
    );
  }
  // The background agents this session spawned (part B7): the server reads
  // them from Claude Code's transcripts and sends them ordered and capped on
  // `SessionInfo.agents` with their totals on `agentCounts`; `agentTable`
  // formats the rows and derives the `+N working` / `+N finished` counts (B11),
  // and the same signature rule renders once per real change. The table is
  // behind the `paneAgents` switch (B11, default off) — `repaintStatus()` runs
  // this on a flip — and absent, not blank, when it has nothing to show. Its
  // appearing or going changes the terminal card's height; the term host's
  // ResizeObserver refits and sends the new rows like any other resize. The
  // 15 s tick above is what moves a running agent's time: the row's text
  // changes, so the signature does.
  const table = agentTable(info, getStatusLine(), Date.now());
  const agentsSig = JSON.stringify(table);
  if (agentsSig !== pay.agentsSig) {
    pay.agentsSig = agentsSig;
    const node = renderAgents(table);
    pay.agentsHost.replaceChildren(...(node === null ? [] : [node]));
  }
}

function updateNote(s: Slot, pay: SessionPayload): void {
  if (pay.dead) {
    // Reconnect exhausted and the server does not know the session anymore.
    s.note.hidden = false;
    s.note.className = 'pane-note is-dead';
    s.note.replaceChildren(
      el('span', 'pane-note-text', 'This session is gone from the server'),
      button('pane-note-btn', 'Close pane', () => st.removeSessionEverywhere(pay.id)),
    );
    return;
  }
  if (pay.exitCode !== null) {
    // Structural exited banner; the buffer below stays readable.
    s.note.hidden = false;
    s.note.className = `pane-note ${pay.exitCode === 0 ? 'is-exit' : 'is-exit-err'}`;
    const relaunchBtn = button('pane-note-btn is-primary', 'Start it again', () =>
      void relaunch(s, pay),
    );
    const delBtn = button('pane-note-btn', 'End session');
    // The shared arming primitive with ONE extra question asked at click
    // time: `Confirm before ending a session` (part B6). Off = the click
    // ends it; on = arm first, exactly as before.
    armButton(delBtn, 'Sure?', () => void killSession(pay.id), {
      ask: () => getBehaviour().confirmEnd,
    });
    s.note.replaceChildren(
      el('span', 'pane-note-text', `Finished, code ${pay.exitCode}`),
      relaunchBtn,
      delBtn,
    );
    return;
  }
  s.note.hidden = true;
}

/**
 * Exited-banner relaunch: bring this pane's session back, swap it into this
 * slot, then DELETE the exited one. The attach flow reconciles the PTY size
 * with the pane's actual dimensions, so stale cols/rows self-correct.
 *
 * When the session history still holds THIS session's entry, relaunch goes
 * through /api/history/:id/resume so a claude session continues its own
 * conversation instead of starting an empty one (the server composes the
 * argv). Without an entry — a backend without history, or one already
 * forgotten — it falls back to reposting the same command.
 *
 * The lookup reads a FRESH /api/history rather than `state.history`: the cached
 * list is filled by a 300 ms-debounced refetch, so a click inside that window
 * would find no entry, fall back to the create path, and silently FORK the
 * conversation onto a new pinned id. A failing fetch keeps today's behaviour.
 */
async function relaunch(s: Slot, pay: SessionPayload): Promise<void> {
  const oldId = pay.id;
  const info = st.state.sessions.get(oldId);
  if (info === undefined) return;
  const viewId = renderedViewId; // Captured: the user may switch tabs mid-await.
  const index = s.index;
  let history = st.state.history;
  try {
    history = await api.getHistory();
    st.setHistory(history); // Publish it, so the drawer agrees with this click.
  } catch {
    // Unreachable/absent history routes: fall back to the cached list.
  }
  const entry = history.find((h) => h.sessionId === oldId);
  const req: CreateSessionRequest = {
    ...(info.projectId !== undefined ? { projectId: info.projectId } : {}),
    cwd: info.cwd, // Explicit, so relaunch survives a deleted project.
    command: info.command,
    args: info.args,
    title: info.title,
    cols: info.cols,
    rows: info.rows,
  };
  try {
    const created =
      entry !== undefined
        ? await api.resumeHistory(entry.id, { cols: info.cols, rows: info.rows })
        : await api.createSession(req);
    log.info(
      `relaunch ok: old=${oldId} new=${created.id} via=${entry !== undefined ? 'history entry ' + entry.id : 'fresh session'}`,
    );
    st.upsertSession(created);
    st.replaceSessionInView(viewId, index, created.id);
    if (st.state.activeViewId === viewId) {
      st.focusPane(index);
      requestTerminalFocus();
    }
  } catch (err) {
    log.warn(`relaunch failed: old=${oldId} ${err instanceof Error ? err.message : String(err)}`);
    flash(`Could not start it again: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  scheduleHistoryRefresh(); // the entry is live again — it leaves the ended list
  // The new session is live; losing the DELETE only leaves the exited one
  // listed in the drawer (its kill button still works).
  try {
    await api.deleteSession(oldId);
    st.removeSessionEverywhere(oldId);
  } catch (err) {
    if (err instanceof api.ApiError && err.status === 404) st.removeSessionEverywhere(oldId);
  }
}

// Shared with the sibling pieces (O8 split glue); not part of the public face.
export { updateHeader, updateStatus, updateNote };
