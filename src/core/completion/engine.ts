// One completion, end to end. Written provider-agnostic and editor-agnostic so the whole
// behaviour — budgets, caches, trimming, the decision not to ask at all — is testable without an
// editor, which is what keeps it honest.

import type { Provider } from "../providers/types.js";
import { tailToTokens, headToTokens, estimateTokens } from "../util/tokens.js";
import { CompletionCache } from "./cache.js";
import { buildFimPrompt } from "./fim.js";
import { cleanCompletion, isUseless } from "./postprocess.js";

export interface CompletionContext {
  /** Everything before the cursor, current file. */
  prefix: string;
  /** Everything after the cursor, current file. */
  suffix: string;
  /** Text of the current line before the cursor. */
  linePrefix: string;
  /** Text of the current line after the cursor. */
  lineSuffix: string;
  languageId: string;
  /** Related snippets (neighbouring open files, imported symbols) prepended as comments. */
  related?: Array<{ path: string; body: string }>;
}

export interface CompletionSettings {
  model: string;
  maxTokens: number;
  multiline: boolean;
  /** Token budget for prefix+suffix. Small on purpose: latency is a feature of completion. */
  contextTokens: number;
  /** Send the raw halves and let the server apply the model's template (Ollama, vLLM...). */
  serverSideFim: boolean;
}

export interface CompletionOutcome {
  completion: string;
  source: "cache" | "continuation" | "model" | "none";
  reason?: string;
  requestTokens?: number;
}

/**
 * Reasons NOT to ask a model. Each one is a request that would have been paid for (in latency on
 * a local model, in money on a remote one) and thrown away.
 */
export function shouldSkip(ctx: CompletionContext): string | undefined {
  // Mid-word: the model has no idea whether the user is typing `count` or `country`, and an inline
  // suggestion that replaces half a word is the most irritating failure mode there is.
  if (/[A-Za-z0-9_$]$/.test(ctx.linePrefix) && /^[A-Za-z0-9_$]/.test(ctx.lineSuffix)) {
    return "cursor inside a word";
  }
  // A line that already has code after the cursor is being edited, not written.
  if (ctx.lineSuffix.trim().length > 0 && !/^[)\]},;:\s]*$/.test(ctx.lineSuffix)) {
    return "cursor before existing code";
  }
  if (ctx.prefix.trim().length === 0) return "empty file";
  return undefined;
}

export async function complete(
  provider: Provider,
  cache: CompletionCache,
  ctx: CompletionContext,
  settings: CompletionSettings,
  signal?: AbortSignal,
): Promise<CompletionOutcome> {
  const skip = shouldSkip(ctx);
  if (skip) return { completion: "", source: "none", reason: skip };

  const cont = cache.continuation(ctx.prefix, ctx.suffix);
  if (cont) return { completion: cont, source: "continuation" };

  const cached = cache.get(settings.model, ctx.prefix, ctx.suffix);
  if (cached !== undefined) {
    return cached ? { completion: cached, source: "cache" } : { completion: "", source: "none", reason: "known-empty" };
  }

  // Two thirds of the window before the cursor, one third after: what precedes decides the shape
  // of the completion, what follows only constrains it.
  const before = tailToTokens(withRelated(ctx), Math.floor(settings.contextTokens * 0.66));
  const after = headToTokens(ctx.suffix, Math.floor(settings.contextTokens * 0.34));

  if (!provider.complete) return { completion: "", source: "none", reason: "provider has no completion endpoint" };

  const { prompt, stop } = settings.serverSideFim
    ? { prompt: before, stop: [] as string[] }
    : buildFimPrompt(settings.model, before, after);

  const raw = await provider.complete({
    model: settings.model,
    prefix: settings.serverSideFim ? before : prompt,
    suffix: settings.serverSideFim ? after : "",
    maxTokens: settings.maxTokens,
    stop: stop.length ? stop : ["\n\n\n"],
    signal,
  });

  const completion = cleanCompletion(raw, {
    suffix: ctx.suffix,
    multiline: settings.multiline,
    linePrefix: ctx.linePrefix,
  });

  // Cache the empty answer too: asking again for a context the model had nothing to say about is
  // the most common wasted request of all.
  cache.set(settings.model, ctx.prefix, ctx.suffix, isUseless(completion) ? "" : completion);

  if (isUseless(completion)) return { completion: "", source: "none", reason: "model returned nothing usable" };
  return { completion, source: "model", requestTokens: estimateTokens(before) + estimateTokens(after) };
}

/** Neighbouring snippets go in as comments above the prefix — the format every FIM model saw. */
function withRelated(ctx: CompletionContext): string {
  if (!ctx.related?.length) return ctx.prefix;
  const c = commentPrefix(ctx.languageId);
  const header = ctx.related
    .map((r) => `${c} --- ${r.path} ---\n` + r.body.split("\n").map((l) => `${c} ${l}`).join("\n"))
    .join("\n");
  return `${header}\n${ctx.prefix}`;
}

function commentPrefix(languageId: string): string {
  switch (languageId) {
    case "python":
    case "ruby":
    case "shellscript":
    case "yaml":
    case "makefile":
    case "r":
      return "#";
    case "sql":
    case "lua":
    case "haskell":
      return "--";
    case "clojure":
    case "lisp":
      return ";;";
    default:
      return "//";
  }
}
