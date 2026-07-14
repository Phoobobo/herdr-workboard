# herdr-workboard

A kanban workboard TUI that lives **inside** [herdr](https://herdr.dev), built as a herdr plugin.

The board is not a separate app that mirrors your terminal — it **is** your terminal session, arranged:

| Kanban concept | herdr concept |
| -------------- | ------------- |
| Board          | Workspace     |
| Column (task state) | Tab      |
| Task session   | Pane          |
| The board view itself | First tab of the workspace |

Moving a card between columns physically moves its live session pane between
tabs (`pane.move`). Dragging a pane between state tabs in herdr moves the card
on the board. An agent going `working → blocked → done` in a session pane shows
up live as the card's status badge.

## Requirements

- herdr ≥ 0.7.1 with a running server
- [bun](https://bun.sh) on the PATH herdr was started with
- macOS or Linux

## Install

```bash
herdr plugin install Phoobobo/herdr-workboard
```

Or, for local development:

```bash
herdr plugin link /path/to/herdr-workboard
```

## Usage

Create a board for the current project (a new workspace: `board` tab first,
then one tab per state):

```bash
herdr plugin action invoke phoobobo.workboard.init
```

The action takes its project directory from the **active** workspace. Re-invoking
it focuses the existing board; if the board workspace was closed (or the herdr
server restarted), it rebuilds the workspace with all tasks preserved.

Re-focus or repair the board later (e.g. after a server restart left the board
pane as a plain shell):

```bash
herdr plugin action invoke phoobobo.workboard.open
```

Peek at the board from anywhere inside a board workspace as a temporary
overlay (`q` returns you exactly where you were):

```bash
herdr plugin pane open --plugin phoobobo.workboard --entrypoint board
```

Bind a key in your herdr config:

```toml
[[keys.command]]
key = "prefix+shift+b"
type = "plugin_action"
command = "phoobobo.workboard.open"
description = "open workboard"
```

## Keys

| Key | Action |
| --- | ------ |
| `←/→` `h/l` | select column |
| `↑/↓` `j/k` | select card |
| `n` | new task in selected column |
| `Enter` | jump to the task's session pane |
| `s` | start an **agent** session with the board's agent |
| `o` | start a session with a **chosen** agent (per-task pick) |
| `S` | start a plain **shell** session |
| `[` / `]` (or `H`/`L`) | move card left / right — moves its pane between tabs |
| `J` / `K` | reorder card within its column |
| `e` | edit task title |
| `E` | edit task **body** in `$EDITOR` (flows into the agent prompt) |
| `a` | choose the board's agent (`d` in the picker: also make it your default) |
| `P` | edit the board's prompt template (`{title}` / `{body}`) |
| `A` | toggle auto-sync (columns follow agent state) |
| `R` | rename board (and its workspace) |
| `x` | archive card (asks whether to close its session pane) |
| `r` | refresh + recreate missing state tabs |
| `?` | help |
| `q` | quit board view |

Mouse: click to select, double-click to jump to the session, drag a card to
another column to move it (pane moves too), wheel to scroll a column.

## Task states

Default columns are `todo · doing · review · done`. Each column is a real tab
in the board workspace. Renaming a state tab in herdr renames the column;
closing one is fine — it is recreated on demand. Cards follow their panes:
however a session pane ends up in another state tab (drag, `pane.move`,
scripts), the board adopts that as the task's new state.

## Sessions

`s` runs the board's agent command (default `claude`) with the task text as
the initial prompt, inside the tab of the task's current state. `S` starts a
bare shell session instead. If the tab already contains an **idle shell pane**
(each state tab starts with one), the session claims that pane instead of
splitting a new one — the agent is exec'd right into it; only when every pane
in the tab is busy or claimed does a new split appear. The session pane is
labeled `#<n> <title>` and its detected agent status
(`idle / working / blocked / done`) is shown live on the card. Archiving a
card offers to close its pane; closing the pane by hand simply clears the
card's session.

## Choosing agents

The board probes your PATH for agent CLIs it knows how to launch (claude,
codex, hermes, opencode, copilot, cursor-agent, droid, kimi, kilo, qoder,
gemini, pi, omp) — no configuration needed. Three levels:

- **your default** — in the `a` picker, press `d` on an agent to make it the
  default for every *new* board (stored in the plugin state dir's
  `config.json`)
- **board agent** — `a` picks per board; `s` always starts this one
- **per task** — `o` picks an agent for just that card and starts the session;
  the choice sticks to the card for restarts

Each entry shows the exact launch argv (e.g. `hermes -z <task>`); pick
`custom…` to hand-edit the argv for anything unlisted. If you pick an agent
herdr has no detection manifest for, the board warns you: its status will stay
`unknown`, so status badges and auto-sync can't follow it.

## Task bodies and the prompt

`E` opens the task body in `$VISUAL`/`$EDITOR` (falls back to `vi`) — the TUI
hands over the terminal and takes it back on exit; cards with a body show a
`≡` marker. The session prompt is built from the board's template (`P` to
edit, same editor flow):

```
{title}

{body}

Work autonomously. If you need a human decision, say BLOCKED and why.
```

The default template is just `{title}\n\n{body}`; house rules like the last
line above are how you teach agents to produce clean `done`/`blocked` signals
for auto-sync and notifications. Use a terminal editor — GUI editors that
return before the file is saved won't work.

## Auto-sync: columns follow the agent

With auto-sync on (the default — toggle per board with `A`), the columns track
the agent session's state machine:

- **starting an agent session** moves the card to the working column
  (`doing`) so the pane spawns in the right tab from the start
- agent turns **`working`** → card moves to `doing` — including *rework*:
  reopening an agent on a reviewed card pulls it back
- agent turns **`done`** → card advances to `review` (or `done` when no
  review-like column exists); it never moves backward on `done`
- agent turns **`blocked`** → moves only if the board has a blocked-like
  column; otherwise it's just the red badge
- a claude launched by hand inside a plain shell session is picked up by
  herdr's agent detection and drives the same moves

Moves fire on state *transitions*, so a card you place by hand stays put until
the agent actually changes state; if your focused pane is the one moving, focus
follows it. On startup the board heals forward-only (a finished agent stuck in
`doing` advances; nothing gets yanked backward). Column targets are matched by
name (`doing`/`wip`/`running`…, `review`/`verify`…, `block`/`wait`…) with
positional fallbacks. When a move would empty a state tab, the board seeds a
fresh idle shell first so the tab keeps its position (and the next session has
a pane to claim).

## Unicode & emoji

Task titles, column names, and board names can freely mix CJK text and emoji —
`✅ 部署完成`, `🚀 ship v2` render and truncate at the correct display width.
Width measurement uses `Bun.stringWidth` (Unicode-aware, covers ✅-style
symbols outside the classic emoji block); a range-based fallback keeps CJK and
common emoji aligned if that API is ever unavailable. Wide characters are
tracked per cell, so a card border never lands on the second half of a glyph.

## Storage

Boards are plain JSON under herdr's plugin state dir
(`~/.local/state/herdr/plugins/phoobobo.workboard/`). No daemon, no database:
the TUI reads herdr's live state over the socket API, subscribes to lifecycle
events, and reconciles on every change.

## Known limitations

- After a herdr **server restart**, panes respawn as plain shells (herdr does
  not re-execute pane commands). Run the `open` action once: it relaunches the
  TUI in the leftover board pane. Session panes come back as shells too — the
  cards keep their column, and official herdr agent integrations can restore
  agent sessions natively.
- herdr has no tab-reorder API, so a board tab recreated by `open` lands at the
  **end** of the tab strip. Re-run `init` after closing the board workspace to
  get the board back as tab 1.
- One board per workspace, one workspace per board.
- Multi-codepoint ZWJ emoji (e.g. `🧑‍💻`) are measured per codepoint, so a
  title containing one truncates ~2 cells early. Single-codepoint emoji
  (✅ 🚀 ⚠️ …) are exact.

## Development

```
herdr-plugin.toml   plugin manifest (actions, pane entrypoint)
src/herdr.ts        socket client (one request per connection + event stream)
src/store.ts        board persistence (atomic JSON writes)
src/boardctl.ts     kanban verbs -> herdr socket calls
src/ui.ts           cell-buffer renderer (CJK-safe) + key/mouse parser
src/board.ts        the kanban TUI
src/actions.ts      init / open plugin actions
```

Zero runtime dependencies; TypeScript runs directly under bun.
`bunx tsc --noEmit` typechecks (dev-only `@types/bun`).
