export class TaskOperationCoordinator {
  private readonly activeTasks = new Set<string>();

  tryAcquire(taskId: string): (() => void) | null {
    if (this.activeTasks.has(taskId)) return null;
    this.activeTasks.add(taskId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeTasks.delete(taskId);
    };
  }
}
