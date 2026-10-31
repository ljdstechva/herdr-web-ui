import { createContext } from "react";
import type { OmoTask } from "../../shared/protocol.ts";

/**
 * The pane's look inside one of its tasks (components/TaskView.tsx), which takes the chat's place:
 * PaneTerminal holds it, the working line and the status line's list open it from their rows.
 * Null outside a chat pane: those rows then open nothing.
 */
export interface TaskViewControl {
  /** the task shown in the chat's place, if one is */
  viewing: string | null;
  open: (task: OmoTask) => void;
  /** back to the main agent's chat */
  close: () => void;
}

export const TaskViewContext = createContext<TaskViewControl | null>(null);
