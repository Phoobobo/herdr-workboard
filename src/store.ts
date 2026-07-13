// Board persistence: plain JSON files under the plugin state dir.
//
//   <state-dir>/boards/<board-id>.json   one file per board
//   <state-dir>/bindings.json            workspace_id -> board_id
//
// herdr computes HERDR_PLUGIN_STATE_DIR but never creates it; panes started
// via layout.apply don't receive plugin env at all, so init passes
// WORKBOARD_STATE_DIR through and we fall back to the documented default.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Board } from "./types.ts";

export const PLUGIN_ID = "phoobobo.workboard";

export function stateDir(): string {
  const explicit = process.env.WORKBOARD_STATE_DIR || process.env.HERDR_PLUGIN_STATE_DIR;
  if (explicit && explicit.trim()) return explicit.trim();
  const xdgState = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(xdgState, "herdr", "plugins", PLUGIN_ID);
}

const boardsDir = () => path.join(stateDir(), "boards");
const bindingsPath = () => path.join(stateDir(), "bindings.json");

export function ensureDirs(): void {
  fs.mkdirSync(boardsDir(), { recursive: true });
}

function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp.${process.pid}`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

export function saveBoard(board: Board): void {
  ensureDirs();
  writeAtomic(path.join(boardsDir(), `${board.id}.json`), JSON.stringify(board, null, 2) + "\n");
}

export function loadBoard(id: string): Board | null {
  const file = path.join(boardsDir(), `${id}.json`);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err; // permissions/IO problems must surface, not spawn duplicate boards
  }
  try {
    return JSON.parse(raw) as Board;
  } catch {
    // quarantine instead of silently overwriting the user's data later
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {}
    return null;
  }
}

export function listBoards(): Board[] {
  let names: string[];
  try {
    names = fs.readdirSync(boardsDir());
  } catch {
    return [];
  }
  const boards: Board[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const b = loadBoard(name.slice(0, -5));
    if (b) boards.push(b);
  }
  return boards;
}

export function loadBindings(): Record<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(bindingsPath(), "utf8");
  } catch (err) {
    if (isEnoent(err)) return {};
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {}; // bindings are recoverable from each board's workspace_id
  }
}

export function bindWorkspace(workspaceId: string, boardId: string): void {
  ensureDirs();
  const bindings = loadBindings();
  bindings[workspaceId] = boardId;
  writeAtomic(bindingsPath(), JSON.stringify(bindings, null, 2) + "\n");
}

/** Board bound to a workspace, by binding first, then by recorded workspace id. */
export function resolveBoardForWorkspace(workspaceId: string): Board | null {
  if (!workspaceId) return null;
  const bound = loadBindings()[workspaceId];
  if (bound) {
    const b = loadBoard(bound);
    if (b) return b;
  }
  for (const b of listBoards()) {
    if (b.workspace_id === workspaceId) return b;
  }
  return null;
}

export function findBoardByCwd(cwd: string): Board | null {
  for (const b of listBoards()) {
    if (b.cwd === cwd) return b;
  }
  return null;
}
