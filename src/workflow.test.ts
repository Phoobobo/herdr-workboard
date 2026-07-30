import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bindWorkspace, saveBoard } from "./store.ts";
import {
  WorkflowError,
  boardForWorkspace,
  finishRoleRun,
  getWorkflowStatus,
  initializeWorkflow,
  loadWorkflow,
  parseWorkflow,
  startRoleRun,
  transitionWorkflow,
} from "./workflow.ts";
import type { Board } from "./types.ts";

const VALID = `
stages:
  plan:
    agent: planner
    success_message: plan ready
    terminal: false
  build:
    agent: builder
    success_message: build ready
    retry_message: revise
    retry_to: plan
    output: artifact.md
    terminal: false
  done:
    agent: verifier
    success_message: complete
    terminal: true
`;

let dir: string;
let board: Board;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "workboard-test-"));
  process.env.WORKBOARD_STATE_DIR = dir;
  board = {
    version: 1,
    id: "board-a",
    name: "test",
    cwd: "/tmp/a",
    workspace_id: "workspace-a",
    board_pane_id: null,
    agent_cmd: ["test-agent"],
    states: [],
    tasks: [],
    next_seq: 1,
  };
  saveBoard(board);
  bindWorkspace(board.workspace_id, board.id);
});

afterEach(() => {
  delete process.env.WORKBOARD_STATE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("workflow validation", () => {
  test("snapshots ordered stages and derived transitions", () => {
    const stages = parseWorkflow(VALID);
    expect(stages.map((stage) => stage.name)).toEqual(["plan", "build", "done"]);
    expect(stages[1].transitions).toEqual(["done", "plan"]);
  });

  test("rejects invalid retry targets and non-terminal final stages", () => {
    expect(() => parseWorkflow(VALID.replace("retry_to: plan", "retry_to: missing"))).toThrow("unknown stage");
    expect(() => parseWorkflow(VALID.replace("terminal: true", "terminal: false"))).toThrow("must be terminal");
  });
});

test("legal transitions persist and illegal transitions do not mutate", () => {
  initializeWorkflow(board, VALID, { source: "workflow.yaml", now: 10 });
  const moved = transitionWorkflow(board.id, "build", "request-1", 20);
  expect(moved.current_stage).toBe("build");

  expect(() => transitionWorkflow(board.id, "plan", "request-illegal", 30)).not.toThrow();
  expect(() => transitionWorkflow(board.id, "done", "request-2", 40)).toThrow();
  expect(getWorkflowStatus(board.id).current_stage).toBe("plan");
  expect(loadWorkflow(board.id)?.requests).toHaveLength(2);
});

test("request IDs are idempotent and conflict on changed input", () => {
  initializeWorkflow(board, VALID);
  const original = transitionWorkflow(board.id, "build", "same-id", 20);
  transitionWorkflow(board.id, "done", "next-id", 30);
  const repeated = transitionWorkflow(board.id, "build", "same-id", 40);
  expect(repeated).toEqual(original);
  expect(getWorkflowStatus(board.id).current_stage).toBe("done");
  expect(() => transitionWorkflow(board.id, "plan", "same-id", 50)).toThrow("different input");
  try {
    transitionWorkflow(board.id, "plan", "same-id", 50);
  } catch (error) {
    expect((error as WorkflowError).code).toBe("REQUEST_CONFLICT");
  }
});

test("workflow snapshot and role runs survive reloads", () => {
  const sourceFile = path.join(dir, "workflow.yaml");
  fs.writeFileSync(sourceFile, VALID);
  initializeWorkflow(board, fs.readFileSync(sourceFile, "utf8"), { source: sourceFile, now: 10 });
  fs.writeFileSync(sourceFile, VALID.replace("build:", "changed:"));

  startRoleRun(board.id, "builder", 20);
  const status = finishRoleRun(board.id, "builder", "passed", 30);
  expect(status.current_stage).toBe("plan");
  expect(status.runs[0]).toMatchObject({ role: "builder", started_at: 20, ended_at: 30, result: "passed", status: "finished" });
  expect(loadWorkflow(board.id)?.stages[1].name).toBe("build");
});

test("workspace resolution never crosses bindings", () => {
  expect(boardForWorkspace("workspace-a").id).toBe(board.id);
  bindWorkspace("workspace-b", board.id); // stale/corrupt binding to another workspace
  expect(() => boardForWorkspace("workspace-b")).toThrow("has no workboard");
});
