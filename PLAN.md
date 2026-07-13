# herdr-workboard — project plan

## Where the project is (v0.1)

Shipped and verified live: board = workspace, state = tab, session = pane;
kanban TUI in the first tab; sessions claim idle shells; auto-sync moves cards
with the agent state machine (transition-driven, forward-only healing).

Known architectural limit: **the TUI pane is also the orchestrator.** The
event subscription, reconcile loop, auto-sync moves, and session spawning all
live inside `src/board.ts`. That means:

- Sync only happens while a board pane is running. Close the board (or restart
  the herdr server) and agent transitions are missed; the next startup can only
  heal forward, not replay what happened.
- A pinned board plus an overlay board are two orchestrators on the same
  JSON file. Transition-driven moves and immediate saves make collisions rare,
  but last-writer-wins on the board file is real: two processes can drop each
  other's writes.
- Orchestration is welded to a render loop, so it can't grow features that
  make sense without a UI (auto-dispatch, notifications, schedules).

## Next: a board-guardian session owns the orchestration

**Idea (from the user):** move orchestration out of the view and into a
dedicated *guardian* session per board — the same shape as the Hermes kanban
dispatcher, but herdr-native.

### Responsibilities

The guardian is a headless loop that owns everything that mutates the board:

1. **Single writer** of the board JSON. TUI instances (pinned + overlays)
   become readers that submit *intents* (create task, move card, start
   session, archive) instead of writing the file themselves.
2. **Event subscription + auto-sync** — the logic that exists in `board.ts`
   today (`trackStatusTransitions`, `maybeAutoAdvance`, reconcile) moves here
   and keeps running with no board pane open.
3. **Dispatcher (new capability)** — optional per board: auto-start agent
   sessions for the top of `todo` up to a WIP limit (`max_running`), restart
   crashed sessions with a retry cap, park/schedule tasks. This is the Hermes
   `dispatch` loop expressed in herdr primitives.
4. **Notifications (new capability)** — `notification.show` on `done`/
   `blocked` transitions so the user hears about finished agents even with the
   board tab in the background.

### Where the guardian lives — options

| Option | Lifecycle | Verdict |
| --- | --- | --- |
| A. Detached background process (spawned by init/open, pidfile in state dir) | Survives pane/workspace closes; must self-manage herdr restarts, orphan risk | no — invisible processes fight herdr's model |
| B. **Pane in the board workspace** (e.g. a slim pane in the board tab or a `guard` tab) | herdr-native: visible, dies with the workspace, restartable by `open`, inherits socket env | **recommended** — the workspace *is* the board's lifetime, so the guardian scoping is exactly right; its pane doubles as a live orchestration log |
| C. Leader election inside existing TUI processes (lock file; overlays become followers) | No new process | good *incremental* step; still dies with the last board pane |

Plan: **C first** (small, fixes double-orchestration now), then **B** as the
real guardian once intents land.

### Sketch

- `src/guardian.ts` — headless loop: event subscription, reconcile, auto-sync,
  dispatcher, notifications; writes an orchestration log to stdout (its pane).
- Intents: `<state-dir>/boards/<id>.intents.jsonl` append-only; TUI appends,
  guardian consumes and applies, then rewrites the board JSON (single writer).
  The TUI keeps rendering from the board JSON + live herdr state, so a dead
  guardian degrades to today's behavior (read-only view + direct writes behind
  a lock).
- Leadership: `flock`-style lock file in the state dir; the guardian holds it,
  TUIs check it to decide reader vs. legacy-writer mode.
- Manifest: a third `[[panes]]` entrypoint `guard` (placement `split`), spawned
  by `init` into the board tab (small ratio) or a dedicated last tab.
- Board doc additions: `max_running`, `dispatch: on|off`, `notify: on|off`.

### Open questions

- Dispatcher prompt contract: what does an auto-started agent get beyond
  title+body? (Probably: task body + board cwd + "comment via
  `workboard comment`" once a CLI exists.)
- Should `done`-column cards auto-archive after N days?
- Multi-machine/state-dir sync is out of scope.

## Milestones

- **v0.1 — shipped**: TUI, sessions, idle-pane reuse, auto-sync. Publish to
  GitHub with the `herdr-plugin` topic (installable via
  `herdr plugin install Phoobobo/herdr-workboard`).
- **v0.2 — single-writer discipline**: lock file + leader election among board
  panes; intents file; TUIs stop racing on the JSON.
- **v0.3 — guardian pane**: `src/guardian.ts` + `guard` entrypoint owning
  sync/dispatch/notifications; TUI becomes a pure view/controller.
- **v0.4 — dispatcher features**: WIP limits, retry caps, scheduled tasks,
  done-column auto-archive.
