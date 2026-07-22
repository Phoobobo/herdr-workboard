import fs from "node:fs";
import path from "node:path";
import { newId, resolveBoardForWorkspace, stateDir } from "./store.ts";
import type { Board, RoleRun, RoleRunResult, WorkflowStage, WorkflowStatus, WorkflowTask } from "./types.ts";

export type WorkflowErrorCode =
  | "INVALID_ARGUMENT"
  | "WORKSPACE_NOT_FOUND"
  | "WORKFLOW_NOT_FOUND"
  | "WORKFLOW_EXISTS"
  | "INVALID_WORKFLOW"
  | "INVALID_TRANSITION"
  | "REQUEST_CONFLICT"
  | "RUN_NOT_FOUND";

export class WorkflowError extends Error {
  constructor(public code: WorkflowErrorCode, message: string) {
    super(message);
    this.name = "WorkflowError";
  }
}

function workflowDir(): string {
  return path.join(stateDir(), "workflows");
}

function workflowPath(boardId: string): string {
  return path.join(workflowDir(), `${boardId}.json`);
}

function lockPath(boardId: string): string {
  return path.join(workflowDir(), `${boardId}.lock`);
}

function writeAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function withLock<T>(boardId: string, fn: () => T): T {
  fs.mkdirSync(workflowDir(), { recursive: true });
  const lock = lockPath(boardId);
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {}
      if (Date.now() >= deadline) throw new Error("timed out waiting for workflow storage lock");
      Bun.sleepSync(10);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

export function loadWorkflow(boardId: string): WorkflowTask | null {
  try {
    return JSON.parse(fs.readFileSync(workflowPath(boardId), "utf8")) as WorkflowTask;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function requireWorkflow(boardId: string): WorkflowTask {
  const workflow = loadWorkflow(boardId);
  if (!workflow) throw new WorkflowError("WORKFLOW_NOT_FOUND", "no workflow is initialized for this workspace");
  return workflow;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkflowError("INVALID_WORKFLOW", `${field} must be a non-empty string`);
  }
  return value.trim();
}

/** Parse and validate the small declarative workflow format, preserving stage order. */
export function parseWorkflow(text: string): WorkflowStage[] {
  let document: any;
  try {
    document = Bun.YAML.parse(text);
  } catch (error) {
    throw new WorkflowError("INVALID_WORKFLOW", `cannot parse workflow: ${error instanceof Error ? error.message : error}`);
  }
  const rawStages = document?.stages;
  let entries: Array<[string, any]>;
  if (rawStages && !Array.isArray(rawStages) && typeof rawStages === "object") {
    entries = Object.entries(rawStages);
  } else if (Array.isArray(rawStages)) {
    entries = rawStages.map((stage, index) => [nonEmpty(stage?.name, `stages[${index}].name`), stage]);
  } else {
    throw new WorkflowError("INVALID_WORKFLOW", "stages must be a mapping or array");
  }
  if (entries.length === 0) throw new WorkflowError("INVALID_WORKFLOW", "workflow must contain at least one stage");

  const names = new Set<string>();
  const stages = entries.map(([rawName, value], index): WorkflowStage => {
    const name = nonEmpty(rawName, `stages[${index}].name`);
    if (names.has(name)) throw new WorkflowError("INVALID_WORKFLOW", `duplicate stage '${name}'`);
    names.add(name);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new WorkflowError("INVALID_WORKFLOW", `stage '${name}' must be an object`);
    }
    if (typeof value.terminal !== "boolean") {
      throw new WorkflowError("INVALID_WORKFLOW", `stage '${name}'.terminal must be a boolean`);
    }
    return {
      name,
      agent: nonEmpty(value.agent, `stage '${name}'.agent`),
      success_message: nonEmpty(value.success_message, `stage '${name}'.success_message`),
      ...(value.retry_message === undefined ? {} : { retry_message: nonEmpty(value.retry_message, `stage '${name}'.retry_message`) }),
      ...(value.retry_to === undefined ? {} : { retry_to: nonEmpty(value.retry_to, `stage '${name}'.retry_to`) }),
      ...(value.output === undefined ? {} : { output: value.output }),
      terminal: value.terminal,
      transitions: [],
    };
  });

  for (let index = 0; index < stages.length; index++) {
    const stage = stages[index];
    if (stage.retry_to && !names.has(stage.retry_to)) {
      throw new WorkflowError("INVALID_WORKFLOW", `stage '${stage.name}'.retry_to references unknown stage '${stage.retry_to}'`);
    }
    if (stage.terminal && index < stages.length - 1) {
      throw new WorkflowError("INVALID_WORKFLOW", `terminal stage '${stage.name}' must be last`);
    }
    if (!stage.terminal && index === stages.length - 1) {
      throw new WorkflowError("INVALID_WORKFLOW", `final stage '${stage.name}' must be terminal`);
    }
    if (!stage.terminal && stages[index + 1]) stage.transitions.push(stages[index + 1].name);
    if (stage.retry_to && !stage.transitions.includes(stage.retry_to)) stage.transitions.push(stage.retry_to);
  }
  return stages;
}

export function initializeWorkflow(board: Board, text: string, source?: string, force = false, now = Date.now()): WorkflowStatus {
  const stages = parseWorkflow(text);
  return withLock(board.id, () => {
    if (loadWorkflow(board.id) && !force) {
      throw new WorkflowError("WORKFLOW_EXISTS", "this workspace already has a workflow; pass --force to replace it");
    }
    const workflow: WorkflowTask = {
      version: 1,
      board_id: board.id,
      workspace_id: board.workspace_id,
      ...(source ? { source } : {}),
      initialized_at: now,
      updated_at: now,
      current_stage: stages[0].name,
      stages,
      runs: [],
      requests: [],
    };
    writeAtomic(workflowPath(board.id), workflow);
    return workflowStatus(workflow);
  });
}

export function workflowStatus(workflow: WorkflowTask): WorkflowStatus {
  const stage = workflow.stages.find((candidate) => candidate.name === workflow.current_stage);
  if (!stage) throw new WorkflowError("INVALID_WORKFLOW", `stored current stage '${workflow.current_stage}' is missing`);
  return {
    board_id: workflow.board_id,
    workspace_id: workflow.workspace_id,
    current_stage: workflow.current_stage,
    terminal: stage.terminal,
    stage,
    runs: workflow.runs,
    current_runs: workflow.runs.filter((run) => run.status === "running"),
    updated_at: workflow.updated_at,
  };
}

export function getWorkflowStatus(boardId: string): WorkflowStatus {
  return workflowStatus(requireWorkflow(boardId));
}

export function transitionWorkflow(boardId: string, state: string, requestId: string, now = Date.now()): WorkflowStatus {
  if (!state.trim() || !requestId.trim()) throw new WorkflowError("INVALID_ARGUMENT", "state and request ID must be non-empty");
  return withLock(boardId, () => {
    const workflow = requireWorkflow(boardId);
    const previous = workflow.requests.find((request) => request.request_id === requestId);
    if (previous) {
      if (previous.input.state !== state) {
        throw new WorkflowError("REQUEST_CONFLICT", `request ID '${requestId}' was already used with different input`);
      }
      return previous.result;
    }
    const current = workflow.stages.find((stage) => stage.name === workflow.current_stage);
    if (!current || !current.transitions.includes(state)) {
      throw new WorkflowError("INVALID_TRANSITION", `cannot transition from '${workflow.current_stage}' to '${state}'`);
    }
    workflow.current_stage = state;
    workflow.updated_at = now;
    const result = workflowStatus(workflow);
    workflow.requests.push({ request_id: requestId, input: { state }, result });
    writeAtomic(workflowPath(boardId), workflow);
    return result;
  });
}

export function startRoleRun(boardId: string, role: string, now = Date.now()): WorkflowStatus {
  if (!role.trim()) throw new WorkflowError("INVALID_ARGUMENT", "role must be non-empty");
  return withLock(boardId, () => {
    const workflow = requireWorkflow(boardId);
    const run: RoleRun = { id: newId("run"), role, started_at: now, status: "running" };
    workflow.runs.push(run);
    workflow.updated_at = now;
    writeAtomic(workflowPath(boardId), workflow);
    return workflowStatus(workflow);
  });
}

export function finishRoleRun(boardId: string, role: string, result: RoleRunResult, now = Date.now()): WorkflowStatus {
  if (!role.trim()) throw new WorkflowError("INVALID_ARGUMENT", "role must be non-empty");
  return withLock(boardId, () => {
    const workflow = requireWorkflow(boardId);
    const run = [...workflow.runs].reverse().find((candidate) => candidate.role === role && candidate.status === "running");
    if (!run) throw new WorkflowError("RUN_NOT_FOUND", `role '${role}' has no running run`);
    run.status = "finished";
    run.result = result;
    run.ended_at = now;
    workflow.updated_at = now;
    writeAtomic(workflowPath(boardId), workflow);
    return workflowStatus(workflow);
  });
}

export function boardForWorkspace(workspaceId: string): Board {
  if (!workspaceId) throw new WorkflowError("WORKSPACE_NOT_FOUND", "cannot resolve the current Herdr workspace");
  const board = resolveBoardForWorkspace(workspaceId);
  if (!board) throw new WorkflowError("WORKSPACE_NOT_FOUND", `workspace '${workspaceId}' has no workboard`);
  return board;
}
