export interface UndoAction {
  readonly description: string;
  undo(): void;
  redo(): void;
}

const MAX_HISTORY = 200;

export class History {
  private undoStack: UndoAction[] = [];
  private redoStack: UndoAction[] = [];

  push(action: UndoAction): void {
    this.undoStack.push(action);
    this.redoStack.length = 0;
    if (this.undoStack.length > MAX_HISTORY) {
      this.undoStack.shift();
    }
  }

  undo(): UndoAction | null {
    const action = this.undoStack.pop();
    if (!action) return null;
    action.undo();
    this.redoStack.push(action);
    return action;
  }

  redo(): UndoAction | null {
    const action = this.redoStack.pop();
    if (!action) return null;
    action.redo();
    this.undoStack.push(action);
    return action;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get undoCount(): number { return this.undoStack.length; }
  get redoCount(): number { return this.redoStack.length; }
}
