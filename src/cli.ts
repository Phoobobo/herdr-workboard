// The machine-driven surface. Every board primitive the TUI offers is
// reachable here as one `--json` command, so an agent or a supervisor process
// can drive a board without a terminal.
//
// Addressing: `--board <id>` wins, then `--workspace <id>`, then the pane's
// own workspace (HERDR_* env), then the focused workspace over the socket.
// Callers inside a board pane never need to pass ids at all.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { request } from "./herdr.ts";
import * as ctl from "./boardctl.ts";
import { buildWorkspace } from "./actions.ts";
import { listBoards } from "./store.ts";
import { addTask, listTasks, requireActiveTask, requireState, requireTask, updateTask, viewTask } from "./tasks.ts";
import {
  WorkflowError,
  boardById,
  boardForWorkspace,
  finishRoleRun,
  getWorkflowStatus,
  initializeWorkflow,
  loadWorkflow,
  startRoleRun,
  transitionWorkflow,
} from "./workflow.ts";
import type { Board, RoleRunResult, Task, WorkspaceInfo, WorkflowStatus } from "./types.ts";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

/**
 * Split the command's own arguments from a verbatim trailing argv. Everything
 * after `--` belongs to the agent command, so a `--json` (or any other flag)
 * inside it is passed through rather than read as ours.
 */
function splitArgv(args: string[]): { args: string[]; agentArgv?: string[] } {
  const index = args.indexOf("--");
  return index >= 0 ? { args: args.slice(0, index), agentArgv: args.slice(index + 1) } : { args };
}

function workspaceFromContext(): string | undefined {
  if (process.env.HERDR_WORKSPACE_ID?.trim()) return process.env.HERDR_WORKSPACE_ID.trim();
  try {
    const context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}");
    if (typeof context.workspace_id === "string" && context.workspace_id.trim()) return context.workspace_id.trim();
  } catch {}
  return undefined;
}

export async function resolveCurrentWorkspace(): Promise<string> {
  const fromEnvironment = workspaceFromContext();
  if (fromEnvironment) return fromEnvironment;
  try {
    const result = await request<{ workspaces: WorkspaceInfo[] }>("workspace.list", {});
    const focused = result.workspaces.find((workspace) => workspace.focused);
    if (focused) return focused.workspace_id;
  } catch {}
  throw new WorkflowError("WORKSPACE_NOT_FOUND", "cannot resolve a current Herdr workspace; run inside a Herdr pane");
}

/** The board this invocation acts on, honouring explicit overrides first. */
async function resolveBoard(args: string[]): Promise<Board> {
  const boardId = option(args, "--board");
  if (boardId) return boardById(boardId);
  const workspaceId = option(args, "--workspace") ?? (await resolveCurrentWorkspace());
  return boardForWorkspace(workspaceId);
}

function usage(): string {
  return `Usage:
  herdr-workboard status [--json]
  herdr-workboard transition <state> --request-id <id> [--json]
  herdr-workboard run start <role> [--request-id <id>] [--json]
  herdr-workboard run finish <role> --result <passed|failed|blocked> [--request-id <id>] [--json]
  herdr-workboard workflow init <file.yaml> [--task <id>] [--force] [--json]
  herdr-workboard workflow show [--json]

  herdr-workboard board show [--json]
  herdr-workboard board list [--json]
  herdr-workboard board new [--name <name>] [--cwd <dir>] [--json]

  herdr-workboard task add <title> [--body <text>] [--state <id|name>] [-- <agent argv>] [--json]
  herdr-workboard task list [--state <id|name>] [--all] [--json]
  herdr-workboard task show <task> [--json]
  herdr-workboard task update <task> [--title <t>] [--body <b>] [-- <agent argv>] [--json]
  herdr-workboard task move <task> --state <id|name> [--json]
  herdr-workboard task start <task> [--shell] [--json]
  herdr-workboard task focus <task> [--json]
  herdr-workboard task archive <task> [--close-pane] [--json]

Board selection: --board <id> | --workspace <id> | the current pane's workspace.`;
}

function exitCode(error: WorkflowError): number {
  if (error.code === "INVALID_ARGUMENT" || error.code === "INVALID_WORKFLOW") return 2;
  if (
    error.code === "WORKSPACE_NOT_FOUND" ||
    error.code === "WORKFLOW_NOT_FOUND" ||
    error.code === "RUN_NOT_FOUND" ||
    error.code === "BOARD_NOT_FOUND" ||
    error.code === "TASK_NOT_FOUND" ||
    error.code === "STATE_NOT_FOUND"
  ) {
    return 3;
  }
  if (error.code === "INVALID_TRANSITION" || error.code === "REQUEST_CONFLICT" || error.code === "WORKFLOW_EXISTS") return 4;
  return 1;
}

// ---- rendering ----

/** Every command returns a payload plus the lines to print without --json. */
interface Output {
  payload: Record<string, unknown>;
  lines: string[];
}

function statusOutput(status: WorkflowStatus, extra: Record<string, unknown> = {}): Output {
  const running = status.current_runs.map((run) => run.role).join(", ") || "none";
  return {
    payload: { status, ...extra },
    lines: [`stage: ${status.current_stage}${status.terminal ? " (terminal)" : ""}`, `running roles: ${running}`],
  };
}

function boardSummary(board: Board): Record<string, unknown> {
  return {
    id: board.id,
    name: board.name,
    cwd: board.cwd,
    workspace_id: board.workspace_id,
    board_pane_id: board.board_pane_id,
    agent_cmd: board.agent_cmd,
    states: board.states.map((state) => ({
      id: state.id,
      name: state.name,
      tab_id: state.tab_id,
      task_count: board.tasks.filter((task) => !task.archived && task.state_id === state.id).length,
    })),
    task_count: board.tasks.filter((task) => !task.archived).length,
  };
}

function taskLine(board: Board, task: Task): string {
  const view = viewTask(board, task);
  const session = view.pane_id ? ` [${view.pane_id}]` : "";
  return `${view.id}\t#${view.seq}\t${view.state}\t${view.title}${session}${view.archived ? " (archived)" : ""}`;
}

function taskOutput(board: Board, task: Task, note?: string): Output {
  return { payload: { task: viewTask(board, task) }, lines: [...(note ? [note] : []), taskLine(board, task)] };
}

// ---- stage → card ----

/**
 * Keep the card in step with the workflow stage. Run after every transition —
 * including replays — because moveTaskToState is a no-op once the card already
 * sits in the target column, which makes retries safe.
 */
async function syncCardToStage(board: Board, status: WorkflowStatus): Promise<Record<string, unknown> | undefined> {
  if (!status.task_id) return undefined;
  const task = board.tasks.find((candidate) => candidate.id === status.task_id);
  if (!task || task.archived) return { task_id: status.task_id, moved: false, reason: "task is gone" };
  const target = ctl.resolveStageState(board, status.stage);
  if (!target) return { task_id: task.id, moved: false, reason: `stage '${status.stage.name}' maps to no column` };
  if (target.id === task.state_id) return { task_id: task.id, state: target.name, moved: false };
  await ctl.moveTaskToState(board, task, target.id, undefined, false, false);
  return { task_id: task.id, state: target.name, moved: true };
}

// ---- commands ----

async function runWorkflowCommand(args: string[], board: Board): Promise<Output | null> {
  if (args[0] === "status") {
    return statusOutput(getWorkflowStatus(board.id));
  }
  if (args[0] === "transition") {
    const state = args[1];
    const requestId = option(args, "--request-id");
    if (!state || !requestId) throw new WorkflowError("INVALID_ARGUMENT", "transition requires <state> and --request-id <id>");
    const status = transitionWorkflow(board.id, state, requestId);
    const card = await syncCardToStage(board, status);
    return statusOutput(status, card ? { card } : {});
  }
  if (args[0] === "run" && args[1] === "start") {
    const role = args[2];
    if (!role) throw new WorkflowError("INVALID_ARGUMENT", "run start requires <role>");
    return statusOutput(startRoleRun(board.id, role, Date.now(), option(args, "--request-id")));
  }
  if (args[0] === "run" && args[1] === "finish") {
    const role = args[2];
    const result = option(args, "--result") as RoleRunResult | undefined;
    if (!role || !result || !["passed", "failed", "blocked"].includes(result)) {
      throw new WorkflowError("INVALID_ARGUMENT", "run finish requires <role> --result <passed|failed|blocked>");
    }
    return statusOutput(finishRoleRun(board.id, role, result, Date.now(), option(args, "--request-id")));
  }
  if (args[0] === "workflow" && args[1] === "init") {
    const file = args[2];
    if (!file) throw new WorkflowError("INVALID_ARGUMENT", "workflow init requires <file.yaml>");
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      throw new WorkflowError("INVALID_ARGUMENT", `cannot read workflow file '${file}': ${error instanceof Error ? error.message : error}`);
    }
    const taskRef = option(args, "--task");
    const taskId = taskRef ? requireTask(board, taskRef).id : undefined;
    const status = initializeWorkflow(board, text, { source: file, force: args.includes("--force"), taskId });
    const card = await syncCardToStage(board, status);
    return statusOutput(status, card ? { card } : {});
  }
  if (args[0] === "workflow" && args[1] === "show") {
    const workflow = loadWorkflow(board.id);
    if (!workflow) throw new WorkflowError("WORKFLOW_NOT_FOUND", "no workflow is initialized for this workspace");
    return {
      payload: { workflow },
      lines: workflow.stages.map(
        (stage) =>
          `${stage.name === workflow.current_stage ? "*" : " "} ${stage.name}\tagent=${stage.agent}` +
          `\tcolumn=${stage.state ?? stage.name}\t-> ${stage.transitions.join(", ") || "(terminal)"}`,
      ),
    };
  }
  return null;
}

async function runBoardCommand(args: string[], board: () => Promise<Board>): Promise<Output | null> {
  if (args[0] !== "board") return null;
  if (args[1] === "show") {
    const resolved = await board();
    const summary = boardSummary(resolved);
    return {
      payload: { board: summary },
      lines: [
        `board ${resolved.id} '${resolved.name}' (${resolved.workspace_id})`,
        `cwd: ${resolved.cwd}`,
        `states: ${resolved.states.map((state) => `${state.id}:${state.name}`).join(" ")}`,
      ],
    };
  }
  if (args[1] === "list") {
    const boards = listBoards().map(boardSummary);
    return { payload: { boards }, lines: boards.map((b) => `${b.id}\t${b.workspace_id}\t${b.name}\t${b.cwd}`) };
  }
  if (args[1] === "new") {
    // Build the workspace synchronously and hand back its ids, so callers
    // never have to poll `workspace list` to discover what was created.
    const cwd = path.resolve(option(args, "--cwd") ?? process.cwd() ?? os.homedir());
    const name = option(args, "--name")?.trim();
    const created = ctl.makeBoard(name || path.basename(cwd), cwd, "");
    await buildWorkspace(created);
    return {
      payload: { board: boardSummary(created) },
      lines: [`created board ${created.id} '${created.name}' in workspace ${created.workspace_id}`],
    };
  }
  throw new WorkflowError("INVALID_ARGUMENT", usage());
}

async function runTaskCommand(args: string[], agentArgv: string[] | undefined, board: Board): Promise<Output | null> {
  if (args[0] !== "task") return null;
  const verb = args[1];

  if (verb === "add") {
    const title = args[2];
    if (!title || title.startsWith("--")) throw new WorkflowError("INVALID_ARGUMENT", "task add requires <title>");
    const task = addTask(board, title, {
      body: option(args, "--body"),
      state: option(args, "--state"),
      agentCmd: agentArgv,
    });
    return taskOutput(board, task);
  }
  if (verb === "list") {
    const tasks = listTasks(board, { state: option(args, "--state"), all: args.includes("--all") });
    return { payload: { tasks: tasks.map((task) => viewTask(board, task)) }, lines: tasks.map((task) => taskLine(board, task)) };
  }
  if (verb === "show") {
    if (!args[2]) throw new WorkflowError("INVALID_ARGUMENT", "task show requires <task>");
    return taskOutput(board, requireTask(board, args[2]));
  }
  if (verb === "update") {
    if (!args[2]) throw new WorkflowError("INVALID_ARGUMENT", "task update requires <task>");
    const task = requireActiveTask(board, args[2]);
    updateTask(board, task, { title: option(args, "--title"), body: option(args, "--body"), agentCmd: agentArgv });
    return taskOutput(board, task);
  }
  if (verb === "move") {
    const state = option(args, "--state");
    if (!args[2] || !state) throw new WorkflowError("INVALID_ARGUMENT", "task move requires <task> --state <id|name>");
    const task = requireActiveTask(board, args[2]);
    await ctl.moveTaskToState(board, task, requireState(board, state).id, undefined, false, false);
    return taskOutput(board, task);
  }
  if (verb === "start") {
    if (!args[2]) throw new WorkflowError("INVALID_ARGUMENT", "task start requires <task>");
    const task = requireActiveTask(board, args[2]);
    const pane = await ctl.startSession(board, task, args.includes("--shell") ? "shell" : "agent");
    return { payload: { task: viewTask(board, task), pane }, lines: [`session ${pane.pane_id} for ${task.id}`] };
  }
  if (verb === "focus") {
    if (!args[2]) throw new WorkflowError("INVALID_ARGUMENT", "task focus requires <task>");
    const task = requireActiveTask(board, args[2]);
    if (!task.pane_id) throw new WorkflowError("TASK_NOT_FOUND", `task '${task.id}' has no session to focus`);
    await ctl.focusTask(task);
    return taskOutput(board, task, "focused");
  }
  if (verb === "archive") {
    if (!args[2]) throw new WorkflowError("INVALID_ARGUMENT", "task archive requires <task>");
    const task = requireActiveTask(board, args[2]);
    await ctl.archiveTask(board, task, args.includes("--close-pane"));
    return taskOutput(board, task, "archived");
  }
  throw new WorkflowError("INVALID_ARGUMENT", usage());
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { args, agentArgv } = splitArgv(argv);
  const json = args.includes("--json");
  try {
    // Reject unknown commands before resolving a board, so `--help` outside a
    // board workspace answers with usage rather than "no workboard here".
    const roots = ["status", "transition", "run", "workflow", "board", "task"];
    if (!args[0] || !roots.includes(args[0])) throw new WorkflowError("INVALID_ARGUMENT", usage());

    // `board new` and `board list` must work with no board in scope yet, so
    // board resolution is deferred until a command actually needs one.
    let cached: Board | undefined;
    const board = async () => (cached ??= await resolveBoard(args));

    const output =
      (await runBoardCommand(args, board)) ??
      (await runTaskCommand(args, agentArgv, await board())) ??
      (await runWorkflowCommand(args, await board()));
    if (!output) throw new WorkflowError("INVALID_ARGUMENT", usage());

    if (json) console.log(JSON.stringify({ ok: true, ...output.payload }));
    else if (output.lines.length) console.log(output.lines.join("\n"));
    return 0;
  } catch (error) {
    const known = error instanceof WorkflowError ? error : new WorkflowError("INVALID_ARGUMENT", error instanceof Error ? error.message : String(error));
    if (json) console.error(JSON.stringify({ ok: false, error: { code: known.code, message: known.message } }));
    else console.error(`herdr-workboard: ${known.code}: ${known.message}`);
    return exitCode(known);
  }
}

if (import.meta.main) process.exit(await main());
