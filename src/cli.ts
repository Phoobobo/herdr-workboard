import fs from "node:fs";
import { request } from "./herdr.ts";
import {
  WorkflowError,
  boardForWorkspace,
  finishRoleRun,
  getWorkflowStatus,
  initializeWorkflow,
  startRoleRun,
  transitionWorkflow,
} from "./workflow.ts";
import type { RoleRunResult, WorkspaceInfo, WorkflowStatus } from "./types.ts";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
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

function usage(): string {
  return `Usage:
  herdr-workboard status [--json]
  herdr-workboard transition <state> --request-id <id> [--json]
  herdr-workboard run start <role> [--json]
  herdr-workboard run finish <role> --result <passed|failed|blocked> [--json]
  herdr-workboard workflow init <file.yaml> [--force] [--json]`;
}

function printStatus(status: WorkflowStatus, json: boolean): void {
  if (json) console.log(JSON.stringify({ ok: true, status }));
  else {
    const running = status.current_runs.map((run) => run.role).join(", ") || "none";
    console.log(`stage: ${status.current_stage}${status.terminal ? " (terminal)" : ""}\nrunning roles: ${running}`);
  }
}

function exitCode(error: WorkflowError): number {
  if (error.code === "INVALID_ARGUMENT" || error.code === "INVALID_WORKFLOW") return 2;
  if (error.code === "WORKSPACE_NOT_FOUND" || error.code === "WORKFLOW_NOT_FOUND" || error.code === "RUN_NOT_FOUND") return 3;
  if (error.code === "INVALID_TRANSITION" || error.code === "REQUEST_CONFLICT" || error.code === "WORKFLOW_EXISTS") return 4;
  return 1;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const json = args.includes("--json");
  try {
    const workspaceId = await resolveCurrentWorkspace();
    const board = boardForWorkspace(workspaceId);
    let status: WorkflowStatus;

    if (args[0] === "status") {
      status = getWorkflowStatus(board.id);
    } else if (args[0] === "transition") {
      const state = args[1];
      const requestId = option(args, "--request-id");
      if (!state || !requestId) throw new WorkflowError("INVALID_ARGUMENT", "transition requires <state> and --request-id <id>");
      status = transitionWorkflow(board.id, state, requestId);
    } else if (args[0] === "run" && args[1] === "start") {
      const role = args[2];
      if (!role) throw new WorkflowError("INVALID_ARGUMENT", "run start requires <role>");
      status = startRoleRun(board.id, role);
    } else if (args[0] === "run" && args[1] === "finish") {
      const role = args[2];
      const result = option(args, "--result") as RoleRunResult | undefined;
      if (!role || !result || !["passed", "failed", "blocked"].includes(result)) {
        throw new WorkflowError("INVALID_ARGUMENT", "run finish requires <role> --result <passed|failed|blocked>");
      }
      status = finishRoleRun(board.id, role, result);
    } else if (args[0] === "workflow" && args[1] === "init") {
      const file = args[2];
      if (!file) throw new WorkflowError("INVALID_ARGUMENT", "workflow init requires <file.yaml>");
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch (error) {
        throw new WorkflowError("INVALID_ARGUMENT", `cannot read workflow file '${file}': ${error instanceof Error ? error.message : error}`);
      }
      status = initializeWorkflow(board, text, file, args.includes("--force"));
    } else {
      throw new WorkflowError("INVALID_ARGUMENT", usage());
    }
    printStatus(status, json);
    return 0;
  } catch (error) {
    const known = error instanceof WorkflowError ? error : new WorkflowError("INVALID_ARGUMENT", error instanceof Error ? error.message : String(error));
    if (json) console.error(JSON.stringify({ ok: false, error: { code: known.code, message: known.message } }));
    else console.error(`herdr-workboard: ${known.code}: ${known.message}`);
    return exitCode(known);
  }
}

if (import.meta.main) process.exit(await main());
