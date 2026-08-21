// The router: which model answers, and what it is allowed to cost.
//
// The whole cost story of this extension is one inversion. A hosted assistant sends everything to
// one large remote model because that is the product. Here the DEFAULT is the model already
// running on the machine, and the remote one is an escalation that must be justified, consented
// to, and paid for from a budget. Concretely:
//
//   • completion, embeddings and chores (titles, commit messages, classification) never escalate.
//     They are the high-frequency traffic — one request per keystroke pause — and they are
//     exactly the tasks a 7B coder model does well. This alone is the difference between a bill
//     of tens of dollars per developer-day and one of zero.
//   • chat and agent turns escalate only on a signal: the operator configured a remote provider,
//     or the request is genuinely beyond the local model (context larger than its window, or a
//     class of question small models fail at), and the policy allows it.
//
// The classifier below never spends money on its own. Its output is a recommendation the caller
// either applies (policy `auto`), asks about (`ask`), or ignores (`never`).

import type { ProviderId } from "../providers/index.js";

export type TaskKind = "completion" | "chat" | "agent" | "aux" | "embed";
export type EscalationPolicy = "never" | "ask" | "auto";
export type Complexity = "trivial" | "standard" | "hard";

export interface RouterConfig {
  chat: { provider: ProviderId; model: string };
  completion: { provider: ProviderId | "off"; model: string };
  /** Where an escalated request goes when the everyday provider is local. */
  escalateTo?: { provider: ProviderId; model: string };
  escalation: EscalationPolicy;
  /** Context window of the local model, in tokens. Beyond it, quality collapses silently. */
  localContextTokens: number;
}

export interface RouteInput {
  kind: TaskKind;
  promptTokens: number;
  /** The user's own words for a chat/agent turn — the only honest complexity signal we have. */
  prompt?: string;
  /** Set when the user explicitly asked for the cloud in this turn. */
  forceRemote?: boolean;
}

export interface Route {
  provider: ProviderId;
  model: string;
  /** Set when the router would rather escalate but is not allowed to decide alone. */
  suggestEscalation?: { provider: ProviderId; model: string; why: string };
  why: string;
}

// Signals that a request is beyond a small local model. Deliberately conservative: the failure
// mode of escalating too eagerly is a bill, and the whole point of this project is not to have one.
const HARD_SIGNALS: Array<[RegExp, string]> = [
  [/\b(architecture|refactor(?:ing)?\s+(?:the|all|across)|migrat(?:e|ion)\s+(?:the|all)|redesign)\b/i, "cross-cutting change"],
  [/\b(why does|why is|root cause|race condition|deadlock|memory leak|heisenbug)\b/i, "diagnosis rather than transformation"],
  [/\b(threat model|security review|audit|vulnerab)/i, "security reasoning"],
  [/\b(prove|invariant|complexity analysis|algorithm design)\b/i, "formal reasoning"],
];

export function classifyComplexity(prompt: string, promptTokens: number, localContextTokens: number): {
  level: Complexity;
  why: string;
} {
  if (promptTokens > localContextTokens * 0.8) {
    return { level: "hard", why: `context (~${promptTokens} tokens) does not fit the local model's window` };
  }
  for (const [re, why] of HARD_SIGNALS) if (re.test(prompt)) return { level: "hard", why };
  if (prompt.trim().length < 40 && !/\?/.test(prompt)) return { level: "trivial", why: "short instruction" };
  return { level: "standard", why: "ordinary coding turn" };
}

export function route(cfg: RouterConfig, input: RouteInput): Route {
  // High-frequency, low-value-per-call work. Never leaves, whatever the policy says.
  if (input.kind === "completion" || input.kind === "aux" || input.kind === "embed") {
    const p = input.kind === "completion" ? cfg.completion : { provider: cfg.completion.provider, model: cfg.completion.model };
    const provider = (p.provider === "off" ? "local" : p.provider) as ProviderId;
    return { provider, model: p.model, why: `${input.kind} never escalates: it is the high-frequency traffic` };
  }

  const base: Route = { provider: cfg.chat.provider, model: cfg.chat.model, why: "configured chat model" };
  if (cfg.chat.provider !== "local" || !cfg.escalateTo) return base;

  const { level, why } = classifyComplexity(input.prompt ?? "", input.promptTokens, cfg.localContextTokens);
  const wantsRemote = input.forceRemote || level === "hard";
  if (!wantsRemote) return base;

  if (cfg.escalation === "never") {
    return { ...base, why: `${why}, but escalation is disabled` };
  }
  if (cfg.escalation === "auto") {
    return { provider: cfg.escalateTo.provider, model: cfg.escalateTo.model, why: `escalated: ${why}` };
  }
  return { ...base, suggestEscalation: { ...cfg.escalateTo, why } };
}
