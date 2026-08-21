// The only vocabulary the panel and the extension share. Imported by both sides, so a message
// that one sends and the other does not understand is a compile error rather than a silent no-op.

export interface UiContextItem {
  kind: string;
  label: string;
  /** Tokens the item costs, so the user can see what their context is worth before sending. */
  tokens: number;
}

export interface UiEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: number;
  included: boolean;
  pinned?: boolean;
  error?: string;
  model?: string;
  usdCost?: number;
  context?: UiContextItem[];
  /** Tool calls made while producing this answer. */
  steps?: Array<{ tool: string; summary: string; ok: boolean }>;
}

export interface UiSession {
  id: string;
  title: string;
  updatedAt: number;
  entries: UiEntry[];
}

export interface UiState {
  session: UiSession;
  history: Array<{ id: string; title: string; updatedAt: number }>;
  model: string;
  provider: string;
  /** True when this provider sends data off the machine. Drives the badge in the header. */
  remote: boolean;
  agentMode: boolean;
  contextTokens: number;
  budget: { spentTodayUsd: number; dailyUsd: number };
  attachments: UiContextItem[];
}

/** Panel → extension. */
export type ToExtension =
  | { type: "ready" }
  | { type: "send"; text: string; agentMode: boolean }
  | { type: "stop" }
  | { type: "newSession" }
  | { type: "openSession"; id: string }
  | { type: "deleteSession"; id: string }
  | { type: "setIncluded"; id: string; included: boolean }
  | { type: "setPinned"; id: string; pinned: boolean }
  | { type: "dropEntry"; id: string }
  | { type: "editEntry"; id: string; text: string }
  | { type: "retry" }
  | { type: "pickModel" }
  | { type: "attachActive" }
  | { type: "attachFile" }
  | { type: "removeAttachment"; label: string }
  | { type: "openEgress" }
  | { type: "approve"; id: string; approved: boolean }
  | { type: "insertCode"; code: string }
  | { type: "copy"; text: string };

/** Extension → panel. */
export type ToPanel =
  | { type: "state"; state: UiState }
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "status"; text: string }
  | { type: "turnStart" }
  | { type: "turnEnd" }
  | { type: "approval"; id: string; tool: string; description: string }
  | { type: "error"; message: string };
