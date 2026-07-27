import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { actionNew } from "./actions.ts";
import { makeBoard } from "./boardctl.ts";
import { bindWorkspace, listBoards, resolveBoardForWorkspace, saveBoard } from "./store.ts";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "workboard-action-test-"));
  process.env.WORKBOARD_STATE_DIR = dir;
});

afterEach(() => {
  delete process.env.WORKBOARD_STATE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
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
