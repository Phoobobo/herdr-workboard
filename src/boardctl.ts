// Board operations: every kanban verb expressed as herdr socket calls.
//
// Mapping: board = workspace, state = tab, task session = pane.
// Moving a card between states physically moves its pane between tabs.

import { HerdrApiError, request } from "./herdr.ts";
import { loadConfig, newId, saveBoard } from "./store.ts";
import type { AgentStatus, Board, BoardState, PaneInfo, PaneMoveResult, TabInfo, Task, WorkspaceInfo } from "./types.ts";

export const DEFAULT_STATES = ["todo", "doing", "review", "done"];
export const DEFAULT_AGENT_CMD = ["claude"];
export const BOARD_TAB_LABEL = "board";
export const BOARD_PANE_LABEL = "workboard";

export function makeBoard(name: string, cwd: string, workspaceId: string): Board {
  let defaultCmd = [...DEFAULT_AGENT_CMD];
  try {
    const cfg = loadConfig();
    if (cfg.default_cmd?.length) defaultCmd = [...cfg.default_cmd];
  } catch {
    // unreadable config falls back to the built-in default
  }
  return {
    version: 1,
    id: newId("b"),
    name,
    cwd,
    workspace_id: workspaceId,
    board_pane_id: null,
    agent_cmd: defaultCmd,
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

function claimedPaneIds(board: Board): Set<string> {
  const claimed = new Set(board.tasks.filter((t) => !t.archived && t.pane_id).map((t) => t.pane_id as string));
  if (board.board_pane_id) claimed.add(board.board_pane_id);
  return claimed;
}

/**
 * Unclaimed panes in the tab whose foreground is provably just an idle shell
 * — e.g. the root shell every state tab starts with. `posix` says whether
 * that shell is POSIX enough to exec an agent command into. Pass an
 * already-fetched pane list to skip the round trip.
 */
async function idleShellPanesInTab(board: Board, tabId: string, allPanes?: PaneInfo[]): Promise<Array<{ pane: PaneInfo; posix: boolean }>> {
  const panes = allPanes ?? (await request<{ panes: PaneInfo[] }>("pane.list", {})).panes;
  const claimed = claimedPaneIds(board);
  const candidates = panes.filter((p) => p.tab_id === tabId && !claimed.has(p.pane_id) && !p.agent);
  const idle: Array<{ pane: PaneInfo; posix: boolean }> = [];
  for (const pane of candidates) {
    try {
      const res = await request<{ process_info: PaneProcessInfo }>("pane.process_info", { pane_id: pane.pane_id });
      const procs = res.process_info?.foreground_processes ?? [];
      if (procs.length > 0 && procs.every((p) => SHELL_NAME_RE.test(p.name ?? ""))) {
        idle.push({ pane, posix: procs.every((p) => POSIX_SHELL_RE.test(p.name ?? "")) });
      }
    } catch {
      // can't prove it's idle — leave it alone
    }
  }
  return idle;
}

async function findIdlePane(board: Board, tabId: string): Promise<{ pane: PaneInfo; posix: boolean } | null> {
  return (await idleShellPanesInTab(board, tabId))[0] ?? null;
}

/**
 * Character cells are roughly twice as tall as wide, so comparing raw
 * width/height would nearly always prefer splitting into columns. Correcting
 * height by this factor makes the comparison track visual squareness.
 */
const GRID_ASPECT = 2;

/**
 * Where the next pane should land in a tab, so repeated arrivals tile the
 * tab into a roughly even grid (2 panes → left/right; 4 → a 2x2 grid; …)
 * instead of a lopsided stack of slivers. If the tab already holds an idle,
 * unclaimed shell pane (and isn't down to just that one pane), it is closed
 * first so the newcomer reclaims its spot instead of growing the pane count.
 */
export async function prepareTabForArrival(board: Board, tabId: string): Promise<{ targetPaneId: string; direction: "right" | "down"; ratio: number }> {
  let panes = (await request<{ panes: PaneInfo[] }>("pane.list", {})).panes.filter((p) => p.tab_id === tabId);
  if (panes.length === 0) throw new Error(`no panes in tab ${tabId}`);

  if (panes.length > 1) {
    const idle = await idleShellPanesInTab(board, tabId, panes);
    if (idle.length > 0) {
      const victim = idle[0].pane;
      try {
        await request("pane.close", { pane_id: victim.pane_id });
        panes = panes.filter((p) => p.pane_id !== victim.pane_id);
      } catch {
        // best effort — worst case the newcomer just splits alongside it
      }
    }
  }

  const anchor = panes[0].pane_id;
  let targetId = anchor;
  let direction: "right" | "down" = "right";
  try {
    const res = await request<{ layout: { panes: Array<{ pane_id: string; rect: { width: number; height: number } }> } }>("pane.layout", { pane_id: anchor });
    const rects = res.layout.panes.filter((p) => panes.some((q) => q.pane_id === p.pane_id));
    if (rects.length > 0) {
      const best = rects.reduce((a, b) => (b.rect.width * b.rect.height > a.rect.width * a.rect.height ? b : a));
      targetId = best.pane_id;
      direction = best.rect.width > best.rect.height * GRID_ASPECT ? "right" : "down";
    }
  } catch {
    // layout lookup failed — fall back to a plain right-split off the anchor
  }
  return { targetPaneId: targetId, direction, ratio: 0.5 };
}

function sessionEnv(board: Board, task: Task): Record<string, string> {
  return { WORKBOARD_BOARD_ID: board.id, WORKBOARD_TASK_ID: task.id };
}

export const DEFAULT_PROMPT_TEMPLATE = "{title}\n\n{body}";

/** The agent argv for a task: per-task override, else the board default. */
export function taskAgentCmd(board: Board, task: Task): string[] {
  return task.agent_cmd?.length ? task.agent_cmd : board.agent_cmd;
}

/** Fill the board's prompt template with the task's title and body. */
export function buildPrompt(board: Board, task: Task): string {
  const template = board.prompt_template?.trim() ? board.prompt_template : DEFAULT_PROMPT_TEMPLATE;
  // Single pass with a function replacement: string replacements would expand
  // $-patterns ($&, $') from task text, and sequential passes would
  // re-substitute a "{body}" occurring inside the title.
  return template.replace(/\{title\}|\{body\}/g, (m) => (m === "{title}" ? task.title : task.body ?? "")).trim();
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

/**
 * The column a workflow stage lives in: the stage's explicit `state:`, else a
 * column named like the stage. Returns null when neither matches, which means
 * "this stage doesn't own a column" — the card simply stays where it is.
 */
export function resolveStageState(board: Board, stage: { name: string; state?: string }): BoardState | null {
  const byName = (want: string) => board.states.find((s) => s.name.toLowerCase() === want.toLowerCase()) ?? null;
  if (stage.state) {
    const explicit = byName(stage.state);
    // An explicit mapping naming a column that doesn't exist is a workflow
    // authoring bug, not a silent no-op.
    if (!explicit) throw new Error(`stage '${stage.name}' maps to unknown column '${stage.state}'`);
    return explicit;
  }
  return byName(stage.name);
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
  const agentCmd = taskAgentCmd(board, task);
  const prompt = buildPrompt(board, task);

  const idle = await findIdlePane(board, tabId);
  let pane: PaneInfo;
  if (idle && (kind === "shell" || idle.posix)) {
    // take the pane that's already sitting there empty, rather than growing
    // the tab's pane count
    pane = idle.pane;
    const paneCwd = pane.foreground_cwd ?? pane.cwd;
    const cd = paneCwd !== board.cwd ? `cd ${shQuote(board.cwd)} && ` : "";
    if (kind === "agent") {
      const assigns = Object.entries(env)
        .map(([k, v]) => `${k}=${shQuote(v)}`)
        .join(" ");
      const argv = [...agentCmd, prompt].map(shQuote).join(" ");
      // leading space keeps the line out of shell history
      await request("pane.send_input", { pane_id: pane.pane_id, text: ` ${cd}${assigns} exec ${argv}`, keys: ["Enter"] });
    } else if (cd) {
      await request("pane.send_input", { pane_id: pane.pane_id, text: ` cd ${shQuote(board.cwd)}`, keys: ["Enter"] });
    }
  } else {
    // no reusable idle pane — land in a fresh split, chosen so repeated
    // arrivals tile the tab into an even grid instead of a lopsided stack
    const spot = await prepareTabForArrival(board, tabId);
    const res = await request<{ pane: PaneInfo }>("pane.split", {
      workspace_id: board.workspace_id,
      target_pane_id: spot.targetPaneId,
      direction: spot.direction,
      ratio: spot.ratio,
      cwd: board.cwd,
      focus: false,
      env,
    });
    pane = res.pane;
    if (kind === "agent") {
      const assigns = Object.entries(env)
        .map(([k, v]) => `${k}=${shQuote(v)}`)
        .join(" ");
      const argv = [...agentCmd, prompt].map(shQuote).join(" ");
      await request("pane.send_input", { pane_id: pane.pane_id, text: ` ${assigns} exec ${argv}`, keys: ["Enter"] });
    }
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
export async function moveTaskToState(
  board: Board,
  task: Task,
  targetStateId: string,
  refocusPaneId?: string,
  followFocus = false,
  /**
   * Whether landing a session-less card in the working column starts its agent.
   * True for the TUI, where the drag IS the "start work" gesture; false for the
   * CLI, where a caller that wants a session asks for one with `task start`.
   */
  spawnOnArrival = true,
): Promise<void> {
  const target = board.states.find((s) => s.id === targetStateId);
  if (!target) throw new Error("unknown target state");
  if (task.state_id === targetStateId) return;
  const hadNoSession = !task.pane_id;

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
    // Reclaim any idle pane sitting in the destination and pick a grid-aware
    // landing spot, same as a fresh session would.
    const spot = await prepareTabForArrival(board, tabId);
    const move = () =>
      request<{ move_result: PaneMoveResult }>("pane.move", {
        pane_id: task.pane_id,
        destination: { type: "tab", tab_id: tabId, target_pane_id: spot.targetPaneId, split: spot.direction, ratio: spot.ratio },
        // followFocus keeps the user attached when THEIR focused pane moves
        focus: followFocus,
      });
    let { move_result: mv } = await move();
    if (!mv.changed && mv.reason === "zoomed_tab") {
      await request("pane.zoom", { pane_id: task.pane_id, mode: "off" }).catch(() => {});
      await request("pane.zoom", { pane_id: spot.targetPaneId, mode: "off" }).catch(() => {});
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

  // Moving a session-less card into the working column IS starting work on
  // it: spawn its preferred agent there, same as pressing s would.
  if (spawnOnArrival && hadNoSession && stateForStatus(board, "working")?.id === targetStateId) {
    await startSession(board, task, "agent");
  }
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
