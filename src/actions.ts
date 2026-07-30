// Plugin action entrypoint. herdr invokes this with HERDR_PLUGIN_ACTION_ID set
// (an argv fallback keeps `bun run src/actions.ts init` usable by hand).
//
//   init  create or reuse a dedicated board workspace for the current project
//   new   always create another independent board workspace for the project
//   open    focus the board for the current workspace/project, recreating the
//           board pane (and, after a server restart, the whole workspace) if needed
//   attach  append a fresh board and its state tabs to the active workspace

import path from "node:path";
import os from "node:os";
import { request } from "./herdr.ts";
import * as store from "./store.ts";
import * as ctl from "./boardctl.ts";
import type { Board, PaneInfo, TabInfo, WorkspaceInfo } from "./types.ts";

export interface Ctx {
  workspace_id?: string;
  workspace_label?: string;
  workspace_cwd?: string;
  focused_pane_cwd?: string;
}

const { shQuote } = ctl;

function pluginRoot(): string {
  return process.env.HERDR_PLUGIN_ROOT ?? path.resolve(import.meta.dir, "..");
}

function boardCommand(): string[] {
  return [process.execPath, "run", path.join(pluginRoot(), "src", "board.ts")];
}

function boardEnv(board: Board): Record<string, string> {
  return {
    WORKBOARD_BOARD_ID: board.id,
    WORKBOARD_STATE_DIR: store.stateDir(),
    WORKBOARD_PINNED: "1",
  };
}

async function focusBoard(board: Board): Promise<void> {
  await request("workspace.focus", { workspace_id: board.workspace_id });
  if (board.board_pane_id) {
    await request("pane.zoom", { pane_id: board.board_pane_id, mode: "off" }).catch(() => {});
  }
}

/** Create the board workspace: board TUI in tab 1, then one tab per state. */
async function buildWorkspace(board: Board): Promise<void> {
  const ws = await request<{ workspace: WorkspaceInfo; tab: TabInfo }>("workspace.create", {
    cwd: board.cwd,
    label: `▦ ${board.name}`,
    focus: false,
  });
  board.workspace_id = ws.workspace.workspace_id;
  for (const st of board.states) st.tab_id = null;
  // Persist before the board pane launches — it reads this file on startup.
  store.saveBoard(board);
  store.bindWorkspace(board.workspace_id, board.id);

  // Replace the fresh workspace's only tab with one that runs the board TUI.
  // layout.apply replacement tabs land at the end of the strip — with a single
  // tab that end IS position 1, which is why the board tab must be built
  // before any state tab.
  const applied = await request<{ layout: { tab_id: string; focused_pane_id?: string; root: { pane_id?: string } } }>("layout.apply", {
    tab_id: ws.tab.tab_id,
    tab_label: ctl.BOARD_TAB_LABEL,
    focus: false,
    root: {
      type: "pane",
      label: ctl.BOARD_PANE_LABEL,
      cwd: board.cwd,
      command: boardCommand(),
      env: boardEnv(board),
    },
  });
  board.board_pane_id = applied.layout.focused_pane_id ?? applied.layout.root.pane_id ?? null;

  await ctl.ensureStateTabs(board);
  store.saveBoard(board);

  await request("workspace.focus", { workspace_id: board.workspace_id });
  await request("tab.focus", { tab_id: applied.layout.tab_id }).catch(() => {});
}

async function actionInit(ctx: Ctx): Promise<void> {
  const cwd = ctx.workspace_cwd ?? ctx.focused_pane_cwd ?? os.homedir();

  // invoked from inside an existing board workspace → just focus it
  const bound = ctx.workspace_id ? store.resolveBoardForWorkspace(ctx.workspace_id) : null;
  if (bound && (await ctl.workspaceExists(bound.workspace_id))) {
    await focusBoard(bound);
    console.log(`workboard: focused existing board '${bound.name}' (${bound.workspace_id})`);
    return;
  }

  // a board for this project already exists → focus (or rebuild) it
  const existing = store.findBoardByCwd(cwd);
  if (existing) {
    if (await ctl.workspaceExists(existing.workspace_id)) {
      await focusBoard(existing);
      console.log(`workboard: board '${existing.name}' already exists — focused it`);
    } else {
      await buildWorkspace(existing);
      console.log(`workboard: rebuilt workspace for board '${existing.name}' (tasks preserved)`);
    }
    return;
  }

  const board = ctl.makeBoard(path.basename(cwd), cwd, "");
  await buildWorkspace(board);
  console.log(
    `workboard: created board '${board.name}' — workspace ${board.workspace_id}, ` +
      `states: ${board.states.map((s) => s.name).join(", ")}`,
  );
}

type ActionRequest = <T = any>(method: string, params?: Record<string, unknown>) => Promise<T>;

export interface AttachDeps {
  request: ActionRequest;
  focusExisting: (ctx: Ctx) => Promise<void>;
}

const defaultAttachDeps: AttachDeps = {
  request,
  focusExisting: actionOpen,
};

/**
 * Attach a fresh independent board to the active workspace. Existing tabs are
 * never passed to a replacement API: the board and state tabs are appended in
 * that order. Persistence is committed only after the complete layout exists.
 */
export async function actionAttach(ctx: Ctx, deps: AttachDeps = defaultAttachDeps): Promise<Board> {
  const workspaceId = ctx.workspace_id?.trim();
  if (!workspaceId) throw new Error("attach requires an active workspace context");

  const bound = store.resolveBoardForWorkspace(workspaceId);
  if (bound) {
    await deps.focusExisting(ctx);
    console.log(`workboard: focused board '${bound.name}' already attached to workspace ${workspaceId}`);
    return bound;
  }

  const cwd = ctx.workspace_cwd ?? ctx.focused_pane_cwd ?? os.homedir();
  const board = ctl.makeBoard(ctx.workspace_label?.trim() || path.basename(cwd), cwd, workspaceId);
  const createdTabIds: string[] = [];

  // The board process needs its document as soon as its new pane starts. The
  // workspace binding remains uncommitted until every configured tab exists.
  store.saveBoard(board);
  try {
    const opened = await deps.request<{ plugin_pane: { pane: PaneInfo } }>("plugin.pane.open", {
      plugin_id: store.PLUGIN_ID,
      entrypoint: "board",
      placement: "tab",
      workspace_id: workspaceId,
      focus: false,
      env: boardEnv(board),
    });
    board.board_pane_id = opened.plugin_pane.pane.pane_id;
    createdTabIds.push(opened.plugin_pane.pane.tab_id);
    await deps.request("tab.rename", { tab_id: opened.plugin_pane.pane.tab_id, label: ctl.BOARD_TAB_LABEL });
    store.saveBoard(board);

    // Do not use ensureStateTabs here: attach must create its own tabs rather
    // than adopt a client's pre-existing tab that happens to share a label.
    for (const state of board.states) {
      const created = await deps.request<{ tab: TabInfo }>("tab.create", {
        workspace_id: workspaceId,
        cwd: board.cwd,
        label: state.name,
        focus: false,
      });
      state.tab_id = created.tab.tab_id;
      createdTabIds.push(created.tab.tab_id);
      store.saveBoard(board);
    }

    store.bindWorkspace(workspaceId, board.id);
    await deps.request("workspace.focus", { workspace_id: workspaceId });
    await deps.request("tab.focus", { tab_id: opened.plugin_pane.pane.tab_id });
  } catch (error) {
    for (const tabId of createdTabIds.reverse()) {
      await deps.request("tab.close", { tab_id: tabId }).catch(() => {});
    }
    store.unbindWorkspace(workspaceId, board.id);
    store.deleteBoard(board.id);
    throw error;
  }

  console.log(
    `workboard: attached independent board '${board.name}' to workspace ${workspaceId} — ` +
      `states: ${board.states.map((state) => state.name).join(", ")}`,
  );
  return board;
}

/** Always create a fresh board, even when another board uses the same cwd. */
export async function actionNew(
  ctx: Ctx,
  builder: (board: Board) => Promise<void> = buildWorkspace,
): Promise<Board> {
  const cwd = ctx.workspace_cwd ?? ctx.focused_pane_cwd ?? os.homedir();
  const board = ctl.makeBoard(path.basename(cwd), cwd, "");
  await builder(board);
  console.log(
    `workboard: created independent board '${board.name}' — workspace ${board.workspace_id}, ` +
      `states: ${board.states.map((s) => s.name).join(", ")}`,
  );
  return board;
}

async function actionOpen(ctx: Ctx): Promise<void> {
  const cwd = ctx.workspace_cwd ?? ctx.focused_pane_cwd ?? "";
  const board =
    (ctx.workspace_id ? store.resolveBoardForWorkspace(ctx.workspace_id) : null) ??
    (cwd ? store.findBoardByCwd(cwd) : null);
  if (!board) {
    console.error("workboard: no board for this workspace — run the init action first");
    process.exit(1);
  }

  if (!(await ctl.workspaceExists(board.workspace_id))) {
    await buildWorkspace(board);
    console.log(`workboard: rebuilt workspace for board '${board.name}'`);
    return;
  }

  // board pane still alive?
  let pane: PaneInfo | null = null;
  if (board.board_pane_id) {
    try {
      pane = (await request<{ pane: PaneInfo }>("pane.get", { pane_id: board.board_pane_id })).pane;
    } catch {
      pane = null;
    }
  }
  if (pane && pane.workspace_id === board.workspace_id) {
    const info = await request<{ process_info?: { foreground_processes?: Array<{ name?: string; argv?: string[]; cmdline?: string }> } }>(
      "pane.process_info",
      { pane_id: pane.pane_id },
    ).catch(() => null);
    const procs = info?.process_info?.foreground_processes ?? [];
    const runningBoard = procs.some(
      (p) => p.argv?.some((a) => a.includes("board.ts")) || p.cmdline?.includes("board.ts"),
    );
    // After a server restart the pane is a leftover shell; relaunch the TUI in
    // place — but only when the foreground is provably a shell. Typing into an
    // unknown program would feed it garbage.
    // POSIX only — the relaunch line uses `K=v exec cmd` syntax
    const isShell = procs.length > 0 && procs.every((p) => /^-?(zsh|bash|sh|dash|ksh)$/.test(p.name ?? ""));
    if (runningBoard || isShell) {
      if (!runningBoard) {
        const assigns = Object.entries(boardEnv(board))
          .map(([k, v]) => `${k}=${shQuote(v)}`)
          .join(" ");
        const cmd = boardCommand().map(shQuote).join(" ");
        await request("pane.send_input", { pane_id: pane.pane_id, text: ` ${assigns} exec ${cmd}`, keys: ["Enter"] });
      }
      await request("workspace.focus", { workspace_id: board.workspace_id });
      await request("pane.zoom", { pane_id: pane.pane_id, mode: "off" }).catch(() => {});
      console.log(`workboard: focused board '${board.name}'`);
      return;
    }
    // Something else runs in the recorded pane — leave it alone and open fresh.
  }

  // board pane gone → open a fresh plugin pane in a new tab, label it 'board'
  const opened = await request<{ plugin_pane: { pane: PaneInfo } }>("plugin.pane.open", {
    plugin_id: store.PLUGIN_ID,
    entrypoint: "board",
    placement: "tab",
    workspace_id: board.workspace_id,
    focus: true,
    env: boardEnv(board),
  });
  board.board_pane_id = opened.plugin_pane.pane.pane_id;
  store.saveBoard(board);
  await request("tab.rename", { tab_id: opened.plugin_pane.pane.tab_id, label: ctl.BOARD_TAB_LABEL }).catch(() => {});
  console.log(`workboard: reopened board pane for '${board.name}'`);
}

async function main(): Promise<void> {
  const action = process.env.HERDR_PLUGIN_ACTION_ID ?? process.argv[2] ?? "init";
  let ctx: Ctx = {};
  try {
    ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}");
  } catch {}
  store.ensureDirs();
  if (action === "init") await actionInit(ctx);
  else if (action === "new") await actionNew(ctx);
  else if (action === "open") await actionOpen(ctx);
  else if (action === "attach") await actionAttach(ctx);
  else {
    console.error(`workboard: unknown action '${action}'`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`workboard action failed: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
