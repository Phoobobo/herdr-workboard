// Shared types: herdr socket API objects + workboard data model.

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface WorkspaceInfo {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  tab_count: number;
  active_tab_id: string;
  agent_status: AgentStatus;
}

export interface TabInfo {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  agent_status: AgentStatus;
}

export interface PaneInfo {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  agent_status: AgentStatus;
  revision: number;
  cwd?: string;
  foreground_cwd?: string;
  label?: string;
  agent?: string;
  title?: string;
  display_agent?: string;
  custom_status?: string;
}

export interface PaneMoveResult {
  changed: boolean;
  reason?: "same_tab" | "zoomed_tab";
  previous_pane_id: string;
  previous_workspace_id: string;
  previous_tab_id: string;
  pane: PaneInfo;
  created_tab?: TabInfo;
  closed_tab_id?: string;
  closed_workspace_id?: string;
  focused_pane_id?: string;
}

// ---- workboard model ----

export interface BoardState {
  id: string;        // stable local id, e.g. "s1"
  name: string;      // mirrors the herdr tab label
  tab_id: string | null;
}

export interface Task {
  id: string;        // "t3"
  seq: number;
  title: string;
  body?: string;
  state_id: string;
  agent_cmd?: string[]; // per-task agent override (set by the picker)
  pane_id: string | null; // live session pane (public id, stable on this server)
  created_at: number;
  updated_at: number;
  archived?: boolean;
}

export interface WorkflowStage {
  name: string;
  agent: string;
  success_message: string;
  retry_message?: string;
  retry_to?: string;
  output?: unknown;
  /** Column this stage lives in; defaults to a column named like the stage. */
  state?: string;
  terminal: boolean;
  transitions: string[];
}

export type RoleRunResult = "passed" | "failed" | "blocked";

export interface RoleRun {
  id: string;
  role: string;
  started_at: number;
  ended_at?: number;
  result?: RoleRunResult;
  status: "running" | "finished";
}

/**
 * An idempotency record. `input` carries the whole request payload so replaying
 * an ID with different arguments is a detectable conflict; `op` is absent on
 * records written before runs were made idempotent (those are all transitions).
 */
export interface RequestRecord {
  request_id: string;
  input: { op?: "transition" | "run.start" | "run.finish"; state?: string; role?: string; result?: RoleRunResult };
  result: WorkflowStatus;
}

/** @deprecated use RequestRecord — kept so older imports keep compiling. */
export type TransitionRecord = RequestRecord;

export interface WorkflowTask {
  version: 1;
  board_id: string;
  workspace_id: string;
  source?: string;
  /** Kanban card this workflow drives, when bound at init. */
  task_id?: string;
  initialized_at: number;
  updated_at: number;
  current_stage: string;
  stages: WorkflowStage[];
  runs: RoleRun[];
  requests: RequestRecord[];
}

export interface WorkflowStatus {
  board_id: string;
  workspace_id: string;
  task_id?: string;
  current_stage: string;
  terminal: boolean;
  stage: WorkflowStage;
  runs: RoleRun[];
  current_runs: RoleRun[];
  updated_at: number;
}

export interface Board {
  version: 1;
  id: string;
  name: string;
  cwd: string;
  workspace_id: string;
  board_pane_id: string | null;
  agent_cmd: string[]; // argv prefix; task prompt appended as final arg
  prompt_template?: string; // {title}/{body} placeholders; default "{title}\n\n{body}"
  auto_sync?: boolean; // default true: columns follow agent session state
  states: BoardState[];
  tasks: Task[];
  next_seq: number;
}
