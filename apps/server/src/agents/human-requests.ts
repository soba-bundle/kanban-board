import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  HumanRequestAnswerBatchSchema,
  HumanRequestQuestionsSchema,
  type HumanRequest,
  type HumanRequestAnswer,
  type HumanRequestAnswerInput,
  type HumanRequestQuestion,
} from "@kanban-board/shared";

type RequestRow = {
  id: string;
  task_id: string;
  run_id: string;
  session_id: string;
  tool_call_id: string;
  question: string;
  options_json: string | null;
  answer: string | null;
  questions_json: string | null;
  answers_json: string | null;
  status: HumanRequest["status"];
  created_at: string;
  answered_at: string | null;
};

type AskInput = {
  taskId: string;
  runId: string;
  sessionId: string;
  toolCallId: string;
  questions: HumanRequestQuestion[];
};

type HumanRequestHooks = {
  onWaiting: (request: HumanRequest) => void | Promise<void>;
  onAnswered: (request: HumanRequest) => void | Promise<void>;
};

type Waiter = {
  runId: string;
  resolve: (answers: HumanRequestAnswer[]) => void;
  reject: (error: Error) => void;
};

export class HumanRequestService {
  private readonly waiters = new Map<string, Waiter>();

  constructor(private readonly db: Database.Database, private readonly hooks: HumanRequestHooks) {}

  async ask(input: AskInput): Promise<HumanRequestAnswer[]> {
    const questions = HumanRequestQuestionsSchema.parse(input.questions);
    for (const [key, value] of Object.entries({
      taskId: input.taskId,
      runId: input.runId,
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
    })) {
      if (!value.trim()) throw new Error(`${key} is required.`);
    }

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const firstQuestion = questions[0]!;
    const inserted = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO human_requests (id, task_id, run_id, session_id, tool_call_id,
        question, options_json, answer, questions_json, answers_json, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, 'PENDING', ?)`)
        .run(id, input.taskId, input.runId, input.sessionId, input.toolCallId,
          firstQuestion.prompt, JSON.stringify(firstQuestion.options), JSON.stringify(questions), createdAt);
      return this.getRequest(id);
    })();

    let resolve!: Waiter["resolve"];
    let reject!: Waiter["reject"];
    const waiting = new Promise<HumanRequestAnswer[]>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    void waiting.catch(() => {});
    this.waiters.set(id, { runId: input.runId, resolve, reject });
    if (this.getRequest(id).status !== "PENDING") {
      this.waiters.delete(id);
      reject(new Error("Human Request was cancelled before its wait was registered."));
      return waiting;
    }

    try {
      await this.hooks.onWaiting(inserted);
    } catch (error) {
      this.db.prepare(`UPDATE human_requests SET status = 'CANCELLED'
        WHERE id = ? AND status = 'PENDING'`).run(id);
      const status = this.getRequest(id).status;
      if (status !== "ANSWERED") {
        this.waiters.delete(id);
        reject(status === "CANCELLED"
          ? new Error("Human Request was cancelled because the run was stopped.")
          : error instanceof Error ? error : new Error(String(error)));
      }
    }
    return waiting;
  }

  listForTask(taskId: string): HumanRequest[] {
    const rows = this.db.prepare(`SELECT id, task_id, run_id, session_id, tool_call_id,
      question, options_json, answer, questions_json, answers_json, status, created_at, answered_at
      FROM human_requests WHERE task_id = ? ORDER BY created_at, id`).all(taskId) as RequestRow[];
    return rows.map((row) => this.toRequest(row));
  }

  async answer(requestId: string, input: HumanRequestAnswerInput[]): Promise<HumanRequest> {
    const submitted = HumanRequestAnswerBatchSchema.parse({ answers: input }).answers;
    const result = this.db.transaction(() => {
      const row = this.getRow(requestId);
      const request = this.toRequest(row);
      const answers = this.normalizeAnswers(request.questions, submitted);

      if (row.status === "ANSWERED") {
        if (JSON.stringify(request.answers) !== JSON.stringify(answers)) {
          throw new Error("Human Request was already answered with a different answer.");
        }
        return { request, created: false };
      }
      if (row.status !== "PENDING") throw new Error("Human Request is cancelled.");

      const answeredAt = new Date().toISOString();
      const updated = this.db.prepare(`UPDATE human_requests SET status = 'ANSWERED', answer = ?,
        answers_json = ?, answered_at = ? WHERE id = ? AND status = 'PENDING'`)
        .run(answers[0]!.value, JSON.stringify(answers), answeredAt, requestId);
      if (updated.changes !== 1) throw new Error("Human Request is no longer pending.");
      return {
        request: this.toRequest(this.getRow(requestId)),
        created: true,
      };
    })();

    if (result.created) await this.hooks.onAnswered(result.request);
    return result.request;
  }

  resume(requestId: string): void {
    const request = this.getRequest(requestId);
    if (request.status !== "ANSWERED" || !request.answers) {
      throw new Error("Only an answered Human Request can resume.");
    }
    const waiter = this.waiters.get(requestId);
    if (!waiter) throw new Error("Human Request is no longer waiting; it may have been stopped.");
    this.waiters.delete(requestId);
    waiter.resolve(request.answers);
  }

  cancelForRun(runId: string): void {
    this.db.prepare(`UPDATE human_requests SET status = 'CANCELLED'
      WHERE run_id = ? AND status = 'PENDING'`).run(runId);
    for (const [requestId, waiter] of this.waiters) {
      if (waiter.runId !== runId) continue;
      this.waiters.delete(requestId);
      waiter.reject(new Error("Human Request was cancelled because the run was stopped."));
    }
  }

  private normalizeAnswers(questions: HumanRequestQuestion[], submitted: HumanRequestAnswerInput[]): HumanRequestAnswer[] {
    if (submitted.length !== questions.length) throw new Error("You must answer every question exactly once.");
    const byId = new Map(submitted.map((answer) => [answer.id, answer.value.trim()]));
    if (byId.size !== submitted.length || questions.some((question) => !byId.has(question.id))) {
      throw new Error("You must answer every question exactly once.");
    }

    return questions.map((question) => {
      const value = byId.get(question.id)!;
      if (!value) throw new Error("Answers cannot be empty.");
      const index = question.options.findIndex((option) => option.value === value);
      if (index >= 0) {
        const option = question.options[index]!;
        return { id: question.id, value, label: option.label, wasCustom: false, index: index + 1 };
      }
      if (!question.allowOther) throw new Error(`Answer for ${question.label} must be an allowed option.`);
      return { id: question.id, value, label: value, wasCustom: true };
    });
  }

  private getRequest(requestId: string): HumanRequest {
    return this.toRequest(this.getRow(requestId));
  }

  private getRow(requestId: string): RequestRow {
    const row = this.db.prepare(`SELECT id, task_id, run_id, session_id, tool_call_id,
      question, options_json, answer, questions_json, answers_json, status, created_at, answered_at
      FROM human_requests WHERE id = ?`).get(requestId) as RequestRow | undefined;
    if (!row) throw new Error(`Human Request ${requestId} not found.`);
    return row;
  }

  private toRequest(row: RequestRow): HumanRequest {
    const legacyOptions = JSON.parse(row.options_json ?? "[]") as Array<string | HumanRequestQuestion["options"][number]>;
    const legacyAnswerIndex = row.answer === null ? -1 : legacyOptions.findIndex((option) =>
      (typeof option === "string" ? option : option.value) === row.answer);
    const questions = row.questions_json
      ? JSON.parse(row.questions_json) as HumanRequestQuestion[]
      : [{
        id: `legacy-${row.id}`,
        label: row.question,
        prompt: row.question,
        options: legacyOptions.map((option) => typeof option === "string"
          ? { value: option, label: option }
          : option),
        allowOther: legacyOptions.length === 0 || (row.answer !== null && legacyAnswerIndex < 0),
      }];
    const answers = row.answers_json
      ? JSON.parse(row.answers_json) as HumanRequestAnswer[]
      : row.answer === null ? null : (() => {
        const question = questions[0]!;
        const index = question.options.findIndex((option) => option.value === row.answer);
        return index >= 0
          ? [{ id: question.id, value: row.answer!, label: question.options[index]!.label, wasCustom: false, index: index + 1 }]
          : [{ id: question.id, value: row.answer, label: row.answer, wasCustom: true }];
      })();
    return {
      id: row.id,
      task_id: row.task_id,
      run_id: row.run_id,
      session_id: row.session_id,
      tool_call_id: row.tool_call_id,
      status: row.status,
      created_at: row.created_at,
      answered_at: row.answered_at,
      questions,
      answers,
    };
  }
}
