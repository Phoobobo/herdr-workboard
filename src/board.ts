// workboard — kanban TUI that runs inside a herdr pane.
//
// Columns are the board workspace's state tabs; cards are tasks; a card's
// session is a live pane in the matching tab. The TUI holds one event
// subscription to herdr and re-reconciles on every relevant event.

import path from "node:path";
import { HerdrApiError, request, subscribe, type EventStream } from "./herdr.ts";
import * as store from "./store.ts";
import * as ctl from "./boardctl.ts";
import { SGR, Screen, truncate, strWidth, InputParser, fmtAge, type InputEvent } from "./ui.ts";
import type { AgentStatus, Board, PaneInfo, Task } from "./types.ts";

const SELF_PANE = process.env.HERDR_PANE_ID ?? "";
const SELF_WS = process.env.HERDR_WORKSPACE_ID ?? "";
const PINNED = process.env.WORKBOARD_PINNED === "1";

type Mode =
  | { type: "normal" }
  | { type: "input"; label: string; value: string; onSubmit: (v: string) => void }
  | { type: "confirm"; msg: string; onYes: () => void; onNo?: () => void }
  | { type: "help" }
  | { type: "noboard" };

interface ColRect {
  x: number;
  w: number;
  col: number;
}

interface CardHit {
  x: number;
  y: number;
  w: number;
  h: number;
  col: number;
  row: number;
  taskId: string;
}

let board: Board | null = null;
let live: ctl.LiveState = { tabs: new Map(), panes: new Map() };
let mode: Mode = { type: "normal" };
let selCol = 0;
let selRow = 0;
let colScroll: number[] = [];
let flash: { msg: string; err: boolean; until: number } | null = null;
let busy = false;
let stream: EventStream | null = null;
let subKey: string | null = null;
let colRects: ColRect[] = [];
let cardHits: CardHit[] = [];
let drag: { taskId: string; fromCol: number; sx: number; sy: number; active: boolean; overCol: number | null } | null = null;
let lastClick = { t: 0, taskId: "" };
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

// ---- terminal ----

function out(s: string): void {
  process.stdout.write(s);
}

function termSize(): { w: number; h: number } {
  return { w: process.stdout.columns || 80, h: process.stdout.rows || 24 };
}

let terminalReady = false;

function setupTerminal(): void {
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  out("\x1b[?1049h\x1b[?25l\x1b[?1002h\x1b[?1006h\x1b[?2004h");
  terminalReady = true;
  process.on("exit", cleanupTerminal);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => process.exit(0));
  }
  process.stdout.on("resize", () => draw());
}

function cleanupTerminal(): void {
  if (!terminalReady) return;
  terminalReady = false;
  out("\x1b[?2004l\x1b[?1002l\x1b[?1006l\x1b[?25h\x1b[?1049l");
  process.stdin.setRawMode?.(false);
}

function die(msg: string): never {
  cleanupTerminal();
  console.error(msg);
  process.exit(1);
}

// ---- helpers ----

function errMsg(e: unknown): string {
  if (e instanceof HerdrApiError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

function setFlash(msg: string, err = false, ttl = 2500): void {
  flash = { msg, err, until: Date.now() + ttl };
  setTimeout(() => draw(), ttl + 60);
}

function tasksInCol(col: number): Task[] {
  if (!board || col < 0 || col >= board.states.length) return [];
  return ctl.activeTasks(board, board.states[col].id);
}

function selectedTask(): Task | null {
  return tasksInCol(selCol)[selRow] ?? null;
}

/**
 * Re-resolve a task in the CURRENT board object. Modal callbacks and async
 * ops must not mutate Task references captured before a refresh() reloaded
 * the board from disk — those writes would be silently lost.
 */
function liveTask(id: string): Task | null {
  return board?.tasks.find((t) => t.id === id && !t.archived) ?? null;
}

function clampSelection(): void {
  if (!board) return;
  selCol = Math.max(0, Math.min(selCol, board.states.length - 1));
  const len = tasksInCol(selCol).length;
  selRow = Math.max(0, Math.min(selRow, len - 1));
  while (colScroll.length < board.states.length) colScroll.push(0);
}

function taskPane(task: Task): PaneInfo | null {
  return task.pane_id ? live.panes.get(task.pane_id) ?? null : null;
}

function run(op: () => Promise<void>): void {
  if (busy) return;
  busy = true;
  draw();
  op()
    .catch((e) => setFlash(errMsg(e), true))
    .finally(() => {
      busy = false;
      scheduleRefresh(0);
    });
}

// ---- data flow ----

function resolveBoard(): Board | null {
  const explicit = process.env.WORKBOARD_BOARD_ID;
  if (explicit) {
    const b = store.loadBoard(explicit);
    if (b) return b;
  }
  return store.resolveBoardForWorkspace(SELF_WS);
}

let refreshing = false;
let refreshQueued = false;

// ---- auto-sync: columns follow the agent session state machine ----

const statusPrev = new Map<string, AgentStatus>(); // pane_id -> last seen status
const syncInFlight = new Set<string>(); // task ids with an auto-move running
let startupHealed = false;

function autoSyncEnabled(): boolean {
  return !!board && board.auto_sync !== false;
}

function stateIdx(stateId: string): number {
  return board ? board.states.findIndex((s) => s.id === stateId) : -1;
}

/**
 * Move a task's card to the column its agent status maps to. Transition-
 * driven, so user-placed cards are never fought mid-state; `startup` (and
 * `done`) moves are forward-only, while a live `working` transition may move
 * backward (rework on a reviewed card).
 */
function maybeAutoAdvance(paneId: string, status: AgentStatus, startup = false): void {
  if (!board || !autoSyncEnabled()) return;
  if (status !== "working" && status !== "done" && status !== "blocked") return;
  const task = board.tasks.find((t) => !t.archived && t.pane_id === paneId);
  if (!task || syncInFlight.has(task.id)) return;
  const target = ctl.stateForStatus(board, status);
  if (!target || target.id === task.state_id) return;
  if ((startup || status === "done") && stateIdx(task.state_id) >= stateIdx(target.id)) return;

  syncInFlight.add(task.id);
  const followFocus = !!live.panes.get(paneId)?.focused;
  ctl
    .moveTaskToState(board, task, target.id, SELF_PANE || undefined, followFocus)
    .then(() => setFlash(`#${task.seq} → ${target.name} · agent ${status}`))
    .catch((e) => setFlash(errMsg(e), true))
    .finally(() => {
      syncInFlight.delete(task.id);
      scheduleRefresh(0);
    });
}

/** Record statuses and fire transitions; heals stale boards on first pass. */
function trackStatusTransitions(): void {
  if (!board) return;
  const firstPass = !startupHealed;
  for (const task of board.tasks) {
    if (task.archived || !task.pane_id) continue;
    const pane = live.panes.get(task.pane_id);
    if (!pane) continue;
    const prev = statusPrev.get(task.pane_id);
    statusPrev.set(task.pane_id, pane.agent_status);
    if (firstPass) {
      maybeAutoAdvance(task.pane_id, pane.agent_status, true);
    } else if (prev !== undefined && prev !== pane.agent_status) {
      maybeAutoAdvance(task.pane_id, pane.agent_status);
    }
  }
  startupHealed = true;
}

async function refresh(): Promise<void> {
  if (!board) return;
  if (refreshing) {
    refreshQueued = true;
    return;
  }
  refreshing = true;
  try {
    // Reload from disk (the init/open actions write the same file) — but not
    // while an op, auto-sync move, or modal holds references into the current
    // board object.
    const modal = mode.type === "input" || mode.type === "confirm";
    if (!busy && !modal && syncInFlight.size === 0) {
      const fresh = store.loadBoard(board.id);
      if (fresh) board = fresh;
    }
    live = await ctl.fetchLive();
    if (ctl.reconcile(board, live)) store.saveBoard(board);
    trackStatusTransitions();
    ensureSubscription();
    clampSelection();
    draw();
  } finally {
    refreshing = false;
    if (refreshQueued) {
      refreshQueued = false;
      scheduleRefresh(50);
    }
  }
}

function scheduleRefresh(delay: number): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refresh().catch((e) => setFlash(errMsg(e), true));
  }, delay);
}

function ensureSubscription(): void {
  if (!board) return;
  const paneIds = board.tasks
    .filter((t) => !t.archived && t.pane_id)
    .map((t) => t.pane_id as string)
    .sort();
  const key = paneIds.join(",");
  if (stream && key === subKey) return;
  stream?.close();
  subKey = key;
  const subs: Array<Record<string, unknown>> = [
    { type: "pane.created" },
    { type: "pane.closed" },
    { type: "pane.moved" },
    { type: "pane.exited" },
    { type: "pane.agent_detected" },
    { type: "tab.created" },
    { type: "tab.closed" },
    { type: "tab.renamed" },
    { type: "workspace.renamed" },
    { type: "workspace.closed" },
    ...paneIds.map((pane_id) => ({ type: "pane.agent_status_changed", pane_id })),
  ];
  stream = subscribe(
    subs,
    (ev) => {
      if (ev.event === "pane.agent_status_changed") {
        const pane = live.panes.get(ev.data?.pane_id);
        if (pane) {
          const status = (ev.data.agent_status as AgentStatus) ?? pane.agent_status;
          pane.agent_status = status;
          if (ev.data.agent) pane.agent = ev.data.agent;
          if (ev.data.custom_status !== undefined) pane.custom_status = ev.data.custom_status;
          const prev = statusPrev.get(pane.pane_id);
          statusPrev.set(pane.pane_id, status);
          if (prev !== undefined && prev !== status) maybeAutoAdvance(pane.pane_id, status);
          draw();
        }
        return;
      }
      scheduleRefresh(120);
    },
    () => {
      stream = null;
      subKey = null;
      setTimeout(() => ensureSubscription(), 1000);
    },
  );
}

// ---- rendering ----

function stateColor(name: string): string {
  const n = name.toLowerCase();
  if (/(triage|idea)/.test(n)) return SGR.lilac;
  if (/(todo|backlog)/.test(n)) return SGR.gray;
  if (/(doing|progress|running|wip|active)/.test(n)) return SGR.green;
  if (/(review|ready|verify|test)/.test(n)) return SGR.amber;
  if (/(done|complete|shipped)/.test(n)) return SGR.blue;
  if (/block/.test(n)) return SGR.red;
  return SGR.accent;
}

function statusGlyph(status: AgentStatus): { glyph: string; style: string } {
  switch (status) {
    case "working": return { glyph: "●", style: SGR.green };
    case "blocked": return { glyph: "⊘", style: SGR.red };
    case "done": return { glyph: "✓", style: SGR.blue };
    case "idle": return { glyph: "○", style: SGR.gray };
    default: return { glyph: "·", style: SGR.faint };
  }
}

const CARD_H = 4;

function visibleCards(): number {
  const { h } = termSize();
  return Math.max(1, Math.floor((h - 4 - 2) / CARD_H));
}

/** Scroll the selected column just enough to reveal the selection. */
function ensureSelVisible(): void {
  const visible = visibleCards();
  let scroll = colScroll[selCol] ?? 0;
  if (selRow < scroll) scroll = selRow;
  if (selRow >= scroll + visible) scroll = selRow - visible + 1;
  colScroll[selCol] = Math.max(0, scroll);
}

function moveSelection(dc: number, dr: number): void {
  selCol += dc;
  selRow += dr;
  clampSelection();
  ensureSelVisible();
  draw();
}

function draw(): void {
  const { w, h } = termSize();
  const scr = new Screen(w, h);
  colRects = [];
  cardHits = [];

  if (mode.type === "noboard" || !board) {
    drawNoBoard(scr);
  } else {
    drawBoard(scr);
  }
  if (mode.type === "help") drawHelp(scr);
  drawFooter(scr);
  out(scr.render());
}

function drawNoBoard(scr: Screen): void {
  const cy = Math.floor(scr.h / 2) - 2;
  const center = (y: number, s: string, style: string) => {
    scr.text(Math.max(0, Math.floor((scr.w - strWidth(s)) / 2)), y, s, style);
  };
  center(cy, "▦ workboard", SGR.accentBold);
  center(cy + 2, "no board is bound to this workspace", SGR.dim);
  center(cy + 4, "c  create a board here (state tabs + this view)", SGR.text);
  center(cy + 5, "q  quit", SGR.text);
}

function drawBoard(scr: Screen): void {
  const b = board!;
  const total = ctl.activeTasks(b).length;
  const sessions = ctl.activeTasks(b).filter((t) => taskPane(t)).length;

  // header
  scr.fill(0, 0, scr.w, 1, " ", SGR.headerBg);
  let hx = 1;
  hx += scr.text(hx, 0, "▦ ", SGR.headerBg + SGR.accentBold);
  hx += scr.text(hx, 0, b.name, SGR.headerBg + SGR.bold + SGR.text);
  hx += scr.text(hx, 0, `  ${total} task${total === 1 ? "" : "s"} · ${sessions} session${sessions === 1 ? "" : "s"}`, SGR.headerBg + SGR.dim);
  const cwdShort = b.cwd.replace(/^\/Users\/[^/]+/, "~");
  const right = `${cwdShort} `;
  scr.text(Math.max(hx + 2, scr.w - strWidth(right)), 0, right, SGR.headerBg + SGR.faint);

  // columns
  const n = b.states.length;
  if (n === 0) return;
  const areaTop = 2;
  const areaH = scr.h - areaTop - 2;
  if (areaH < CARD_H + 2) return;
  const colW = Math.max(12, Math.floor((scr.w - 2 - (n - 1)) / n));
  const visible = Math.max(1, Math.floor((areaH - 2) / CARD_H));

  for (let c = 0; c < n; c++) {
    const st = b.states[c];
    const x = 1 + c * (colW + 1);
    if (x >= scr.w) break;
    colRects.push({ x, w: colW, col: c });
    const tasks = tasksInCol(c);
    const dotStyle = stateColor(st.name);
    const isDragTarget = drag?.active && drag.overCol === c && drag.fromCol !== c;
    const headStyle = isDragTarget ? SGR.inverse + SGR.bold : c === selCol && mode.type === "normal" ? SGR.bold + SGR.text : SGR.dim;

    let cx = x;
    cx += scr.text(cx, areaTop, "● ", dotStyle, colW);
    cx += scr.text(cx, areaTop, st.name, headStyle, colW - (cx - x) - 3);
    scr.text(cx + 1, areaTop, String(tasks.length), SGR.faint);
    scr.hline(x, areaTop + 1, colW, st.tab_id ? SGR.border : SGR.faint, st.tab_id ? "─" : "┄");

    // scroll window (selection-follow happens in ensureSelVisible, not here,
    // so the wheel can scroll the selected column freely)
    const scroll = Math.max(0, Math.min(colScroll[c] ?? 0, Math.max(0, tasks.length - visible)));
    colScroll[c] = scroll;

    if (tasks.length === 0) {
      scr.text(x + Math.max(0, Math.floor((colW - 10) / 2)), areaTop + 3, "— empty —", SGR.faint);
    }

    for (let i = scroll; i < Math.min(tasks.length, scroll + visible); i++) {
      const task = tasks[i];
      const cy = areaTop + 2 + (i - scroll) * CARD_H;
      drawCard(scr, task, x, cy, colW, c, i);
    }
    if (scroll > 0) scr.text(x + colW - 2, areaTop + 2, "↑", SGR.dim);
    if (tasks.length > scroll + visible) scr.text(x + colW - 2, areaTop + 1 + visible * CARD_H, "↓", SGR.dim);
  }
}

function drawCard(scr: Screen, task: Task, x: number, y: number, w: number, col: number, row: number): void {
  const selected = mode.type !== "noboard" && col === selCol && row === selRow;
  const pane = taskPane(task);
  const dragged = drag?.active && drag.taskId === task.id;
  let borderStyle = selected ? SGR.accent : SGR.border;
  if (pane?.agent_status === "blocked" && !selected) borderStyle = SGR.red;
  if (dragged) borderStyle = SGR.faint;

  scr.box(x, y, w, CARD_H, borderStyle);
  cardHits.push({ x, y, w, h: CARD_H, col, row, taskId: task.id });

  const inner = w - 4;
  scr.text(x + 2, y + 1, truncate(task.title, inner), (selected ? SGR.bold + SGR.text : SGR.text) + (dragged ? SGR.faint : ""));

  // meta row: #id · status ......... age
  let mx = x + 2;
  mx += scr.text(mx, y + 2, `#${task.seq}`, SGR.faint, inner);
  mx += 1;
  if (pane) {
    const { glyph, style } = statusGlyph(pane.agent_status);
    const away = board && pane.workspace_id !== board.workspace_id ? "⇢" : "";
    const agent = pane.display_agent ?? pane.agent;
    const label = `${away}${agent ? `${agent} · ` : ""}${pane.custom_status ?? pane.agent_status}`;
    mx += scr.text(mx, y + 2, glyph + " ", style, x + w - 2 - mx);
    mx += scr.text(mx, y + 2, truncate(label, Math.max(0, x + w - 2 - mx - 4)), SGR.dim);
  } else {
    mx += scr.text(mx, y + 2, "∅ no session", SGR.faint, Math.max(0, x + w - 2 - mx - 4));
  }
  const age = fmtAge(task.updated_at);
  if (x + w - 2 - strWidth(age) > mx) scr.text(x + w - 2 - strWidth(age), y + 2, age, SGR.faint);
}

function drawHelp(scr: Screen): void {
  const lines: Array<[string, string]> = [
    ["←/→ h/l", "select column"],
    ["↑/↓ j/k", "select card"],
    ["n", "new task in column"],
    ["enter", "open session pane"],
    ["s / S", "start agent / shell session"],
    ["[ / ]", "move card left / right (moves pane between tabs)"],
    ["J / K", "reorder card within column"],
    ["e", "edit title"],
    ["a", "set agent command"],
    ["A", "toggle auto-sync (columns follow agent state)"],
    ["R", "rename board"],
    ["x", "archive card"],
    ["r", "refresh + heal state tabs"],
    ["q", "quit"],
    ["", ""],
    ["mouse", "click select · double-click open · drag between columns"],
  ];
  const w = Math.min(scr.w - 4, 64);
  const h = lines.length + 4;
  const x = Math.floor((scr.w - w) / 2);
  const y = Math.max(1, Math.floor((scr.h - h) / 2));
  scr.fill(x, y, w, h, " ", "");
  scr.box(x, y, w, h, SGR.accent);
  scr.text(x + 2, y + 1, "workboard keys", SGR.accentBold);
  lines.forEach(([k, desc], i) => {
    scr.text(x + 3, y + 3 + i, k, SGR.amber);
    scr.text(x + 13, y + 3 + i, desc, SGR.text, w - 15);
  });
}

function drawFooter(scr: Screen): void {
  const y = scr.h - 1;
  scr.fill(0, y, scr.w, 1, " ", "");
  if (mode.type === "input") {
    let x = 1;
    x += scr.text(x, y, `${mode.label}: `, SGR.amber);
    x += scr.text(x, y, mode.value, SGR.bold + SGR.text, scr.w - x - 2);
    scr.text(x, y, "▌", SGR.accent);
    return;
  }
  if (mode.type === "confirm") {
    scr.text(1, y, `${mode.msg} `, SGR.amber);
    scr.text(1 + strWidth(mode.msg) + 1, y, "[y/n]", SGR.bold + SGR.text);
    return;
  }
  if (flash && Date.now() < flash.until) {
    scr.text(1, y, flash.msg, flash.err ? SGR.red : SGR.green, scr.w - 2);
    return;
  }
  const hints =
    mode.type === "noboard"
      ? "c create board · q quit"
      : "n new · ⏎ open · s/S session · [ ] move · e edit · x archive · r refresh · ? help · q quit";
  scr.text(1, y, (busy ? "⏳ " : "") + hints, SGR.dim, scr.w - 2);
}

// ---- actions from the UI ----

function createBoardHere(): void {
  run(async () => {
    if (!SELF_WS) throw new Error("not inside a herdr pane (no HERDR_WORKSPACE_ID)");
    const ws = await request<{ workspace: { label: string } }>("workspace.get", { workspace_id: SELF_WS });
    let ctx: any = {};
    try {
      ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}");
    } catch {}
    const cwd = ctx.workspace_cwd ?? ctx.focused_pane_cwd ?? process.env.HOME ?? process.cwd();
    const b = ctl.makeBoard(ws.workspace.label || path.basename(cwd), cwd, SELF_WS);
    b.board_pane_id = PINNED ? SELF_PANE || null : null;
    store.saveBoard(b);
    store.bindWorkspace(SELF_WS, b.id);
    await ctl.ensureStateTabs(b);
    board = b;
    mode = { type: "normal" };
    await refresh();
    setFlash(`board '${b.name}' created — state tabs added to this workspace`);
  });
}

function newTask(): void {
  if (!board) return;
  const st = board.states[selCol];
  if (!st) {
    setFlash("board has no states", true);
    draw();
    return;
  }
  const stateId = st.id;
  mode = {
    type: "input",
    label: `new task (${st.name})`,
    value: "",
    onSubmit: (v) => {
      const title = v.trim();
      if (!title || !board) return;
      const task = ctl.makeTask(board, stateId, title);
      selRow = Math.max(0, tasksInCol(selCol).indexOf(task));
      ensureSelVisible();
      setFlash(`#${task.seq} added to ${st.name}`);
    },
  };
  draw();
}

function moveSelected(dir: -1 | 1): void {
  if (!board) return;
  const task = selectedTask();
  if (!task) return;
  const target = selCol + dir;
  if (target < 0 || target >= board.states.length) return;
  moveToCol(task, target);
}

function moveToCol(taskRef: Task, target: number): void {
  if (!board) return;
  const st = board.states[target];
  if (!st) return;
  const taskId = taskRef.id;
  const stateId = st.id;
  run(async () => {
    const task = liveTask(taskId);
    if (!task) throw new Error("task no longer exists");
    await ctl.moveTaskToState(board!, task, stateId, SELF_PANE || undefined);
    selCol = target;
    selRow = Math.max(0, tasksInCol(target).indexOf(task));
    ensureSelVisible();
    setFlash(`#${task.seq} → ${st.name}`);
  });
}

function reorderSelected(dir: -1 | 1): void {
  if (!board) return;
  const list = tasksInCol(selCol);
  const other = selRow + dir;
  if (other < 0 || other >= list.length) return;
  const a = board.tasks.indexOf(list[selRow]);
  const b = board.tasks.indexOf(list[other]);
  [board.tasks[a], board.tasks[b]] = [board.tasks[b], board.tasks[a]];
  selRow = other;
  ensureSelVisible();
  store.saveBoard(board);
  draw();
}

function openSelected(taskRef = selectedTask()): void {
  if (!taskRef) return;
  if (!taskRef.pane_id || !taskPane(taskRef)) {
    setFlash("no session — press s (agent) or S (shell)", false);
    draw();
    return;
  }
  const taskId = taskRef.id;
  run(async () => {
    const task = liveTask(taskId);
    if (!task) throw new Error("task no longer exists");
    await ctl.focusTask(task);
  });
}

function startSelected(kind: "agent" | "shell"): void {
  if (!board) return;
  const taskRef = selectedTask();
  if (!taskRef) return;
  if (taskRef.pane_id && taskPane(taskRef)) {
    setFlash("session already running — press ⏎ to open");
    draw();
    return;
  }
  const taskId = taskRef.id;
  run(async () => {
    const task = liveTask(taskId);
    if (!task) throw new Error("task no longer exists");
    const pane = await ctl.startSession(board!, task, kind);
    statusPrev.set(pane.pane_id, pane.agent_status);
    const st = board!.states.find((s) => s.id === task.state_id);
    setFlash(`${kind} session started in '${st?.name}' — ⏎ to open`);
    selCol = Math.max(0, stateIdx(task.state_id));
    selRow = Math.max(0, tasksInCol(selCol).indexOf(task));
    ensureSelVisible();
  });
}

function archiveSelected(): void {
  if (!board) return;
  const taskRef = selectedTask();
  if (!taskRef) return;
  const taskId = taskRef.id;
  const finish = (closePane: boolean) =>
    run(async () => {
      const task = liveTask(taskId);
      if (!task) throw new Error("task no longer exists");
      await ctl.archiveTask(board!, task, closePane);
      setFlash(`#${task.seq} archived`);
    });
  mode = {
    type: "confirm",
    msg: `archive #${taskRef.seq} '${truncate(taskRef.title, 30)}'?`,
    onYes: () => {
      const task = liveTask(taskId);
      if (!task) return;
      if (task.pane_id && taskPane(task)) {
        // "no" archives the card but keeps the pane alive as a plain pane
        mode = { type: "confirm", msg: "close its session pane too?", onYes: () => finish(true), onNo: () => finish(false) };
        draw();
      } else {
        finish(false);
      }
    },
  };
  draw();
}

function editTitle(): void {
  if (!board) return;
  const taskRef = selectedTask();
  if (!taskRef) return;
  const taskId = taskRef.id;
  mode = {
    type: "input",
    label: `edit #${taskRef.seq}`,
    value: taskRef.title,
    onSubmit: (v) => {
      const title = v.trim();
      if (!title || !board) return;
      const task = liveTask(taskId);
      if (!task) {
        setFlash("task no longer exists", true);
        return;
      }
      task.title = title;
      task.updated_at = Date.now();
      store.saveBoard(board);
      if (task.pane_id) {
        request("pane.rename", { pane_id: task.pane_id, label: ctl.paneLabel(task) }).catch(() => {});
      }
    },
  };
  draw();
}

function editAgentCmd(): void {
  if (!board) return;
  mode = {
    type: "input",
    label: "agent command",
    value: board.agent_cmd.join(" "),
    onSubmit: (v) => {
      const argv = v.trim().split(/\s+/).filter(Boolean);
      if (argv.length === 0 || !board) return;
      board.agent_cmd = argv;
      store.saveBoard(board);
      setFlash(`sessions will run: ${argv.join(" ")} "<task>"`);
    },
  };
  draw();
}

function renameBoard(): void {
  if (!board) return;
  mode = {
    type: "input",
    label: "board name",
    value: board.name,
    onSubmit: (v) => {
      const name = v.trim();
      if (!name || !board) return;
      board.name = name;
      store.saveBoard(board);
      request("workspace.rename", { workspace_id: board.workspace_id, label: `▦ ${name}` }).catch(() => {});
    },
  };
  draw();
}

function quit(): void {
  if (PINNED) {
    mode = { type: "confirm", msg: "quit the board? (its tab closes; reopen via the 'open' action)", onYes: () => process.exit(0) };
    draw();
    return;
  }
  process.exit(0);
}

// ---- input dispatch ----

function handleEvent(ev: InputEvent): void {
  if (ev.type === "key" && ev.name === "ctrl-c") process.exit(0);

  if (ev.type === "paste") {
    if (mode.type === "input") {
      // collapse control chars/newlines — titles are single-line
      mode.value += ev.text.replace(/[\x00-\x1f\x7f]+/g, " ");
      draw();
    } else {
      setFlash("paste ignored — open an input first (n, e, …)");
      draw();
    }
    return;
  }

  if (mode.type === "input") {
    if (ev.type === "char") {
      mode.value += ev.ch;
    } else if (ev.type === "key") {
      if (ev.name === "backspace") mode.value = [...mode.value].slice(0, -1).join("");
      else if (ev.name === "ctrl-u") mode.value = "";
      else if (ev.name === "ctrl-w") mode.value = mode.value.replace(/\S+\s*$/, "");
      else if (ev.name === "esc") mode = { type: "normal" };
      else if (ev.name === "enter") {
        const m = mode;
        mode = { type: "normal" };
        m.onSubmit(m.value);
      }
    }
    draw();
    return;
  }

  if (mode.type === "confirm") {
    const m = mode;
    if (ev.type === "char" && (ev.ch === "y" || ev.ch === "Y")) {
      mode = { type: "normal" };
      m.onYes();
    } else if ((ev.type === "char" && (ev.ch === "n" || ev.ch === "N")) || (ev.type === "key" && ev.name === "esc")) {
      mode = { type: "normal" };
      m.onNo?.();
      draw();
    }
    return;
  }

  if (mode.type === "help") {
    if (ev.type === "key" || ev.type === "char") {
      mode = { type: "normal" };
      draw();
    }
    return;
  }

  if (mode.type === "noboard") {
    if (ev.type === "char" && ev.ch === "c") createBoardHere();
    else if (ev.type === "char" && ev.ch === "q") process.exit(0);
    return;
  }

  // normal mode
  if (ev.type === "mouse") {
    handleMouse(ev);
    return;
  }
  if (ev.type === "key") {
    switch (ev.name) {
      case "left": moveSelection(-1, 0); break;
      case "right": moveSelection(1, 0); break;
      case "up": moveSelection(0, -1); break;
      case "down": moveSelection(0, 1); break;
      case "enter": openSelected(); break;
      case "esc": draw(); break;
    }
    return;
  }
  switch (ev.ch) {
    case "h": moveSelection(-1, 0); break;
    case "l": moveSelection(1, 0); break;
    case "k": moveSelection(0, -1); break;
    case "j": moveSelection(0, 1); break;
    case "K": reorderSelected(-1); break;
    case "J": reorderSelected(1); break;
    case "[": case "H": moveSelected(-1); break;
    case "]": case "L": moveSelected(1); break;
    case "n": newTask(); break;
    case "s": startSelected("agent"); break;
    case "S": startSelected("shell"); break;
    case "e": editTitle(); break;
    case "a": editAgentCmd(); break;
    case "A":
      if (board) {
        board.auto_sync = !autoSyncEnabled();
        store.saveBoard(board);
        setFlash(`auto-sync ${board.auto_sync ? "on — columns follow agent state" : "off"}`);
        draw();
      }
      break;
    case "R": renameBoard(); break;
    case "x": archiveSelected(); break;
    case "r": run(async () => { await ctl.ensureStateTabs(board!); await refresh(); setFlash("refreshed"); }); break;
    case "?": mode = { type: "help" }; draw(); break;
    case "q": quit(); break;
  }
}

function selectTaskById(taskId: string): boolean {
  if (!board) return false;
  for (let c = 0; c < board.states.length; c++) {
    const idx = tasksInCol(c).findIndex((t) => t.id === taskId);
    if (idx >= 0) {
      selCol = c;
      selRow = idx;
      ensureSelVisible();
      return true;
    }
  }
  return false;
}

function colAt(x: number): number | null {
  for (const c of colRects) {
    if (x >= c.x && x < c.x + c.w) return c.col;
  }
  return null;
}

function cardAt(x: number, y: number): CardHit | null {
  for (const h of cardHits) {
    if (x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h) return h;
  }
  return null;
}

function handleMouse(ev: Extract<InputEvent, { type: "mouse" }>): void {
  if (!board) return;
  if (ev.kind === "wheel-up" || ev.kind === "wheel-down") {
    const col = colAt(ev.x);
    if (col !== null) {
      colScroll[col] = Math.max(0, (colScroll[col] ?? 0) + (ev.kind === "wheel-down" ? 1 : -1));
      draw();
    }
    return;
  }
  if (ev.kind === "press" && ev.button === 0) {
    const hit = cardAt(ev.x, ev.y);
    if (hit) {
      // select by task id — the hit map may predate a concurrent refresh
      if (!selectTaskById(hit.taskId)) {
        clampSelection();
        draw();
        return;
      }
      drag = { taskId: hit.taskId, fromCol: selCol, sx: ev.x, sy: ev.y, active: false, overCol: null };
      draw();
    } else {
      const col = colAt(ev.x);
      if (col !== null) {
        selCol = col;
        clampSelection();
        draw();
      }
    }
    return;
  }
  if (ev.kind === "drag" && drag) {
    if (!drag.active && (Math.abs(ev.x - drag.sx) > 1 || Math.abs(ev.y - drag.sy) > 1)) drag.active = true;
    if (drag.active) {
      const over = colAt(ev.x);
      if (over !== drag.overCol) {
        drag.overCol = over;
        draw();
      }
    }
    return;
  }
  if (ev.kind === "release") {
    const d = drag;
    drag = null;
    if (d?.active && d.overCol !== null && d.overCol !== d.fromCol) {
      const task = board.tasks.find((t) => t.id === d.taskId);
      if (task) moveToCol(task, d.overCol);
      return;
    }
    // click / double-click
    const hit = cardAt(ev.x, ev.y);
    if (hit) {
      const now = Date.now();
      if (lastClick.taskId === hit.taskId && now - lastClick.t < 400) {
        const task = board.tasks.find((t) => t.id === hit.taskId);
        if (task) openSelected(task);
      }
      lastClick = { t: now, taskId: hit.taskId };
    }
    draw();
  }
}

// ---- main ----

async function main(): Promise<void> {
  if (!process.stdin.isTTY) die("workboard: must run inside a terminal (herdr pane)");
  store.ensureDirs();
  setupTerminal();

  // Wire input before any awaits so Ctrl-C / q work during startup.
  const parser = new InputParser();
  let escTimer: ReturnType<typeof setTimeout> | null = null;
  process.stdin.on("data", (data: string) => {
    for (const ev of parser.feed(data.toString())) handleEvent(ev);
    if (escTimer) {
      clearTimeout(escTimer);
      escTimer = null;
    }
    if (parser.hasPendingEscape()) {
      // a bare ESC that never grows into a sequence is a real Esc key
      escTimer = setTimeout(() => {
        for (const ev of parser.flushEscape()) handleEvent(ev);
      }, 40);
    }
  });
  process.stdin.on("end", () => process.exit(0));

  board = resolveBoard();
  if (!board) {
    mode = { type: "noboard" };
    draw();
  } else {
    // self-heal: adopt this workspace/pane if the recorded ones are gone
    if (SELF_WS && board.workspace_id !== SELF_WS && !(await ctl.workspaceExists(board.workspace_id))) {
      board.workspace_id = SELF_WS;
      store.bindWorkspace(SELF_WS, board.id);
    }
    if (PINNED && SELF_PANE && board.board_pane_id !== SELF_PANE) board.board_pane_id = SELF_PANE;
    store.saveBoard(board);
    draw();
    try {
      // No tab creation here — init/open own that (avoids racing them at
      // startup); 'r' and session ops heal missing tabs on demand.
      await refresh();
    } catch (e) {
      setFlash(errMsg(e), true);
      draw();
    }
  }

  setInterval(() => {
    if (!busy && mode.type !== "input" && mode.type !== "confirm") scheduleRefresh(0);
  }, 4000);
}

main().catch((e) => die(`workboard: ${errMsg(e)}`));
