# Herdr Kanban

A small Herdr plugin that starts a private, local web dashboard for task tracking. Tasks are stored as JSON in the plugin state directory.

## Run

From this directory, run `npm install`, then start with `npm start` and open the URL printed in the terminal (default: `http://127.0.0.1:4173`). To register the plugin with Herdr, use:

```sh
herdr plugin link .
herdr plugin action invoke open-dashboard --plugin herdr.kanban
```

Files can also be added while editing a task. Use the file picker or drop files anywhere in the task details window; new files are saved with the task and their paths are sent to an already running agent.

The dashboard supports creating and deleting tasks, setting priority and agent options, attaching files, and dragging tasks across Backlog, To do, In Progress, Review, and Done. Attachments of any file type are saved with the task (up to 30 MiB total) and their names and local paths are included in the agent prompt. Agent kinds come from Herdr CLI introspection; visible model names and each model’s supported reasoning levels come from Codex model introspection. The dashboard uses built-in fallback choices if introspection is unavailable. Select an agent, model, and effort when creating a task; click a card to edit those settings along with its title, description, and priority. Agent settings are locked while that task’s agent is working. Enable browser notifications to get the task title and new status when a task changes columns while the dashboard is open. When Codex is selected, the “Run task in worktree” checkbox is shown and checked by default. It uses Codex CLI’s native managed worktree option; clear it to run in the active workspace. The root `HERDR.md` is injected into every agent prompt. It instructs agents working in a task worktree to commit all task changes with a descriptive message. Cards report whether the task branch is safe to merge into `main`; a clean worktree and a successful Git merge check are required. Moving a worktree task to Done merges its branch into `main`. If the merge fails, the task returns to Review and the card shows Git’s output. Creating a task in To do (or moving one there) opens a focused tab in the active Herdr workspace, starts the selected interactive agent, and submits the task title, description, and attachment paths as its prompt. Model and effort are passed to Codex sessions. Started tasks move to In Progress; when the agent finishes, the task moves to Review. If its agent starts working again, it returns to In Progress. Cards show a green running dot or a gray inactive dot. Task details include an xterm.js terminal connected to the task’s Herdr pane, with keyboard input and refreshed ANSI pane snapshots, plus a button to focus its Herdr tab. Output refreshes about once per second; Herdr exposes snapshots rather than a raw PTY stream, so terminal resize is local to the display. This needs an active Herdr workspace and a supported agent setup. Set `PORT` to change the dashboard port. For local development outside Herdr, tasks are stored in `.herdr-kanban/`; Herdr supplies `HERDR_PLUGIN_STATE_DIR` when it launches the plugin.
