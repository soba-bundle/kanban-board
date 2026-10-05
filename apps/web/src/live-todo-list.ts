import type { LiveHistoryEntry } from "@kanban-board/shared";

export type LiveTodo = { id: number; text: string; status: "pending" | "in_progress" | "completed" };

export function latestLiveTodos(entries: LiveHistoryEntry[]): LiveTodo[] | null {
  let latest: LiveTodo[] | null = null;
  let previousSnapshot: LiveTodo[] = [];
  let previousPromptTodos: LiveTodo[] = [];
  let awaitingNewTodos = false;
  let hiddenIds = new Set<number>();
  for (const entry of entries) {
    if (entry.role === "user") {
      previousPromptTodos = previousSnapshot;
      awaitingNewTodos = true;
    }
    if (entry.role !== "tool") continue;
    const message = entry.message;
    if (message.role !== "toolResult" || message.toolName !== "todo") continue;
    const details = message.details;
    if (typeof details !== "object" || details === null || !Array.isArray((details as { todos?: unknown }).todos)) continue;
    const todos = (details as { todos: unknown[] }).todos;
    if (!todos.every((todo) => typeof todo === "object" && todo !== null &&
      typeof (todo as LiveTodo).id === "number" && Number.isFinite((todo as LiveTodo).id) &&
      typeof (todo as LiveTodo).text === "string" &&
      ["pending", "in_progress", "completed"].includes((todo as LiveTodo).status))) continue;
    const snapshot = todos as LiveTodo[];
    if (awaitingNewTodos && snapshot.some((todo) => !previousPromptTodos.some((old) => old.id === todo.id && old.text === todo.text))) {
      hiddenIds = new Set(previousPromptTodos.filter((old) => snapshot.some((todo) => todo.id === old.id && todo.text === old.text)).map((todo) => todo.id));
      awaitingNewTodos = false;
    }
    previousSnapshot = snapshot;
    if (!awaitingNewTodos || latest === null) latest = snapshot.filter((todo) => !hiddenIds.has(todo.id));
  }
  return latest;
}
