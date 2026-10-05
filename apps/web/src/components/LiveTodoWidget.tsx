import { Collapsible } from "@astryxdesign/core/Collapsible";
import { List, ListItem } from "@astryxdesign/core/List";
import { ScrollableArea } from "@astryxdesign/core/ScrollableArea";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import type { LiveHistoryEntry } from "@kanban-board/shared";
import { latestLiveTodos } from "../live-todo-list.js";

export function LiveTodoWidget({ entries }: { entries: LiveHistoryEntry[] }) {
  const todos = latestLiveTodos(entries);
  if (!todos?.length) return null;

  const completed = todos.filter((todo) => todo.status === "completed").length;
  return (
    <section className="live-todo-widget" aria-label="Agent todo list">
      <Collapsible key={`${todos[0].id}:${todos[0].text}:${completed === todos.length}`} defaultIsOpen={completed !== todos.length}
        trigger={<Text type="supporting">{completed === todos.length ? "✓ Todos complete" : "Todos"} · {completed}/{todos.length}</Text>}>
      <ScrollableArea
        axis="block"
        label="Todo list"
        className="live-todo-scroll"
      >
        <List density="compact" className="live-todo-list">
          {todos.map((todo) => <ListItem
            key={todo.id}
            label={<Text type="supporting" maxLines={1} hasTruncateTooltip={false}>{`#${todo.id} ${todo.text}`}</Text>}
            startContent={<StatusDot
              variant={todo.status === "in_progress" ? "accent" : todo.status === "completed" ? "success" : "neutral"}
              label={todo.status === "in_progress" ? "In progress" : todo.status === "completed" ? "Completed" : "Waiting"}
              isPulsing={todo.status === "in_progress"}
            />}
            className="live-todo-item"
          />)}
        </List>
      </ScrollableArea>
      </Collapsible>
    </section>
  );
}
