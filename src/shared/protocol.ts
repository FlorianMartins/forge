// The only vocabulary the panel and the extension share. Imported by both sides, so a message one
// sends and the other does not understand is a compile error rather than a silent no-op.

export type Mode = "chat" | "plan" | "agent";
export type Reasoning = "none" | "low" | "medium" | "high";
export type Screen = "chat" | "history" | "models" | "permissions";

export interface UiContextItem {
  kind: string;
  label: string;
  /** Tokens the item costs, so the user can see what their context is worth before sending. */
  tokens: number;
}

export interface UiStep {
  tool: string;
  summary: string;
  ok: boolean;
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
  /** What the model thought before answering, when a reasoning effort was asked for. */
  reasoning?: string;
  context?: UiContextItem[];
  steps?: UiStep[];
}

export interface UiSession {
  id: string;
  title: string;
  mode: Mode;
  entries: UiEntry[];
}

export interface UiHistoryRow {
  id: string;
  title: string;
  updatedAt: number;
  createdAt: number;
  messages: number;
  usdCost: number;
  mode: Mode;
  excerpt?: string;
}

export interface UiHistoryFilter {
  query: string;
  period: "all" | "today" | "week" | "month";
  mode: Mode | "all";
  paidOnly: boolean;
  sort: "updated" | "created" | "messages" | "cost";
}

export interface UiModel {
  id: string;
  name: string;
  vendor: string;
  /** Context window in tokens, 0 when unknown. */
  context: number;
  /** USD per million tokens. Both zero means free — or local, which is the same thing here. */
  inUsd: number;
  outUsd: number;
  cachedInUsd: number;
  provider: string;
  /** True when this endpoint runs on the user's own machine or network. */
  local: boolean;
  /** True when the model is currently selected for the chat role. */
  current?: boolean;
}

export interface UiPermissionRule {
  tool: string;
  prefix?: string;
  level: "always" | "never";
  /** Session grants are listed too, marked as temporary. */
  session?: boolean;
}

export interface UiOpenFile {
  path: string;
  active: boolean;
  language: string;
  dirty: boolean;
}

export interface UiState {
  screen: Screen;
  session: UiSession;
  mode: Mode;
  reasoning: Reasoning;
  /** True when the selected chat model can think — drives whether the control is offered. */
  reasoningAvailable: boolean;
  model: string;
  modelLabel: string;
  provider: string;
  remote: boolean;
  contextTokens: number;
  budget: { spentTodayUsd: number; dailyUsd: number };
  attachments: UiContextItem[];
  openFiles: UiOpenFile[];
  history: UiHistoryRow[];
  historyFilter: UiHistoryFilter;
  models: UiModel[];
  modelsLoading: boolean;
  permissions: UiPermissionRule[];
  /** Entry ids matching the in-conversation search, in document order. */
  matches: string[];
  searchQuery: string;
}

/** Panel → extension. */
export type ToExtension =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "stop" }
  | { type: "newSession" }
  | { type: "openScreen"; screen: Screen }
  | { type: "openSession"; id: string }
  | { type: "deleteSession"; id: string }
  | { type: "setMode"; mode: Mode }
  | { type: "setReasoning"; reasoning: Reasoning }
  | { type: "setModel"; model: string; provider: string }
  | { type: "refreshModels" }
  | { type: "setHistoryFilter"; filter: Partial<UiHistoryFilter> }
  | { type: "search"; query: string }
  | { type: "setIncluded"; id: string; included: boolean }
  | { type: "setPinned"; id: string; pinned: boolean }
  | { type: "dropEntry"; id: string }
  | { type: "editEntry"; id: string; text: string }
  | { type: "retry" }
  | { type: "attach"; what: "active" | "selection" | "browse" | "openFiles" | "mention" }
  | { type: "attachPath"; path: string }
  | { type: "removeAttachment"; label: string }
  | { type: "setPermission"; tool: string; prefix?: string; level: "always" | "never" }
  | { type: "forgetPermission"; tool: string; prefix?: string }
  | { type: "clearSessionPermissions" }
  | { type: "openEgress" }
  | { type: "openCosts" }
  | { type: "openSettings" }
  | { type: "approve"; id: string; answer: "once" | "session" | "always" | "no" }
  | { type: "insertCode"; code: string }
  | { type: "applyCode"; code: string; language: string }
  | { type: "copy"; text: string };

/** Extension → panel. */
export type ToPanel =
  | { type: "state"; state: UiState }
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "status"; text: string; tool?: string; ok?: boolean }
  | { type: "turnStart" }
  | { type: "turnEnd" }
  | { type: "approval"; id: string; tool: string; description: string; command?: string }
  | { type: "error"; message: string };
