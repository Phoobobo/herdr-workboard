// Board operations: every kanban verb expressed as herdr socket calls.
//
// Mapping: board = workspace, state = tab, task session = pane.
// Moving a card between states physically moves its pane between tabs.

import { HerdrApiError, request } from "./herdr.ts";
import { newId, saveBoard } from "./store.ts";
import type { AgentStatus, Board, BoardState, PaneInfo, PaneMoveResult, TabInfo, Task, WorkspaceInfo } from "./types.ts";

export const DEFAULT_STATES = ["todo", "doing", "review", "done"];
export const DEFAULT_AGENT_CMD = ["claude"];
export const BOARD_TAB_LABEL = "board";
export const BOARD_PANE_LABEL = "workboard";

export function makeBoard(name: string, cwd: string, workspaceId: string): Board {
  return {
    version: 1,
    id: newId("b"),
    name,
    cwd,
    workspace_id: workspaceId,
    board_pane_id: null,
    agent_cmd: [...DEFAULT_AGENT_CMD],
    states: DEFAULT_STATES.map((n, i) => ({ id: `s${i + 1}`, name: n, tab_id: null })),
    tasks: [],
    next_seq: 1,
  };
}

export function makeTask(board: Board, stateId: string, title: string, body?: string): Task {
  const seq = board.next_seq++;
  const task: Task = {
    id: `t${seq}`,
    seq,
    title,
    body,
    state_id: stateId,
    pane_id: null,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  board.tasks.push(task);
  saveBoard(board);
  return task;
}

export function activeTasks(board: Board, stateId?: string): Task[] {
  return board.tasks.filter((t) => !t.archived && (stateId === undefined || t.state_id === stateId));
}

// ---- live herdr state ----

export interface LiveState {
  tabs: Map<string, TabInfo>;
  panes: Map<string, PaneInfo>;
}

export async function fetchLive(): Promise<LiveState> {
  const [tabsRes, panesRes] = await Promise.all([
    request<{ tabs: TabInfo[] }>("tab.list", {}),
    request<{ panes: PaneInfo[] }>("pane.list", {}),
  ]);
  return {
    tabs: new Map(tabsRes.tabs.map((t) => [t.tab_id, t])),
    panes: new Map(panesRes.panes.map((p) => [p.pane_id, p])),
  };
}

/**
 * Reconcile the board doc with live herdr state:
 *  - a state adopts its tab's label (renaming the tab renames the column)
 *  - a state whose tab is gone drops the tab_id (recreated lazily)
 *  - a task whose pane is gone loses its session
 *  - a task whose pane sits in another state's tab follows the pane
 *    (dragging a pane between tabs in herdr == moving the card)
 * Returns true when the board doc changed.
 */
export function reconcile(board: Board, live: LiveState): boolean {
  let changed = false;
  for (const st of board.states) {
    if (!st.tab_id) continue;
    const tab = live.tabs.get(st.tab_id);
    if (!tab || tab.workspace_id !== board.workspace_id) {
      st.tab_id = null;
      changed = true;
    } else if (tab.label && tab.label !== st.name) {
      st.name = tab.label;
      changed = true;
    }
  }
  for (const task of board.tasks) {
    if (task.archived || !task.pane_id) continue;
    const pane = live.panes.get(task.pane_id);
    if (!pane) {
      task.pane_id = null;
      task.updated_at = Date.now();
      changed = true;
      continue;
    }
    const st = board.states.find((s) => s.tab_id === pane.tab_id);
    if (st && st.id !== task.state_id) {
      task.state_id = st.id;
      task.updated_at = Date.now();
      changed = true;
    }
  }
  return changed;
}

// ---- tabs ----

/** Resolve (or recreate) the tab backing a state. Saves the board when it changes. */
export async function ensureStateTab(board: Board, state: BoardState): Promise<string> {
  if (state.tab_id) {
    try {
      const res = await request<{ tab: TabInfo }>("tab.get", { tab_id: state.tab_id });
      if (res.tab.workspace_id === board.workspace_id) return state.tab_id;
    } catch {
      // fall through and re-resolve
    }
  }
  const tabs = await request<{ tabs: TabInfo[] }>("tab.list", { workspace_id: board.workspace_id });
  const taken = new Set(board.states.map((s) => s.tab_id).filter(Boolean));
  const adopt = tabs.tabs.find((t) => t.label === state.name && !taken.has(t.tab_id));
  if (adopt) {
    state.tab_id = adopt.tab_id;
    saveBoard(board);
    return adopt.tab_id;
  }
  const created = await request<{ tab: TabInfo }>("tab.create", {
    workspace_id: board.workspace_id,
    cwd: board.cwd,
    label: state.name,
    focus: false,
  });
  state.tab_id = created.tab.tab_id;
  saveBoard(board);
  return state.tab_id;
}

export async function ensureStateTabs(board: Board): Promise<void> {
  for (const st of board.states) {
    await ensureStateTab(board, st);
  }
}

/** A pane inside the given tab to split from / move next to. */
async function tabAnchorPane(tabId: string): Promise<string> {
  const res = await request<{ panes: PaneInfo[] }>("pane.list", {});
  const inTab = res.panes.filter((p) => p.tab_id === tabId);
  if (inTab.length === 0) throw new Error(`no panes in tab ${tabId}`);
  return (inTab.find((p) => p.focused) ?? inTab[0]).pane_id;
}

// ---- sessions ----

/** Shells we can safely detect as "idle" foregrounds. */
export const SHELL_NAME_RE = /^-?(zsh|bash|fish|sh|dash|ksh|nu|pwsh)$/;
/** Shells whose syntax supports `cd x && K=v exec cmd` lines we synthesize. */
const POSIX_SHELL_RE = /^-?(zsh|bash|sh|dash|ksh)$/;

/** POSIX single-quote escaping: ' -> '\'' */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface PaneProcessInfo {
  shell_pid?: number;
  foreground_processes?: Array<{ pid: number; name?: string; argv?: string[]; cmdline?: string }>;
}

/**
 * An unclaimed pane in the tab whose foreground is provably just an idle
 * shell — e.g. the root shell every state tab starts with. Returns the pane
 * plus whether that shell is POSIX enough to exec an agent command into.
 */
async function findIdlePane(board: Board, tabId: string): Promise<{ pane: PaneInfo; posix: boolean } | null> {
  const res = await request<{ panes: PaneInfo[] }>("pane.list", {});
  const claimed = new Set(board.tasks.filter((t) => !t.archived && t.pane_id).map((t) => t.pane_id as string));
  if (board.board_pane_id) claimed.add(board.board_pane_id);
  const candidates = res.panes.filter((p) => p.tab_id === tabId && !claimed.has(p.pane_id) && !p.agent);
  for (const pane of candidates) {
    try {
      const res2 = await request<{ process_info: PaneProcessInfo }>("pane.process_info", { pane_id: pane.pane_id });
      const procs = res2.process_info?.foreground_processes ?? [];
      if (procs.length > 0 && procs.every((p) => SHELL_NAME_RE.test(p.name ?? ""))) {
        return { pane, posix: procs.every((p) => POSIX_SHELL_RE.test(p.name ?? "")) };
      }
    } catch {
      // can't prove it's idle — leave it alone
    }
  }
  return null;
}

function sessionEnv(board: Board, task: Task): Record<string, string> {
  return { WORKBOARD_BOARD_ID: board.id, WORKBOARD_TASK_ID: task.id };
}

/**
 * Which column an agent status maps to, by state name with positional
 * fallbacks: working → doing-like (else 2nd column), done → review-like
 * (else done-like, else last), blocked → blocked-like column IF one exists.
 */
export function stateForStatus(board: Board, status: AgentStatus): BoardState | null {
  const find = (re: RegExp) => board.states.find((s) => re.test(s.name.toLowerCase())) ?? null;
  if (status === "working") {
    return find(/doing|progress|running|wip|active/) ?? (board.states.length > 1 ? board.states[1] : null);
  }
  if (status === "done") {
    return find(/review|verify|check|test/) ?? find(/done|complete|finish|shipped/) ?? board.states[board.states.length - 1] ?? null;
  }
  if (status === "blocked") {
    return find(/block|stuck|wait/); // no fallback: most boards show blocked as a badge only
  }
  return null;
}

export function paneLabel(task: Task): string {
  return `#${task.seq} ${task.title}`.slice(0, 60);
}

/**
 * Start a session pane for a task inside its state's tab. An idle shell pane
 * already sitting in that tab (like the tab's root shell) is claimed and
 * reused instead of splitting a new pane.
 */
export async function startSession(board: Board, task: Task, kind: "agent" | "shell"): Promise<PaneInfo> {
  // With auto-sync on, starting an agent IS starting work: the card moves to
  // the working column first so the session pane spawns in the right tab.
  if (kind === "agent" && board.auto_sync !== false) {
    const working = stateForStatus(board, "working");
    if (working && working.id !== task.state_id) {
      task.state_id = working.id;
      task.updated_at = Date.now();
      saveBoard(board);
    }
  }
  const state = board.states.find((s) => s.id === task.state_id);
  if (!state) throw new Error(`task ${task.id} has unknown state`);
  const tabId = await ensureStateTab(board, state);
  const env = sessionEnv(board, task);
  const prompt = task.body ? `${task.title}\n\n${task.body}` : task.title;

  const idle = await findIdlePane(board, tabId);
  let pane: PaneInfo;
  if (idle && (kind === "shell" || idle.posix)) {
    pane = idle.pane;
    const paneCwd = pane.foreground_cwd ?? pane.cwd;
    const cd = paneCwd !== board.cwd ? `cd ${shQuote(board.cwd)} && ` : "";
    if (kind === "agent") {
      const assigns = Object.entries(env)
        .map(([k, v]) => `${k}=${shQuote(v)}`)
        .join(" ");
      const argv = [...board.agent_cmd, prompt].map(shQuote).join(" ");
      // leading space keeps the line out of shell history
      await request("pane.send_input", { pane_id: pane.pane_id, text: ` ${cd}${assigns} exec ${argv}`, keys: ["Enter"] });
    } else if (cd) {
      await request("pane.send_input", { pane_id: pane.pane_id, text: ` cd ${shQuote(board.cwd)}`, keys: ["Enter"] });
    }
  } else if (kind === "agent") {
    const res = await request<{ agent: PaneInfo }>("agent.start", {
      name: `wb-${task.seq}-${Date.now().toString(36)}`,
      argv: [...board.agent_cmd, prompt],
      cwd: board.cwd,
      tab_id: tabId,
      focus: false,
      env,
    });
    pane = res.agent;
  } else {
    const res = await request<{ pane: PaneInfo }>("pane.split", {
      workspace_id: board.workspace_id,
      target_pane_id: await tabAnchorPane(tabId),
      direction: "right",
      cwd: board.cwd,
      focus: false,
      env,
    });
    pane = res.pane;
  }

  task.pane_id = pane.pane_id;
  task.updated_at = Date.now();
  saveBoard(board);
  await request("pane.rename", { pane_id: pane.pane_id, label: paneLabel(task) }).catch(() => {});
  return pane;
}

/** Focus a task's session pane (herdr has no pane.focus; zoom-off focuses). */
export async function focusTask(task: Task): Promise<void> {
  if (!task.pane_id) throw new Error("task has no session");
  await request("pane.zoom", { pane_id: task.pane_id, mode: "off" });
}

/**
 * Move a task to another state. With a live session this moves the pane into
 * the destination tab; zoomed source/destination tabs are unzoomed and the
 * move retried once. `refocusPaneId` (the board's own pane) restores focus
 * afterwards, since unzooming steals it.
 */
export async function moveTaskToState(board: Board, task: Task, targetStateId: string, refocusPaneId?: string, followFocus = false): Promise<void> {
  const target = board.states.find((s) => s.id === targetStateId);
  if (!target) throw new Error("unknown target state");
  if (task.state_id === targetStateId) return;

  if (task.pane_id) {
    const tabId = await ensureStateTab(board, target);
    // If the moving pane is the last one in its state tab, seed a fresh idle
    // shell first — otherwise the tab closes and later gets recreated at the
    // END of the tab strip (herdr has no tab-reorder API). The shell also
    // becomes the pane the next session in that column claims.
    try {
      const res = await request<{ panes: PaneInfo[] }>("pane.list", {});
      const me = res.panes.find((p) => p.pane_id === task.pane_id);
      if (
        me &&
        me.tab_id !== tabId &&
        board.states.some((s) => s.tab_id === me.tab_id) &&
        res.panes.filter((p) => p.tab_id === me.tab_id).length === 1
      ) {
        await request("pane.split", {
          workspace_id: me.workspace_id,
          target_pane_id: task.pane_id,
          direction: "right",
          cwd: board.cwd,
          focus: false,
        });
      }
    } catch {
      // best effort — worst case the tab closes and is recreated on demand
    }
    const move = () =>
      request<{ move_result: PaneMoveResult }>("pane.move", {
        pane_id: task.pane_id,
        destination: { type: "tab", tab_id: tabId, split: "right" },
        // followFocus keeps the user attached when THEIR focused pane moves
        focus: followFocus,
      });
    let { move_result: mv } = await move();
    if (!mv.changed && mv.reason === "zoomed_tab") {
      await request("pane.zoom", { pane_id: task.pane_id, mode: "off" }).catch(() => {});
      await request("pane.zoom", { pane_id: await tabAnchorPane(tabId), mode: "off" }).catch(() => {});
      ({ move_result: mv } = await move());
      if (refocusPaneId) await request("pane.zoom", { pane_id: refocusPaneId, mode: "off" }).catch(() => {});
    }
    if (!mv.changed && mv.reason !== "same_tab") {
      throw new Error(`pane move failed${mv.reason ? `: ${mv.reason}` : ""}`);
    }
    task.pane_id = mv.pane.pane_id; // id can change on cross-workspace moves
    if (mv.closed_tab_id) {
      const closed = board.states.find((s) => s.tab_id === mv.closed_tab_id);
      if (closed) closed.tab_id = null;
    }
  }

  task.state_id = targetStateId;
  task.updated_at = Date.now();
  saveBoard(board);
}

export async function archiveTask(board: Board, task: Task, closePane: boolean): Promise<void> {
  if (closePane && task.pane_id) {
    try {
      await request("pane.close", { pane_id: task.pane_id });
    } catch (err) {
      // an already-gone pane is fine; anything else aborts the archive
      if (!(err instanceof HerdrApiError && /not_found/.test(err.code))) throw err;
    }
  }
  task.archived = true;
  task.pane_id = null;
  task.updated_at = Date.now();
  saveBoard(board);
}

// ---- board workspace bootstrap (shared by the init action and the TUI) ----

export async function workspaceExists(workspaceId: string): Promise<WorkspaceInfo | null> {
  if (!workspaceId) return null;
  try {
    const res = await request<{ workspace: WorkspaceInfo }>("workspace.get", { workspace_id: workspaceId });
    return res.workspace;
  } catch (err) {
    // Only a definitive API "no such workspace" means gone; transient socket
    // failures must not trigger rebinds or workspace rebuilds.
    if (err instanceof HerdrApiError) return null;
    throw err;
  }
}
