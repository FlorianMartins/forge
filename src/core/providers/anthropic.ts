// Anthropic's native Messages API. Kept separate from the OpenAI shape rather than proxied
// through a compatibility layer for one reason that matters to the cost target: PROMPT CACHING
// is explicit here. Marking the stable prefix — system prompt, repository map, the files already
// discussed — makes every later turn of a conversation cost a fraction of the first, and that is
// the single biggest lever on a coding assistant's bill, because a coding conversation resends
// almost the same context on every turn.

import { sseData, sseLines } from "../util/sse.js";
import type { ChatDelta, ChatRequest, ChatResult, Provider, ToolCall, Usage } from "./types.js";
import { EMPTY_USAGE } from "./types.js";
import { describeHttpError } from "./openai.js";

export interface AnthropicOptions {
  baseUrl: string;
  apiKey: string;
  version?: string;
}

export class AnthropicProvider implements Provider {
  readonly id = "anthropic";
  readonly baseUrl: string;
  readonly isLocal = false;
  private readonly opts: AnthropicOptions;

  constructor(opts: AnthropicOptions) {
    this.opts = opts;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
  }

  async chat(req: ChatRequest, onDelta?: (d: ChatDelta) => void): Promise<ChatResult> {
    const system = req.messages.filter((m) => m.role === "system");
    const rest = req.messages.filter((m) => m.role !== "system");

    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      stream: true,
      messages: rest.map((m) => {
        if (m.role === "tool") {
          return { role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }] };
        }
        if (m.toolCalls?.length) {
          const blocks: unknown[] = [];
          if (m.content) blocks.push({ type: "text", text: m.content });
          for (const t of m.toolCalls) {
            blocks.push({ type: "tool_use", id: t.id, name: t.name, input: safeJson(t.args) });
          }
          return { role: "assistant", content: blocks };
        }
        const block: Record<string, unknown> = { type: "text", text: m.content };
        // A cache breakpoint costs nothing when it misses and saves ~90 % of the input price when
        // it hits. Put it on the big, stable blocks only: the API allows four per request.
        if (m.cacheable) block["cache_control"] = { type: "ephemeral" };
        return { role: m.role === "assistant" ? "assistant" : "user", content: [block] };
      }),
    };
    if (system.length) {
      body["system"] = system.map((s) => {
        const b: Record<string, unknown> = { type: "text", text: s.content };
        if (s.cacheable !== false) b["cache_control"] = { type: "ephemeral" };
        return b;
      });
    }
    if (req.temperature != null) body["temperature"] = req.temperature;
    if (req.tools?.length) {
      body["tools"] = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    }

    const res = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.opts.apiKey.trim(),
        "anthropic-version": this.opts.version ?? "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok || !res.body) throw new Error(await describeHttpError(res));

    let text = "";
    let reasoning = "";
    let stopReason: ChatResult["stopReason"] = "stop";
    const usage: Usage = { ...EMPTY_USAGE };
    const blocks = new Map<number, { type: string; id?: string; name?: string; json: string }>();

    for await (const line of sseLines(res.body, req.signal)) {
      const ev = sseData(line) as any;
      if (!ev) continue;
      switch (ev.type) {
        case "message_start": {
          const u = ev.message?.usage;
          if (u) {
            usage.promptTokens = u.input_tokens ?? 0;
            // Reads are the cheap tokens; writes are billed at a premium once and repay on turn 2.
            usage.cachedTokens = u.cache_read_input_tokens ?? 0;
            usage.promptTokens += (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          }
          break;
        }
        case "content_block_start":
          blocks.set(ev.index, { type: ev.content_block?.type, id: ev.content_block?.id, name: ev.content_block?.name, json: "" });
          break;
        case "content_block_delta": {
          const d = ev.delta ?? {};
          if (d.type === "text_delta" && d.text) {
            text += d.text;
            onDelta?.({ text: d.text });
          } else if (d.type === "thinking_delta" && d.thinking) {
            reasoning += d.thinking;
            onDelta?.({ reasoning: d.thinking });
          } else if (d.type === "input_json_delta") {
            const b = blocks.get(ev.index);
            if (b) b.json += d.partial_json ?? "";
          }
          break;
        }
        case "message_delta":
          if (ev.usage?.output_tokens) usage.completionTokens = ev.usage.output_tokens;
          if (ev.delta?.stop_reason === "max_tokens") stopReason = "length";
          if (ev.delta?.stop_reason === "tool_use") stopReason = "tool_calls";
          break;
        case "error":
          throw new Error(ev.error?.message ?? "Anthropic stream error");
      }
    }

    const toolCalls: ToolCall[] = [...blocks.entries()]
      .filter(([, b]) => b.type === "tool_use")
      .sort((a, b) => a[0] - b[0])
      .map(([i, b]) => ({ id: b.id ?? `call_${i}`, name: b.name ?? "", args: b.json || "{}" }))
      .filter((t) => t.name);
    if (toolCalls.length) stopReason = "tool_calls";

    return { text, reasoning, toolCalls, usage, stopReason };
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/models`, {
      headers: { "x-api-key": this.opts.apiKey.trim(), "anthropic-version": this.opts.version ?? "2023-06-01" },
    });
    if (!res.ok) throw new Error(await describeHttpError(res));
    const json = (await res.json()) as any;
    return (json.data ?? []).map((m: any) => m.id).filter(Boolean);
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
