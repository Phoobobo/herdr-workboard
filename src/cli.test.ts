import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bindWorkspace, saveBoard } from "./store.ts";
import type { Board } from "./types.ts";

const YAML = `stages:\n  ready:\n    agent: worker\n    success_message: ready\n    terminal: false\n  done:\n    agent: worker\n    success_message: done\n    terminal: true\n`;
let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "workboard-cli-test-"));
  process.env.WORKBOARD_STATE_DIR = dir;
  const board: Board = {
    version: 1,
    id: "cli-board",
    name: "cli",
    cwd: dir,
    workspace_id: "cli-workspace",
    board_pane_id: null,
    agent_cmd: ["agent"],
    states: [],
    tasks: [],
    next_seq: 1,
  };
  saveBoard(board);
  bindWorkspace(board.workspace_id, board.id);
  file = path.join(dir, "workflow.yaml");
  fs.writeFileSync(file, YAML);
});

afterEach(() => {
  delete process.env.WORKBOARD_STATE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

function cli(...args: string[]) {
  return Bun.spawnSync([process.execPath, "run", path.join(import.meta.dir, "cli.ts"), ...args], {
    env: { ...process.env, WORKBOARD_STATE_DIR: dir, HERDR_WORKSPACE_ID: "cli-workspace" },
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("CLI emits JSON for initialization, status, runs, and transitions", () => {
  const initialized = cli("workflow", "init", file, "--json");
  expect(initialized.exitCode).toBe(0);
  expect(JSON.parse(initialized.stdout.toString()).status.current_stage).toBe("ready");

  expect(cli("run", "start", "worker", "--json").exitCode).toBe(0);
  const finished = cli("run", "finish", "worker", "--result", "passed", "--json");
  expect(JSON.parse(finished.stdout.toString()).status.runs[0].result).toBe("passed");

  const transitioned = cli("transition", "done", "--request-id", "cli-request", "--json");
  expect(transitioned.exitCode).toBe(0);
  expect(JSON.parse(transitioned.stdout.toString()).status.terminal).toBe(true);

  const status = cli("status", "--json");
  expect(JSON.parse(status.stdout.toString()).status.current_stage).toBe("done");
});

test("CLI uses nonzero exits and stable JSON error codes", () => {
  expect(cli("workflow", "init", file, "--json").exitCode).toBe(0);
  const invalid = cli("transition", "missing", "--request-id", "bad", "--json");
  expect(invalid.exitCode).toBe(4);
  expect(JSON.parse(invalid.stderr.toString()).error.code).toBe("INVALID_TRANSITION");

  const absent = Bun.spawnSync([process.execPath, "run", path.join(import.meta.dir, "cli.ts"), "status", "--json"], {
    env: { ...process.env, WORKBOARD_STATE_DIR: dir, HERDR_WORKSPACE_ID: "other-workspace" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(absent.exitCode).toBe(3);
  expect(JSON.parse(absent.stderr.toString()).error.code).toBe("WORKSPACE_NOT_FOUND");
});
