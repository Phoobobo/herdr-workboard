// Coding-agent registry: which agent CLIs we know how to launch, how each
// takes an initial prompt, and which herdr detection manifest tracks it.
// Detection is PATH-probing only — nothing is configured until the user picks.

export interface AgentDef {
  id: string; // short display id
  bin: string; // binary probed on PATH
  manifest: string; // herdr agent-detection manifest id (for trackability)
  promptFlag?: string; // flag inserted before the prompt argv (default: positional)
}

export const KNOWN_AGENTS: AgentDef[] = [
  { id: "claude", bin: "claude", manifest: "claude" },
  { id: "codex", bin: "codex", manifest: "codex" },
  { id: "hermes", bin: "hermes", manifest: "hermes", promptFlag: "-z" },
  { id: "opencode", bin: "opencode", manifest: "opencode" },
  { id: "copilot", bin: "copilot", manifest: "copilot", promptFlag: "-p" },
  { id: "gemini", bin: "gemini", manifest: "gemini" },
  { id: "cursor", bin: "cursor-agent", manifest: "cursor" },
  { id: "droid", bin: "droid", manifest: "droid" },
  { id: "kimi", bin: "kimi", manifest: "kimi" },
  { id: "kilo", bin: "kilo", manifest: "kilo" },
  { id: "qoder", bin: "qoder", manifest: "qodercli" },
  { id: "pi", bin: "pi", manifest: "pi" },
  { id: "omp", bin: "omp", manifest: "omp" },
];

export interface DetectedAgent extends AgentDef {
  path: string;
  cmd: string[]; // argv prefix; the task prompt is appended as the last arg
}

export function agentCmd(def: AgentDef): string[] {
  return def.promptFlag ? [def.bin, def.promptFlag] : [def.bin];
}

/** Agents whose binary exists on PATH, in registry order. */
export function detectAgents(): DetectedAgent[] {
  const found: DetectedAgent[] = [];
  for (const def of KNOWN_AGENTS) {
    const p = Bun.which(def.bin);
    if (p) found.push({ ...def, path: p, cmd: agentCmd(def) });
  }
  return found;
}

/** Manifest id to check trackability for an argv, best effort. */
export function manifestIdFor(argv: string[]): string {
  const bin = (argv[0] ?? "").split("/").pop() ?? "";
  return KNOWN_AGENTS.find((a) => a.bin === bin)?.manifest ?? bin;
}

/** Short human name for an agent argv. */
export function agentLabel(argv: string[]): string {
  const bin = (argv[0] ?? "?").split("/").pop() ?? "?";
  return KNOWN_AGENTS.find((a) => a.bin === bin)?.id ?? bin;
}
