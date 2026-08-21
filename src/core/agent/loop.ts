// The agent turn: model, tools, model again, until it has an answer.
//
// Three things are deliberately NOT inside this loop, because putting them here is what turns an
// agent into something nobody can audit:
//
//   • WHAT A TOOL DOES. Tools are injected. The loop knows their schemas and nothing else, so the
//     same loop drives the editor extension and the terminal client with different capabilities.
//   • WHETHER SOMETHING IS ALLOWED. Approval is a callback. The loop never decides that writing a
//     file is fine; it asks, and it treats a refusal as an ordinary tool result so the model can
//     react to it instead of being cut off mid-thought.
//   • WHAT MAY LEAVE THE MACHINE. Redaction is a callback applied to the messages just before the
//     request, and to nothing else. The rule "model-visible means redacted" is enforced by there
//     being exactly one place where messages become a request.
//
// What the loop does own: the step budget, the transcript of the turn, and the guarantee that a
// tool result is always paired with the call that produced it — a model that receives an
// unmatched tool result from a provider that is strict about it gets a 400 and the user gets a
// mysterious failure.

import type { ChatMessage, ChatResult, Provider, ReasoningEffort, ToolCall, ToolSchema, Usage } from "../providers/types.js";

export interface ToolContext {
  /** Cancels when the user stops the turn. */
  signal?: AbortSignal;
  /** Progress line for the UI, e.g. "read src/app.ts (120 lines)". */
  report(message: string): void;
}

export interface ToolResult {
  /** What the model sees. Keep it short: tool output is re-sent on every later step. */
  content: string;
  /** Set when the tool failed; the model is told so it can try something else. */
  isError?: boolean;
  /** Anything the UI wants to show (a diff, a file path) but the model does not need. */
  display?: unknown;
}

export interface Tool {
  schema: ToolSchema;
  /**
   * Whether this call needs the user's blessing. Returning a string asks with that description;
   * `false` runs it. Reads are usually free, writes and commands are not.
   */
  approval(args: Record<string, unknown>): string | false;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export type Approver = (request: { tool: string; description: string; args: Record<string, unknown> }) => Promise<boolean>;

export interface TurnOptions {
  provider: Provider;
  model: string;
  /** Messages built from the session (system prompt, ambient context, transcript). */
  messages: ChatMessage[];
  tools?: Tool[];
  maxSteps?: number;
  maxTokens?: number;
  temperature?: number;
  reasoning?: ReasoningEffort;
  signal?: AbortSignal;
  onDelta?: (d: { text?: string; reasoning?: string }) => void;
  onStep?: (info: { step: number; toolCalls: ToolCall[] }) => void;
  onToolResult?: (info: { call: ToolCall; result: ToolResult }) => void;
  approve?: Approver;
  /** Applied to the messages of EVERY step, immediately before the request leaves. */
  beforeRequest?: (messages: ChatMessage[]) => Promise<ChatMessage[]> | ChatMessage[];
  /** Applied to text coming back, to put real values behind the placeholders. */
  afterResponse?: (text: string) => string;
  report?: (message: string) => void;
}

export interface TurnResult {
  text: string;
  reasoning: string;
  steps: number;
  usage: Usage;
  /** The tool calls made during this turn, for the transcript and the audit log. */
  trace: Array<{ call: ToolCall; result: ToolResult; approved: boolean }>;
  stoppedBecause: "answer" | "max-steps" | "cancelled";
}

const DEFAULT_MAX_STEPS = 12;

export async function runTurn(opts: TurnOptions): Promise<TurnResult> {
  const tools = opts.tools ?? [];
  const byName = new Map(tools.map((t) => [t.schema.name, t]));
  const schemas: ToolSchema[] = tools.map((t) => t.schema);
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;

  const working: ChatMessage[] = [...opts.messages];
  const trace: TurnResult["trace"] = [];
  const usage: Usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, costUsd: 0 };
  let text = "";
  let reasoning = "";

  for (let step = 0; step < maxSteps; step++) {
    if (opts.signal?.aborted) return done("cancelled");

    const outgoing = opts.beforeRequest ? await opts.beforeRequest(working) : working;
    let res: ChatResult;
    try {
      res = await opts.provider.chat(
        {
          model: opts.model,
          messages: outgoing,
          tools: schemas.length ? schemas : undefined,
          maxTokens: opts.maxTokens,
          temperature: opts.temperature,
          reasoning: opts.reasoning,
          signal: opts.signal,
        },
        opts.onDelta,
      );
    } catch (err) {
      if (opts.signal?.aborted) return done("cancelled");
      throw err;
    }

    usage.promptTokens += res.usage.promptTokens;
    usage.completionTokens += res.usage.completionTokens;
    usage.cachedTokens += res.usage.cachedTokens;
    if (typeof res.usage.costUsd === "number") usage.costUsd = (usage.costUsd ?? 0) + res.usage.costUsd;

    const answer = opts.afterResponse ? opts.afterResponse(res.text) : res.text;
    if (answer) text = text ? `${text}\n${answer}` : answer;
    if (res.reasoning) reasoning += res.reasoning;

    if (!res.toolCalls.length) return done("answer");

    opts.onStep?.({ step, toolCalls: res.toolCalls });
    working.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });

    // Every call gets a result message, including the ones that were refused or failed. A missing
    // result is a protocol error with most providers and a silent hang with the rest.
    for (const call of res.toolCalls) {
      if (opts.signal?.aborted) {
        working.push({ role: "tool", toolCallId: call.id, content: "Cancelled by the user." });
        continue;
      }
      const tool = byName.get(call.name);
      if (!tool) {
        working.push({ role: "tool", toolCallId: call.id, content: `Unknown tool: ${call.name}` });
        continue;
      }

      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.args || "{}") as Record<string, unknown>;
      } catch {
        // A malformed call is the model's mistake to fix, not a crash.
        working.push({ role: "tool", toolCallId: call.id, content: "Arguments were not valid JSON. Send the call again." });
        continue;
      }

      const needs = tool.approval(args);
      let approved = true;
      if (needs !== false) {
        approved = opts.approve ? await opts.approve({ tool: call.name, description: needs, args }) : false;
      }
      if (!approved) {
        const result: ToolResult = { content: "The user declined this action.", isError: true };
        trace.push({ call, result, approved: false });
        opts.onToolResult?.({ call, result });
        working.push({ role: "tool", toolCallId: call.id, content: result.content });
        continue;
      }

      let result: ToolResult;
      try {
        result = await tool.run(args, {
          signal: opts.signal,
          report: (m) => opts.report?.(m),
        });
      } catch (err) {
        result = { content: `Tool failed: ${(err as Error).message}`, isError: true };
      }
      trace.push({ call, result, approved: true });
      opts.onToolResult?.({ call, result });
      working.push({ role: "tool", toolCallId: call.id, content: result.content });
    }
  }

  return done("max-steps");

  function done(stoppedBecause: TurnResult["stoppedBecause"]): TurnResult {
    return { text, reasoning, steps: trace.length, usage, trace, stoppedBecause };
  }
}
