export interface StartupRecoverySteps {
  reconcileMerge(): Promise<void>;
  reconcileRunInputs(): Promise<void>;
  reconcileHumanRequests(): Promise<void>;
  initializeQueue(): void;
}

/** Complete all persisted recovery before allowing queue dispatch. */
export async function recoverBeforeDispatch(steps: StartupRecoverySteps): Promise<void> {
  await steps.reconcileMerge();
  await steps.reconcileRunInputs();
  await steps.reconcileHumanRequests();
  steps.initializeQueue();
}
