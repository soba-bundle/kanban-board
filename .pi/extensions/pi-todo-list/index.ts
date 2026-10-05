/**
 * Todo Extension - Demonstrates state management via session entries
 *
 * This extension:
 * - Registers a `todo` tool for the LLM to manage todos
 * - Shows a persistent, live-updating todo panel above the editor whenever
 *   the list is non-empty (no command needed to view it)
 *
 * State is stored in tool result details (not external files), which allows
 * proper branching - when you branch, the todo state is automatically
 * correct for that point in history.
 *
 * The agent is instructed (via promptSnippet/promptGuidelines) to use this
 * tool for every non-trivial task: break the task into todo items, work
 * through them one at a time (in_progress -> completed), and review the
 * list before ending its turn.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
	WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// Same pastel palette as the working-indicator.ts reference example, so the
// in_progress/completed indicators visually match pi's other custom indicators.
const PASTEL_RAINBOW = [
	"\x1b[38;2;255;179;186m",
	"\x1b[38;2;255;223;186m",
	"\x1b[38;2;255;255;186m",
	"\x1b[38;2;186;255;201m",
	"\x1b[38;2;186;225;255m",
	"\x1b[38;2;218;186;255m",
];
const RESET_FG = "\x1b[39m";

function colorize(text: string, color: string): string {
	return `${color}${text}${RESET_FG}`;
}

const PULSE_INDICATOR: WorkingIndicatorOptions = {
	frames: [
		colorize("·", PASTEL_RAINBOW[0]!),
		colorize("•", PASTEL_RAINBOW[2]!),
		colorize("●", PASTEL_RAINBOW[4]!),
		colorize("•", PASTEL_RAINBOW[5]!),
	],
	intervalMs: 120,
};

const DOT_INDICATOR: WorkingIndicatorOptions = {
	frames: [colorize("●", PASTEL_RAINBOW[0]!)],
};

type TodoStatus = "pending" | "in_progress" | "completed";

interface Todo {
	id: number;
	text: string;
	status: TodoStatus;
}

interface TodoDetails {
	action: "list" | "add" | "insert" | "edit" | "setStatus" | "remove" | "clear";
	todos: Todo[];
	nextId: number;
	error?: string;
	/** id of the item this action created/modified (add, insert, edit, setStatus, remove) */
	changedId?: number;
}

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "insert", "edit", "setStatus", "remove", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for add, insert, edit)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for edit, setStatus, remove)" })),
	status: Type.Optional(
		StringEnum(["pending", "in_progress", "completed"] as const, {
			description: "New status (for setStatus)",
		}),
	),
	position: Type.Optional(
		Type.Number({ description: "0-based index to insert before (for insert). Omit to append." }),
	),
});

function statusIcon(theme: Theme, status: TodoStatus): string {
	if (status === "completed") return theme.fg("success", "✓");
	if (status === "in_progress") return theme.fg("accent", "▶");
	return theme.fg("dim", "○");
}

// Animated per-row icon for the live todo panel: pulses while in_progress,
// settles to the static working-indicator dot once completed. Only meaningful
// in a component that ticks its own render loop (see createTodoWidget below) —
// the static tool-call/result log rendering keeps using statusIcon() as-is.
function animatedStatusIcon(status: TodoStatus, frame: number): string {
	if (status === "completed") return DOT_INDICATOR.frames[0]!;
	if (status === "in_progress") return PULSE_INDICATOR.frames[frame % PULSE_INDICATOR.frames.length]!;
	return "\x1b[2m\u25cb\x1b[22m";
}

// (the old modal /todos component has been replaced by the persistent
// todo-panel widget created inside the default export below)

export default function (pi: ExtensionAPI) {
	// In-memory state (reconstructed from session on load)
	let todos: Todo[] = [];
	let nextId = 1;

	// Keep ids aligned with list position so the displayed numbering stays 1..n
	// after structural changes (insert/remove). Without this, an item inserted in
	// the middle keeps a high creation-order id and the list looks jumbled.
	function renumber(): void {
		todos.forEach((t, i) => {
			t.id = i + 1;
		});
		nextId = todos.length + 1;
	}

	// Persistent todo widget (shown above the editor whenever todos is non-empty).
	// widgetTui/widgetInvalidate track the currently-installed instance so tool
	// calls can force an immediate re-render after mutating state.
	let widgetTui: TUI | undefined;
	let widgetInvalidate: (() => void) | undefined;

	function createTodoWidget(tui: TUI, theme: Theme) {
		let frame = 0;
		let animationTimer: ReturnType<typeof setInterval> | undefined;
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;

		function invalidate(): void {
			cachedWidth = undefined;
			cachedLines = undefined;
		}

		function startAnimation(): void {
			if (animationTimer) return;
			animationTimer = setInterval(() => {
				frame++;
				invalidate();
				tui.requestRender();
			}, PULSE_INDICATOR.intervalMs ?? 120);
		}

		function stopAnimation(): void {
			if (animationTimer) {
				clearInterval(animationTimer);
				animationTimer = undefined;
			}
		}

		widgetTui = tui;
		widgetInvalidate = invalidate;

		return {
			render(width: number): string[] {
				if (todos.some((t) => t.status === "in_progress")) startAnimation();
				else stopAnimation();

				if (cachedLines && cachedWidth === width) return cachedLines;

				const lines: string[] = [];
				const done = todos.filter((t) => t.status === "completed").length;
				const total = todos.length;
				const header = `${theme.fg("accent", "Todos")} ${theme.fg("muted", `${done}/${total}`)}`;
				lines.push(truncateToWidth(header, width));
				for (const todo of todos) {
					const icon = animatedStatusIcon(todo.status, frame);
					const id = theme.fg("dim", `#${todo.id}`);
					const text = todo.status === "completed" ? theme.fg("dim", todo.text) : theme.fg("text", todo.text);
					lines.push(truncateToWidth(`  ${icon} ${id} ${text}`, width));
				}

				cachedWidth = width;
				cachedLines = lines;
				return lines;
			},
			invalidate,
			dispose(): void {
				stopAnimation();
				if (widgetInvalidate === invalidate) {
					widgetTui = undefined;
					widgetInvalidate = undefined;
				}
			},
		};
	}

	// Show/hide/refresh the persistent widget to reflect current state. Called
	// after every mutating tool action and after session load/branch switches.
	function syncWidget(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		if (todos.length === 0) {
			if (widgetTui) {
				ctx.ui.setWidget("todo-list", undefined);
				// Null the globals now instead of waiting for the widget's async
				// dispose(). Otherwise a later repopulate sees a stale widgetTui,
				// takes the else-branch below, and invalidates a torn-down instance
				// instead of mounting a fresh one — leaving the pulse stuck on the
				// old row instead of the newly active item.
				widgetTui = undefined;
				widgetInvalidate = undefined;
			}
			return;
		}
		if (!widgetTui) {
			ctx.ui.setWidget("todo-list", (tui, theme) => createTodoWidget(tui, theme), { placement: "aboveEditor" });
		} else {
			widgetInvalidate?.();
			widgetTui.requestRender();
		}
	}

	/**
	 * Reconstruct state from session entries.
	 * Scans tool results for this tool and applies them in order.
	 */
	const reconstructState = (ctx: ExtensionContext) => {
		todos = [];
		nextId = 1;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

			const details = msg.details as TodoDetails | undefined;
			if (details && Array.isArray(details.todos)) {
				todos = details.todos.filter(
					(todo): todo is Todo =>
						todo !== null &&
						typeof todo === "object" &&
						typeof todo.id === "number" &&
						typeof todo.text === "string" &&
						(todo.status === "pending" || todo.status === "in_progress" || todo.status === "completed"),
				);
				nextId = typeof details.nextId === "number" ? details.nextId : todos.length + 1;
			}
		}
		syncWidget(ctx);
	};

	// Reconstruct state on session events
	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	// Register the todo tool for the LLM
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: "Manage a todo list. Actions: list, add (text), setStatus (id, status), clear",
		promptSnippet: "Track multi-step work with the todo tool: add items, mark one in_progress while working on it, then completed.",
		promptGuidelines: [
			"Use the todo tool for any task with more than one step: break it into items with action=add before starting. Skip it only for trivial single-step requests.",
			"Work items in list order: set exactly one item to in_progress before starting it, and mark it completed the moment it's done (never batch completions at the end).",
			"The tool blocks starting an item while an earlier one is incomplete. To change the plan use action=edit, action=remove, or action=insert (with position) instead of skipping ahead.",
			"Before ending your turn, call action=list and keep working until every item is completed, or you are blocked and must ask the user.",
		],
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "list":
					return {
						content: [
							{
								type: "text",
								text: todos.length
									? todos.map((t) => `[${t.status}] #${t.id}: ${t.text}`).join("\n")
									: "No todos",
							},
						],
						details: { action: "list", todos: [...todos], nextId } as TodoDetails,
					};

				case "add": {
					if (!params.text) {
						return {
							content: [{ type: "text", text: "Error: text required for add" }],
							details: { action: "add", todos: [...todos], nextId, error: "text required" } as TodoDetails,
						};
					}
					const newTodo: Todo = { id: nextId++, text: params.text, status: "pending" };
					todos.push(newTodo);
					syncWidget(ctx);
					return {
						content: [{ type: "text", text: `Added todo #${newTodo.id}: ${newTodo.text}` }],
						details: { action: "add", todos: [...todos], nextId, changedId: newTodo.id } as TodoDetails,
					};
				}

				case "insert": {
					if (!params.text) {
						return {
							content: [{ type: "text", text: "Error: text required for insert" }],
							details: { action: "insert", todos: [...todos], nextId, error: "text required" } as TodoDetails,
						};
					}
					const newTodo: Todo = { id: nextId, text: params.text, status: "pending" };
					const index =
						params.position === undefined ? todos.length : Math.max(0, Math.min(params.position, todos.length));
					todos.splice(index, 0, newTodo);
					renumber();
					syncWidget(ctx);
					return {
						content: [{ type: "text", text: `Inserted todo #${newTodo.id} at position ${index}: ${newTodo.text}` }],
						details: { action: "insert", todos: [...todos], nextId, changedId: newTodo.id } as TodoDetails,
					};
				}

				case "edit": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id required for edit" }],
							details: { action: "edit", todos: [...todos], nextId, error: "id required" } as TodoDetails,
						};
					}
					if (!params.text) {
						return {
							content: [{ type: "text", text: "Error: text required for edit" }],
							details: { action: "edit", todos: [...todos], nextId, error: "text required" } as TodoDetails,
						};
					}
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) {
						return {
							content: [{ type: "text", text: `Todo #${params.id} not found` }],
							details: { action: "edit", todos: [...todos], nextId, error: `#${params.id} not found` } as TodoDetails,
						};
					}
					todo.text = params.text;
					syncWidget(ctx);
					return {
						content: [{ type: "text", text: `Todo #${todo.id} updated: ${todo.text}` }],
						details: { action: "edit", todos: [...todos], nextId, changedId: todo.id } as TodoDetails,
					};
				}

				case "remove": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id required for remove" }],
							details: { action: "remove", todos: [...todos], nextId, error: "id required" } as TodoDetails,
						};
					}
					const index = todos.findIndex((t) => t.id === params.id);
					if (index === -1) {
						return {
							content: [{ type: "text", text: `Todo #${params.id} not found` }],
							details: { action: "remove", todos: [...todos], nextId, error: `#${params.id} not found` } as TodoDetails,
						};
					}
					const [removed] = todos.splice(index, 1);
					renumber();
					syncWidget(ctx);
					return {
						content: [{ type: "text", text: `Removed todo #${removed.id}: ${removed.text}` }],
						details: { action: "remove", todos: [...todos], nextId, changedId: removed.id } as TodoDetails,
					};
				}

				case "setStatus": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id required for setStatus" }],
							details: { action: "setStatus", todos: [...todos], nextId, error: "id required" } as TodoDetails,
						};
					}
					if (!params.status) {
						return {
							content: [{ type: "text", text: "Error: status required for setStatus" }],
							details: { action: "setStatus", todos: [...todos], nextId, error: "status required" } as TodoDetails,
						};
					}
					const todoIndex = todos.findIndex((t) => t.id === params.id);
					if (todoIndex === -1) {
						return {
							content: [{ type: "text", text: `Todo #${params.id} not found` }],
							details: {
								action: "setStatus",
								todos: [...todos],
								nextId,
								error: `#${params.id} not found`,
							} as TodoDetails,
						};
					}
					const todo = todos[todoIndex];
					// Enforce strict sequential order: an item can only start once every
					// earlier item is completed. This forces the agent to either finish,
					// remove, or reorder earlier items instead of skipping ahead.
					if (params.status === "in_progress") {
						const blockers = todos.slice(0, todoIndex).filter((t) => t.status !== "completed");
						if (blockers.length > 0) {
							const blockerList = blockers.map((b) => `#${b.id} (${b.status}): ${b.text}`).join("; ");
							return {
								content: [
									{
										type: "text",
										text: `Error: cannot start #${todo.id} — earlier item(s) not completed: ${blockerList}. Complete them, or use action=edit/insert/remove to update the plan, then try again.`,
									},
								],
								details: {
									action: "setStatus",
									todos: [...todos],
									nextId,
									error: `#${todo.id} blocked by earlier incomplete item(s)`,
								} as TodoDetails,
							};
						}
						// Only one item should be in_progress at a time: starting a new one
						// demotes any other in_progress item back to pending.
						for (const other of todos) {
							if (other.id !== todo.id && other.status === "in_progress") {
								other.status = "pending";
							}
						}
					}
					todo.status = params.status;
					if (ctx.mode === "tui") {
						if (todo.status === "in_progress") ctx.ui.setWorkingIndicator(PULSE_INDICATOR);
						else if (todo.status === "completed") ctx.ui.setWorkingIndicator(DOT_INDICATOR);
					}
					syncWidget(ctx);
					return {
						content: [{ type: "text", text: `Todo #${todo.id} set to ${todo.status}` }],
						details: { action: "setStatus", todos: [...todos], nextId, changedId: todo.id } as TodoDetails,
					};
				}

				case "clear": {
					const count = todos.length;
					todos = [];
					nextId = 1;
					syncWidget(ctx);
					return {
						content: [{ type: "text", text: `Cleared ${count} todos` }],
						details: { action: "clear", todos: [], nextId: 1 } as TodoDetails,
					};
				}

				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${params.action}` }],
						details: {
							action: "list",
							todos: [...todos],
							nextId,
							error: `unknown action: ${params.action}`,
						} as TodoDetails,
					};
			}
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.status) text += ` ${theme.fg("dim", `-> ${args.status}`)}`;
			if (args.position !== undefined) text += ` ${theme.fg("dim", `@${args.position}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			const todoList = details.todos;

			switch (details.action) {
				case "list": {
					if (todoList.length === 0) {
						return new Text(theme.fg("dim", "No todos"), 0, 0);
					}
					let listText = theme.fg("muted", `${todoList.length} todo(s):`);
					const display = expanded ? todoList : todoList.slice(0, 5);
					for (const t of display) {
						const check = statusIcon(theme, t.status);
						const itemText = t.status === "completed" ? theme.fg("dim", t.text) : theme.fg("muted", t.text);
						listText += `\n${check} ${theme.fg("accent", `#${t.id}`)} ${itemText}`;
					}
					if (!expanded && todoList.length > 5) {
						listText += `\n${theme.fg("dim", `... ${todoList.length - 5} more`)}`;
					}
					return new Text(listText, 0, 0);
				}

				case "add":
				case "insert":
				case "edit":
				case "setStatus": {
					// Icon reflects the actual new status of the changed item, instead of a
					// fixed checkmark that would misleadingly imply completion for every action.
					const todo = todoList.find((t) => t.id === details.changedId);
					const icon = todo ? statusIcon(theme, todo.status) : theme.fg("success", "✓");
					const fallback = result.content[0]?.type === "text" ? result.content[0].text : "";
					const label = todo ? todo.text : fallback;
					return new Text(`${icon} ${theme.fg("accent", `#${details.changedId}`)} ${theme.fg("muted", label)}`, 0, 0);
				}

				case "remove": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("dim", "✕ ") + theme.fg("muted", msg), 0, 0);
				}

				case "clear":
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "Cleared all todos"), 0, 0);

				default: {
					const text = result.content[0];
					return new Text(text?.type === "text" ? text.text : "", 0, 0);
				}
			}
		},
	});
}
