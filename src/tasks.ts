// Task primitives on a board document: pure, socket-free, and shared by the
// TUI and the machine CLI. Anything that has to touch herdr (starting a
// session, moving a pane between tabs) lives in boardctl.ts instead.

import { saveBoard } from "./store.ts";
import { activeTasks, makeTask } from "./boardctl.ts";
import { WorkflowError } from "./workflow.ts";
import type { Board, BoardState, Task } from "./types.ts";

/** A task as agents see it: ids plus the resolved column name. */
export interface TaskView {
  id: string;
  seq: number;
  title: string;
  body?: string;
  state_id: string;
  state: string;
  pane_id: string | null;
  agent_cmd?: string[];
  archived: boolean;
  created_at: number;
  updated_at: number;
}

export function viewTask(board: Board, task: Task): TaskView {
  return {
    id: task.id,
    seq: task.seq,
    title: task.title,
    ...(task.body === undefined ? {} : { body: task.body }),
    state_id: task.state_id,
    state: board.states.find((s) => s.id === task.state_id)?.name ?? task.state_id,
    pane_id: task.pane_id,
    ...(task.agent_cmd ? { agent_cmd: task.agent_cmd } : {}),
    archived: task.archived === true,
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
}

/** Resolve a state by local id (`s2`) or by column name (`doing`). */
export function requireState(board: Board, ref: string): BoardState {
  const wanted = ref.trim();
  if (!wanted) throw new WorkflowError("INVALID_ARGUMENT", "state must be non-empty");
  const state =
    board.states.find((s) => s.id === wanted) ??
    board.states.find((s) => s.name.toLowerCase() === wanted.toLowerCase());
  if (!state) {
    const known = board.states.map((s) => `${s.id} (${s.name})`).join(", ") || "none";
    throw new WorkflowError("STATE_NOT_FOUND", `board '${board.id}' has no state '${wanted}'; known states: ${known}`);
  }
  return state;
}

/** Resolve a task by id (`t3`) or by `#seq`/`seq`. Archived tasks stay findable. */
export function requireTask(board: Board, ref: string): Task {
  const wanted = ref.trim().replace(/^#/, "");
  if (!wanted) throw new WorkflowError("INVALID_ARGUMENT", "task must be non-empty");
  const task =
    board.tasks.find((t) => t.id === wanted) ??
    (/^\d+$/.test(wanted) ? board.tasks.find((t) => t.seq === Number(wanted)) : undefined);
  if (!task) throw new WorkflowError("TASK_NOT_FOUND", `board '${board.id}' has no task '${ref}'`);
  return task;
}

/**
 * Same as requireTask, for verbs that change a card. Archived cards stay
 * readable but must not be moved, started, or edited back into circulation.
 */
export function requireActiveTask(board: Board, ref: string): Task {
  const task = requireTask(board, ref);
  if (task.archived) throw new WorkflowError("TASK_NOT_FOUND", `task '${task.id}' is archived`);
  return task;
}

export interface AddTaskOptions {
  body?: string;
  state?: string;
  agentCmd?: string[];
}

/** Create a card. Without an explicit state it lands in the first column. */
export function addTask(board: Board, title: string, options: AddTaskOptions = {}): Task {
  if (!title.trim()) throw new WorkflowError("INVALID_ARGUMENT", "task title must be non-empty");
  if (board.states.length === 0) {
    throw new WorkflowError("STATE_NOT_FOUND", `board '${board.id}' has no states; open the board once to create them`);
  }
  const state = options.state ? requireState(board, options.state) : board.states[0];
  const task = makeTask(board, state.id, title.trim(), options.body);
  if (options.agentCmd?.length) {
    task.agent_cmd = options.agentCmd;
    task.updated_at = Date.now();
    saveBoard(board);
  }
  return task;
}

export interface UpdateTaskFields {
  title?: string;
  body?: string;
  agentCmd?: string[];
}

/** Edit a card in place. Omitted fields are left untouched. */
export function updateTask(board: Board, task: Task, fields: UpdateTaskFields): Task {
  if (fields.title !== undefined) {
    if (!fields.title.trim()) throw new WorkflowError("INVALID_ARGUMENT", "task title must be non-empty");
    task.title = fields.title.trim();
  }
  if (fields.body !== undefined) task.body = fields.body;
  if (fields.agentCmd !== undefined) {
    // An empty argv clears the per-task override back to the board default.
    if (fields.agentCmd.length === 0) delete task.agent_cmd;
    else task.agent_cmd = fields.agentCmd;
  }
  task.updated_at = Date.now();
  saveBoard(board);
  return task;
}

export function listTasks(board: Board, options: { state?: string; all?: boolean } = {}): Task[] {
  const stateId = options.state ? requireState(board, options.state).id : undefined;
  if (options.all) {
    return board.tasks.filter((t) => stateId === undefined || t.state_id === stateId);
  }
  return activeTasks(board, stateId);
}
