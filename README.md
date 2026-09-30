# Local Agent Kanban

A local-first Kanban board for organizing development tasks and running Pi Coding Agent sessions against local Git repositories. Manage work across projects, follow agent activity, and review structured handovers from one web interface.

## Project structure

- `apps/web` — React and TypeScript web application
- `apps/server` — Node.js, TypeScript, and Fastify API and agent orchestration
- `packages/shared` — shared TypeScript contracts and validation

The server uses SQLite for application data; Git remains the source of truth for repository state.

## Requirements

- Node.js and npm
- A local Git repository configured as a project in the application
- Pi Coding Agent for agent workflows

## Getting started

Install dependencies from the repository root:

```sh
npm install
```

Run the web app and server in separate terminals:

```sh
npm run dev:server
npm run dev:web
```

The web app is served by Vite. The server command builds the shared package and server before starting the API. Configure projects and their repository roots through the application.

## Development commands

```sh
npm run build       # Build all workspaces
npm run typecheck   # Type-check all workspaces
npm test            # Build and run workspace tests
```

Optional integration smoke tests are available with `npm run smoke:pi` and `npm run smoke:windows-process-tree`.

See [the product requirements](local-agent-kanban-prd-v2.md) and [implementation plan](local-agent-kanban-implementation-plan-v2.md) for additional project context.
