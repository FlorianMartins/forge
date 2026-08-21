// The OpenAI-compatible wire format — which by now is what almost everything speaks: Ollama,
// LM Studio, llama.cpp, vLLM, TGI, LiteLLM, Azure, OpenRouter, and OpenAI itself.
//
// Two provider-specific details are worth the branches:
//   • OpenRouter returns the REAL cost of a call when asked (`usage.include`), which is the only
//     way a budget can be enforced on facts instead of on an estimate.
//   • Ollama exposes fill-in-the-middle through its native `/api/generate` with a `suffix`, and
//     that path is much better than hand-writing FIM tokens into a chat prompt.

import { request } from "../util/http.js";
import { sseData, sseLines } from "../util/sse.js";
import type {
  ChatDelta,
  ChatRequest,
  ChatResult,
  CompletionRequest,
  Provider,
  ToolCall,
  Usage,
} from "./types.js";
import { EMPTY_USAGE } from "./types.js";

export interface OpenAIProviderOptions {
  id: string;
  baseUrl: string;
  apiKey?: string;
  isLocal: boolean;
  /** OpenRouter attribution headers. Sent to OpenRouter ONLY: on a local server they turn the
   *  request into a preflighted one and some builds answer 403 to the OPTIONS. */
  referer?: string;
  title?: string;
  timeoutMs?: number;
}

const trimSlash = (u: string) => u.replace(/\/+$/, "");

export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  readonly baseUrl: string;
  readonly isLocal: boolean;
  private readonly opts: OpenAIProviderOptions;
  private ollamaProbe: boolean | undefined;

  constructor(opts: OpenAIProviderOptions) {
    this.opts = opts;
    this.id = opts.id;
    this.baseUrl = trimSlash(opts.baseUrl);
    this.isLocal = opts.isLocal;
  }

  /**
   * Is this endpoint an Ollama server? The port is the usual clue, but plenty of teams run it
   * behind a reverse proxy on 443 or on a custom port, and getting this wrong costs the good
   * fill-in-the-middle path. So: sniff the URL first, then probe once and remember.
   *
   * The probe only ever runs against an endpoint already classified as local. A remote provider
   * must never receive a request the user did not ask for, even an empty one.
   */
  private async isOllamaServer(): Promise<boolean> {
    if (this.ollamaProbe !== undefined) return this.ollamaProbe;
    if (isOllama(this.baseUrl)) return (this.ollamaProbe = true);
    if (!this.isLocal) return (this.ollamaProbe = false);
    try {
      const root = trimSlash(this.baseUrl).replace(/\/v1$/, "");
      const res = await request(`${root}/api/version`, { timeoutMs: 2500, label: "server probe" });
      this.ollamaProbe = res.ok;
    } catch {
      this.ollamaProbe = false;
    }
    return this.ollamaProbe;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    const key = this.opts.apiKey?.trim();
    if (key) h["Authorization"] = `Bearer ${key}`;
    if (this.id === "openrouter") {
      if (this.opts.referer) h["HTTP-Referer"] = this.opts.referer;
      if (this.opts.title) h["X-Title"] = this.opts.title;
    }
    return h;
  }

  async chat(req: ChatRequest, onDelta?: (d: ChatDelta) => void): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      stream: true,
      messages: req.messages.map((m) => {
        if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
        if (m.toolCalls?.length) {
          return {
            role: m.role,
            content: m.content || null,
            tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.args } })),
          };
        }
        return { role: m.role, content: m.content };
      }),
    };
    if (req.maxTokens) body["max_tokens"] = req.maxTokens;
    if (req.temperature != null) body["temperature"] = req.temperature;
    if (req.tools?.length) {
      body["tools"] = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    // Reasoning. OpenRouter normalises it under `reasoning`; OpenAI's own API and several
    // gateways take `reasoning_effort`. Sending both is safe: an unknown field is dropped, and a
    // server that knows one of them gets the intent.
    if (req.reasoning && req.reasoning !== "none") {
      if (this.id === "openrouter") body["reasoning"] = { effort: req.reasoning };
      else body["reasoning_effort"] = req.reasoning;
    } else if (req.reasoning === "none" && this.id === "openrouter") {
      // Explicitly off, so a model that thinks by default does not bill for it.
      body["reasoning"] = { exclude: true };
    }

    // Ask for the accounting. OpenAI-compatible servers that do not know the field ignore it.
    body["stream_options"] = { include_usage: true };
    if (this.id === "openrouter") body["usage"] = { include: true };

    const res = await request(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: req.signal,
      timeoutMs: this.opts.timeoutMs ?? 180_000,
      label: "chat",
    });
    if (!res.ok || !res.body) throw new Error(await describeHttpError(res));

    let text = "";
    let reasoning = "";
    let stopReason: ChatResult["stopReason"] = "stop";
    const usage: Usage = { ...EMPTY_USAGE };
    // Tool calls arrive in fragments indexed by position; assemble them by index, never by id
    // (several providers send the id only on the first fragment).
    const partial = new Map<number, { id: string; name: string; args: string }>();

    for await (const line of sseLines(res.body, req.signal)) {
      const payload = sseData(line) as any;
      if (!payload) continue;
      if (payload.error) throw new Error(payload.error.message ?? String(payload.error));
      const choice = payload.choices?.[0];
      if (payload.usage) {
        usage.promptTokens = payload.usage.prompt_tokens ?? usage.promptTokens;
        usage.completionTokens = payload.usage.completion_tokens ?? usage.completionTokens;
        usage.cachedTokens = payload.usage.prompt_tokens_details?.cached_tokens ?? usage.cachedTokens;
        if (typeof payload.usage.cost === "number") usage.costUsd = payload.usage.cost;
      }
      if (!choice) continue;
      if (choice.finish_reason === "length") stopReason = "length";
      const delta = choice.delta ?? {};
      // DeepSeek names it reasoning_content, OpenRouter normalises to reasoning.
      const r = delta.reasoning_content ?? delta.reasoning;
      if (typeof r === "string" && r) {
        reasoning += r;
        onDelta?.({ reasoning: r });
      }
      if (typeof delta.content === "string" && delta.content) {
        text += delta.content;
        onDelta?.({ text: delta.content });
      }
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const cur = partial.get(idx) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        partial.set(idx, cur);
      }
    }

    const toolCalls: ToolCall[] = [...partial.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, t]) => ({ id: t.id || `call_${i}`, name: t.name, args: t.args || "{}" }))
      .filter((t) => t.name);
    if (toolCalls.length) stopReason = "tool_calls";

    return { text, reasoning, toolCalls, usage, stopReason };
  }

  /**
   * Fill-in-the-middle. Ollama's native endpoint takes prefix/suffix as fields, which is both
   * simpler and more reliable than embedding the model's FIM tokens in a prompt — the server
   * knows the template for the model it loaded. Anything else goes through /completions with the
   * templated prompt the caller built.
   */
  async complete(req: CompletionRequest): Promise<string> {
    if (await this.isOllamaServer()) {
      const root = trimSlash(this.baseUrl).replace(/\/v1$/, "");
      const res = await request(`${root}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeoutMs: 45_000,
        label: "completion",
        body: JSON.stringify({
          model: req.model,
          prompt: req.prefix,
          suffix: req.suffix,
          stream: false,
          raw: false,
          options: { num_predict: req.maxTokens, temperature: 0.1, stop: req.stop },
          // Keep the weights resident: the cost of a cold start is paid on the next keystroke.
          keep_alive: "30m",
        }),
        signal: req.signal,
      });
      if (!res.ok) throw new Error(await describeHttpError(res));
      const json = (await res.json()) as { response?: string };
      return json.response ?? "";
    }

    const res = await request(`${this.baseUrl}/completions`, {
      method: "POST",
      headers: this.headers(),
      timeoutMs: 45_000,
      label: "completion",
      body: JSON.stringify({
        model: req.model,
        prompt: req.prefix,
        suffix: req.suffix,
        max_tokens: req.maxTokens,
        temperature: 0.1,
        stop: req.stop,
        stream: false,
      }),
      signal: req.signal,
    });
    if (!res.ok) throw new Error(await describeHttpError(res));
    const json = (await res.json()) as any;
    return json.choices?.[0]?.text ?? "";
  }

  /**
   * Load the model without generating anything. Ollama unloads weights after a few minutes of
   * inactivity, and the first request after that pays the whole load time — which is the one
   * request the user is watching. Called on activation and after a long idle.
   */
  async warmup(model: string): Promise<void> {
    if (!(await this.isOllamaServer())) return;
    const root = trimSlash(this.baseUrl).replace(/\/v1$/, "");
    try {
      await request(`${root}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: "", keep_alive: "30m" }),
        timeoutMs: 120_000,
        label: "warm-up",
      });
    } catch {
      // A warm-up that fails is not an error the user needs: the next real request will report it.
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await request(`${this.baseUrl}/models`, { headers: this.headers(), timeoutMs: 15_000, label: "model list" });
      if (res.ok) {
        const json = (await res.json()) as any;
        const ids = (json.data ?? []).map((m: any) => m.id).filter(Boolean);
        if (ids.length) return ids;
      }
    } catch {
      /* fall through to the native listing */
    }
    // Older or proxied Ollama builds do not serve /v1/models.
    if (await this.isOllamaServer()) {
      const root = trimSlash(this.baseUrl).replace(/\/v1$/, "");
      const res = await request(`${root}/api/tags`, { timeoutMs: 15_000, label: "model list" });
      if (!res.ok) throw new Error(await describeHttpError(res));
      const json = (await res.json()) as any;
      return (json.models ?? []).map((m: any) => m.name).filter(Boolean);
    }
    return [];
  }
}

export function isOllama(baseUrl: string): boolean {
  return /:11434(\/|$)/.test(baseUrl) || /ollama/i.test(baseUrl);
}

export async function describeHttpError(res: Response): Promise<string> {
  let detail = "";
  try {
    const body = await res.text();
    const json = JSON.parse(body);
    detail = json?.error?.message ?? json?.error ?? json?.message ?? body.slice(0, 300);
  } catch {
    /* body already consumed or not JSON */
  }
  const hint =
    res.status === 401 || res.status === 403
      ? " — check the API key (Forge: “Enregistrer une clé de fournisseur”)."
      : res.status === 404
        ? " — check the endpoint URL and that the model exists on it."
        : res.status === 429
          ? " — rate limited by the provider."
          : "";
  return `HTTP ${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}${hint}`;
}
