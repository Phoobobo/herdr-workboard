import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { actionAttach, actionNew, type AttachDeps } from "./actions.ts";
import { makeBoard } from "./boardctl.ts";
import { bindWorkspace, listBoards, resolveBoardForWorkspace, saveBoard } from "./store.ts";
import type { PaneInfo, TabInfo } from "./types.ts";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "workboard-action-test-"));
  process.env.WORKBOARD_STATE_DIR = dir;
});

afterEach(() => {
  delete process.env.WORKBOARD_STATE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeAttachDeps(initialTabs: string[], failOnState?: string): { deps: AttachDeps; tabOrder: string[]; calls: string[] } {
  const tabOrder = [...initialTabs];
  const calls: string[] = [];
  let next = 1;
  const deps: AttachDeps = {
    request: async <T>(method: string, params: Record<string, any> = {}): Promise<T> => {
      calls.push(method);
      if (method === "plugin.pane.open") {
        const tabId = `board-tab-${next++}`;
        tabOrder.push(tabId);
        return {
          plugin_pane: {
            pane: {
              pane_id: "board-pane",
              tab_id: tabId,
              workspace_id: params.workspace_id,
            } as PaneInfo,
          },
        } as T;
      }
      if (method === "tab.rename" || method === "workspace.focus" || method === "tab.focus") return {} as T;
      if (method === "tab.create") {
        if (params.label === failOnState) throw new Error(`cannot create ${params.label}`);
        const tabId = `state-${params.label}`;
        tabOrder.push(tabId);
        return {
          tab: { tab_id: tabId, workspace_id: params.workspace_id, label: params.label } as TabInfo,
        } as T;
      }
      if (method === "tab.close") {
        const index = tabOrder.indexOf(params.tab_id);
        if (index >= 0) tabOrder.splice(index, 1);
        return {} as T;
      }
      throw new Error(`unexpected request: ${method}`);
    },
    focusExisting: async () => {
      calls.push("focusExisting");
    },
  };
  return { deps, tabOrder, calls };
}

test("attach appends a board and state tabs without disturbing existing tab order", async () => {
  const fake = fakeAttachDeps(["client-tab-1", "client-tab-2"]);
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const board = await actionAttach(
      { workspace_id: "workspace-current", workspace_label: "Client workspace", workspace_cwd: path.join(dir, "repo") },
      fake.deps,
    );

    expect(fake.tabOrder).toEqual([
      "client-tab-1",
      "client-tab-2",
      "board-tab-1",
      "state-todo",
      "state-doing",
      "state-review",
      "state-done",
    ]);
    expect(board.workspace_id).toBe("workspace-current");
    expect(board.board_pane_id).toBe("board-pane");
    expect(resolveBoardForWorkspace("workspace-current")?.id).toBe(board.id);
    expect(board.states.map((state) => state.tab_id)).toEqual([
      "state-todo",
      "state-doing",
      "state-review",
      "state-done",
    ]);
  } finally {
    log.mockRestore();
  }
});

test("duplicate attach focuses the board already bound to the workspace", async () => {
  const board = makeBoard("existing", path.join(dir, "repo"), "workspace-current");
  saveBoard(board);
  bindWorkspace(board.workspace_id, board.id);
  const fake = fakeAttachDeps(["client-tab-1", "board-tab"]);
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const attached = await actionAttach({ workspace_id: board.workspace_id, workspace_cwd: board.cwd }, fake.deps);
    expect(attached.id).toBe(board.id);
    expect(fake.tabOrder).toEqual(["client-tab-1", "board-tab"]);
    expect(fake.calls).toEqual(["focusExisting"]);
    expect(listBoards()).toHaveLength(1);
  } finally {
    log.mockRestore();
  }
});

test("failed attach rolls back its board, binding, and newly appended tabs", async () => {
  const unrelated = makeBoard("other", path.join(dir, "other"), "workspace-other");
  saveBoard(unrelated);
  bindWorkspace(unrelated.workspace_id, unrelated.id);
  const fake = fakeAttachDeps(["client-tab-1", "client-tab-2"], "review");
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await expect(
      actionAttach({ workspace_id: "workspace-current", workspace_cwd: path.join(dir, "repo") }, fake.deps),
    ).rejects.toThrow("cannot create review");
    expect(fake.tabOrder).toEqual(["client-tab-1", "client-tab-2"]);
    expect(resolveBoardForWorkspace("workspace-current")).toBeNull();
    expect(resolveBoardForWorkspace("workspace-other")?.id).toBe(unrelated.id);
    expect(listBoards().map((board) => board.id)).toEqual([unrelated.id]);
  } finally {
    log.mockRestore();
  }
});

test("new action creates and binds an independent board for an already-used cwd", async () => {
  const cwd = path.join(dir, "repo");
  const existing = makeBoard("repo", cwd, "workspace-existing");
  saveBoard(existing);
  bindWorkspace(existing.workspace_id, existing.id);

  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const created = await actionNew(
      { workspace_id: existing.workspace_id, workspace_cwd: cwd },
      async (board) => {
        board.workspace_id = "workspace-new";
        saveBoard(board);
        bindWorkspace(board.workspace_id, board.id);
      },
    );

    expect(created.id).not.toBe(existing.id);
    expect(created.cwd).toBe(cwd);
    expect(resolveBoardForWorkspace("workspace-existing")?.id).toBe(existing.id);
    expect(resolveBoardForWorkspace("workspace-new")?.id).toBe(created.id);
    expect(listBoards()).toHaveLength(2);
  } finally {
    log.mockRestore();
  }
});
