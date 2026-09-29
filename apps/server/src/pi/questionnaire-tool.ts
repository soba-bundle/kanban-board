import { defineTool } from "@earendil-works/pi-coding-agent";
import { HumanRequestQuestionsSchema, type HumanRequestAnswer, type HumanRequestQuestion } from "@kanban-board/shared";
import { Type, type Static } from "typebox";

type AskInput = {
  taskId: string;
  runId: string;
  sessionId: string;
  toolCallId: string;
  questions: HumanRequestQuestion[];
};

interface HumanRequests {
  ask(input: AskInput): Promise<HumanRequestAnswer[]>;
}

const QuestionnaireParameters = Type.Object({
  questions: Type.Array(Type.Object({
    id: Type.String({ minLength: 1, description: "Stable question ID used to correlate its answer." }),
    label: Type.Optional(Type.String({ description: "Short tab label; defaults to the prompt." })),
    prompt: Type.String({ minLength: 1, description: "The question to ask the user." }),
    options: Type.Array(Type.Object({
      value: Type.String({ minLength: 1 }),
      label: Type.String({ minLength: 1 }),
      description: Type.Optional(Type.String()),
    })),
    allowOther: Type.Optional(Type.Boolean({ description: "Whether a custom text answer is allowed." })),
  }), { minItems: 1 }),
});

type QuestionnaireParameters = Static<typeof QuestionnaireParameters>;
type ToolContext = {
  humanRequests?: HumanRequests;
  taskId: string;
  runId: string | (() => string | undefined);
  sessionId: string;
};

export function createKanbanQuestionnaireTool(context: ToolContext) {
  return defineTool({
    name: "kanban_questionnaire",
    label: "Ask Human Questions",
    description: "Ask one or more questions that require human input. Submit all questions in one call with stable IDs.",
    promptSnippet: "kanban_questionnaire - ask the user a batch of questions when progress requires human input",
    promptGuidelines: ["Use kanban_questionnaire when you need explicit human decisions; group related questions into one call."],
    parameters: QuestionnaireParameters,
    execute: async (toolCallId, params: QuestionnaireParameters) => {
      const runId = typeof context.runId === "function" ? context.runId() : context.runId;
      if (!runId) throw new Error("No active run is associated with this questionnaire.");
      if (!context.humanRequests) throw new Error("Human Request scheduling is not configured for this session.");
      const questions = HumanRequestQuestionsSchema.parse(params.questions.map((question) => ({
        ...question,
        label: question.label?.trim() || question.prompt,
        allowOther: question.allowOther ?? false,
      })));
      const answers = await context.humanRequests.ask({
        taskId: context.taskId,
        runId,
        sessionId: context.sessionId,
        toolCallId,
        questions,
      });
      const answerById = new Map(answers.map((answer) => [answer.id, answer]));
      if (answers.length !== questions.length || answerById.size !== answers.length ||
        questions.some((question) => !answerById.has(question.id))) {
        throw new Error("Human Request service returned an incomplete or mismatched answer batch.");
      }
      const summary = questions.map((question) => {
        const answer = answerById.get(question.id)!;
        return answer.wasCustom
          ? `${question.label}: user wrote: ${answer.value}`
          : `${question.label}: user selected: ${answer.index ?? ""}. ${answer.label}`;
      }).join("\n");
      return {
        content: [{ type: "text" as const, text: summary }],
        details: { questions, answers, cancelled: false },
      };
    },
  });
}
