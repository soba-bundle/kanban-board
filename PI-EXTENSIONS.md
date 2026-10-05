# Project-local Pi extensions

Kanban starts Pi sessions through the Pi SDK in the server; do not start a separate Pi CLI process to make Kanban load extensions. The server uses each task's project/worktree directory as Pi's `cwd`.

## How extension loading is scoped

The Kanban server uses `<Kanban repository>/.pi/agent` for Pi settings and model/auth configuration. It does not use Pi's global agent directory, and it does not read a task project's `.pi/settings.json`. Its resource loader disables automatic extension loading and explicitly loads only the package rooted at `<Kanban repository>/.pi/extensions`. Both paths are resolved from the server package itself, not from the task's `cwd`, which may point at another project or worktree. The checked-in `.pi/extensions/package.json` is an allowlist: only entries in its `pi.extensions` array are loaded. Global extensions, extensions configured in task-project settings/packages, and task-project or CLI extension paths are not loaded into Kanban sessions.

Extensions execute with the server process's permissions. Review every extension before adding it; a project-local path is a source boundary, not a sandbox.

## Kanban-owned Pi configuration

- `.pi/agent/settings.json` is the copied Kanban-owned settings file. Its default model is `ollama/kanban-omnicoder-9b-8k:latest`.
- `.pi/agent/models.json` defines that local Ollama model at `http://localhost:11434/v1`. The `apiKey` value `ollama` is a placeholder required by Pi's OpenAI-compatible model configuration; Ollama ignores it.
- No global credentials are copied. Future Pi logins use `.pi/agent/auth.json`, which is gitignored. `.pi/agent/models-store.json` and `.pi/agent/npm/` are generated caches and are also gitignored.
- Attached-project `.pi/settings.json` files are ignored for Kanban sessions so they cannot override the repo-owned settings.

The Ollama endpoint must be reachable from the Kanban server process. `localhost` works when Ollama and the server share the same host/network namespace; containers or remote servers need a reachable host address instead.

## Add an extension

1. Put the entry point under the Kanban repository's `.pi/extensions/<extension-name>/index.ts`.
2. Add that exact entry-point path to `.pi/extensions/package.json` under `pi.extensions`.
3. Keep required runtime dependencies available from the Kanban repository's installed dependencies.
4. Build and test the server. Deploy/ship the Kanban repo's `.pi/extensions` directory with the server. Task-project worktrees do not need copies of these extensions.

The current port is `.pi/extensions/pi-todo-list/index.ts`. Its tool result `details.todos` snapshots are persisted in Pi session history. Its original `setWidget(..., { placement: "aboveEditor" })` is TUI-only; Kanban's SDK session is not a terminal UI, so the web Live panel renders the persisted snapshots separately.

## Start Kanban

Run commands from the Kanban repository root, with dependencies installed. This matters because the server resolves its extension allowlist relative to its own source/package location:

```sh
npm run dev:server
```

This builds the shared package and server, then starts the server with the project-local extension loader. In a second terminal at the same repository root, start the web UI:

```sh
npm run dev:web
```

For a production-style server start, build first and then run:

```sh
npm run build --workspace @kanban-board/shared
npm run build --workspace @kanban-board/server
npm --workspace @kanban-board/server start
```

Restart the server after changing an extension or its allowlist entry so newly created Pi sessions load the updated resources. Existing restored sessions also initialize the current extension set when the server opens them. The production server must retain the same relative repository layout, including `.pi/extensions`, beside its `apps/server` package.
