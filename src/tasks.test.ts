// CLI-level coverage for the agent-facing surface. Everything exercised here
// is deliberately socket-free, so the suite runs outside herdr.

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bindWorkspace, saveBoard } from "./store.ts";
import type { Board } from "./types.ts";

// `build` deliberately declares no column, so it exercises the "stage maps to
// no column" path alongside the two stages that do move the card.
const YAML = `stages:
  plan:
    agent: planner
    success_message: planned
    state: todo
    terminal: false
  build:
    agent: builder
    success_message: built
    terminal: false
  review:
    agent: checker
    success_message: reviewed
    terminal: true
`;

let dir: string;
let workflowFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "workboard-tasks-test-"));
  process.env.WORKBOARD_STATE_DIR = dir;
  const board: Board = {
    version: 1,
    id: "task-board",
    name: "tasks",
    cwd: dir,
    workspace_id: "task-workspace",
    board_pane_id: null,
    agent_cmd: ["agent"],
    states: [
      { id: "s1", name: "todo", tab_id: null },
      { id: "s2", name: "doing", tab_id: null },
      { id: "s3", name: "review", tab_id: null },
    ],
    tasks: [],
    next_seq: 1,
  };
  saveBoard(board);
  bindWorkspace(board.workspace_id, board.id);
  workflowFile = path.join(dir, "workflow.yaml");
  fs.writeFileSync(workflowFile, YAML);
});

afterEach(() => {
  delete process.env.WORKBOARD_STATE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

function cli(...args: string[]) {
  // --json is ours, so it has to land before any verbatim agent argv
  const separator = args.indexOf("--");
  const withJson = separator >= 0 ? [...args.slice(0, separator), "--json", ...args.slice(separator)] : [...args, "--json"];
  const result = Bun.spawnSync([process.execPath, "run", path.join(import.meta.dir, "cli.ts"), ...withJson], {
    env: { ...process.env, WORKBOARD_STATE_DIR: dir, HERDR_WORKSPACE_ID: "task-workspace" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = (result.exitCode === 0 ? result.stdout : result.stderr).toString().trim();
  return { exitCode: result.exitCode, body: text ? JSON.parse(text) : null };
}

test("tasks are created, read, edited, and archived through the CLI", () => {
  const added = cli("task", "add", "ship the thing", "--body", "details", "--state", "doing");
  expect(added.exitCode).toBe(0);
  expect(added.body.task).toMatchObject({ id: "t1", seq: 1, title: "ship the thing", body: "details", state: "doing" });

  // #seq addressing is what a human reads off a card
  expect(cli("task", "show", "#1").body.task.id).toBe("t1");

  const updated = cli("task", "update", "t1", "--title", "ship it", "--", "codex", "--yolo");
  expect(updated.body.task).toMatchObject({ title: "ship it", agent_cmd: ["codex", "--yolo"] });

  cli("task", "add", "second", "--state", "todo");
  expect(cli("task", "list").body.tasks).toHaveLength(2);
  expect(cli("task", "list", "--state", "todo").body.tasks.map((t: { id: string }) => t.id)).toEqual(["t2"]);

  expect(cli("task", "archive", "t2").body.task.archived).toBe(true);
  expect(cli("task", "list").body.tasks).toHaveLength(1);
  expect(cli("task", "list", "--all").body.tasks).toHaveLength(2);
});

test("archived tasks stay readable but refuse further changes", () => {
  cli("task", "add", "done with this");
  cli("task", "archive", "t1");

  expect(cli("task", "show", "t1").exitCode).toBe(0);
  for (const verb of [
    ["task", "move", "t1", "--state", "doing"],
    ["task", "update", "t1", "--title", "revived"],
    ["task", "archive", "t1"],
  ]) {
    const rejected = cli(...verb);
    expect(rejected.exitCode).toBe(3);
    expect(rejected.body.error.message).toContain("archived");
  }
  expect(cli("task", "show", "t1").body.task).toMatchObject({ title: "done with this", state: "todo" });
});

test("unknown tasks and states report their own codes and exit 3", () => {
  expect(cli("task", "show", "t99").exitCode).toBe(3);
  expect(cli("task", "show", "t99").body.error.code).toBe("TASK_NOT_FOUND");
  expect(cli("task", "add", "x", "--state", "nowhere").body.error.code).toBe("STATE_NOT_FOUND");
  expect(cli("board", "show", "--board", "no-such-board").body.error.code).toBe("BOARD_NOT_FOUND");
});

test("board is addressable explicitly, without a workspace in scope", () => {
  const shown = Bun.spawnSync(
    [process.execPath, "run", path.join(import.meta.dir, "cli.ts"), "board", "show", "--board", "task-board", "--json"],
    { env: { ...process.env, WORKBOARD_STATE_DIR: dir, HERDR_WORKSPACE_ID: "" }, stdout: "pipe", stderr: "pipe" },
  );
  expect(shown.exitCode).toBe(0);
  const board = JSON.parse(shown.stdout.toString()).board;
  expect(board).toMatchObject({ id: "task-board", workspace_id: "task-workspace" });
  expect(board.states.map((state: { name: string }) => state.name)).toEqual(["todo", "doing", "review"]);
});

test("workflow stages drive the bound card between columns", () => {
  cli("task", "add", "the work", "--state", "doing");
  const initialized = cli("workflow", "init", workflowFile, "--task", "t1");
  expect(initialized.body.status.task_id).toBe("t1");
  // init lands on `plan`, which maps to todo, so the card moves immediately
  expect(initialized.body.card).toMatchObject({ task_id: "t1", state: "todo", moved: true });
  expect(cli("task", "show", "t1").body.task.state).toBe("todo");

  // `build` declares no column and matches none by name — the card stays put
  const built = cli("transition", "build", "--request-id", "r1");
  expect(built.body.card.moved).toBe(false);
  expect(cli("task", "show", "t1").body.task.state).toBe("todo");

  // `review` has no explicit state but matches the review column by name
  const reviewed = cli("transition", "review", "--request-id", "r2");
  expect(reviewed.body.card).toMatchObject({ state: "review", moved: true });
  expect(cli("task", "show", "t1").body.task.state).toBe("review");

  // replaying a transition is safe and reports the card as already in place
  const replay = cli("transition", "review", "--request-id", "r2");
  expect(replay.exitCode).toBe(0);
  expect(replay.body.card.moved).toBe(false);
});

test("run request IDs make retries safe and conflicts loud", () => {
  cli("workflow", "init", workflowFile);
  expect(cli("run", "start", "builder", "--request-id", "start-1").exitCode).toBe(0);
  expect(cli("run", "start", "builder", "--request-id", "start-1").body.status.runs).toHaveLength(1);

  expect(cli("run", "finish", "builder", "--result", "passed", "--request-id", "fin-1").exitCode).toBe(0);
  // the replay must not demand a second running run to close
  const replayed = cli("run", "finish", "builder", "--result", "passed", "--request-id", "fin-1");
  expect(replayed.exitCode).toBe(0);
  expect(replayed.body.status.runs).toHaveLength(1);

  const conflict = cli("run", "finish", "builder", "--result", "failed", "--request-id", "fin-1");
  expect(conflict.exitCode).toBe(4);
  expect(conflict.body.error.code).toBe("REQUEST_CONFLICT");
});

test("workflow show exposes the stage graph agents must plan against", () => {
  cli("workflow", "init", workflowFile);
  const shown = cli("workflow", "show");
  expect(shown.exitCode).toBe(0);
  expect(shown.body.workflow.stages.map((stage: { name: string }) => stage.name)).toEqual(["plan", "build", "review"]);
  expect(shown.body.workflow.stages[0].state).toBe("todo");
});
