export type StartStage = "INVESTIGATION" | "IMPLEMENTATION";
export type StartAction =
  | { type: "enqueue"; stage: StartStage }
  | { type: "confirm"; title: string; warning: string };

export const DIRECT_IMPLEMENTATION_WARNING: string;
export function chooseStartAction(stage: StartStage, directConfirmed?: boolean): StartAction;
export function enqueueTask(taskId: string, stage: StartStage, fetchImpl?: typeof fetch): Promise<unknown>;
