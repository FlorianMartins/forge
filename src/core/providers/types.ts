// One shape for every backend. The rest of the extension never learns which vendor answered.

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  args: string; // raw JSON, parsed by the caller so a malformed call is a tool error, not a crash
}

export interface ChatMessage {
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /** Marks a prefix that is worth caching remotely (system prompt + repo map). */
  cacheable?: boolean;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  /** Tokens served from the provider's prompt cache — the cheap ones. */
  cachedTokens: number;
  /** Real cost in USD when the provider reports it; otherwise the router estimates. */
  costUsd?: number;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  tools?: ToolSchema[];
  signal?: AbortSignal;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatDelta {
  text?: string;
  reasoning?: string;
}

export interface ChatResult {
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage: Usage;
  stopReason: "stop" | "length" | "tool_calls" | "error";
}

export interface CompletionRequest {
  model: string;
  prefix: string;
  suffix: string;
  maxTokens: number;
  stop: string[];
  signal?: AbortSignal;
}

export interface Provider {
  readonly id: string;
  readonly baseUrl: string;
  /** True when nothing sent to this endpoint leaves the operator's network. */
  readonly isLocal: boolean;
  chat(req: ChatRequest, onDelta?: (d: ChatDelta) => void): Promise<ChatResult>;
  /** Fill-in-the-middle. Absent on providers whose models cannot do it. */
  complete?(req: CompletionRequest): Promise<string>;
  listModels(): Promise<string[]>;
}

export const EMPTY_USAGE: Usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
